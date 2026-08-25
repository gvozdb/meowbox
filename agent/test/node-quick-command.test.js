'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  QUICK_COMMAND_OUTPUT_MAX_BYTES,
} = require('@meowbox/shared');
const { NodeAppManager } = require('../src/node/node-app.manager');

test('T-OPS-004 quick-command output is redacted, bounded, and does not double-buffer', async () => {
  const manager = new NodeAppManager();
  manager.assertWithinHome = () => '/tmp';
  let options;
  manager.executor = {
    executeStreaming: async (_command, _args, value) => {
      options = value;
      value.onLine('password=should-not-persist', 'stdout');
      for (let index = 0; index < 6_000; index += 1) {
        value.onLine(`line-${index}-${'x'.repeat(180)}`, 'stdout');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };

  const result = await manager.runQuickCommand('fixture', 'npm', 'build', '/tmp');
  assert.equal(options.discardOutputBuffer, true);
  assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(result.output, 'utf8') <= QUICK_COMMAND_OUTPUT_MAX_BYTES, true);
  assert.doesNotMatch(result.output, /should-not-persist/);
  assert.match(result.output, /password=\[REDACTED\]/);
});
