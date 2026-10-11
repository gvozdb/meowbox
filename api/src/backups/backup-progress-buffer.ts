/** Progress is replaceable telemetry. Never build a queue of DB promises. */
export class BackupProgressBuffer {
  private readonly pending = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private draining = false;

  constructor(
    private readonly persist: (id: string, progress: number) => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly intervalMs = 2000,
  ) {}

  push(id: string, progress: number): void {
    if (typeof id !== 'string' || id.length > 80 || !Number.isFinite(progress)) return;
    if (!this.pending.has(id) && this.pending.size >= 128) return;
    this.pending.set(id, Math.max(0, Math.min(100, Math.floor(progress))));
    if (!this.timer && !this.draining) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.intervalMs);
      this.timer.unref();
    }
  }

  discard(id: string): void { this.pending.delete(id); }

  async flush(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    const batch = new Map(this.pending);
    this.pending.clear();
    try {
      for (const [id, progress] of batch) {
        try { await this.persist(id, progress); } catch (error) { this.onError(error); }
      }
    } finally {
      this.draining = false;
      if (this.pending.size && !this.timer) {
        this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.intervalMs);
        this.timer.unref();
      }
    }
  }
}
