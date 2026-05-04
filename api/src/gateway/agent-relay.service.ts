import { Injectable, Logger } from '@nestjs/common';
import { Socket } from 'socket.io';

const AGENT_TIMEOUT_MS = 120_000;

interface AgentResponse<T = unknown> {
  success: boolean;
  error?: string;
  data?: T;
}

@Injectable()
export class AgentRelayService {
  private readonly logger = new Logger('AgentRelay');
  private agentSocket: Socket | null = null;
  /**
   * Hooks, which are called every time the agent transitions from offline to
   * online (incl. reconnect). Used by services (e.g. sites.service) which
   * want to do best-effort tasks at startup, but the API may start before the
   * agent is ready — without this hook, those tasks would silently skip.
   * Errors in handlers are caught & logged, чтобы один кривой подписчик не
   * валил остальные.
   */
  private connectHandlers: Array<() => void | Promise<void>> = [];

  setAgentSocket(socket: Socket | null) {
    const wasConnected = this.isAgentConnected();
    this.agentSocket = socket;
    if (socket) {
      this.logger.log('Agent connected');
      if (!wasConnected) {
        for (const h of this.connectHandlers) {
          Promise.resolve()
            .then(() => h())
            .catch((err) => {
              this.logger.warn(
                `onAgentConnect handler failed: ${(err as Error).message}`,
              );
            });
        }
      }
    } else {
      this.logger.warn('Agent disconnected');
    }
  }

  /**
   * Регистрирует колбэк, который сработает при следующем (и каждом
   * последующем) подключении агента. Если агент УЖЕ подключён в момент
   * вызова — колбэк выстрелит сразу, на ближайшем тике, чтобы вызывающие
   * сервисы не пропустили событие из-за гонки порядка инициализации.
   */
  onAgentConnect(handler: () => void | Promise<void>): void {
    this.connectHandlers.push(handler);
    if (this.isAgentConnected()) {
      Promise.resolve()
        .then(() => handler())
        .catch((err) => {
          this.logger.warn(
            `onAgentConnect immediate handler failed: ${(err as Error).message}`,
          );
        });
    }
  }

  isAgentConnected(): boolean {
    return this.agentSocket !== null && this.agentSocket.connected;
  }

  /**
   * Emit a command to the agent and wait for ack response.
   * Uses Socket.io acknowledgement callbacks with timeout.
   */
  async emitToAgent<T = unknown>(
    event: string,
    data: unknown,
    timeoutMs = AGENT_TIMEOUT_MS,
  ): Promise<AgentResponse<T>> {
    if (!this.isAgentConnected()) {
      throw new AgentUnavailableError();
    }

    return new Promise<AgentResponse<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new AgentTimeoutError(event, timeoutMs));
      }, timeoutMs);

      this.agentSocket!.emit(event, data, (response: AgentResponse<T>) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  /**
   * Emit a command without waiting for response (fire-and-forget).
   * Used for async operations like deploy/backup that stream results back.
   */
  emitToAgentAsync(event: string, data: unknown): void {
    if (!this.isAgentConnected()) {
      throw new AgentUnavailableError();
    }
    this.agentSocket!.emit(event, data, () => {
      // ack received, nothing to do
    });
  }

  getAgentSocket(): Socket | null {
    return this.agentSocket;
  }
}

export class AgentUnavailableError extends Error {
  constructor() {
    super('Agent is not connected. Server operations are unavailable.');
    this.name = 'AgentUnavailableError';
  }
}

export class AgentTimeoutError extends Error {
  constructor(event: string, timeoutMs: number) {
    super(`Agent did not respond to "${event}" within ${timeoutMs / 1000}s`);
    this.name = 'AgentTimeoutError';
  }
}
