'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertOperationTransition,
  assertFederatedWebhookRawLength,
  FEDERATED_WEBHOOK_MAX_ENCODED_BYTES,
  intersectFederationProtocol,
  toBrowserRemoteContext,
  validateFederatedOperation,
  validateFederatedWebhookDelivery,
  validateFederatedWebhookDeliveryResult,
  validateFederatedWsChannelAssertion,
  validateFederatedWsEnvelope,
  validateFederationError,
  validateSignedFederationManifest,
  validateOperationAccepted,
  validatePublicDelivery,
  validateRemoteContext,
  validateSignedFederatedVpnFragment,
} = require('../dist');

const SERVER_ID = '11111111-2222-4333-8444-555555555555';
const TARGET_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const REQUEST_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const OPERATION_ID = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
const CHANNEL_ID = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb';
const NOW = '2026-08-24T16:00:00.000Z';
const LATER = '2026-08-24T16:01:00.000Z';

function state(value, reasonCode = 'READY') {
  return { state: value, reasonCode, observedAt: NOW, freshUntil: LATER };
}

function remoteContext() {
  return {
    serverId: SERVER_ID,
    targetInstallationId: TARGET_ID,
    displayName: 'Fixture target',
    registryGeneration: 2,
    contextEpoch: 7,
    endpoints: {
      apiOrigin: 'https://api.target.test',
      apiPath: '/api',
      wsOrigin: 'https://ws.target.test',
      socketPath: '/socket.io',
      browserPublicOrigin: 'https://panel.target.test',
      directTransferOrigin: 'https://transfer.target.test',
      sshHost: 'target.test',
      sshPort: 2222,
    },
    productVersion: 'v0.8.0',
    protocol: {
      mode: 'v1-read-only',
      selected: 1,
      target: { min: 1, max: 1 },
      acceptedMaster: { min: 1, max: 1 },
    },
    manifest: { schemaVersion: 1, revision: 'fixture-r1', validUntil: LATER },
    capabilities: {
      'sites.list': {
        actionId: 'sites.list',
        schemaVersion: 1,
        enabled: true,
        roles: ['ADMIN', 'MANAGER'],
        permissions: ['sites.read'],
        requestMedia: ['application/json'],
        responseMedia: ['application/json'],
        executionMode: 'INTERACTIVE',
        idempotency: 'NOT_DECLARED',
        cancellation: 'UNSUPPORTED',
        connectMs: 5000,
        headersMs: 15000,
        idleMs: 30000,
        operationMs: 30000,
        legacySafe: false,
      },
    },
    status: {
      transport: state('ONLINE'),
      trust: state('ACTIVE'),
      capability: state('FRESH'),
      browser: state('REACHABLE'),
    },
    topologyMode: 'PUBLIC',
    killSwitches: { http: false, ws: true, publicDelivery: true, legacy: true },
  };
}

function deliveryBase() {
  return {
    purpose: 'DOWNLOAD',
    targetInstallationId: TARGET_ID,
    resource: { kind: 'BACKUP_EXPORT', id: OPERATION_ID },
    method: 'GET',
    allowedHeaders: ['range'],
    cachePolicy: 'NO_STORE',
    referrerPolicy: 'NO_REFERRER',
    expiresAt: LATER,
    browserReachabilityRequired: true,
    rangeSupported: true,
    resumeSupported: true,
    fallbackReason: null,
  };
}

function operation() {
  return {
    operationId: OPERATION_ID,
    targetInstallationId: TARGET_ID,
    state: 'RUNNING',
    progress: 50,
    attempt: 1,
    policy: {
      actionId: 'backups.export',
      schemaVersion: 1,
      actorKind: 'OPERATOR',
      issuerId: SERVER_ID,
      subject: 'master-user:42',
      role: 'MANAGER',
      permissions: ['backups.export'],
      idempotencyId: 'export-request-42',
      requestId: REQUEST_ID,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
    },
    leaseOwner: 'api:fixture-boot:worker-1',
    leaseExpiresAt: LATER,
    heartbeatAt: NOW,
    deadlineAt: '2026-08-24T17:00:00.000Z',
    cancelRequestedAt: null,
    cancelOutcome: 'NOT_REQUESTED',
    result: { inlineJson: null, artifactId: null },
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
  };
}

test('T-SIG-001 RemoteContext is strict and browser projection omits control origins', () => {
  const context = validateRemoteContext(remoteContext());
  const browser = toBrowserRemoteContext(context);
  assert.equal(browser.browserPublicOrigin, 'https://panel.target.test');
  assert.equal(browser.sshPort, 2222);
  assert.equal(Object.hasOwn(browser, 'endpoints'), false);
  assert.equal(JSON.stringify(browser).includes('api.target.test'), false);
  assert.throws(() => validateRemoteContext({ ...remoteContext(), secretKey: 'forbidden' }));
  assert.throws(() => validateRemoteContext({
    ...remoteContext(),
    capabilities: {
      'sites.list': { ...remoteContext().capabilities['sites.list'], executionMode: 'UNKNOWN_REQUIRES_CHARACTERIZATION' },
    },
  }));
});

test('manifest protocol compatibility chooses highest exact intersection', () => {
  assert.deepEqual(
    intersectFederationProtocol({ min: 1, max: 3 }, { min: 1, max: 2 }, { min: 2, max: 4 }),
    { compatible: true, selectedProtocol: 2, reasonCode: 'READY' },
  );
  assert.deepEqual(
    intersectFederationProtocol({ min: 1, max: 1 }, { min: 2, max: 2 }, { min: 1, max: 3 }),
    { compatible: false, selectedProtocol: null, reasonCode: 'PROTOCOL_INCOMPATIBLE' },
  );
});

test('signed manifest contract binds endpoints, capabilities and bounded validity', () => {
  const manifest = {
    schemaVersion: 1,
    revision: 'a'.repeat(64),
    catalogueSha256: 'b'.repeat(64),
    installationId: TARGET_ID,
    installationRole: 'TARGET',
    protocolMode: 'v1-read-only',
    productVersion: 'v0.8.0',
    protocol: { min: 1, max: 1 },
    acceptedMasterProtocol: { min: 1, max: 1 },
    endpointState: 'READY',
    endpoints: {
      apiOrigin: 'https://api.target.test',
      apiPath: '/api',
      wsOrigin: 'https://ws.target.test',
      socketPath: '/socket.io',
      browserPublicOrigin: 'https://panel.target.test',
      directTransferOrigin: 'https://transfer.target.test',
    },
    actions: remoteContext().capabilities,
    generatedAt: NOW,
    validUntil: LATER,
    signature: {
      algorithm: 'Ed25519',
      kid: 'ed25519-abcdefghijklmnopqrstuv',
      value: 'a'.repeat(86),
    },
  };
  assert.equal(validateSignedFederationManifest(manifest).endpointState, 'READY');
  assert.throws(() => validateSignedFederationManifest({
    ...manifest,
    endpoints: { ...manifest.endpoints, apiOrigin: 'http://api.target.test' },
  }));
  assert.throws(() => validateSignedFederationManifest({
    ...manifest,
    validUntil: '2026-08-24T16:10:00.000Z',
  }), /validity window/);
});

test('public delivery distinguishes generated streams from staged artifacts', () => {
  const staged = validatePublicDelivery({
    ...deliveryBase(),
    kind: 'TransferSession',
    reusable: true,
    url: 'https://transfer.target.test/api/public/v1/transfers/token',
    transferMode: 'STAGED_ARTIFACT',
    contentLength: 1048576,
    sha256: 'a'.repeat(64),
    leaseId: SERVER_ID,
  });
  assert.equal(staged.transferMode, 'STAGED_ARTIFACT');

  assert.throws(() => validatePublicDelivery({
    ...deliveryBase(),
    kind: 'TransferSession',
    reusable: false,
    url: 'https://transfer.target.test/api/public/v1/transfers/token',
    transferMode: 'GENERATED_STREAM',
    contentLength: 1048576,
    sha256: 'a'.repeat(64),
    leaseId: SERVER_ID,
  }), /Generated stream/);

  const upload = validatePublicDelivery({
    ...deliveryBase(),
    kind: 'TransferSession',
    purpose: 'UPLOAD',
    method: 'PUT',
    allowedHeaders: ['content-type'],
    reusable: false,
    rangeSupported: false,
    resumeSupported: false,
    url: 'https://transfer.target.test/api/public/v1/transfers/token/upload',
    transferMode: 'STAGED_ARTIFACT',
    contentLength: 1024,
    sha256: null,
    leaseId: SERVER_ID,
  });
  assert.equal(upload.purpose, 'UPLOAD');
  assert.throws(() => validatePublicDelivery({
    ...upload,
    reusable: true,
  }), /Upload session/);
});

test('T-VPN-001 signed VPN fragment is strict and bounded', () => {
  const fragment = {
    schemaVersion: 1,
    targetInstallationId: TARGET_ID,
    sourceId: SERVER_ID,
    epoch: 'a'.repeat(64),
    issuedAt: NOW,
    expiresAt: LATER,
    entries: [{ fingerprint: 'b'.repeat(64), content: 'vless://fixture' }],
    signature: {
      algorithm: 'Ed25519',
      kid: 'ed25519-abcdefghijklmnopqrstuv',
      value: 'c'.repeat(86),
    },
  };
  assert.equal(validateSignedFederatedVpnFragment(fragment).entries.length, 1);
  assert.throws(() => validateSignedFederatedVpnFragment({
    ...fragment,
    entries: [{ fingerprint: 'b'.repeat(64), content: 'bad\u0000value' }],
  }));
  assert.throws(() => validateSignedFederatedVpnFragment({
    ...fragment,
    entries: Array.from({ length: 257 }, (_, index) => ({
      fingerprint: index.toString(16).padStart(64, '0'),
      content: `entry-${index}`,
    })),
  }));
});

test('operation envelope enforces recovery, terminal, and transition contracts', () => {
  assert.equal(validateFederatedOperation(operation()).state, 'RUNNING');
  assert.doesNotThrow(() => assertOperationTransition('RUNNING', 'NEEDS_ATTENTION'));
  assert.throws(() => assertOperationTransition('RUNNING', 'QUEUED'));
  assert.throws(() => validateFederatedOperation({
    ...operation(),
    state: 'SUCCEEDED',
    completedAt: null,
  }), /completedAt/);
  assert.equal(validateOperationAccepted({
    operationId: OPERATION_ID,
    requestId: REQUEST_ID,
    state: 'QUEUED',
    statusPath: `/api/operations/${OPERATION_ID}`,
    retryAfterSeconds: 2,
  }).state, 'QUEUED');
});

test('WS channel and event envelopes bind epoch, sequence, action, and payload budget', () => {
  const assertion = validateFederatedWsChannelAssertion({
    channelId: CHANNEL_ID,
    targetInstallationId: TARGET_ID,
    epoch: 2,
    nonce: 'abcdefghijklmnopqrstuvwx',
    actionIds: ['logs.subscribe'],
    issuedAt: NOW,
    expiresAt: '2026-08-24T16:00:30.000Z',
    assertion: 'a'.repeat(64),
    signature: 'a'.repeat(86),
  });
  assert.equal(assertion.epoch, 2);
  const envelope = validateFederatedWsEnvelope({
    channelId: CHANNEL_ID,
    epoch: 2,
    sequence: 8,
    actionId: 'logs.subscribe',
    correlationId: REQUEST_ID,
    event: 'site:logs:subscribe',
    kind: 'EVENT',
    payload: { siteId: SERVER_ID, logType: 'error' },
  });
  assert.equal(envelope.sequence, 8);
  assert.throws(() => validateFederatedWsEnvelope({ ...envelope, payload: 'x'.repeat(300000) }), /256 KiB/);
});

test('federation error contract is bounded and correlated', () => {
  assert.equal(validateFederationError({
    code: 'REMOTE_CONNECT_TIMEOUT',
    message: 'Target connection timed out',
    requestId: REQUEST_ID,
    targetInstallationId: TARGET_ID,
    actionId: 'sites.list',
    retryable: true,
    retryAfterSeconds: 5,
    targetStatus: null,
  }).retryable, true);
});

test('T-WEB-001 webhook delivery contract binds exact bounded provider bytes', () => {
  const delivery = {
    schemaVersion: 1,
    deliveryId: REQUEST_ID,
    routeId: SERVER_ID,
    targetInstallationId: TARGET_ID,
    siteId: OPERATION_ID,
    domainId: CHANNEL_ID,
    domain: 'app.example.test',
    provider: 'GITHUB',
    providerDeliveryId: 'provider-delivery-1',
    event: 'push',
    receivedAt: NOW,
    rawBodyBase64: Buffer.from('{"ref":"refs/heads/main"}').toString('base64url'),
    rawBodySha256: 'a'.repeat(64),
    providerSignature: `sha256=${'b'.repeat(64)}`,
  };
  assert.equal(validateFederatedWebhookDelivery(delivery).provider, 'GITHUB');
  assert.equal(assertFederatedWebhookRawLength(delivery.rawBodyBase64), 25);
  assert.throws(() => validateFederatedWebhookDelivery({
    ...delivery,
    rawBodyBase64: 'a'.repeat(FEDERATED_WEBHOOK_MAX_ENCODED_BYTES + 1),
  }));
  assert.equal(validateFederatedWebhookDeliveryResult({
    schemaVersion: 1,
    deliveryId: REQUEST_ID,
    status: 'DELIVERED',
    deployId: OPERATION_ID,
    duplicate: false,
  }).status, 'DELIVERED');
});
