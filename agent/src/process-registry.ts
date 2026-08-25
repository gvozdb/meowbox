import type {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  SpawnOptions,
} from 'node:child_process';
import { spawn } from 'node:child_process';
import { currentAgentJobContext } from './job-context';

interface TrackedProcess {
  proc: ChildProcess;
  label: string;
  startedAt: number;
  jobId: string | null;
  cancelSafe: boolean;
  processGroup: boolean;
}

export interface TrackProcessOptions {
  jobId?: string | null;
  cancelSafe?: boolean;
  processGroup?: boolean;
}

export interface TrackedProcessHandle {
  untrack(): void;
  terminate(graceMs?: number): Promise<void>;
}

export interface ProcessCancellationResult {
  outcome: 'CANCELLED' | 'NOT_CANCELLABLE' | 'NOT_FOUND';
  count: number;
}

export class ChildProcessRegistry {
  private readonly tracked = new Map<number, TrackedProcess>();
  private nextId = 1;

  track(
    proc: ChildProcess,
    label: string,
    options: TrackProcessOptions = {},
  ): TrackedProcessHandle {
    if (!proc.pid) {
      return { untrack: () => {}, terminate: async () => {} };
    }
    const context = currentAgentJobContext();
    const id = this.nextId++;
    const tracked: TrackedProcess = {
      proc,
      label: label.slice(0, 128),
      startedAt: Date.now(),
      jobId: options.jobId === undefined ? context?.jobId || null : options.jobId,
      cancelSafe: options.cancelSafe === undefined
        ? context?.cancelSafe === true
        : options.cancelSafe,
      processGroup: options.processGroup === true,
    };
    this.tracked.set(id, tracked);
    const cleanup = () => this.tracked.delete(id);
    proc.once('exit', cleanup);
    proc.once('error', cleanup);
    return {
      untrack: cleanup,
      terminate: (graceMs = 5_000) => this.terminateMany([tracked], graceMs),
    };
  }

  list(): Array<{
    pid: number;
    label: string;
    ageSec: number;
    jobId: string | null;
    cancelSafe: boolean;
    processGroup: boolean;
  }> {
    return [...this.tracked.values()]
      .filter((entry) => entry.proc.pid)
      .map((entry) => ({
        pid: entry.proc.pid!,
        label: entry.label,
        ageSec: Math.round((Date.now() - entry.startedAt) / 1000),
        jobId: entry.jobId,
        cancelSafe: entry.cancelSafe,
        processGroup: entry.processGroup,
      }));
  }

  async cancelJob(jobId: string, graceMs = 5_000): Promise<ProcessCancellationResult> {
    const matches = [...this.tracked.values()].filter((entry) => entry.jobId === jobId);
    if (matches.length === 0) return { outcome: 'NOT_FOUND', count: 0 };
    if (matches.some((entry) => !entry.cancelSafe)) {
      return { outcome: 'NOT_CANCELLABLE', count: matches.length };
    }
    await this.terminateMany(matches, graceMs);
    return { outcome: 'CANCELLED', count: matches.length };
  }

  async killAll(graceMs = 5_000): Promise<void> {
    await this.terminateMany([...this.tracked.values()], graceMs);
  }

  private async terminateMany(entries: TrackedProcess[], graceMs: number): Promise<void> {
    const live = entries.filter((entry) => this.isAlive(entry));
    if (live.length === 0) return;
    for (const entry of live) this.signal(entry, 'SIGTERM');
    await Promise.race([
      Promise.all(live.map((entry) => this.waitForExit(entry))),
      new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
    ]);
    for (const entry of live) {
      if (this.isAlive(entry)) this.signal(entry, 'SIGKILL');
    }
  }

  private signal(entry: TrackedProcess, signal: NodeJS.Signals): void {
    if (!entry.proc.pid) return;
    try {
      if (entry.processGroup) process.kill(-entry.proc.pid, signal);
      else entry.proc.kill(signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') {
        console.warn(
          `[ProcessRegistry] ${signal} ${entry.label}(pid=${entry.proc.pid}) failed: ${(error as Error).message}`,
        );
      }
    }
  }

  private isAlive(entry: TrackedProcess): boolean {
    if (!entry.proc.pid) return false;
    try {
      process.kill(entry.processGroup ? -entry.proc.pid : entry.proc.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private waitForExit(entry: TrackedProcess): Promise<void> {
    if (!this.isAlive(entry)) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => resolve();
      entry.proc.once('exit', done);
      entry.proc.once('error', done);
    });
  }
}

export const childProcessRegistry = new ChildProcessRegistry();

export function spawnOwned(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  label: string,
  trackOptions: Omit<TrackProcessOptions, 'processGroup'> = {},
): ChildProcessWithoutNullStreams {
  const proc = spawn(command, [...args], { ...options, detached: true });
  childProcessRegistry.track(proc, label, {
    ...trackOptions,
    processGroup: true,
  });
  return proc as ChildProcessWithoutNullStreams;
}
