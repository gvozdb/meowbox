'use strict';

// Regeneration is intentionally source-only. It never boots Nest, connects to
// an agent, or touches runtime state; the checked-in matrix remains the CI
// contract and this script is merely a review aid when source changes.

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  discoverCurrentSurface,
  matrixDocumentFromSurface,
} = require('../test/remote-panel-parity-inventory');

const checkOnly = process.argv.includes('--check');
if (process.argv.slice(2).some((argument) => argument !== '--check')) {
  throw new Error('Usage: generate-federation-action-matrix.cjs [--check]');
}

const repositoryRoot = path.resolve(__dirname, '..', '..');
const outputPath = path.join(
  repositoryRoot,
  'specs',
  'remote-panel-parity',
  'action-matrix.yaml',
);
const compiledOutputPath = path.join(
  repositoryRoot,
  'api',
  'src',
  'federation',
  'action-catalogue.generated.json',
);
const browserRoutesOutputPath = path.join(
  repositoryRoot,
  'web',
  'generated',
  'federation-http-actions.json',
);
const overridesPath = path.join(
  repositoryRoot,
  'specs',
  'remote-panel-parity',
  'action-overrides.json',
);
const socketPolicyPath = path.join(
  repositoryRoot,
  'api',
  'src',
  'federation',
  'federated-socket-policy.json',
);

const socketPolicy = JSON.parse(fs.readFileSync(socketPolicyPath, 'utf8'));
if (
  socketPolicy.schemaVersion !== 'meowbox.federated-socket-policy/v1' ||
  !Array.isArray(socketPolicy.browserToApi) ||
  !Array.isArray(socketPolicy.apiToBrowser)
) throw new Error('Federated Socket.IO policy document is invalid');

const socketPolicyBySourceKey = new Map();
for (const [collection, channel, direction] of [
  [socketPolicy.browserToApi, 'browser-command', 'browser_to_api'],
  [socketPolicy.apiToBrowser, 'browser-notification', 'api_to_browser'],
]) {
  for (const entry of collection) {
    const keys = Object.keys(entry).sort().join(',');
    const expectedKeys = channel === 'browser-command'
      ? 'event,readiness,roles'
      : 'event,roles';
    if (
      keys !== expectedKeys ||
      typeof entry.event !== 'string' ||
      !/^[a-z][a-z0-9]*(?::[a-z0-9_-]+)+$/.test(entry.event) ||
      !Array.isArray(entry.roles) ||
      entry.roles.length === 0 ||
      new Set(entry.roles).size !== entry.roles.length ||
      entry.roles.some((role) => !['ADMIN', 'MANAGER'].includes(role)) ||
      (channel === 'browser-command' &&
        !['REQUIRE_READY', 'QUEUE_SUBSCRIPTION'].includes(entry.readiness))
    ) throw new Error(`Invalid federated Socket.IO policy entry: ${channel}/${String(entry.event)}`);
    const sourceKey = `socketio|${channel}|${entry.event}`;
    if (socketPolicyBySourceKey.has(sourceKey)) {
      throw new Error(`Duplicate federated Socket.IO policy entry: ${sourceKey}`);
    }
    socketPolicyBySourceKey.set(sourceKey, { ...entry, channel, direction });
  }
}

const expandAction = (document, entry) => {
  const profile = entry.profile === undefined
    ? {}
    : document.profiles?.[entry.profile];
  if (profile === undefined) throw new Error(`Unknown action profile: ${entry.profile}`);
  const expanded = { ...profile, ...entry };
  delete expanded.profile;
  return expanded;
};

const baseDocument = matrixDocumentFromSurface(discoverCurrentSurface());
const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
if (
  Object.keys(overrides).sort().join(',') !== 'actions,reviewedJsonMutations,reviewedJsonReads,schemaVersion' ||
  overrides.schemaVersion !== 'meowbox.remote-panel-parity.action-overrides/v1' ||
  typeof overrides.actions !== 'object' ||
  overrides.actions === null ||
  Array.isArray(overrides.actions)
) throw new Error('Federation action overrides document is invalid');
const reviewedJsonReads = overrides.reviewedJsonReads;
if (
  !reviewedJsonReads ||
  Object.keys(reviewedJsonReads).sort().join(',') !== 'actionIds,evidence,sourceSetSha256' ||
  !/^[0-9a-f]{64}$/.test(reviewedJsonReads.sourceSetSha256) ||
  typeof reviewedJsonReads.evidence !== 'string' ||
  reviewedJsonReads.evidence.trim().length === 0 ||
  !Array.isArray(reviewedJsonReads.actionIds) ||
  reviewedJsonReads.actionIds.length === 0 ||
  reviewedJsonReads.actionIds.some((actionId) => typeof actionId !== 'string') ||
  new Set(reviewedJsonReads.actionIds).size !== reviewedJsonReads.actionIds.length ||
  [...reviewedJsonReads.actionIds].sort().some((actionId, index) => actionId !== reviewedJsonReads.actionIds[index])
) throw new Error('Reviewed federation JSON read set is invalid');

const reviewedJsonMutations = overrides.reviewedJsonMutations;
if (
  !reviewedJsonMutations ||
  Object.keys(reviewedJsonMutations).sort().join(',') !== 'actionIds,evidence,sourceSetSha256' ||
  !/^[0-9a-f]{64}$/.test(reviewedJsonMutations.sourceSetSha256) ||
  typeof reviewedJsonMutations.evidence !== 'string' ||
  reviewedJsonMutations.evidence.trim().length === 0 ||
  !Array.isArray(reviewedJsonMutations.actionIds) ||
  reviewedJsonMutations.actionIds.length === 0 ||
  reviewedJsonMutations.actionIds.some((actionId) => typeof actionId !== 'string') ||
  new Set(reviewedJsonMutations.actionIds).size !== reviewedJsonMutations.actionIds.length ||
  [...reviewedJsonMutations.actionIds].sort().some((actionId, index) => actionId !== reviewedJsonMutations.actionIds[index])
) throw new Error('Reviewed federation JSON mutation set is invalid');

const baseActionById = new Map(baseDocument.actions.map((action) => [action.actionId, action]));
const reviewedReadById = new Map();
for (const actionId of reviewedJsonReads.actionIds) {
  const action = baseActionById.get(actionId);
  if (
    !action ||
    action.owner !== 'target' ||
    action.transport.kind !== 'http' ||
    action.transport.method !== 'GET' ||
    action.execution.mode !== 'INTERACTIVE' ||
    action.request.media.length !== 1 ||
    action.request.media[0] !== 'application/json' ||
    action.response.media.length !== 1 ||
    action.response.media[0] !== 'application/json' ||
    action.legacy.remoteActivation !== 'DENY' ||
    Object.prototype.hasOwnProperty.call(overrides.actions, actionId)
  ) throw new Error(`Invalid or stale reviewed federation JSON read: ${actionId}`);
  const roles = action.authorization.roles.includes('AUTHENTICATED_ANY')
    ? ['ADMIN', 'MANAGER', 'VIEWER']
    : [...action.authorization.roles];
  if (
    roles.length === 0 ||
    roles.some((role) => !['ADMIN', 'MANAGER', 'VIEWER'].includes(role))
  ) throw new Error(`Reviewed federation JSON read has unsafe roles: ${actionId}`);
  reviewedReadById.set(actionId, { action, roles });
}
const reviewedReadSourceHash = createHash('sha256')
  .update([...reviewedReadById.values()].map(({ action, roles }) =>
    [action.actionId, action.sourceKey, roles].join('\0')).join('\n'))
  .digest('hex');
if (reviewedReadSourceHash !== reviewedJsonReads.sourceSetSha256) {
  throw new Error('Reviewed federation JSON read source set drifted');
}

const reviewedMutationById = new Map();
for (const actionId of reviewedJsonMutations.actionIds) {
  const action = baseActionById.get(actionId);
  if (
    !action ||
    action.owner !== 'target' ||
    action.transport.kind !== 'http' ||
    !['POST', 'PUT', 'PATCH', 'DELETE'].includes(action.transport.method) ||
    action.execution.mode !== 'INTERACTIVE' ||
    action.request.media.length !== 1 ||
    action.request.media[0] !== 'application/json' ||
    action.response.media.length !== 1 ||
    action.response.media[0] !== 'application/json' ||
    action.legacy.remoteActivation !== 'DENY' ||
    Object.prototype.hasOwnProperty.call(overrides.actions, actionId) ||
    reviewedReadById.has(actionId)
  ) throw new Error(`Invalid or stale reviewed federation JSON mutation: ${actionId}`);
  const roles = action.authorization.roles.includes('AUTHENTICATED_ANY')
    ? ['ADMIN', 'MANAGER']
    : [...action.authorization.roles];
  if (
    roles.length === 0 ||
    roles.some((role) => !['ADMIN', 'MANAGER'].includes(role))
  ) throw new Error(`Reviewed federation JSON mutation has unsafe roles: ${actionId}`);
  reviewedMutationById.set(actionId, { action, roles });
}
const reviewedMutationSourceHash = createHash('sha256')
  .update([...reviewedMutationById.values()].map(({ action, roles }) =>
    [action.actionId, action.sourceKey, roles].join('\0')).join('\n'))
  .digest('hex');
if (reviewedMutationSourceHash !== reviewedJsonMutations.sourceSetSha256) {
  throw new Error('Reviewed federation JSON mutation source set drifted');
}
const remainingOverrides = new Set(Object.keys(overrides.actions));
const document = {
  ...baseDocument,
  actions: baseDocument.actions.map((action) => {
    const reviewedRead = reviewedReadById.get(action.actionId);
    if (reviewedRead) {
      return {
        ...action,
        authorization: { ...action.authorization, roles: reviewedRead.roles },
        legacy: {
          behavior: `FEDERATION_V1_REVIEWED: ${reviewedJsonReads.evidence}`,
          remoteActivation: 'ALLOW',
        },
      };
    }
    const reviewedMutation = reviewedMutationById.get(action.actionId);
    if (reviewedMutation) {
      return {
        ...action,
        authorization: { ...action.authorization, roles: reviewedMutation.roles },
        idempotency: {
          policy: 'DECLARED',
          currentBehavior: 'FEDERATION_TRANSPORT_AT_MOST_ONCE_ADMISSION',
        },
        legacy: {
          behavior: `FEDERATION_V1_REVIEWED: ${reviewedJsonMutations.evidence}`,
          remoteActivation: 'ALLOW',
        },
      };
    }
    const override = overrides.actions[action.actionId];
    if (override === undefined) return action;
    remainingOverrides.delete(action.actionId);
    if (
      typeof override !== 'object' ||
      override === null ||
      override.sourceKey !== action.sourceKey ||
      override.remoteActivation !== 'ALLOW' ||
      typeof override.evidence !== 'string' ||
      override.evidence.trim().length === 0 ||
      action.owner !== 'target'
    ) throw new Error(`Invalid or stale federation action override: ${action.actionId}`);
    const socketPolicyEntry = action.transport.kind === 'socket.io'
      ? socketPolicyBySourceKey.get(action.sourceKey)
      : undefined;
    if (action.transport.kind === 'socket.io' && !socketPolicyEntry) {
      throw new Error(`Activated Socket.IO action is absent from policy: ${action.actionId}`);
    }
    if (
      socketPolicyEntry &&
      (socketPolicyEntry.channel !== action.transport.channel ||
        socketPolicyEntry.direction !== action.transport.direction)
    ) throw new Error(`Federated Socket.IO policy binding mismatch: ${action.actionId}`);
    if (socketPolicyEntry) socketPolicyBySourceKey.delete(action.sourceKey);
    return {
      ...action,
      authorization: socketPolicyEntry
        ? { ...action.authorization, roles: socketPolicyEntry.roles }
        : action.authorization,
      legacy: {
        behavior: `FEDERATION_V1_REVIEWED: ${override.evidence}`,
        remoteActivation: 'ALLOW',
      },
    };
  }),
};
if (remainingOverrides.size > 0) {
  throw new Error(`Stale federation action overrides: ${[...remainingOverrides].sort().join(', ')}`);
}
if (socketPolicyBySourceKey.size > 0) {
  throw new Error(`Federated Socket.IO policy lacks activation overrides: ${[...socketPolicyBySourceKey.keys()].sort().join(', ')}`);
}
const matrixBytes = `${JSON.stringify(document, null, 2)}\n`;
const compiled = {
  schemaVersion: document.schemaVersion,
  matrixSha256: createHash('sha256').update(matrixBytes).digest('hex'),
  actions: document.actions
    .map((entry) => expandAction(document, entry))
    .filter((entry) => entry.legacy.remoteActivation === 'ALLOW'),
};
const compiledBytes = `${JSON.stringify(compiled, null, 2)}\n`;
const browserRoutesBytes = `${JSON.stringify({
  schemaVersion: 'meowbox.browser-federation-http-actions/v1',
  matrixSha256: compiled.matrixSha256,
  actions: compiled.actions
    .filter((entry) =>
      entry.owner === 'target' &&
      entry.transport.kind === 'http' &&
      ['INTERACTIVE', 'OPERATION', 'STAGED_ARTIFACT', 'APP_HANDOFF'].includes(
        entry.execution.mode,
      ))
    .map((entry) => ({
      actionId: entry.actionId,
      method: entry.transport.method,
      routeTemplate: entry.transport.routeTemplate,
    })),
}, null, 2)}\n`;

const outputs = [
  [outputPath, matrixBytes],
  [compiledOutputPath, compiledBytes],
  [browserRoutesOutputPath, browserRoutesBytes],
];
if (checkOnly) {
  for (const [target, expected] of outputs) {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== expected) {
      throw new Error(`Generated federation contract is stale: ${path.relative(repositoryRoot, target)}`);
    }
  }
} else {
  for (const [target, bytes] of outputs) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { encoding: 'utf8', mode: 0o644 });
  }
}
process.stdout.write(
  `${checkOnly ? 'Verified' : 'Wrote'} ${document.actions.length} actions, ${compiled.actions.length} active actions, and ${document.legacyUnsafeFindings.length} denied findings\n`,
);
