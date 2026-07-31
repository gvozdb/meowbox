#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  parseHookArguments,
  requiredAbsolutePath,
} from './hooks/cli';
import {
  assertPathInsideRelease,
  fetchReleaseHealth,
  readPm2Process,
} from './hooks/release-health';
import { safeErrorMessage } from './release/redaction';

type ReleaseHealthFetcher = typeof fetchReleaseHealth;

export async function waitForAgentConnection(
  database: string,
  timeoutMs = 30_000,
  fetcher: ReleaseHealthFetcher = fetchReleaseHealth,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    const remaining = Math.max(1_000, deadline - Date.now());
    const health = await fetcher(database, Math.min(5_000, remaining));
    if (health.agentConnected) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error('candidate agent did not connect to API before timeout');
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const arguments_ = parseHookArguments(argv, true);
    if (arguments_.command !== 'check' && arguments_.command !== 'verify') {
      throw new Error('agent health command must be check or verify');
    }
    const releaseDirectory = requiredAbsolutePath(arguments_, 'release-dir');
    const database = requiredAbsolutePath(arguments_, 'database');
    const agent = await readPm2Process('meowbox-agent');
    if (agent.status !== 'online') throw new Error(`meowbox-agent is ${agent.status}`);

    if (arguments_.command === 'verify') {
      const entrypoint = path.join(releaseDirectory, 'agent', 'dist', 'main.js');
      const metadata = await fs.stat(entrypoint);
      if (!metadata.isFile()) throw new Error('candidate agent entrypoint is missing');
      await assertPathInsideRelease(agent.cwd, releaseDirectory, 'meowbox-agent cwd');
      await assertPathInsideRelease(agent.executable, releaseDirectory, 'meowbox-agent executable');
      await waitForAgentConnection(database);
    }

    process.stdout.write(`[agent-health] ${arguments_.command} passed\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`[agent-health] ${safeErrorMessage(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
