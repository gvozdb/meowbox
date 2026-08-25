'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PrismaClient } = require('@prisma/client');
const masterKey = require('../src/common/crypto/master-key');
const { PanelSettingsService } = require('../src/panel-settings/panel-settings.service');
const { PanelIdentityService } = require('../src/federation/panel-identity.service');
const { FederationActionCatalogueService } = require('../src/federation/federation-action-catalogue.service');
const { FederationLocalEndpointService } = require('../src/federation/federation-local-endpoint.service');
const { FederationManifestService } = require('../src/federation/federation-manifest.service');
const { OperationsService } = require('../src/operations/operations.service');
const { OperationAdmissionService } = require('../src/operations/operation-admission.service');
const { OperationsWorkerService } = require('../src/operations/operations-worker.service');
const { PanelAccessCutoverTargetService } = require('../src/panel-access/panel-access-cutover-target.service');

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-panel-access-'));
  const databaseUrl = `file:${path.join(root, 'fixture.db')}`;
  execFileSync(path.resolve(__dirname, '../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });
  const previousMasterKey = process.env.MEOWBOX_MASTER_KEY;
  process.env.MEOWBOX_MASTER_KEY = crypto.randomBytes(32).toString('base64');
  masterKey._resetMasterKeyCacheForTests();
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const user = await prisma.user.create({
    data: {
      username: `panel-access-${crypto.randomUUID()}`,
      email: `panel-access-${crypto.randomUUID()}@example.test`,
      passwordHash: 'not-used',
      identityKind: 'LOCAL',
      role: 'ADMIN',
    },
  });
  const configValues = {
    MEOWBOX_INSTALLATION_ROLE: 'TARGET',
    MEOWBOX_VERSION: 'v0.7.35',
    FEDERATION_PROTOCOL_MODE: 'v1-enabled',
    FEDERATION_API_ORIGIN: 'https://old.target.test',
    FEDERATION_WS_ORIGIN: 'https://old.target.test',
    FEDERATION_BROWSER_PUBLIC_ORIGIN: 'https://old.target.test',
    FEDERATION_DIRECT_TRANSFER_ORIGIN: 'https://old.target.test',
    FEDERATION_WS_PATH: '/socket.io',
  };
  const config = {
    get: (key, fallback) => Object.hasOwn(configValues, key) ? configValues[key] : fallback,
  };
  const identity = new PanelIdentityService(prisma, config);
  const localEndpoint = new FederationLocalEndpointService(config);
  const manifests = new FederationManifestService(
    identity,
    config,
    new FederationActionCatalogueService(),
    localEndpoint,
  );
  const settings = new PanelSettingsService(prisma);
  const previousSettings = {
    domain: 'old.target.test',
    certMode: 'LE',
    httpsRedirect: true,
    denyIpAccess: true,
    certIssuedAt: '2026-08-01T00:00:00.000Z',
    certExpiresAt: '2026-11-01T00:00:00.000Z',
    certPath: '/fixture/old/fullchain.pem',
    keyPath: '/fixture/old/privkey.pem',
    leLastError: null,
    leEmail: 'ops@example.test',
  };
  await settings.set('panel-access', previousSettings);
  let agentState = 'STAGED';
  let finalizeCalls = 0;
  const agent = {
    runAgentJob: async ({ payload }) => ({
      cutoverId: payload.cutoverId,
      state: 'STAGED',
      candidateOrigin: 'https://new.target.test',
      spkiSha256: `sha256/${Buffer.alloc(32, 7).toString('base64')}`,
      candidateSettings: {
        domain: 'new.target.test',
        certMode: 'LE',
        httpsRedirect: payload.httpsRedirect,
        denyIpAccess: payload.denyIpAccess,
        certIssuedAt: '2026-08-25T08:00:00.000Z',
        certExpiresAt: '2026-11-23T08:00:00.000Z',
        certPath: '/fixture/new/fullchain.pem',
        keyPath: '/fixture/new/privkey.pem',
        leLastError: null,
        leEmail: payload.email,
      },
    }),
    emitToAgent: async (event) => {
      if (event === 'panel-access:finalize-cutover') {
        finalizeCalls += 1;
        agentState = 'FINALIZED';
        if (options.loseFinalizeAck && finalizeCalls === 1) {
          return { success: false, error: 'fixture lost acknowledgement' };
        }
        return { success: true };
      }
      if (event === 'panel-access:rollback-cutover') {
        agentState = 'ROLLED_BACK';
        return { success: true };
      }
      if (event === 'panel-access:cutover-status') {
        return {
          success: true,
          state: agentState,
          candidateOrigin: 'https://new.target.test',
        };
      }
      throw new Error(`Unexpected agent event ${event}`);
    },
  };
  const operations = new OperationsService(prisma);
  const worker = new OperationsWorkerService(operations);
  const admission = new OperationAdmissionService(operations, identity);
  const service = new PanelAccessCutoverTargetService(
    prisma,
    settings,
    agent,
    admission,
    worker,
    localEndpoint,
    manifests,
  );
  service.onModuleInit();
  t.after(async () => {
    service.onModuleDestroy();
    worker.onModuleDestroy();
    await prisma.$disconnect();
    if (previousMasterKey === undefined) delete process.env.MEOWBOX_MASTER_KEY;
    else process.env.MEOWBOX_MASTER_KEY = previousMasterKey;
    masterKey._resetMasterKeyCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { prisma, service, settings, user, worker, previousSettings };
}

async function stageCandidate(state, cutoverId) {
  const ticket = await state.service.start(
    {
      cutoverId,
      domain: 'new.target.test',
      email: 'ops@example.test',
      httpsRedirect: true,
      denyIpAccess: true,
      deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    },
    { userId: state.user.id, role: 'ADMIN' },
    `panel-access-stage-${cutoverId}`,
  );
  await state.worker.pollOnce();
  const deadline = Date.now() + 3_000;
  let operation;
  do {
    operation = await state.prisma.operation.findUnique({ where: { id: ticket.operationId } });
    if (operation?.status === 'SUCCEEDED') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.equal(
    operation.status,
    'SUCCEEDED',
    JSON.stringify({
      status: operation.status,
      errorMessage: operation.errorMessage,
      currentStep: operation.currentStep,
      attempt: operation.attempt,
      result: operation.result,
    }),
  );
  return { ticket, staged: await state.service.status(cutoverId) };
}

test('T-PA-001 target stages, finalizes, and rolls back through durable state', async (t) => {
  const state = await fixture(t);
  const cutoverId = '44444444-5555-4666-8777-888888888888';
  const { staged } = await stageCandidate(state, cutoverId);
  assert.equal(staged.state, 'STAGED');
  assert.equal(staged.previousEndpoint.apiOrigin, 'https://old.target.test');
  assert.equal(staged.candidate.endpoints.apiOrigin, 'https://new.target.test');
  assert.equal(staged.candidate.manifest.endpointState, 'READY');

  const finalized = await state.service.finalize(cutoverId);
  assert.equal(finalized.state, 'FINALIZED');
  assert.equal((await state.settings.getPanelAccess()).domain, 'new.target.test');

  const rolledBack = await state.service.rollback(cutoverId);
  assert.equal(rolledBack.state, 'ROLLED_BACK');
  assert.deepEqual(await state.settings.getPanelAccess(), state.previousSettings);
});

test('T-PA-002 lost target finalize acknowledgement reconciles from agent journal', async (t) => {
  const state = await fixture(t, { loseFinalizeAck: true });
  const cutoverId = '55555555-6666-4777-8888-999999999999';
  await stageCandidate(state, cutoverId);
  await assert.rejects(() => state.service.finalize(cutoverId), /lost acknowledgement/);
  assert.equal(
    JSON.parse((await state.prisma.panelSetting.findUnique({ where: { key: 'panel-access-cutover' } })).value).state,
    'NEEDS_ATTENTION',
  );

  const reconciled = await state.service.status(cutoverId);
  assert.equal(reconciled.state, 'FINALIZED');
  assert.equal((await state.settings.getPanelAccess()).domain, 'new.target.test');
});
