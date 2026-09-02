const TELEGRAM_BOT_TOKEN_RE = /^\d{5,20}:[A-Za-z0-9_-]{20,200}$/;
const TELEGRAM_USER_ID_RE = /^[1-9]\d{0,19}$/;
const TELEGRAM_CHAT_ID_RE = /^-?\d{1,20}$/;
const TELEGRAM_USERNAME_RE = /^@[A-Za-z0-9_]{5,32}$/;

export interface TelegramDestination {
  chatId: string;
  messageThreadId?: number;
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  commandsEnabled: boolean;
  commandUserId: string | null;
}

export class TelegramConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramConfigValidationError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isSafeNumericTelegramId(value: string, allowNegative: boolean): boolean {
  try {
    const parsed = BigInt(value);
    if (parsed === 0n || (!allowNegative && parsed < 0n)) return false;
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER)
      && parsed >= BigInt(Number.MIN_SAFE_INTEGER);
  } catch {
    return false;
  }
}

export function parseTelegramDestination(raw: unknown): TelegramDestination | null {
  const value = trimmedString(raw);
  const separator = Math.max(value.lastIndexOf(':'), value.lastIndexOf('/'));
  const rawChatId = separator > 0 ? value.slice(0, separator) : value;
  const rawThreadId = separator > 0 ? value.slice(separator + 1) : null;

  if (!TELEGRAM_CHAT_ID_RE.test(rawChatId) && !TELEGRAM_USERNAME_RE.test(rawChatId)) {
    return null;
  }
  if (
    TELEGRAM_CHAT_ID_RE.test(rawChatId)
    && !isSafeNumericTelegramId(rawChatId, true)
  ) return null;
  if (rawThreadId === null) return { chatId: rawChatId };
  if (!/^\d{1,10}$/.test(rawThreadId)) return null;

  const messageThreadId = Number(rawThreadId);
  if (!Number.isSafeInteger(messageThreadId) || messageThreadId <= 0) return null;
  return { chatId: rawChatId, messageThreadId };
}

export function readTelegramConfig(value: unknown): TelegramConfig | null {
  const input = asRecord(value);
  if (!input) return null;

  const botToken = trimmedString(input.botToken);
  const chatId = trimmedString(input.chatId);
  if (!botToken || !chatId) return null;

  return {
    botToken,
    chatId,
    commandsEnabled: input.commandsEnabled === true,
    commandUserId: trimmedString(input.commandUserId) || null,
  };
}

export function normalizeTelegramConfig(
  value: unknown,
  previousValue: unknown,
): Record<string, unknown> {
  const input = asRecord(value);
  if (!input) throw new TelegramConfigValidationError('Telegram config must be an object');

  const previous = readTelegramConfig(previousValue);
  const botToken = trimmedString(input.botToken) || previous?.botToken || '';
  if (!TELEGRAM_BOT_TOKEN_RE.test(botToken)) {
    throw new TelegramConfigValidationError('Invalid Telegram Bot Token');
  }

  const destination = parseTelegramDestination(input.chatId);
  if (!destination) throw new TelegramConfigValidationError('Invalid Telegram Chat ID');

  const commandsEnabled = input.commandsEnabled === true;
  const commandUserId = trimmedString(input.commandUserId);
  if (
    commandUserId
    && (
      !TELEGRAM_USER_ID_RE.test(commandUserId)
      || !isSafeNumericTelegramId(commandUserId, false)
    )
  ) {
    throw new TelegramConfigValidationError('Invalid Telegram User ID');
  }
  if (commandsEnabled && destination.chatId.startsWith('@')) {
    throw new TelegramConfigValidationError(
      'Telegram commands require a numeric Chat ID',
    );
  }

  return {
    botToken,
    chatId: trimmedString(input.chatId),
    commandsEnabled,
    commandUserId,
  };
}

export function publicTelegramConfig(value: unknown): Record<string, unknown> {
  const config = readTelegramConfig(value);
  if (!config) return {};
  return {
    botToken: '',
    hasBotToken: true,
    chatId: config.chatId,
    commandsEnabled: config.commandsEnabled,
    commandUserId: config.commandUserId ?? '',
  };
}
