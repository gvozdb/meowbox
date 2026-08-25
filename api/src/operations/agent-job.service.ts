import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  AgentJobHeartbeat,
  AgentJobResult,
  AgentJobStarted,
  AgentJobStatus,
} from '@meowbox/shared';
import { safeErrorMessage } from '@meowbox/shared';
import { PrismaService } from '../common/prisma.service';
import { assertNoSecretFields } from '../common/safe-persisted-json';
import { stableJson } from '../common/stable-json';

const ACTION_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9_-]+)+$/;
const STEP = /^[a-z][a-z0-9._:-]{0,127}$/;
const EXECUTING_OPERATION_STATES = [
  'CLAIMED',
  'RUNNING',
  'RECOVERING',
  'CANCEL_REQUESTED',
] as const;
const TERMINAL_JOB_STATES = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'NEEDS_ATTENTION',
]);
const MAX_JOB_PAYLOAD_BYTES = 1024 * 1024;
const MAX_JOB_RESULT_BYTES = 1024 * 1024;

export interface PrepareAgentJobInput {
  operationId: string;
  actionId: string;
  step: string;
  payload: unknown;
  deadlineAt: Date;
  cancelSafe: boolean;
}

export interface PreparedAgentJob {
  id: string;
  operationId: string;
  actionId: string;
  step: string;
  requestHash: string;
  state: string;
  deadlineAt: Date;
  cancelSafe: boolean;
  payload: unknown;
}

function deterministicJobId(operationId: string, step: string): string {
  const bytes = createHash('sha256')
    .update('MEOWBOX-AGENT-JOB-V1\0')
    .update(operationId)
    .update('\0')
    .update(step)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseStoredResult(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

@Injectable()
export class AgentJobService {
  constructor(private readonly prisma: PrismaService) {}

  async prepare(input: PrepareAgentJobInput): Promise<PreparedAgentJob> {
    if (!ACTION_ID.test(input.actionId)) {
      throw new BadRequestException('Agent job action is invalid');
    }
    if (!STEP.test(input.step)) {
      throw new BadRequestException('Agent job step is invalid');
    }
    if (
      !(input.deadlineAt instanceof Date) ||
      !Number.isFinite(input.deadlineAt.getTime()) ||
      input.deadlineAt.getTime() <= Date.now()
    ) {
      throw new BadRequestException('Agent job deadline is invalid');
    }
    const payloadJson = stableJson(input.payload);
    if (Buffer.byteLength(payloadJson, 'utf8') > MAX_JOB_PAYLOAD_BYTES) {
      throw new BadRequestException('Agent job payload exceeds 1 MiB');
    }
    const requestHash = createHash('sha256')
      .update(input.actionId)
      .update('\0')
      .update(input.step)
      .update('\0')
      .update(payloadJson)
      .digest('hex');
    const id = deterministicJobId(input.operationId, input.step);

    const job = await this.prisma.$transaction(async (tx) => {
      const operation = await tx.operation.findUnique({
        where: { id: input.operationId },
        select: { status: true, deadlineAt: true },
      });
      if (!operation) throw new NotFoundException('Operation not found');
      if (!EXECUTING_OPERATION_STATES.includes(operation.status as never)) {
        throw new ConflictException('Operation is not executing');
      }
      if (
        operation.deadlineAt &&
        input.deadlineAt.getTime() > operation.deadlineAt.getTime()
      ) {
        throw new ConflictException('Agent job exceeds operation deadline');
      }

      const existing = await tx.agentJob.findUnique({
        where: { operationId_step: { operationId: input.operationId, step: input.step } },
      });
      if (existing) {
        if (
          existing.id !== id ||
          existing.actionId !== input.actionId ||
          existing.requestHash !== requestHash ||
          existing.cancelSafe !== input.cancelSafe
        ) {
          throw new ConflictException('Agent job idempotency conflict');
        }
        return existing;
      }
      return tx.agentJob.create({
        data: {
          id,
          operationId: input.operationId,
          actionId: input.actionId,
          step: input.step,
          requestHash,
          cancelSafe: input.cancelSafe,
          deadlineAt: input.deadlineAt,
        },
      });
    });

    return {
      id: job.id,
      operationId: job.operationId,
      actionId: job.actionId,
      step: job.step,
      requestHash: job.requestHash,
      state: job.state,
      deadlineAt: job.deadlineAt,
      cancelSafe: job.cancelSafe,
      payload: input.payload,
    };
  }

  async recordStarted(started: AgentJobStarted): Promise<void> {
    const job = await this.prisma.agentJob.findUnique({ where: { id: started.jobId } });
    if (!job || job.operationId !== started.operationId) {
      throw new NotFoundException('Agent job not found');
    }
    if (!started.success) {
      await this.prisma.agentJob.update({
        where: { id: job.id },
        data: {
          state: 'FAILED',
          agentBootId: started.bootId,
          errorMessage: safeErrorMessage(started.error || 'Agent rejected job').slice(0, 4096),
          completedAt: new Date(),
        },
      });
      return;
    }
    if (TERMINAL_JOB_STATES.has(job.state)) return;
    if (job.agentBootId && job.agentBootId !== started.bootId) {
      throw new ConflictException('Agent job boot identity changed');
    }
    await this.prisma.agentJob.updateMany({
      where: {
        id: job.id,
        agentBootId: started.bootId,
        state: { in: ['STARTING', 'RUNNING'] },
      },
      data: {
        state: 'RUNNING',
        startedAt: job.startedAt || new Date(),
        heartbeatAt: new Date(),
      },
    });
  }

  async bindToBoot(jobId: string, bootId: string): Promise<void> {
    const updated = await this.prisma.agentJob.updateMany({
      where: {
        id: jobId,
        state: 'STARTING',
        OR: [{ agentBootId: null }, { agentBootId: bootId }],
      },
      data: { agentBootId: bootId },
    });
    if (updated.count === 1) return;
    const job = await this.prisma.agentJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Agent job not found');
    if (job.agentBootId !== bootId && !TERMINAL_JOB_STATES.has(job.state)) {
      throw new ConflictException('Agent job is bound to another agent boot');
    }
  }

  async recordHeartbeat(heartbeat: AgentJobHeartbeat): Promise<boolean> {
    const result = await this.prisma.agentJob.updateMany({
      where: {
        id: heartbeat.jobId,
        operationId: heartbeat.operationId,
        agentBootId: heartbeat.bootId,
        state: { in: ['STARTING', 'RUNNING', 'CANCEL_REQUESTED'] },
        sequence: { lt: heartbeat.sequence },
      },
      data: {
        sequence: heartbeat.sequence,
        progress: heartbeat.progress,
        currentStep: heartbeat.step,
        heartbeatAt: new Date(heartbeat.timestamp),
      },
    });
    return result.count === 1;
  }

  async recordResult(result: AgentJobResult): Promise<boolean> {
    assertNoSecretFields(result.result, 'agentJob.result');
    const resultJson = stableJson(result.result);
    if (Buffer.byteLength(resultJson, 'utf8') > MAX_JOB_RESULT_BYTES) {
      throw new BadRequestException('Agent job result exceeds 1 MiB');
    }
    const state = result.cancelled
      ? 'CANCELLED'
      : result.success
        ? 'SUCCEEDED'
        : 'FAILED';
    const updated = await this.prisma.agentJob.updateMany({
      where: {
        id: result.jobId,
        operationId: result.operationId,
        agentBootId: result.bootId,
        state: { in: ['STARTING', 'RUNNING', 'CANCEL_REQUESTED'] },
        sequence: { lt: result.sequence },
      },
      data: {
        state,
        sequence: result.sequence,
        progress: result.success ? 100 : undefined,
        result: result.success ? resultJson : null,
        errorMessage: result.error ? safeErrorMessage(result.error).slice(0, 4096) : null,
        cancelOutcome: result.cancelled ? 'CANCELLED' : null,
        heartbeatAt: new Date(result.timestamp),
        completedAt: new Date(result.timestamp),
      },
    });
    return updated.count === 1;
  }

  async recordStatus(status: AgentJobStatus): Promise<void> {
    if (!status.success) return;
    if (status.state === 'SUCCEEDED' || status.state === 'FAILED' || status.state === 'CANCELLED') {
      await this.recordResult({
        jobId: status.jobId,
        operationId: status.operationId,
        bootId: status.bootId,
        sequence: status.sequence,
        success: status.state === 'SUCCEEDED',
        cancelled: status.state === 'CANCELLED',
        result: status.state === 'SUCCEEDED' ? status.result : null,
        error: status.error,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    if (status.state === 'NEEDS_ATTENTION') {
      await this.prisma.agentJob.updateMany({
        where: {
          id: status.jobId,
          operationId: status.operationId,
          agentBootId: status.bootId,
          state: { in: ['STARTING', 'RUNNING', 'CANCEL_REQUESTED'] },
        },
        data: {
          state: 'NEEDS_ATTENTION',
          errorMessage: safeErrorMessage(status.error || 'Agent reported unknown outcome').slice(0, 4096),
          completedAt: new Date(),
        },
      });
      return;
    }
    await this.prisma.agentJob.updateMany({
      where: {
        id: status.jobId,
        operationId: status.operationId,
        agentBootId: status.bootId,
        state: { in: ['STARTING', 'RUNNING', 'CANCEL_REQUESTED'] },
        sequence: { lte: status.sequence },
      },
      data: {
        state: status.state === 'CANCEL_REQUESTED' ? 'CANCEL_REQUESTED' : 'RUNNING',
        sequence: status.sequence,
        progress: status.progress,
        currentStep: status.step,
        heartbeatAt: new Date(),
      },
    });
  }

  async requestCancel(jobId: string): Promise<'REQUESTED' | 'NOT_CANCELLABLE' | 'ALREADY_TERMINAL'> {
    return this.prisma.$transaction(async (tx) => {
      const job = await tx.agentJob.findUnique({ where: { id: jobId } });
      if (!job) throw new NotFoundException('Agent job not found');
      if (TERMINAL_JOB_STATES.has(job.state)) return 'ALREADY_TERMINAL';
      if (!job.cancelSafe) {
        await tx.agentJob.update({
          where: { id: job.id },
          data: { cancelOutcome: 'NOT_CANCELLABLE' },
        });
        return 'NOT_CANCELLABLE';
      }
      await tx.agentJob.update({
        where: { id: job.id },
        data: {
          state: 'CANCEL_REQUESTED',
          cancelRequestedAt: job.cancelRequestedAt || new Date(),
          cancelOutcome: 'REQUESTED',
        },
      });
      return 'REQUESTED';
    });
  }

  async recordCancelOutcome(
    jobId: string,
    outcome: string,
  ): Promise<void> {
    await this.prisma.agentJob.update({
      where: { id: jobId },
      data: { cancelOutcome: outcome.slice(0, 128) },
    });
  }

  async markInterruptedByNewBoot(bootId: string): Promise<number> {
    const updated = await this.prisma.agentJob.updateMany({
      where: {
        agentBootId: { not: null },
        NOT: { agentBootId: bootId },
        state: { in: ['RUNNING', 'CANCEL_REQUESTED'] },
      },
      data: {
        state: 'NEEDS_ATTENTION',
        errorMessage: 'Agent restarted while job outcome was unknown',
        completedAt: new Date(),
      },
    });
    return updated.count;
  }

  async markDeadlineUnknown(jobId: string): Promise<void> {
    await this.prisma.agentJob.updateMany({
      where: {
        id: jobId,
        state: { in: ['STARTING', 'RUNNING', 'CANCEL_REQUESTED'] },
      },
      data: {
        state: 'NEEDS_ATTENTION',
        errorMessage: 'Agent job deadline elapsed with unknown outcome',
        completedAt: new Date(),
      },
    });
  }

  async get(jobId: string) {
    const job = await this.prisma.agentJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Agent job not found');
    return {
      id: job.id,
      operationId: job.operationId,
      actionId: job.actionId,
      step: job.step,
      state: job.state,
      agentBootId: job.agentBootId,
      sequence: job.sequence,
      progress: job.progress,
      currentStep: job.currentStep,
      cancelSafe: job.cancelSafe,
      cancelRequestedAt: job.cancelRequestedAt,
      cancelOutcome: job.cancelOutcome,
      result: parseStoredResult(job.result),
      error: job.errorMessage,
      deadlineAt: job.deadlineAt,
      startedAt: job.startedAt,
      heartbeatAt: job.heartbeatAt,
      completedAt: job.completedAt,
    };
  }
}
