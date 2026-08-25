import { Injectable, Logger } from '@nestjs/common';
import { Socket } from 'socket.io';
import {
  AGENT_JOB_EVENTS,
  AGENT_JOB_PROTOCOL_VERSION,
  validateAgentJobStatus,
  validateAgentJobCancelResult,
  validateAgentJobHeartbeat,
  validateAgentJobResult,
  validateAgentJobStarted,
} from '@meowbox/shared';
import {
  AgentJobService,
  type PrepareAgentJobInput,
} from '../operations/agent-job.service';
import { OperationNeedsAttentionError } from '../operations/operation-errors';

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
  private agentBootId: string | null = null;
  private bootReady: Promise<void> = Promise.resolve();
  /**
   * Hooks, which are called every time the agent transitions from offline to
   * online (incl. reconnect). Used by services (e.g. sites.service) which
   * want to do best-effort tasks at startup, but the API may start before the
   * agent is ready — without this hook, those tasks would silently skip.
   * Errors in handlers are caught & logged, чтобы один кривой подписчик не
   * валил остальные.
   */
  private connectHandlers: Array<() => void | Promise<void>> = [];

  constructor(private readonly agentJobs: AgentJobService) {}

  setAgentSocket(socket: Socket | null, bootId: string | null = null) {
    const wasConnected = this.isAgentConnected();
    if (this.agentSocket) this.detachAgentJobListeners(this.agentSocket);
    this.agentSocket = socket;
    this.agentBootId = socket ? bootId : null;
    if (socket) {
      this.logger.log('Agent connected');
      this.attachAgentJobListeners(socket);
      this.bootReady = bootId
        ? this.agentJobs.markInterruptedByNewBoot(bootId).then((count) => {
            if (count > 0) {
              this.logger.warn(`${count} agent job(s) require reconciliation after agent restart`);
            }
          })
        : Promise.resolve();
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
      this.bootReady = Promise.resolve();
      this.logger.warn('Agent disconnected');
    }
  }

  clearAgentSocket(socket: Socket): void {
    if (this.agentSocket === socket) this.setAgentSocket(null);
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

  getAgentBootId(): string | null {
    return this.agentBootId;
  }

  async runAgentJob(
    input: PrepareAgentJobInput,
    isCancellationRequested?: () => Promise<boolean>,
  ): Promise<unknown> {
    await this.bootReady;
    const bootId = this.agentBootId;
    if (!this.isAgentConnected() || !bootId) {
      throw new AgentJobProtocolUnavailableError();
    }
    const job = await this.agentJobs.prepare(input);
    if (job.state === 'NEEDS_ATTENTION') {
      throw new OperationNeedsAttentionError('Agent job outcome requires reconciliation');
    }
    if (job.state === 'SUCCEEDED' || job.state === 'FAILED' || job.state === 'CANCELLED') {
      return this.resolveTerminalJob(await this.agentJobs.get(job.id));
    }

    await this.agentJobs.bindToBoot(job.id, bootId);
    const rawStarted = await this.emitToAgent<never>(
      AGENT_JOB_EVENTS.START,
      {
        protocolVersion: AGENT_JOB_PROTOCOL_VERSION,
        jobId: job.id,
        operationId: job.operationId,
        actionId: job.actionId,
        step: job.step,
        requestHash: job.requestHash,
        deadlineAt: job.deadlineAt.toISOString(),
        cancelSafe: job.cancelSafe,
        payload: job.payload,
      },
      10_000,
    );
    const started = validateAgentJobStarted(rawStarted);
    if (
      started.jobId !== job.id ||
      started.operationId !== job.operationId ||
      started.bootId !== bootId
    ) {
      throw new OperationNeedsAttentionError('Agent job start acknowledgement identity mismatch');
    }
    await this.agentJobs.recordStarted(started);
    if (!started.success) {
      throw new AgentJobTerminalError(started.error || 'Agent rejected job');
    }

    let cancelSent = false;
    let lastStatusQueryAt = Date.now();
    while (Date.now() <= job.deadlineAt.getTime()) {
      const status = await this.agentJobs.get(job.id);
      if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status.state)) {
        return this.resolveTerminalJob(status);
      }
      if (status.state === 'NEEDS_ATTENTION') {
        throw new OperationNeedsAttentionError(
          status.error || 'Agent job outcome requires reconciliation',
        );
      }
      if (
        !cancelSent &&
        isCancellationRequested &&
        await isCancellationRequested()
      ) {
        cancelSent = true;
        const outcome = await this.agentJobs.requestCancel(job.id);
        if (outcome === 'REQUESTED') {
          if (!this.isAgentConnected() || this.agentBootId !== bootId) {
            throw new OperationNeedsAttentionError(
              'Agent disconnected before cancellation could be confirmed',
            );
          }
          const rawCancel = await this.emitToAgent<never>(
            AGENT_JOB_EVENTS.CANCEL,
            { jobId: job.id, operationId: job.operationId },
            10_000,
          );
          const cancel = validateAgentJobCancelResult(rawCancel);
          if (cancel.jobId !== job.id || cancel.operationId !== job.operationId) {
            throw new OperationNeedsAttentionError('Agent job cancellation identity mismatch');
          }
          await this.agentJobs.recordCancelOutcome(job.id, cancel.outcome);
        }
      }
      if (
        Date.now() - lastStatusQueryAt >= 10_000 &&
        this.isAgentConnected() &&
        this.agentBootId === bootId
      ) {
        lastStatusQueryAt = Date.now();
        await this.queryAgentJobStatus(job.id);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 250);
      });
    }
    await this.agentJobs.markDeadlineUnknown(job.id);
    throw new OperationNeedsAttentionError('Agent job deadline elapsed with unknown outcome');
  }

  private resolveTerminalJob(job: Awaited<ReturnType<AgentJobService['get']>>): unknown {
    if (job.state === 'SUCCEEDED') return job.result;
    if (job.state === 'CANCELLED') {
      throw new AgentJobTerminalError('Agent job cancelled');
    }
    throw new AgentJobTerminalError(job.error || 'Agent job failed');
  }

  private attachAgentJobListeners(socket: Socket): void {
    socket.on(AGENT_JOB_EVENTS.STARTED, this.handleAgentJobStarted);
    socket.on(AGENT_JOB_EVENTS.HEARTBEAT, this.handleAgentJobHeartbeat);
    socket.on(AGENT_JOB_EVENTS.RESULT, this.handleAgentJobResult);
  }

  private detachAgentJobListeners(socket: Socket): void {
    socket.off(AGENT_JOB_EVENTS.STARTED, this.handleAgentJobStarted);
    socket.off(AGENT_JOB_EVENTS.HEARTBEAT, this.handleAgentJobHeartbeat);
    socket.off(AGENT_JOB_EVENTS.RESULT, this.handleAgentJobResult);
  }

  private async queryAgentJobStatus(jobId: string): Promise<void> {
    const job = await this.agentJobs.get(jobId);
    const raw = await this.emitToAgent<never>(
      AGENT_JOB_EVENTS.STATUS,
      { jobId: job.id, operationId: job.operationId },
      10_000,
    );
    const status = validateAgentJobStatus(raw);
    if (
      status.jobId !== job.id ||
      status.operationId !== job.operationId ||
      status.bootId !== this.agentBootId
    ) {
      throw new OperationNeedsAttentionError('Agent job status identity mismatch');
    }
    await this.agentJobs.recordStatus(status);
  }

  private readonly handleAgentJobStarted = (raw: unknown): void => {
    try {
      const started = validateAgentJobStarted(raw);
      if (started.bootId !== this.agentBootId) {
        throw new Error('Agent job start event boot identity mismatch');
      }
      void this.agentJobs.recordStarted(started).catch((error) => {
        this.logger.warn(`Agent job start event rejected: ${(error as Error).message}`);
      });
    } catch (error) {
      this.logger.warn(`Invalid agent job start event: ${(error as Error).message}`);
    }
  };

  private readonly handleAgentJobHeartbeat = (raw: unknown): void => {
    try {
      const heartbeat = validateAgentJobHeartbeat(raw);
      if (heartbeat.bootId !== this.agentBootId) {
        throw new Error('Agent job heartbeat boot identity mismatch');
      }
      void this.agentJobs.recordHeartbeat(heartbeat).catch((error) => {
        this.logger.warn(`Agent job heartbeat rejected: ${(error as Error).message}`);
      });
    } catch (error) {
      this.logger.warn(`Invalid agent job heartbeat: ${(error as Error).message}`);
    }
  };

  private readonly handleAgentJobResult = (raw: unknown): void => {
    try {
      const result = validateAgentJobResult(raw);
      if (result.bootId !== this.agentBootId) {
        throw new Error('Agent job result boot identity mismatch');
      }
      void this.agentJobs.recordResult(result).catch((error) => {
        this.logger.warn(`Agent job result rejected: ${(error as Error).message}`);
      });
    } catch (error) {
      this.logger.warn(`Invalid agent job result: ${(error as Error).message}`);
    }
  };
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

export class AgentJobProtocolUnavailableError extends Error {
  constructor() {
    super('Connected agent does not support durable job protocol 1');
    this.name = AgentJobProtocolUnavailableError.name;
  }
}

export class AgentJobTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = AgentJobTerminalError.name;
  }
}
