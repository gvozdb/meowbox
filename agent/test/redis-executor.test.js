'use strict';

const assert = require('node:assert/strict');
const { promises: fs } = require('node:fs');
const test = require('node:test');

const { RedisExecutor } = require('../src/services/redis.executor');

function directoryStat(mode) {
  return {
    mode: 0o040000 | mode,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
}

function commandRecorder(calls) {
  return {
    async execute(command, args, options) {
      calls.push({ command, args, options });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

async function withFsStubs(stubs, run) {
  const originals = {};
  for (const [key, value] of Object.entries(stubs)) {
    originals[key] = fs[key];
    fs[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(originals)) fs[key] = value;
  }
}

test('site enable grants the site user traversal of package Redis parent', { concurrency: false }, async () => {
  const commands = [];
  const chmods = [];
  await withFsStubs({
    lstat: async (file) => {
      assert.equal(file, '/var/lib/redis');
      return directoryStat(0o750);
    },
    chmod: async (...args) => { chmods.push(args); },
    writeFile: async () => {},
    readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  }, async () => {
    await new RedisExecutor(commandRecorder(commands)).siteEnable({
      siteName: 'gh',
      systemUser: 'gh',
      rootPath: '/var/www/gh',
      memoryMaxMb: 128,
    });
  });

  assert.deepEqual(chmods, [['/var/lib/redis', 0o751]]);
  assert.ok(commands.some(({ command, args }) => command === 'systemctl'
    && args.join(' ') === 'enable --now redis@gh.service'));
});

test('site enable leaves an already traversable Redis parent unchanged', { concurrency: false }, async () => {
  const chmods = [];
  await withFsStubs({
    lstat: async () => directoryStat(0o751),
    chmod: async (...args) => { chmods.push(args); },
    writeFile: async () => {},
    readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  }, async () => {
    await new RedisExecutor(commandRecorder([])).siteEnable({
      siteName: 'gh',
      systemUser: 'gh',
      rootPath: '/var/www/gh',
      memoryMaxMb: 128,
    });
  });

  assert.deepEqual(chmods, []);
});
