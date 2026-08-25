import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io-client';
import {
  AGENT_JOB_EVENTS,
  type AgentJobCancelResult,
  type AgentJobHeartbeat,
  type AgentJobResult,
  type AgentJobStartRequest,
  type AgentJobStarted,
  type AgentJobState,
  type AgentJobStatus,
  validateAgentJobStart,
  validateAgentJobStatusRequest,
} from '@meowbox/shared';
import { runInAgentJobContext } from './job-context';
import { childProcessRegistry } from './process-registry';

const HEARTBEAT_MS = 10_000;
const MAX_ACTIVE_JOBS = 2;
const MAX_RESULT_BYTES = 1024 * 1024;
const TERMINAL_STATES = new Set<AgentJobState>([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'NEEDS_ATTENTION',
]);

export interface AgentJobHandlerContext {
  readonly jobId: string;
  readonly operationId: string;
  readonly recovering: boolean;
  heartbeat(step: string, progress: number): void;
  isCancellationRequested(): boolean;
  throwIfCancellationRequested(): void;
}

export type AgentJobHandler = (
  payload: unknown,
  context: AgentJobHandlerContext,
) => Promise<unknown>;

interface RuntimeJob {
  request: AgentJobStartRequest;
  state: AgentJobState;
  sequence: number;
  progress: number;
  step: string;
  result: unknown;
  error: string | null;
  cancellationRequested: boolean;
  createdAt: number;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Agent job failed';
  return message
    .replace(/(password|secret|token|authorization|cookie)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 4096);
}

function assertSafeResult(value: unknown, path = 'result'): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeResult(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/(password|secret|token|credential|private.?key|envvars)/i.test(key)) {
      throw new Error(`Agent job result contains forbidden field: ${path}.${key}`);
    }
    assertSafeResult(nested, `${path}.${key}`);
  }
}

function resultBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Agent job result is not JSON-serializable');
  return Buffer.byteLength(encoded, 'utf8');
}

export class AgentJobRuntime {
  readonly bootId = randomUUID();
  private readonly handlers = new Map<string, AgentJobHandler>();
  private readonly jobs = new Map<string, RuntimeJob>();
  private socket: Socket | null = null;

  registerHandler(actionId: string, handler: AgentJobHandler): () => void {
    if (!/^[a-z][a-z0-9]*(?:\.[a-z0-9_-]+)+$/.test(actionId)) {
      throw new Error('Agent job action ID is invalid');
    }
    if (this.handlers.has(actionId)) {
      throw new Error(`Agent job handler already registered: ${actionId}`);
    }
    this.handlers.set(actionId, handler);
    return () => {
      if (this.handlers.get(actionId) === handler) this.handlers.delete(actionId);
    };
  }

  attach(socket: Socket): void {
    this.detach();
    this.socket = socket;
    socket.on(AGENT_JOB_EVENTS.START, this.handleStart);
    socket.on(AGENT_JOB_EVENTS.STATUS, this.handleStatus);
    socket.on(AGENT_JOB_EVENTS.CANCEL, this.handleCancel);
  }

  detach(): void {
    if (!this.socket) return;
    this.socket.off(AGENT_JOB_EVENTS.START, this.handleStart);
    this.socket.off(AGENT_JOB_EVENTS.STATUS, this.handleStatus);
    this.socket.off(AGENT_JOB_EVENTS.CANCEL, this.handleCancel);
    this.socket = null;
  }

  private readonly handleStart = (
    raw: unknown,
    callback: (response: AgentJobStarted) => void,
  ): void => {
    let request: AgentJobStartRequest;
    try {
      request = validateAgentJobStart(raw);
    } catch (error) {
      callback(this.rejectedStart(raw, safeMessage(error)));
      return;
    }
    const existing = this.jobs.get(request.jobId);
    if (existing) {
      if (
        existing.request.operationId !== request.operationId ||
        existing.request.requestHash !== request.requestHash ||
        existing.request.actionId !== request.actionId ||
        existing.request.step !== request.step
      ) {
        callback(this.rejectedStart(request, 'Agent job idempotency conflict'));
        return;
      }
      callback(this.startedResponse(existing, true));
      if (TERMINAL_STATES.has(existing.state)) this.emitResult(existing);
      return;
    }
    if (Date.parse(request.deadlineAt) <= Date.now()) {
      callback(this.rejectedStart(request, 'Agent job deadline elapsed'));
      return;
    }
    const activeCount = [...this.jobs.values()].filter(
      (job) => !TERMINAL_STATES.has(job.state),
    ).length;
    if (activeCount >= MAX_ACTIVE_JOBS) {
      callback(this.rejectedStart(request, 'Agent job concurrency limit reached'));
      return;
    }
    const handler = this.handlers.get(request.actionId);
    if (!handler) {
      callback(this.rejectedStart(request, 'Agent job action is not registered'));
      return;
    }
    const job: RuntimeJob = {
      request,
      state: 'RUNNING',
      sequence: 0,
      progress: 0,
      step: request.step,
      result: null,
      error: null,
      cancellationRequested: false,
      createdAt: Date.now(),
    };
    this.pruneJobs();
    this.jobs.set(request.jobId, job);
    const started = this.startedResponse(job, false);
    callback(started);
    this.socket?.emit(AGENT_JOB_EVENTS.STARTED, started);
    void this.execute(job, handler);
  };

  private readonly handleStatus = (
    raw: unknown,
    callback: (response: AgentJobStatus) => void,
  ): void => {
    try {
      const request = validateAgentJobStatusRequest(raw);
      const job = this.jobs.get(request.jobId);
      if (!job || job.request.operationId !== request.operationId) {
        callback(this.missingStatus(request.jobId, request.operationId));
        return;
      }
      callback(this.statusResponse(job));
    } catch {
      callback(this.missingStatus(randomUUID(), randomUUID()));
    }
  };

  private readonly handleCancel = (
    raw: unknown,
    callback: (response: AgentJobCancelResult) => void,
  ): void => {
    let request: { jobId: string; operationId: string };
    try {
      request = validateAgentJobStatusRequest(raw);
    } catch {
      callback({
        success: false,
        jobId: randomUUID(),
        operationId: randomUUID(),
        state: 'FAILED',
        outcome: 'NOT_FOUND',
        error: 'Agent job identity is invalid',
      });
      return;
    }
    const job = this.jobs.get(request.jobId);
    if (!job || job.request.operationId !== request.operationId) {
      callback({
        success: false,
        ...request,
        state: 'FAILED',
        outcome: 'NOT_FOUND',
        error: 'Agent job not found',
      });
      return;
    }
    if (TERMINAL_STATES.has(job.state)) {
      callback({
        success: true,
        ...request,
        state: job.state,
        outcome: 'ALREADY_TERMINAL',
        error: null,
      });
      return;
    }
    if (!job.request.cancelSafe) {
      callback({
        success: false,
        ...request,
        state: job.state,
        outcome: 'NOT_CANCELLABLE',
        error: 'Agent job action is not cancellation-safe',
      });
      return;
    }
    job.cancellationRequested = true;
    job.state = 'CANCEL_REQUESTED';
    callback({
      success: true,
      ...request,
      state: job.state,
      outcome: 'REQUESTED',
      error: null,
    });
    void childProcessRegistry.cancelJob(job.request.jobId, 5_000);
  };

  private async execute(job: RuntimeJob, handler: AgentJobHandler): Promise<void> {
    const heartbeat = setInterval(() => this.emitHeartbeat(job), HEARTBEAT_MS);
    heartbeat.unref();
    const remainingMs = Math.max(1, Date.parse(job.request.deadlineAt) - Date.now());
    const deadlineTimer = setTimeout(() => {
      if (!job.request.cancelSafe || TERMINAL_STATES.has(job.state)) return;
      job.cancellationRequested = true;
      job.state = 'CANCEL_REQUESTED';
      void childProcessRegistry.cancelJob(job.request.jobId, 5_000);
    }, Math.min(remainingMs, 2_147_483_647));
    deadlineTimer.unref();
    try {
      const result = await runInAgentJobContext(
        {
          jobId: job.request.jobId,
          operationId: job.request.operationId,
          cancelSafe: job.request.cancelSafe,
        },
        () => handler(job.request.payload, {
          jobId: job.request.jobId,
          operationId: job.request.operationId,
          recovering: false,
          heartbeat: (step, progress) => {
            if (!/^[a-z][a-z0-9._:-]{0,127}$/.test(step)) {
              throw new Error('Agent job heartbeat step is invalid');
            }
            if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
              throw new Error('Agent job heartbeat progress is invalid');
            }
            job.step = step;
            job.progress = progress;
            this.emitHeartbeat(job);
          },
          isCancellationRequested: () => job.cancellationRequested,
          throwIfCancellationRequested: () => {
            if (job.cancellationRequested) throw new Error('Agent job cancelled');
          },
        }),
      );
      if (job.cancellationRequested) {
        job.state = 'CANCELLED';
        job.error = 'Agent job cancelled';
      } else {
        assertSafeResult(result);
        if (resultBytes(result) > MAX_RESULT_BYTES) {
          throw new Error('Agent job result exceeds 1 MiB');
        }
        job.state = 'SUCCEEDED';
        job.progress = 100;
        job.result = result;
      }
    } catch (error) {
      if (job.cancellationRequested) {
        job.state = 'CANCELLED';
        job.error = 'Agent job cancelled';
      } else {
        job.state = 'FAILED';
        job.error = safeMessage(error);
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadlineTimer);
      this.emitResult(job);
    }
  }

  private emitHeartbeat(job: RuntimeJob): void {
    if (TERMINAL_STATES.has(job.state)) return;
    const payload: AgentJobHeartbeat = {
      jobId: job.request.jobId,
      operationId: job.request.operationId,
      bootId: this.bootId,
      sequence: ++job.sequence,
      progress: job.progress,
      step: job.step,
      timestamp: new Date().toISOString(),
    };
    this.socket?.emit(AGENT_JOB_EVENTS.HEARTBEAT, payload);
  }

  private emitResult(job: RuntimeJob): void {
    const payload: AgentJobResult = {
      jobId: job.request.jobId,
      operationId: job.request.operationId,
      bootId: this.bootId,
      sequence: ++job.sequence,
      success: job.state === 'SUCCEEDED',
      cancelled: job.state === 'CANCELLED',
      result: job.state === 'SUCCEEDED' ? job.result : null,
      error: job.error,
      timestamp: new Date().toISOString(),
    };
    this.socket?.emit(AGENT_JOB_EVENTS.RESULT, payload);
  }

  private startedResponse(job: RuntimeJob, replayed: boolean): AgentJobStarted {
    return {
      success: true,
      jobId: job.request.jobId,
      operationId: job.request.operationId,
      bootId: this.bootId,
      state: job.state,
      replayed,
      error: null,
    };
  }

  private rejectedStart(raw: unknown, error: string): AgentJobStarted {
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return {
      success: false,
      jobId: typeof value.jobId === 'string' ? value.jobId : randomUUID(),
      operationId: typeof value.operationId === 'string' ? value.operationId : randomUUID(),
      bootId: this.bootId,
      state: 'FAILED',
      replayed: false,
      error,
    };
  }

  private statusResponse(job: RuntimeJob): AgentJobStatus {
    return {
      success: true,
      jobId: job.request.jobId,
      operationId: job.request.operationId,
      bootId: this.bootId,
      state: job.state,
      sequence: job.sequence,
      progress: job.progress,
      step: job.step,
      result: job.state === 'SUCCEEDED' ? job.result : null,
      error: job.error,
    };
  }

  private missingStatus(jobId: string, operationId: string): AgentJobStatus {
    return {
      success: false,
      jobId,
      operationId,
      bootId: this.bootId,
      state: 'FAILED',
      sequence: 0,
      progress: 0,
      step: 'unknown',
      result: null,
      error: 'Agent job not found',
    };
  }

  private pruneJobs(): void {
    if (this.jobs.size < 1_000) return;
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, job] of this.jobs) {
      if (TERMINAL_STATES.has(job.state) && job.createdAt < cutoff) this.jobs.delete(id);
      if (this.jobs.size < 1_000) break;
    }
    if (this.jobs.size >= 1_000) throw new Error('Agent job history capacity reached');
  }
}
