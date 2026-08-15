import { spawn, type ChildProcess } from 'node:child_process';
import * as fsp from 'node:fs/promises';

const RUNNER_PID_WAIT_MS = 5_000;
const RUNNER_PID_POLL_MS = 25;

// PM2 kills the full child process tree by default. The short-lived launcher
// exits immediately after it starts this new session, so the real updater is
// reparented before the updater itself reaches the quiesce stage.
const LAUNCHER_SCRIPT = [
  'set -eu',
  'pid_file="$1"',
  'log_file="$2"',
  'runner_script="$3"',
  'shift 3',
  'setsid -- bash -c "$runner_script" meowbox-update-runner "$pid_file" "$@" </dev/null >>"$log_file" 2>&1 &',
].join('\n');

const RUNNER_SCRIPT = [
  'set -eu',
  'pid_file="$1"',
  'shift',
  'temporary="${pid_file}.tmp-$$"',
  'umask 077',
  'printf "%s\\n" "$$" > "$temporary"',
  'mv -f -- "$temporary" "$pid_file"',
  'exec "$@"',
].join('\n');

export interface UpdateRunnerOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly logFilePath: string;
  readonly pidFilePath: string;
}

export async function launchReparentedUpdateRunner(options: UpdateRunnerOptions): Promise<number> {
  await fsp.unlink(options.pidFilePath).catch(() => undefined);

  const launcher = spawn(
    'bash',
    [
      '-c',
      LAUNCHER_SCRIPT,
      'meowbox-update-launcher',
      options.pidFilePath,
      options.logFilePath,
      RUNNER_SCRIPT,
      options.command,
      ...options.args,
    ],
    {
      cwd: options.cwd,
      env: options.env,
      stdio: 'ignore',
    },
  );

  const [pid] = await Promise.all([
    waitForRunnerPid(options.pidFilePath),
    waitForSuccessfulExit(launcher),
  ]);
  return pid;
}

async function waitForRunnerPid(pidFilePath: string): Promise<number> {
  const deadline = Date.now() + RUNNER_PID_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const raw = await fsp.readFile(pidFilePath, 'utf8');
      const pid = Number(raw.trim());
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {
      // The reparented runner has not written its pid yet.
    }
    await new Promise((resolve) => setTimeout(resolve, RUNNER_PID_POLL_MS));
  }
  throw new Error('update runner did not publish its pid');
}

function waitForSuccessfulExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`update launcher exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`));
    });
  });
}
