import { Injectable } from '@nestjs/common';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const TELEGRAM_RESPONSE_LIMIT_BYTES = 1024 * 1024;

interface TelegramApiEnvelope<T> {
  ok?: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  date: number;
  text?: string;
  chat: { id: number; type?: string };
  from?: TelegramUser;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramSendMessageInput {
  chatId: string;
  messageThreadId?: number;
  text: string;
  parseMode?: 'HTML' | 'MarkdownV2';
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

@Injectable()
export class TelegramClientService {
  async getMe(botToken: string, signal?: AbortSignal): Promise<TelegramUser> {
    return this.request<TelegramUser>(botToken, 'getMe', {}, {
      timeoutMs: 10_000,
      signal,
    });
  }

  async getUpdates(
    botToken: string,
    options: {
      offset?: number;
      timeoutSeconds?: number;
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<TelegramUpdate[]> {
    const timeoutSeconds = Math.min(30, Math.max(0, options.timeoutSeconds ?? 25));
    const body: Record<string, unknown> = {
      timeout: timeoutSeconds,
      limit: Math.min(100, Math.max(1, options.limit ?? 100)),
      allowed_updates: ['message'],
    };
    if (options.offset !== undefined) body.offset = options.offset;

    return this.request<TelegramUpdate[]>(botToken, 'getUpdates', body, {
      timeoutMs: (timeoutSeconds + 5) * 1000,
      signal: options.signal,
    });
  }

  async sendMessage(
    botToken: string,
    input: TelegramSendMessageInput,
    signal?: AbortSignal,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: input.chatId,
      text: input.text,
      disable_web_page_preview: true,
    };
    if (input.messageThreadId !== undefined) {
      body.message_thread_id = input.messageThreadId;
    }
    if (input.parseMode) body.parse_mode = input.parseMode;
    await this.request<unknown>(botToken, 'sendMessage', body, {
      timeoutMs: 10_000,
      signal,
    });
  }

  private async request<T>(
    botToken: string,
    method: string,
    body: Record<string, unknown>,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', abort, { once: true });

    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    timeout.unref();
    try {
      const response = await fetch(
        `${TELEGRAM_API_BASE}/bot${botToken}/${method}`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      const raw = await this.readBoundedText(response);

      let envelope: TelegramApiEnvelope<T>;
      try {
        envelope = JSON.parse(raw) as TelegramApiEnvelope<T>;
      } catch {
        throw new TelegramApiError('Telegram returned invalid JSON', response.status);
      }

      if (!response.ok || envelope.ok !== true || !('result' in envelope)) {
        const description = typeof envelope.description === 'string'
          ? envelope.description.slice(0, 240)
          : `HTTP ${response.status}`;
        const retryAfter = envelope.parameters?.retry_after;
        throw new TelegramApiError(
          description,
          envelope.error_code ?? response.status,
          typeof retryAfter === 'number' && Number.isFinite(retryAfter)
            ? Math.max(0, Math.round(retryAfter))
            : null,
        );
      }
      return envelope.result as T;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  private async readBoundedText(response: Response): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      if (bytes > TELEGRAM_RESPONSE_LIMIT_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new TelegramApiError(
          'Telegram response exceeded size limit',
          response.status,
        );
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}
