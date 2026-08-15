'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createXrayWebPortReservationMigration,
} = require('../dist/system/2026-08-15-002-reserve-web-ports-from-xray');

const SERVICE_ID = '11111111-1111-4111-8111-111111111111';
const UNIT = `meowbox-vpn-xray-${SERVICE_ID}.service`;

function inactiveError() {
  const error = new Error('inactive');
  error.code = 3;
  return error;
}

function makeContext(services, { remainsActive = false, dryRun = false } = {}) {
  const active = new Set(services.map((service) => `meowbox-vpn-xray-${service.id}.service`));
  const enabled = new Set(active);
  const calls = [];
  const updates = [];
  const logs = [];

  return {
    calls,
    updates,
    logs,
    ctx: {
      dryRun,
      log: (message) => logs.push(message),
      prisma: {
        vpnService: {
          findMany: async () => services,
          update: async (input) => {
            updates.push(input);
            return input;
          },
        },
      },
      exec: {
        run: async (cmd, args) => {
          calls.push([cmd, args]);
          if (cmd === 'systemctl' && args[0] === 'disable') {
            if (!remainsActive) {
              active.delete(args[2]);
              enabled.delete(args[2]);
            }
            return { stdout: '', stderr: '' };
          }
          if (cmd === 'systemctl' && args[0] === 'is-active') {
            if (active.has(args[2])) return { stdout: 'active\n', stderr: '' };
            throw inactiveError();
          }
          if (cmd === 'systemctl' && args[0] === 'is-enabled') {
            if (enabled.has(args[2])) return { stdout: 'enabled\n', stderr: '' };
            throw inactiveError();
          }
          return { stdout: '', stderr: '' };
        },
      },
    },
  };
}

test('migration stops a reserved-port Xray service before reloading nginx', async () => {
  const fixture = makeContext([{ id: SERVICE_ID, port: 443, status: 'RUNNING' }]);
  const migration = createXrayWebPortReservationMigration();

  const plan = await migration.plan(fixture.ctx);
  assert.equal(plan.details.serviceCount, 1);
  assert.deepEqual(plan.details.ports, [443]);

  await migration.up(fixture.ctx);

  assert.equal(fixture.updates.length, 1);
  assert.deepEqual(fixture.updates[0].where, { id: SERVICE_ID });
  assert.equal(fixture.updates[0].data.status, 'STOPPED');
  assert.match(fixture.updates[0].data.errorMessage, /зарезервирован.*HTTP\/HTTPS/);
  assert.equal(fixture.calls[0][0], 'systemctl');
  assert.deepEqual(fixture.calls[0][1], ['disable', '--now', UNIT]);
  const nginxTest = fixture.calls.findIndex(([cmd, args]) => cmd === 'nginx' && args[0] === '-t');
  const nginxReload = fixture.calls.findIndex(
    ([cmd, args]) => cmd === 'systemctl' && args[0] === 'reload' && args[1] === 'nginx',
  );
  assert.ok(nginxTest > 0);
  assert.ok(nginxReload > nginxTest);
});

test('migration fails closed when an Xray service remains active', async () => {
  const fixture = makeContext([{ id: SERVICE_ID, port: 443, status: 'RUNNING' }], {
    remainsActive: true,
  });
  const migration = createXrayWebPortReservationMigration();

  await assert.rejects(migration.up(fixture.ctx), /remains active/);
  assert.deepEqual(fixture.updates, []);
  assert.equal(fixture.calls.some(([cmd]) => cmd === 'nginx'), false);
});

test('migration is a no-op when no Xray service uses a web port', async () => {
  const fixture = makeContext([]);
  const migration = createXrayWebPortReservationMigration();

  await migration.up(fixture.ctx);

  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.updates, []);
});
