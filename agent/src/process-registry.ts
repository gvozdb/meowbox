/**
 * ChildProcessRegistry — учёт всех долгоживущих spawned-процессов.
 *
 * Зачем:
 * - При graceful shutdown агента (SIGTERM от PM2 при reload/restart/OOM)
 *   мы должны убить все запущенные restic'и, иначе они становятся
 *   осиротевшими процессами (PPID=1) и дальше дампят впустую — без
 *   получателя stdout. Сценарий из реального бага: агент упал по OOM →
 *   restic продолжал писать в закрытый pipe → застрял зомби (PID 1826002).
 *
 * - При нормальном завершении хендлера процесс снимается с учёта.
 *
 * Использование:
 *   const proc = spawn(...);
 *   const handle = registry.track(proc, 'restic-dump');
 *   try { ... } finally { handle.untrack(); }
 *
 * При shutdown:
 *   registry.killAll(); // SIGTERM всем + 5s grace + SIGKILL остаткам
 */
import type { ChildProcess } from 'child_process';

interface TrackedProcess {
  proc: ChildProcess;
  label: string;
  startedAt: number;
}

class ChildProcessRegistry {
  private readonly tracked = new Map<number, TrackedProcess>();
  private nextId = 1;

  track(proc: ChildProcess, label: string): { untrack: () => void } {
    if (!proc.pid) {
      // Если spawn не дал PID (редкий случай ENOENT), регистрировать нечего.
      return { untrack: () => {} };
    }
    const id = this.nextId++;
    this.tracked.set(id, { proc, label, startedAt: Date.now() });

    // Авто-снятие с учёта при exit/error — иначе на длительной работе
    // агента Map будет распухать от завершившихся процессов.
    const cleanup = () => this.tracked.delete(id);
    proc.once('exit', cleanup);
    proc.once('error', cleanup);

    return { untrack: cleanup };
  }

  list(): Array<{ pid: number; label: string; ageSec: number }> {
    const out: Array<{ pid: number; label: string; ageSec: number }> = [];
    for (const t of this.tracked.values()) {
      if (t.proc.pid) {
        out.push({
          pid: t.proc.pid,
          label: t.label,
          ageSec: Math.round((Date.now() - t.startedAt) / 1000),
        });
      }
    }
    return out;
  }

  /**
   * Убивает всех учтённых детей. Сначала SIGTERM (мягко), затем,
   * если процесс не умер за graceMs, — SIGKILL.
   *
   * Возвращает promise, который резолвится после grace-периода
   * (но не блокирует на SIGKILL — он fire-and-forget).
   */
  async killAll(graceMs = 5000): Promise<void> {
    if (this.tracked.size === 0) return;

    const procs: Array<{ pid: number; label: string; proc: ChildProcess }> = [];
    for (const t of this.tracked.values()) {
      if (t.proc.pid && !t.proc.killed) {
        procs.push({ pid: t.proc.pid, label: t.label, proc: t.proc });
      }
    }
    if (procs.length === 0) return;

    console.log(
      `[ProcessRegistry] killing ${procs.length} child process(es): ` +
        procs.map((p) => `${p.label}(pid=${p.pid})`).join(', '),
    );

    // SIGTERM всем
    for (const { proc, pid, label } of procs) {
      try {
        proc.kill('SIGTERM');
      } catch (e) {
        console.warn(
          `[ProcessRegistry] SIGTERM ${label}(pid=${pid}) failed: ${(e as Error).message}`,
        );
      }
    }

    // Ждём grace, потом SIGKILL остаткам
    await new Promise((r) => setTimeout(r, graceMs));

    for (const { proc, pid, label } of procs) {
      // proc.killed выставляется при отправке сигнала, но сам процесс
      // мог проигнорировать SIGTERM и продолжать работать. Проверим
      // живой ли он через kill(0).
      let stillAlive = false;
      try {
        process.kill(pid, 0);
        stillAlive = true;
      } catch {
        stillAlive = false;
      }
      if (stillAlive) {
        console.warn(
          `[ProcessRegistry] ${label}(pid=${pid}) survived SIGTERM, sending SIGKILL`,
        );
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
  }
}

export const childProcessRegistry = new ChildProcessRegistry();
