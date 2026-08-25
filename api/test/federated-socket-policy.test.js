'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { FederationActionCatalogueService } = require('../src/federation/federation-action-catalogue.service');
const { FederatedSocketPolicyService } = require('../src/federation/federated-socket-policy.ts');

function policy() {
  return new FederatedSocketPolicyService(new FederationActionCatalogueService());
}

test('T-WS-002 runtime policy exactly matches active catalogue roles', () => {
  const value = policy();
  assert.equal(value.allCommands().length, 13);
  assert.equal(value.allNotifications().length, 20);
  assert.deepEqual(value.commandForEvent('ai:start', 'MANAGER').roles, ['ADMIN', 'MANAGER']);
  assert.equal(value.commandForEvent('terminal:open', 'MANAGER'), undefined);
  assert.equal(value.actionsForRole('VIEWER').length, 0);
  assert.equal(value.actionById('ws.browser-command.unknown'), undefined);
});

test('T-WS-002 payload validators deny unknown and malformed commands', () => {
  const value = policy();
  const terminal = value.commandForEvent('terminal:resize', 'ADMIN');
  const ai = value.commandForEvent('ai:start', 'MANAGER');
  assert.doesNotThrow(() => value.validatePayload(terminal, {
    sessionId: 'session-1', cols: 120, rows: 40,
  }));
  assert.throws(() => value.validatePayload(terminal, {
    sessionId: 'session-1', cols: 0, rows: 40,
  }), /cols/);
  assert.throws(() => value.validatePayload(ai, { prompt: '' }), /prompt/);
});

test('T-WS-002 notification discriminants and ownership events are validated', () => {
  const value = policy();
  const ai = value.notificationForEvent('ai:text', 'MANAGER');
  const terminal = value.notificationForEvent('terminal:data', 'ADMIN');
  assert.doesNotThrow(() => value.validatePayload(ai, { type: 'text', text: 'hello' }));
  assert.throws(() => value.validatePayload(ai, { type: 'thinking', text: 'hello' }), /discriminant/);
  assert.doesNotThrow(() => value.validatePayload(terminal, {
    sessionId: 'session-1', data: 'ok',
  }));
  assert.equal(value.notificationForEvent('terminal:data', 'MANAGER'), undefined);
});
