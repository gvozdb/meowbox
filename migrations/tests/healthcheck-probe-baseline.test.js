'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const test = require('node:test');

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '..', '..');
const healthcheck = path.join(root, 'tools', 'healthcheck.sh');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('healthcheck accepts only an unchanged pre-existing probe failure', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-health-baseline-'));
  const server = http.createServer((request, response) => {
    response.statusCode = request.url === '/broken' ? 500 : 200;
    response.end('test');
  });

  try {
    const port = await listen(server);
    const envFile = path.join(temp, '.env');
    const manifest = path.join(temp, 'manifest.json');
    const baseline = path.join(temp, 'baseline.json');
    const url = `http://127.0.0.1:${port}/broken`;
    fs.writeFileSync(envFile, `API_PORT=${port}\nWEB_PORT=${port}\n`);
    fs.writeFileSync(manifest, JSON.stringify({
      version: 1,
      requiresRuntimeCutover: false,
      artifacts: [],
      httpProbes: [{ url, expectedStatus: [200] }],
    }));
    fs.writeFileSync(baseline, JSON.stringify({
      version: 1,
      probes: [{ url, status: 500 }],
    }));

    const passed = await execFileAsync(
      'bash',
      [healthcheck, '--manifest', manifest, '--probe-baseline', baseline, '--skip-pm2'],
      { env: { ...process.env, MEOWBOX_ENV_FILE: envFile, HEALTHCHECK_TIMEOUT: '2' } },
    );
    assert.match(passed.stdout, /unchanged pre-existing HTTP 500/);

    fs.writeFileSync(baseline, JSON.stringify({
      version: 1,
      probes: [{ url, status: 502 }],
    }));
    await assert.rejects(
      execFileAsync(
        'bash',
        [healthcheck, '--manifest', manifest, '--probe-baseline', baseline, '--skip-pm2'],
        { env: { ...process.env, MEOWBOX_ENV_FILE: envFile, HEALTHCHECK_TIMEOUT: '2' } },
      ),
      (error) => {
        assert.match(`${error.stdout}\n${error.stderr}`, /returned HTTP 500.*baseline 502/);
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('healthcheck accepts an unchanged pre-existing transport failure', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-health-unreachable-baseline-'));
  const healthServer = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.end('test');
  });
  const unavailableServer = http.createServer();

  try {
    const healthPort = await listen(healthServer);
    const unavailablePort = await listen(unavailableServer);
    await new Promise((resolve) => unavailableServer.close(resolve));
    const envFile = path.join(temp, '.env');
    const manifest = path.join(temp, 'manifest.json');
    const baseline = path.join(temp, 'baseline.json');
    const url = `http://127.0.0.1:${unavailablePort}/unreachable`;
    fs.writeFileSync(envFile, `API_PORT=${healthPort}\nWEB_PORT=${healthPort}\n`);
    fs.writeFileSync(manifest, JSON.stringify({
      version: 1,
      requiresRuntimeCutover: false,
      artifacts: [],
      httpProbes: [{ url, expectedStatus: [200] }],
    }));
    fs.writeFileSync(baseline, JSON.stringify({
      version: 1,
      probes: [{ url, status: 0 }],
    }));

    const passed = await execFileAsync(
      'bash',
      [healthcheck, '--manifest', manifest, '--probe-baseline', baseline, '--skip-pm2'],
      { env: { ...process.env, MEOWBOX_ENV_FILE: envFile, HEALTHCHECK_TIMEOUT: '1' } },
    );
    assert.match(passed.stdout, /unchanged pre-existing transport failure/);
  } finally {
    if (unavailableServer.listening) {
      await new Promise((resolve) => unavailableServer.close(resolve));
    }
    await new Promise((resolve) => healthServer.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('healthcheck retries a transient curl transport failure', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-health-retry-'));
  const server = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.end('test');
  });

  try {
    const port = await listen(server);
    const envFile = path.join(temp, '.env');
    const manifest = path.join(temp, 'manifest.json');
    const fakeBin = path.join(temp, 'bin');
    const fakeCurl = path.join(fakeBin, 'curl');
    const attemptFile = path.join(temp, 'flaky-attempted');
    const flakyUrl = `http://127.0.0.1:${port}/flaky`;
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(envFile, `API_PORT=${port}\nWEB_PORT=${port}\n`);
    fs.writeFileSync(manifest, JSON.stringify({
      version: 1,
      requiresRuntimeCutover: false,
      artifacts: [],
      httpProbes: [{ url: flakyUrl, expectedStatus: [200] }],
    }));
    fs.writeFileSync(fakeCurl, `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
if [[ "$url" == "${flakyUrl}" && ! -e "${attemptFile}" ]]; then
  touch "${attemptFile}"
  printf 000
  exit 7
fi
exec /usr/bin/curl "$@"
`, { mode: 0o755 });

    const passed = await execFileAsync(
      'bash',
      [healthcheck, '--manifest', manifest, '--skip-pm2'],
      {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          MEOWBOX_ENV_FILE: envFile,
          HEALTHCHECK_TIMEOUT: '3',
        },
      },
    );
    assert.match(passed.stdout, new RegExp(`probe ${flakyUrl} \\(HTTP 200\\)`));
    assert.equal(fs.existsSync(attemptFile), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
