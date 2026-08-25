'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const test = require('node:test');
const { AGENT_JOB_EVENTS } = require('@meowbox/shared');
const { AgentJobRuntime } = require('../src/agent-job.runtime');

function request(overrides = {}) {
  return {
    protocolVersion: 1,
    jobId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    actionId: 'agent.test.execute',
    step: 'execute',
    requestHash: crypto.randomBytes(32).toString('hex'),
    deadlineAt: new Date(Date.now() + 10_000).toISOString(),
    cancelSafe: true,
    payload: { value: 42 },
    ...overrides,
  };
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

test('T-OPS-004 runtime deduplicates deterministic AgentJob and replays result', async () => {
  const socket = new EventEmitter();
  const runtime = new AgentJobRuntime();
  let executions = 0;
  runtime.registerHandler('agent.test.execute', async (payload, context) => {
    executions += 1;
    context.heartbeat('work', 50);
    return { doubled: payload.value * 2 };
  });
  runtime.attach(socket);

  const input = request();
  const resultEvent = once(socket, AGENT_JOB_EVENTS.RESULT);
  const started = await emitAck(socket, AGENT_JOB_EVENTS.START, input);
  assert.equal(started.success, true);
  assert.equal(started.replayed, false);
  const [result] = await resultEvent;
  assert.equal(result.success, true);
  assert.deepEqual(result.result, { doubled: 84 });

  const replayEvent = once(socket, AGENT_JOB_EVENTS.RESULT);
  const replay = await emitAck(socket, AGENT_JOB_EVENTS.START, input);
  assert.equal(replay.replayed, true);
  assert.equal((await replayEvent)[0].success, true);
  assert.equal(executions, 1);

  const conflict = await emitAck(socket, AGENT_JOB_EVENTS.START, {
    ...input,
    requestHash: crypto.randomBytes(32).toString('hex'),
  });
  assert.equal(conflict.success, false);
  assert.match(conflict.error, /conflict/);
  runtime.detach();
});

test('T-OPS-005 cancellation is explicit and reaches cooperative handler', async () => {
  const socket = new EventEmitter();
  const runtime = new AgentJobRuntime();
  runtime.registerHandler('agent.test.execute', async (_payload, context) => {
    while (!context.isCancellationRequested()) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    context.throwIfCancellationRequested();
  });
  runtime.attach(socket);
  const input = request();
  const resultEvent = once(socket, AGENT_JOB_EVENTS.RESULT);
  await emitAck(socket, AGENT_JOB_EVENTS.START, input);
  const cancel = await emitAck(socket, AGENT_JOB_EVENTS.CANCEL, {
    jobId: input.jobId,
    operationId: input.operationId,
  });
  assert.equal(cancel.outcome, 'REQUESTED');
  const [result] = await resultEvent;
  assert.equal(result.cancelled, true);
  assert.equal(result.success, false);
  runtime.detach();
});
