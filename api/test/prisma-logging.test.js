'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { resolvePrismaLogLevels } = require('../src/common/prisma-logging');

test('Prisma query logging is disabled unless explicitly enabled', () => {
  assert.deepEqual(resolvePrismaLogLevels('false'), ['error']);
  assert.deepEqual(resolvePrismaLogLevels(' true '), ['query', 'error', 'warn']);
  assert.deepEqual(resolvePrismaLogLevels('unexpected'), ['error']);
});
