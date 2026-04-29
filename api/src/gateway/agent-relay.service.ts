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

  setAgentSocket(socket: Socket | null) {
    this.agentSocket = socket;
    if (socket) {
      this.logger.log('Agent connected');
    } else {
      this.logger.warn('Agent disconnected');
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
