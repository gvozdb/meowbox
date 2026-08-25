'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PanelAccessCutoverCoordinatorService,
} = require('../src/panel-access/panel-access-cutover-coordinator.service');

const cutoverId = '11111111-2222-4333-8444-555555555555';
const operationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const requestId = 'ffffffff-1111-4222-8333-444444444444';
const actor = { id: 'operator-1', role: 'ADMIN' };
const endpoints = {
  apiOrigin: 'https://candidate.target.test',
  apiPath: '/api',
  wsOrigin: 'https://candidate.target.test',
  socketPath: '/socket.io',
  browserPublicOrigin: 'https://candidate.target.test',
  directTransferOrigin: 'https://candidate.target.test',
};
const targetCandidate = {
  endpoints,
  spkiSha256: `sha256/${Buffer.alloc(32, 7).toString('base64')}`,
  manifest: {},
};
const endpointRow = {
  generation: 2,
  state: 'CANDIDATE',
  apiOrigin: endpoints.apiOrigin,
  wsOrigin: endpoints.wsOrigin,
  wsPath: endpoints.socketPath,
  browserPublicOrigin: endpoints.browserPublicOrigin,
  directTransferOrigin: endpoints.directTransferOrigin,
  spkiSha256: targetCandidate.spkiSha256,
};

function createService(overrides = {}) {
  const calls = [];
  const prisma = overrides.prisma || {
    remoteEndpointCutover: {},
    remoteOperationLink: {},
    user: {},
  };
  const registry = {
    activateEndpointCutover: async (id) => calls.push(['activate', id]),
    finalizeEndpointCutover: async (id) => calls.push(['finalize', id]),
    rollbackEndpointCutover: async (id, reason) => calls.push(['rollback', id, reason]),
    markEndpointCutoverNeedsAttention: async (id, reason) => calls.push(['attention', id, reason]),
    ...overrides.registry,
  };
  const service = new PanelAccessCutoverCoordinatorService(
    prisma,
    overrides.dispatcher || {},
    overrides.manifests || {},
    overrides.wsIssuer || {},
    registry,
    overrides.operationLinks || {},
  );
  return { service, calls, prisma, registry };
}

function cutover(state = 'STAGED') {
  return {
    id: cutoverId,
    remoteServerId: 'server-1',
    state,
    toGeneration: 2,
    deadlineAt: new Date(Date.now() + 60_000),
    remoteServer: {
      id: 'server-1',
      installationId: '22222222-3333-4444-8555-666666666666',
      activeEndpointGeneration: state === 'STAGED' ? 1 : 2,
      endpoints: [endpointRow],
    },
  };
}

test('T-PA-002 lost finalize acknowledgement preserves activated endpoint as NEEDS_ATTENTION', async () => {
  const { service, calls } = createService();
  service.cutover = async () => cutover();
  service.verifyCandidate = async () => calls.push(['verify']);
  service.view = async () => ({ id: cutoverId });
  service.targetJson = async (_installationId, _actor, _ip, method, suffix) => {
    calls.push(['target', method, suffix]);
    if (method === 'GET') return { candidate: targetCandidate };
    throw new Error('simulated lost acknowledgement');
  };

  await assert.rejects(
    service.confirmBrowser(
      'server-1',
      cutoverId,
      endpoints.browserPublicOrigin,
      actor,
      '203.0.113.10',
      'confirm-cutover-001',
    ),
    /acknowledgement was lost/,
  );
  assert.deepEqual(calls, [
    ['target', 'GET', `/panel-access/federation-cutovers/${cutoverId}`],
    ['verify'],
    ['activate', cutoverId],
    ['target', 'POST', `/panel-access/federation-cutovers/${cutoverId}/finalize`],
    ['attention', cutoverId, 'TARGET_FINALIZE_ACK_LOST'],
  ]);
});

test('T-PA-003 rollback never races a running target stage operation', async () => {
  const prisma = {
    remoteEndpointCutover: {},
    remoteOperationLink: {
      findFirst: async () => ({ targetOperationId: operationId }),
    },
    user: {},
  };
  const { service, calls } = createService({ prisma });
  service.cutover = async () => cutover();
  service.targetJson = async (_installationId, _actor, _ip, method, suffix) => {
    calls.push(['target', method, suffix]);
    if (method === 'GET') {
      return { id: operationId, status: 'RUNNING', result: null, errorMessage: null };
    }
    return { state: 'CANCEL_REQUESTED' };
  };

  await assert.rejects(
    service.rollback(
      'server-1',
      cutoverId,
      actor,
      '203.0.113.10',
      'rollback-cutover-001',
    ),
    /cancellation requested/,
  );
  assert.deepEqual(calls, [
    ['target', 'GET', `/operations/${operationId}`],
    ['target', 'POST', `/operations/${operationId}/cancel`],
    ['attention', cutoverId, 'TARGET_OPERATION_CANCEL_REQUESTED'],
  ]);
});

test('T-PA-002 activated endpoint heals from target FINALIZED journal after lost ack', async () => {
  const prisma = {
    remoteEndpointCutover: {
      findUnique: async () => cutover('NEEDS_ATTENTION'),
    },
    remoteOperationLink: {},
    user: {},
  };
  const { service, calls } = createService({ prisma });
  service.targetJson = async (_installationId, _actor, _ip, method, suffix) => {
    calls.push(['target', method, suffix]);
    return { state: 'FINALIZED' };
  };

  await service.reconcileActivated(cutoverId, actor, '203.0.113.10');
  assert.deepEqual(calls, [
    ['target', 'GET', `/panel-access/federation-cutovers/${cutoverId}`],
    ['finalize', cutoverId],
  ]);
});

test('T-PA-003 expired uncommitted cutover confirms target rollback before registry rollback', async () => {
  const expired = {
    ...cutover('STAGED'),
    deadlineAt: new Date(Date.now() - 1_000),
  };
  const prisma = {
    remoteEndpointCutover: {
      findMany: async () => [expired],
    },
    remoteOperationLink: {
      findFirst: async () => ({
        targetOperationId: operationId,
        masterUserId: 'operator-1',
      }),
    },
    user: {
      findUnique: async () => ({ id: 'operator-1', role: 'ADMIN' }),
    },
  };
  const { service, calls } = createService({ prisma });
  service.targetJson = async (_installationId, _actor, _ip, method, suffix) => {
    calls.push(['target', method, suffix]);
    if (suffix === `/operations/${operationId}`) {
      return { id: operationId, status: 'SUCCEEDED', result: null, errorMessage: null };
    }
    return { state: 'ROLLED_BACK', requestId };
  };

  await service.reconcileExpired();
  assert.deepEqual(calls, [
    ['target', 'GET', `/operations/${operationId}`],
    ['target', 'POST', `/panel-access/federation-cutovers/${cutoverId}/rollback`],
    ['rollback', cutoverId, 'CUTOVER_DEADLINE_EXPIRED'],
  ]);
});
