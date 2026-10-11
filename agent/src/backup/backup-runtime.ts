import * as fs from 'fs';
import * as path from 'path';

export type CompletionEvent = 'backup:complete' | 'server-path:complete' | 'panel-data:complete';
export interface BackupResult {
  backupId: string;
  success: boolean;
  filePath?: string;
  snapshotId?: string;
  sizeBytes?: number;
  error?: string;
}
interface Receipt { event: CompletionEvent; result?: BackupResult }

const MAX_RECEIPTS = 128;
const MAX_BYTES = 512 * 1024;
function textLimit(value: string | undefined): string | undefined {
  return typeof value === 'string' ? Buffer.from(value).subarray(0, 1000).toString('utf8') : undefined;
}

/** One producer at a time; only bounded, credential-free receipts reach disk. */
export class BackupRuntime {
  private receipts: Record<string, Receipt> = {};
  private tasks = new Map<string, Promise<void>>();
  private tail: Promise<void> = Promise.resolve();
  private delivering = false;
  private initialized = false;
  private exclusivePending = 0;

  constructor(private readonly directory: string) {}

  private initialize(): void {
    if (this.initialized) return;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, 'receipts.json');
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size > MAX_BYTES) throw new Error('Backup receipt journal exceeds its limit');
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Object.keys(parsed).length > MAX_RECEIPTS) {
        throw new Error('Invalid backup receipt journal');
      }
      this.receipts = parsed;
      for (const [id, receipt] of Object.entries(this.receipts)) {
        if (!receipt || typeof receipt !== 'object' || !/^[a-zA-Z0-9-]{1,80}$/.test(id) || !['backup:complete', 'server-path:complete', 'panel-data:complete'].includes(receipt.event)) {
          throw new Error('Invalid backup receipt event');
        }
        if (receipt.result && (receipt.result.backupId !== id || typeof receipt.result.success !== 'boolean')) {
          throw new Error('Invalid backup receipt result');
        }
        if (!receipt.result) receipt.result = {
          backupId: id, success: false,
          error: 'Agent restarted before backup completion was confirmed; repository reconciliation is required',
        };
      }
    }
    this.save();
    this.initialized = true;
  }

  private save(): void {
    const contents = JSON.stringify(this.receipts);
    if (Buffer.byteLength(contents) > MAX_BYTES) throw new Error('Backup receipt journal is full');
    const temporary = path.join(this.directory, 'receipts.tmp');
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, path.join(this.directory, 'receipts.json'));
    const dir = fs.openSync(this.directory, 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }

  run(id: string, event: CompletionEvent, task: () => Promise<void>): Promise<void> {
    this.initialize();
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('Invalid backup ID');
    const existing = this.tasks.get(id);
    if (existing) return existing;
    if (Object.prototype.hasOwnProperty.call(this.receipts, id)) {
      return Promise.resolve();
    }
    if (Object.keys(this.receipts).length >= MAX_RECEIPTS) {
      throw new Error('Backup queue/receipt journal is full; waiting for API acknowledgements');
    }
    this.receipts[id] = { event };
    try { this.save(); } catch (error) { delete this.receipts[id]; throw error; }
    const work = this.tail.then(async () => {
      try {
        await task();
        if (!this.receipts[id]?.result) throw new Error('Backup handler did not produce a result');
      } catch (error) {
        if (!this.receipts[id]?.result) this.complete(event, {
          backupId: id, success: false, error: (error as Error).message,
        });
        throw error;
      }
    });
    this.tasks.set(id, work);
    this.tail = work.catch(() => {}).finally(() => { this.tasks.delete(id); });
    return work;
  }

  complete(event: CompletionEvent, raw: BackupResult): void {
    this.initialize();
    if (!this.receipts[raw.backupId]) throw new Error('Backup completion has no reserved receipt');
    this.receipts[raw.backupId] = { event, result: {
      backupId: raw.backupId,
      success: raw.success === true,
      filePath: textLimit(raw.filePath),
      snapshotId: raw.snapshotId?.slice(0, 64),
      sizeBytes: Number.isSafeInteger(raw.sizeBytes) ? raw.sizeBytes : undefined,
      error: textLimit(raw.error),
    } };
    this.save();
  }

  activity(): string[] { this.initialize(); return Object.keys(this.receipts); }

  exclusive<T>(task: () => Promise<T>, requireIdle = false): Promise<T> {
    if (requireIdle && (this.activity().length > 0 || this.exclusivePending > 0)) {
      return Promise.reject(new Error('Backup agent is busy; maintenance must be retried later'));
    }
    if (this.exclusivePending >= 8) return Promise.reject(new Error('Backup maintenance queue is full'));
    this.exclusivePending++;
    const work = this.tail.then(task).finally(() => { this.exclusivePending--; });
    this.tail = work.then(() => {}, () => {});
    return work;
  }

  async deliver(send: (event: CompletionEvent, result: BackupResult) => Promise<boolean>): Promise<void> {
    this.initialize();
    if (this.delivering) return;
    this.delivering = true;
    try {
      for (const [id, receipt] of Object.entries(this.receipts)) {
        if (!receipt.result || this.tasks.has(id)) continue;
        if (!await send(receipt.event, receipt.result)) break;
        delete this.receipts[id];
        try { this.save(); } catch (error) { this.receipts[id] = receipt; throw error; }
      }
    } finally { this.delivering = false; }
  }
}
