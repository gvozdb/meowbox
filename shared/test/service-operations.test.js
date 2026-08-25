'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  SERVICE_AGENT_JOB_ACTIONS,
  SERVICE_OPERATION_ACTIONS,
  resolveServiceAgentCall,
  serviceAgentActionForOperation,
} = require('../dist/service-operations');

const site = {
  id: '11111111-2222-4333-8444-555555555555',
  name: 'example.test',
  systemUser: 'example_test',
  rootPath: '/var/www/example.test',
};

test('T-OPS-004 service action map resolves only allowlisted concrete RPC events', () => {
  assert.equal(
    serviceAgentActionForOperation(SERVICE_OPERATION_ACTIONS.SERVER_INSTALL),
    SERVICE_AGENT_JOB_ACTIONS.SERVER_INSTALL,
  );
  assert.deepEqual(
    resolveServiceAgentCall(SERVICE_AGENT_JOB_ACTIONS.SERVER_INSTALL, {
      serviceKey: 'redis',
    }),
    { event: 'redis:server-install', payload: {} },
  );
  assert.deepEqual(
    resolveServiceAgentCall(SERVICE_AGENT_JOB_ACTIONS.SITE_ENABLE, {
      serviceKey: 'manticore',
      site,
      config: { memoryMaxMb: 256 },
    }),
    {
      event: 'manticore:site-enable',
      payload: {
        siteName: 'example.test',
        systemUser: 'example_test',
        rootPath: '/var/www/example.test',
        memoryMaxMb: 256,
      },
    },
  );
});

test('T-OPS-005 service job routing fails closed on arbitrary events and invalid scope', () => {
  assert.throws(
    () => serviceAgentActionForOperation('services.server.shell'),
    /not supported/,
  );
  assert.throws(
    () => resolveServiceAgentCall(SERVICE_AGENT_JOB_ACTIONS.SERVER_UNINSTALL, {
      serviceKey: 'ssh',
    }),
    /not allowed/,
  );
  assert.throws(
    () => resolveServiceAgentCall(SERVICE_AGENT_JOB_ACTIONS.SITE_START, {
      serviceKey: 'minio',
      site,
    }),
    /not allowed/,
  );
  assert.throws(
    () => resolveServiceAgentCall(SERVICE_AGENT_JOB_ACTIONS.SITE_ENABLE, {
      serviceKey: 'redis',
      site,
      config: { memoryMaxMb: 999999 },
    }),
    /memory limit/,
  );
  assert.throws(
    () => resolveServiceAgentCall(SERVICE_AGENT_JOB_ACTIONS.SERVER_INSTALL, {
      serviceKey: 'redis',
      event: 'terminal:open',
    }),
    /invalid fields/,
  );
});
