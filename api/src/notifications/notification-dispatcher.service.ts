import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { ConfigService } from '@nestjs/config';
import { jsonArrayContains } from '../common/sqlite-mappers';
import { parseJsonObject } from '../common/json-array';
import { assertPublicHttpUrl } from '../common/validators/safe-url';

interface NotificationPayload {
  event: string;
  title: string;
  message: string;
  siteName?: string;
  timestamp?: Date;
}

interface TelegramConfig {
  botToken: string;
  chatId: string;
}

interface EmailConfig {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  from: string;
  to: string;
}

interface WebhookConfig {
  url: string;
  secret?: string;
}

@Injectable()
export class NotificationDispatcherService {
  private readonly logger = new Logger('NotificationDispatcher');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Dispatch a notification to all enabled channels subscribed to this event.
   */
  async dispatch(payload: NotificationPayload): Promise<void> {
    const settings = await this.prisma.notificationSetting.findMany({
      where: {
        enabled: true,
        events: jsonArrayContains(payload.event),
      },
    });

    for (const setting of settings) {
      try {
        const cfg = parseJsonObject<Record<string, unknown>>(setting.config, {});
        switch (setting.channel) {
          case 'TELEGRAM':
            await this.sendTelegram(cfg as unknown as TelegramConfig, payload);
            break;
          case 'EMAIL':
            await this.sendEmail(cfg as unknown as EmailConfig, payload);
            break;
          case 'WEBHOOK':
            await this.sendWebhook(cfg as unknown as WebhookConfig, payload);
            break;
        }
      } catch (err) {
        this.logger.error(
          `Failed to send ${setting.channel} notification: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Send a test notification to a specific channel config.
   */
  async sendTest(channel: string, channelConfig: unknown): Promise<void> {
    const payload: NotificationPayload = {
      event: 'TEST',
      title: 'Meowbox Test Notification',
      message: 'If you see this message, notifications are working correctly!',
      timestamp: new Date(),
    };

    switch (channel) {
      case 'TELEGRAM':
        await this.sendTelegram(channelConfig as TelegramConfig, payload);
        break;
      case 'EMAIL':
        await this.sendEmail(channelConfig as EmailConfig, payload);
        break;
      case 'WEBHOOK':
        await this.sendWebhook(channelConfig as WebhookConfig, payload);
        break;
    }
  }

  // =========================================================================
  // Telegram
  // =========================================================================

  private async sendTelegram(
    cfg: TelegramConfig,
    payload: NotificationPayload,
  ): Promise<void> {
    if (!cfg.botToken || !cfg.chatId) {
      throw new Error('Telegram botToken and chatId are required');
    }

    const emoji = this.getEventEmoji(payload.event);
    const text = [
      `${emoji} *${this.escapeMarkdown(payload.title)}*`,
      '',
      this.escapeMarkdown(payload.message),
      payload.siteName ? `\nSite: _${this.escapeMarkdown(payload.siteName)}_` : '',
      `\n_${this.escapeMarkdown(new Date(payload.timestamp || Date.now()).toISOString())}_`,
    ]
      .filter(Boolean)
      .join('\n');

    // Поддержка топиков (forum threads) в групповых чатах:
    //   "-1003803183992"        → обычный чат
    //   "-1003803183992:3"      → чат -1003803183992, топик 3
    //   "-1003803183992/3"      → то же самое
    //   "@channelname"          → канал по username
    const { chatId, messageThreadId } = this.parseTelegramChatId(cfg.chatId);

    const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    };
    if (messageThreadId !== undefined) {
      body.message_thread_id = messageThreadId;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const apiBody = await response.text();
      throw new Error(`Telegram API error ${response.status}: ${apiBody}`);
    }

    this.logger.debug(
      `Telegram notification sent to ${chatId}` +
        (messageThreadId !== undefined ? ` (topic ${messageThreadId})` : ''),
    );
  }

  /**
   * Парсит Telegram chatId с опциональным указанием топика.
   * Допустимые форматы:
   *   "133652371"                 → личка
   *   "-1003803183992"            → группа/канал
   *   "-1003803183992:3"          → топик 3 в группе
   *   "-1003803183992/3"          → то же
   *   "@channel"                  → username канала
   */
  private parseTelegramChatId(raw: string): {
    chatId: string;
    messageThreadId?: number;
  } {
    const trimmed = String(raw).trim();
    const m = trimmed.match(/^(-?\d+|@[A-Za-z0-9_]+)[:/](\d+)$/);
    if (m) {
      const threadId = Number(m[2]);
      if (Number.isFinite(threadId) && threadId > 0) {
        return { chatId: m[1], messageThreadId: threadId };
      }
    }
    return { chatId: trimmed };
  }

  // =========================================================================
  // Email (SMTP via nodemailer-style fetch to avoid extra deps)
  // =========================================================================

  private async sendEmail(
    cfg: EmailConfig,
    payload: NotificationPayload,
  ): Promise<void> {
    if (!cfg.smtpHost || !cfg.to) {
      throw new Error('SMTP host and recipient are required');
    }

    // Use net.createConnection for raw SMTP — but simpler to use nodemailer
    // Since we don't want extra deps, use a child process with sendmail/msmtp
    // or use the built-in Node.js approach via net module.
    // For production, we'll use a simple SMTP client via net.
    const { createTransport } = await import('nodemailer');
    const transport = createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort || 587,
      secure: cfg.smtpPort === 465,
      auth:
        cfg.smtpUser && cfg.smtpPass
          ? { user: cfg.smtpUser, pass: cfg.smtpPass }
          : undefined,
    });

    await transport.sendMail({
      from: cfg.from || `Meowbox <noreply@${cfg.smtpHost}>`,
      to: cfg.to,
      subject: `[Meowbox] ${payload.title}`,
      text: `${payload.title}\n\n${payload.message}${payload.siteName ? `\n\nSite: ${payload.siteName}` : ''}\n\n${new Date(payload.timestamp || Date.now()).toISOString()}`,
      html: this.buildEmailHtml(payload),
    });

    this.logger.debug(`Email notification sent to ${cfg.to}`);
  }

  // =========================================================================
  // Webhook
  // =========================================================================

  private async sendWebhook(
    cfg: WebhookConfig,
    payload: NotificationPayload,
  ): Promise<void> {
    if (!cfg.url) {
      throw new Error('Webhook URL is required');
    }

    const body = JSON.stringify({
      event: payload.event,
      title: payload.title,
      message: payload.message,
      siteName: payload.siteName,
      timestamp: payload.timestamp || new Date().toISOString(),
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Meowbox/1.0',
    };

    // HMAC signature for webhook security
    if (cfg.secret) {
      const { createHmac } = await import('crypto');
      const signature = createHmac('sha256', cfg.secret)
        .update(body)
        .digest('hex');
      headers['X-Meowbox-Signature'] = `sha256=${signature}`;
    }

    // Webhook URL задаётся админом. Даже для админа режем SSRF: при
    // компрометации аккаунта злоумышленник мог бы направить webhook на
    // 127.0.0.1/AWS IMDS и пивотить во внутренние сервисы.
    const safeUrl = await assertPublicHttpUrl(cfg.url);
    const response = await fetch(safeUrl.toString(), {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Webhook returned ${response.status}`);
    }

    this.logger.debug(`Webhook notification sent to ${cfg.url}`);
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private getEventEmoji(event: string): string {
    const emojis: Record<string, string> = {
      SITE_DOWN: '\u26a0\ufe0f',
      SSL_EXPIRING: '\u{1f512}',
      BACKUP_COMPLETED: '\u2705',
      BACKUP_FAILED: '\u274c',
      DISK_FULL: '\u{1f4be}',
      DEPLOY_SUCCESS: '\u{1f680}',
      DEPLOY_FAILED: '\u274c',
      HIGH_LOAD: '\u{1f525}',
      LOGIN_FAILED: '\u{1f6a8}',
      TEST: '\u{1f3af}',
    };
    return emojis[event] || '\u{1f514}';
  }

  private escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
  }

  /**
   * HTML-escape для подстановки пользовательских/сервисных строк в email-шаблон.
   * Без этого siteName с символами `<script>` в БД давал бы XSS в почтовом
   * клиенте, рендерящем HTML. Защита layered: siteName валидируется как домен,
   * но payload.title/message приходят из системных событий и теоретически
   * могут содержать `<` из стек-трейса.
   */
  private escapeHtml(s: string | undefined | null): string {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private buildEmailHtml(payload: NotificationPayload): string {
    const title = this.escapeHtml(payload.title);
    const message = this.escapeHtml(payload.message);
    const siteName = this.escapeHtml(payload.siteName);
    const ts = this.escapeHtml(
      new Date(payload.timestamp || Date.now()).toLocaleString(),
    );
    return `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 500px; margin: 0 auto; padding: 24px;">
        <div style="background: #f59e0b; color: #0a0a0f; padding: 16px 20px; border-radius: 12px 12px 0 0; font-weight: 700; font-size: 16px;">
          ${title}
        </div>
        <div style="background: #1a1a24; color: #e2e8f0; padding: 20px; border-radius: 0 0 12px 12px; border: 1px solid #2a2a36; border-top: none;">
          <p style="margin: 0 0 12px; line-height: 1.6;">${message}</p>
          ${siteName ? `<p style="margin: 0 0 12px; color: #94a3b8;">Site: <strong style="color: #fbbf24;">${siteName}</strong></p>` : ''}
          <p style="margin: 0; color: #64748b; font-size: 12px;">${ts}</p>
        </div>
        <p style="color: #64748b; font-size: 11px; text-align: center; margin-top: 12px;">Sent by Meowbox Server Panel</p>
      </div>
    `;
  }
}
