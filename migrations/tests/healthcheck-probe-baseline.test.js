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
