'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { waitForAgentConnection } = require('../dist/agent-health.js');

test('agent health waits through restart race until API confirms connection', async () => {
  const states = [false, false, true];
  let calls = 0;
  await waitForAgentConnection('/tmp/test.db', 5_000, async () => {
    const agentConnected = states[Math.min(calls, states.length - 1)];
    calls += 1;
    return { agentConnected };
  });
  assert.equal(calls, 3);
});
