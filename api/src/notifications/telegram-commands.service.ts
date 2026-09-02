import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { safeErrorMessage } from '@meowbox/shared';
import { PrismaService } from '../common/prisma.service';
import { parseJsonObject } from '../common/json-array';
import { DashboardOverviewService } from '../dashboard/dashboard-overview.service';
import {
  formatDashboardCommand,
  formatTelegramHelp,
  parseTelegramCommand,
} from './telegram-command-formatter';
import {
  parseTelegramDestination,
  readTelegramConfig,
  type TelegramConfig,
  type TelegramDestination,
} from './telegram-config';
import {
  TelegramApiError,
  TelegramClientService,
  type TelegramMessage,
  type TelegramUpdate,
} from './telegram-client.service';

const POLL_TIMEOUT_SECONDS = 25;
const LOOP_DELAY_MS = 1000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_COMMANDS = 12;
const RATE_LIMIT_BOT_COMMANDS = 30;
const ENABLED_AT_CLOCK_SKEW_MS = 30_000;
const POLLING_LEASE_MS = 90_000;

interface TelegramCommandSetting {
  id: string;
  userId: string;
  channel: string;
  enabled: boolean;
  config: string;
  commandBotTokenHash: string | null;
  telegramNextUpdateId: string | null;
  telegramCommandsEnabledAt: Date | null;
  telegramLeaseOwner: string | null;
  telegramLeaseExpiresAt: Date | null;
  createdAt: Date;
  user: { id: string; role: string };
}

interface RateLimitState {
  windowStartedAt: number;
  count: number;
}

@Injectable()
export class TelegramCommandsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramCommandsService.name);
  private readonly workerId = `telegram:${process.pid}:${randomUUID()}`;
  private readonly controllers = new Map<string, AbortController>();
  private readonly backoffUntil = new Map<string, number>();
  private readonly failureCounts = new Map<string, number>();
  private readonly rateLimits = new Map<string, RateLimitState>();
  private readonly duplicateWarnings = new Set<string>();
  private readonly botUsernames = new Map<string, string>();
  private loop: Promise<void> | null = null;
  private stopped = false;
  private polling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramClientService,
    private readonly dashboard: DashboardOverviewService,
  ) {}

  onModuleInit(): void {
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    for (const controller of this.controllers.values()) controller.abort();
    await this.loop;
    await this.prisma.notificationSetting.updateMany({
      where: { telegramLeaseOwner: this.workerId },
      data: { telegramLeaseOwner: null, telegramLeaseExpiresAt: null },
    }).catch((error) => {
      this.logger.warn(
        `telegram.commands outcome=lease_release_failed error=${safeErrorMessage(error)}`,
      );
    });
  }

  async pollOnce(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      const rows = await this.prisma.notificationSetting.findMany({
        where: { channel: 'TELEGRAM', enabled: true },
        include: { user: { select: { id: true, role: true } } },
        orderBy: { createdAt: 'asc' },
      }) as TelegramCommandSetting[];

      const seenTokens = new Set<string>();
      const eligible: Array<{ row: TelegramCommandSetting; config: TelegramConfig }> = [];
      for (const row of rows) {
        const config = readTelegramConfig(parseJsonObject(row.config, {}));
        if (!config?.commandsEnabled || !parseTelegramDestination(config.chatId)) continue;

        const tokenKey = this.tokenKey(config.botToken);
        if (seenTokens.has(tokenKey)) {
          if (!this.duplicateWarnings.has(tokenKey)) {
            this.duplicateWarnings.add(tokenKey);
            this.logger.warn('telegram.commands outcome=duplicate_bot_token');
          }
          continue;
        }
        seenTokens.add(tokenKey);
        if ((this.backoffUntil.get(row.id) ?? 0) > Date.now()) continue;
        eligible.push({ row, config });
      }

      await Promise.all(eligible.map(({ row, config }) => this.pollSetting(row, config)));
    } finally {
      this.polling = false;
    }
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (error) {
        this.logger.error(
          `telegram.commands outcome=coordinator_error error=${safeErrorMessage(error)}`,
        );
      }
      if (!this.stopped) await this.sleep(LOOP_DELAY_MS);
    }
  }

  private async pollSetting(
    setting: TelegramCommandSetting,
    config: TelegramConfig,
  ): Promise<void> {
    if (!(await this.claimLease(setting.id))) return;
    const leasedSetting = await this.loadSetting(setting.id);
    const leasedConfig = leasedSetting
      ? readTelegramConfig(parseJsonObject(leasedSetting.config, {}))
      : null;
    if (
      !leasedSetting
      || leasedSetting.telegramLeaseOwner !== this.workerId
      || !leasedConfig?.commandsEnabled
    ) return;
    setting = leasedSetting;
    config = leasedConfig;
    const controller = new AbortController();
    this.controllers.set(setting.id, controller);
    try {
      const updates = await this.telegram.getUpdates(config.botToken, {
        offset: this.parseNextUpdateId(setting.telegramNextUpdateId) ?? undefined,
        timeoutSeconds: POLL_TIMEOUT_SECONDS,
        limit: 100,
        signal: controller.signal,
      });
      const current = await this.loadSetting(setting.id);
      const currentConfig = current
        ? readTelegramConfig(parseJsonObject(current.config, {}))
        : null;
      const mayProcess = current !== null
        && current.enabled
        && current.channel === 'TELEGRAM'
        && current.telegramLeaseOwner === this.workerId
        && currentConfig?.commandsEnabled === true
        && currentConfig.botToken === config.botToken;
      const processed = await this.processUpdates(
        current ?? setting,
        mayProcess ? currentConfig : config,
        updates,
        mayProcess,
        controller.signal,
      );
      if (processed.nextUpdateId !== null) {
        await this.persistNextUpdateId(
          setting.id,
          config.botToken,
          processed.nextUpdateId,
        );
      }
      if (processed.error) throw processed.error;
      this.failureCounts.delete(setting.id);
      this.backoffUntil.delete(setting.id);
    } catch (error) {
      if (this.stopped && this.isAbort(error)) return;
      this.applyBackoff(setting.id, error);
      this.logger.warn(
        `telegram.commands outcome=poll_failed setting=${setting.id} error=${safeErrorMessage(error)}`,
      );
    } finally {
      this.controllers.delete(setting.id);
    }
  }

  private async processUpdates(
    setting: TelegramCommandSetting,
    config: TelegramConfig,
    updates: TelegramUpdate[],
    mayProcess: boolean,
    signal: AbortSignal,
  ): Promise<{ nextUpdateId: number | null; error: unknown | null }> {
    let nextUpdateId = this.parseNextUpdateId(setting.telegramNextUpdateId);
    const ordered = [...updates].sort((a, b) => a.update_id - b.update_id);
    for (const update of ordered) {
      if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) continue;
      if (
        !mayProcess
        || !this.isCurrentUpdate(update, setting.telegramCommandsEnabledAt)
      ) {
        nextUpdateId = Math.max(nextUpdateId ?? 0, update.update_id + 1);
        continue;
      }
      try {
        await this.handleUpdate(setting, config, update.message!, signal);
        nextUpdateId = Math.max(nextUpdateId ?? 0, update.update_id + 1);
      } catch (error) {
        this.logger.warn(
          `telegram.commands outcome=command_failed setting=${setting.id} error=${safeErrorMessage(error)}`,
        );
        return { nextUpdateId, error };
      }
    }
    return { nextUpdateId, error: null };
  }

  private async loadSetting(settingId: string): Promise<TelegramCommandSetting | null> {
    return this.prisma.notificationSetting.findUnique({
      where: { id: settingId },
      include: { user: { select: { id: true, role: true } } },
    }) as Promise<TelegramCommandSetting | null>;
  }

  private isCurrentUpdate(update: TelegramUpdate, enabledAt: Date | null): boolean {
    const message = update.message;
    if (!message || !Number.isSafeInteger(message.date) || message.date <= 0) return false;
    if (!enabledAt) return true;
    return message.date * 1000 >= enabledAt.getTime() - ENABLED_AT_CLOCK_SKEW_MS;
  }

  private async handleUpdate(
    setting: TelegramCommandSetting,
    config: TelegramConfig,
    message: TelegramMessage,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      message.from?.is_bot
      || !message.from
      || !Number.isSafeInteger(message.from.id)
      || message.from.id <= 0
      || !Number.isSafeInteger(message.chat.id)
    ) return;
    const destination = parseTelegramDestination(config.chatId);
    if (!destination || !this.matchesDestination(message, destination)) return;

    const parsedCommand = parseTelegramCommand(message.text);
    if (!parsedCommand) return;
    if (parsedCommand.botUsername) {
      const actualUsername = await this.getBotUsername(config.botToken, signal);
      if (parsedCommand.botUsername !== actualUsername) return;
    }
    const command = parsedCommand.command;
    const telegramUserId = String(message.from.id);
    if (
      !this.consumeRateLimit(`bot:${setting.id}`, RATE_LIMIT_BOT_COMMANDS)
      || !this.consumeRateLimit(`user:${setting.id}:${telegramUserId}`, RATE_LIMIT_COMMANDS)
    ) return;

    if (command === 'whoami') {
      const topic = destination.messageThreadId === undefined
        ? ''
        : `\nTopic ID: <code>${destination.messageThreadId}</code>`;
      await this.reply(
        config,
        destination,
        `Telegram User ID: <code>${telegramUserId}</code>\nChat ID: <code>${destination.chatId}</code>${topic}`,
        signal,
      );
      return;
    }

    if (!config.commandUserId || telegramUserId !== config.commandUserId) {
      this.logger.warn(`telegram.commands outcome=access_denied setting=${setting.id}`);
      return;
    }

    if (command === 'help' || command === 'unknown') {
      await this.reply(config, destination, formatTelegramHelp(), signal);
      return;
    }

    const overview = await this.dashboard.getOverview(setting.user.id, setting.user.role);
    await this.reply(
      config,
      destination,
      formatDashboardCommand(command, overview),
      signal,
    );
    this.logger.log(
      `telegram.commands outcome=served setting=${setting.id} user=${setting.userId} command=${command}`,
    );
  }

  private matchesDestination(
    message: TelegramMessage,
    destination: TelegramDestination,
  ): boolean {
    if (String(message.chat.id) !== destination.chatId) return false;
    return destination.messageThreadId === undefined
      ? message.message_thread_id === undefined
      : message.message_thread_id === destination.messageThreadId;
  }

  private async reply(
    config: TelegramConfig,
    destination: TelegramDestination,
    text: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.telegram.sendMessage(config.botToken, {
      chatId: destination.chatId,
      messageThreadId: destination.messageThreadId,
      text,
      parseMode: 'HTML',
    }, signal);
  }

  private async persistNextUpdateId(
    settingId: string,
    expectedBotToken: string,
    nextUpdateId: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(nextUpdateId) || nextUpdateId < 0) return;
    const tokenKey = this.tokenKey(expectedBotToken);
    const current = await this.prisma.notificationSetting.findUnique({
      where: { id: settingId },
      select: {
        commandBotTokenHash: true,
        telegramNextUpdateId: true,
        telegramLeaseOwner: true,
      },
    });
    if (
      !current
      || current.commandBotTokenHash !== tokenKey
      || current.telegramLeaseOwner !== this.workerId
    ) return;
    if ((this.parseNextUpdateId(current.telegramNextUpdateId) ?? 0) >= nextUpdateId) return;

    const updated = await this.prisma.notificationSetting.updateMany({
      where: {
        id: settingId,
        commandBotTokenHash: tokenKey,
        telegramLeaseOwner: this.workerId,
      },
      data: {
        telegramNextUpdateId: String(nextUpdateId),
        telegramLeaseExpiresAt: new Date(Date.now() + POLLING_LEASE_MS),
      },
    });
    if (updated.count !== 1) {
      this.logger.warn(`telegram.commands outcome=cursor_conflict setting=${settingId}`);
    }
  }

  private async claimLease(settingId: string): Promise<boolean> {
    const now = new Date();
    const claimed = await this.prisma.notificationSetting.updateMany({
      where: {
        id: settingId,
        enabled: true,
        channel: 'TELEGRAM',
        commandBotTokenHash: { not: null },
        OR: [
          { telegramLeaseOwner: null },
          { telegramLeaseOwner: this.workerId },
          { telegramLeaseExpiresAt: { lte: now } },
        ],
      },
      data: {
        telegramLeaseOwner: this.workerId,
        telegramLeaseExpiresAt: new Date(now.getTime() + POLLING_LEASE_MS),
      },
    });
    return claimed.count === 1;
  }

  private parseNextUpdateId(value: string | null): number | null {
    if (value === null || !/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  private consumeRateLimit(key: string, limit: number): boolean {
    const now = Date.now();
    const current = this.rateLimits.get(key);
    if (!current || now - current.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
      if (!current && this.rateLimits.size >= 1000) {
        for (const [entryKey, entry] of this.rateLimits) {
          if (now - entry.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
            this.rateLimits.delete(entryKey);
          }
        }
        if (this.rateLimits.size >= 1000) return false;
      }
      this.rateLimits.set(key, { windowStartedAt: now, count: 1 });
      return true;
    }
    if (current.count >= limit) return false;
    current.count += 1;
    return true;
  }

  private applyBackoff(settingId: string, error: unknown): void {
    const failures = Math.min(6, (this.failureCounts.get(settingId) ?? 0) + 1);
    this.failureCounts.set(settingId, failures);
    const retryAfterMs = error instanceof TelegramApiError && error.retryAfterSeconds !== null
      ? error.retryAfterSeconds * 1000
      : 1000 * 2 ** (failures - 1);
    this.backoffUntil.set(settingId, Date.now() + Math.min(60_000, retryAfterMs));
  }

  private tokenKey(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async getBotUsername(token: string, signal: AbortSignal): Promise<string> {
    const key = this.tokenKey(token);
    const cached = this.botUsernames.get(key);
    if (cached) return cached;
    const bot = await this.telegram.getMe(token, signal);
    const username = typeof bot.username === 'string'
      ? bot.username.trim().toLowerCase()
      : '';
    if (!username || !/^[a-z0-9_]{5,32}$/.test(username)) {
      throw new Error('Telegram bot username is invalid');
    }
    this.botUsernames.set(key, username);
    return username;
  }

  private isAbort(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
    });
  }
}
