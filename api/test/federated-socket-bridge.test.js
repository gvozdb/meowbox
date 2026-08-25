'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { FederationActionCatalogueService } = require('../src/federation/federation-action-catalogue.service');
const { FederatedSocketPolicyService } = require('../src/federation/federated-socket-policy.ts');
const { FederatedSocketBridgeService } = require('../src/gateway/federated-socket-bridge.service');

class Browser extends EventEmitter {
  constructor() {
    super();
    this.id = 'browser-1';
  }
}

function fixture(t) {
  const policy = new FederatedSocketPolicyService(new FederationActionCatalogueService());
  const bridge = new FederatedSocketBridgeService({}, policy);
  bridge.connect = async () => {};
  const browser = new Browser();
  t.after(() => bridge.detach(browser.id));
  return { policy, bridge, browser };
}

test('T-WS-001 pre-ready side effects NACK while safe subscriptions queue bounded state', async (t) => {
  const { bridge, browser } = fixture(t);
  await bridge.attach(browser, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', {
    id: 'operator-1', role: 'ADMIN',
  }, '203.0.113.7');

  let terminalResult;
  browser.emit('terminal:open', {}, (value) => { terminalResult = value; });
  assert.equal(terminalResult.code, 'REMOTE_NOT_READY');

  let subscriptionResult;
  browser.emit('php:install:subscribe', { version: '8.4' }, (value) => {
    subscriptionResult = value;
  });
  assert.deepEqual(subscriptionResult, { accepted: true, queued: true });
  const session = bridge.sessions.get(browser.id);
  assert.equal(session.subscriptions.size, 1);
});

test('T-WS-004 command/ack correlation is sequence- and epoch-bound', async (t) => {
  const { policy, bridge, browser } = fixture(t);
  await bridge.attach(browser, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', {
    id: 'operator-1', role: 'ADMIN',
  }, '203.0.113.7');
  const session = bridge.sessions.get(browser.id);
  const emitted = [];
  session.state = 'READY';
  session.epoch = 7;
  session.allowedActionIds = new Set(policy.actionsForRole('ADMIN').map((action) => action.actionId));
  session.upstream = {
    connected: true,
    __meowboxFederationChannelId: randomUUID(),
    emit: (event, value) => { emitted.push({ event, value }); },
    removeAllListeners: () => {},
    disconnect: () => {},
  };

  let result;
  browser.emit('terminal:open', {}, (value) => { result = value; });
  assert.equal(emitted.length, 1);
  const command = emitted[0].value;
  assert.equal(command.sequence, 1);
  bridge.handleUpstreamMessage(session, {
    channelId: command.channelId,
    epoch: 7,
    sequence: 1,
    actionId: command.actionId,
    correlationId: command.correlationId,
    event: command.event,
    kind: 'ACK',
    payload: {
      acceptedSequence: 1,
      outcome: 'COMPLETED',
      code: null,
      message: null,
      result: { sessionId: 'terminal-1' },
    },
  });
  assert.deepEqual(result, { sessionId: 'terminal-1' });
});

test('T-WS-004 stale epoch closes bridge instead of replaying a mutation', async (t) => {
  const { policy, bridge, browser } = fixture(t);
  await bridge.attach(browser, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', {
    id: 'operator-1', role: 'ADMIN',
  }, '203.0.113.7');
  const session = bridge.sessions.get(browser.id);
  session.state = 'READY';
  session.epoch = 2;
  session.allowedActionIds = new Set(policy.actionsForRole('ADMIN').map((action) => action.actionId));
  session.upstream = {
    connected: true,
    __meowboxFederationChannelId: randomUUID(),
    emit: () => {}, removeAllListeners: () => {}, disconnect: () => {},
  };
  bridge.handleUpstreamMessage(session, {
    channelId: session.upstream.__meowboxFederationChannelId,
    epoch: 1,
    sequence: 1,
    actionId: 'ws.browser-notification.system-metrics',
    correlationId: randomUUID(),
    event: 'system:metrics',
    kind: 'EVENT',
    payload: {},
  });
  assert.equal(bridge.sessions.has(browser.id), false);
});

test('T-WS-006 reconnect replays only explicit subscriptions and enforces backpressure', async (t) => {
  const { policy, bridge, browser } = fixture(t);
  await bridge.attach(browser, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', {
    id: 'operator-1', role: 'ADMIN',
  }, '203.0.113.7');
  browser.emit('php:install:subscribe', { version: '8.4' });
  const session = bridge.sessions.get(browser.id);
  const emitted = [];
  session.state = 'READY';
  session.epoch = 4;
  session.allowedActionIds = new Set(policy.actionsForRole('ADMIN').map((action) => action.actionId));
  session.upstream = {
    connected: true,
    __meowboxFederationChannelId: randomUUID(),
    emit: (event, value) => emitted.push({ event, value }),
    removeAllListeners: () => {}, disconnect: () => {},
  };
  bridge.replaySubscriptions(session);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].value.event, 'php:install:subscribe');

  session.pendingBytes = 1024 * 1024;
  let result;
  browser.emit('terminal:open', {}, (value) => { result = value; });
  assert.equal(result.code, 'REMOTE_BACKPRESSURE');
  assert.equal(session.state, 'DEGRADED');
});

test('T-WS-002 bridge has no arbitrary onAny or insecure TLS fallback', () => {
  for (const file of [
    '../src/gateway/agent.gateway.ts',
    '../src/gateway/federated-socket-bridge.service.ts',
    '../src/federation/federation-socket-dialer.ts',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.doesNotMatch(source, /\.onAny\s*\(/, file);
    assert.doesNotMatch(source, /rejectUnauthorized\s*:\s*false/, file);
  }
});
