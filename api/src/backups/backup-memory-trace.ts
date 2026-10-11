import * as fs from 'node:fs';
import * as path from 'node:path';

let timer: NodeJS.Timeout | undefined;
let nextWindow = 0;
type MemorySample = ReturnType<typeof process.memoryUsage> & { at: string };
interface MemoryWindow { pid: number; samples: MemorySample[] }

function previousPeak(file: string): MemoryWindow | undefined {
  try {
    if (fs.statSync(file).size > 64 * 1024) return;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const window = value.peak || value;
    if (!Number.isSafeInteger(window.pid) || !Array.isArray(window.samples)) return;
    const samples = window.samples.slice(-24).map((sample: MemorySample) => ({
      at: String(sample.at).slice(0, 30), rss: sample.rss, heapTotal: sample.heapTotal,
      heapUsed: sample.heapUsed, external: sample.external, arrayBuffers: sample.arrayBuffers,
    }));
    if (samples.some((sample: MemorySample) =>
      [sample.rss, sample.heapTotal, sample.heapUsed, sample.external, sample.arrayBuffers]
        .some((value) => !Number.isSafeInteger(value) || value < 0))) return;
    return { pid: window.pid, samples };
  } catch { return; }
}

/** Bounded numeric evidence: current window and the highest RSS window survive restarts. */
export function traceBackupMemory(): void {
  if (timer || Date.now() < nextWindow) return;
  nextWindow = Date.now() + 10 * 60_000;
  const samples: MemorySample[] = [];
  const file = path.join(process.env.MEOWBOX_STATE_DIR || '/opt/meowbox/state', 'data', 'backup-memory.json');
  let peak = previousPeak(file);
  let peakRss = Math.max(0, ...(peak?.samples.map((sample) => sample.rss) || []));
  const sample = () => {
    const current = { at: new Date().toISOString(), ...process.memoryUsage() };
    samples.push(current);
    if (current.rss >= peakRss) {
      peakRss = current.rss;
      peak = { pid: process.pid, samples: [...samples] };
    }
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ pid: process.pid, samples, peak }), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch (error) {
      console.warn(`Backup memory trace unavailable: ${(error as NodeJS.ErrnoException).code}`);
      clearInterval(timer); timer = undefined;
      return;
    }
    if (samples.length >= 24) { clearInterval(timer); timer = undefined; }
  };
  timer = setInterval(sample, 5000);
  timer.unref();
  sample();
}
