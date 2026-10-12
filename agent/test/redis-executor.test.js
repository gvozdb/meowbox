'use strict';

const assert = require('node:assert/strict');
const { promises: fs } = require('node:fs');
const test = require('node:test');

const { RedisExecutor } = require('../src/services/redis.executor');

function directoryStat(mode) {
  return {
    mode: 0o040000 | mode,
    uid: 123,
    gid: 456,
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
  assert.ok(commands.some(({ command, args }) => command === 'dpkg-statoverride'
    && args.join(' ') === '--add #123 #456 751 /var/lib/redis'));
  assert.ok(commands.findIndex(({ command }) => command === 'dpkg-statoverride')
    < commands.findIndex(({ command, args }) => command === 'mkdir' && args.includes('/var/lib/redis/gh')));
  assert.ok(commands.some(({ command, args }) => command === 'systemctl'
    && args.join(' ') === 'enable --now redis@gh.service'));
});

test('site enable leaves an already traversable Redis parent unchanged', { concurrency: false }, async () => {
  const chmods = [];
  const commands = [];
  await withFsStubs({
    lstat: async () => directoryStat(0o751),
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

  assert.deepEqual(chmods, []);
  assert.ok(commands.some(({ command, args }) => command === 'dpkg-statoverride'
    && args.join(' ') === '--add #123 #456 751 /var/lib/redis'));
});

test('site start repairs traversal before starting a service', { concurrency: false }, async () => {
  const calls = [];
  await withFsStubs({
    lstat: async () => directoryStat(0o750),
    readFile: async () => 'redis redis 751 /var/lib/redis\n',
    chmod: async (...args) => { calls.push(['chmod', args]); },
  }, async () => {
    await new RedisExecutor({
      async execute(command, args) {
        calls.push([command, args]);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }).siteStart({ siteName: 'gh' });
  });
  assert.deepEqual(calls, [
    ['chmod', ['/var/lib/redis', 0o751]],
    ['systemctl', ['start', 'redis@gh.service']],
  ]);
});

test('conflicting override stops site enable before any side effect', { concurrency: false }, async () => {
  const commands = [];
  const chmods = [];
  await withFsStubs({
    lstat: async () => directoryStat(0o750),
    readFile: async () => 'redis redis 750 /var/lib/redis\n',
    chmod: async (...args) => { chmods.push(args); },
  }, async () => {
    await assert.rejects(
      new RedisExecutor(commandRecorder(commands)).siteEnable({
        siteName: 'gh', systemUser: 'gh', rootPath: '/var/www/gh', memoryMaxMb: 128,
      }),
      /Conflicting dpkg-statoverride.*lacks other-execute/,
    );
  });
  assert.deepEqual(commands, []);
  assert.deepEqual(chmods, []);
});

test('fresh site enable creates the parent before the child and records its override', { concurrency: false }, async () => {
  const calls = [];
  let parentExists = false;
  await withFsStubs({
    lstat: async () => {
      if (!parentExists) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return directoryStat(0o755);
    },
    readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    writeFile: async () => {},
  }, async () => {
    await new RedisExecutor({
      async execute(command, args) {
        calls.push([command, args]);
        if (command === 'mkdir' && args.join(' ') === '-p /var/lib/redis') parentExists = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }).siteEnable({ siteName: 'gh', systemUser: 'gh', rootPath: '/var/www/gh', memoryMaxMb: 128 });
  });
  const parent = calls.findIndex(([command, args]) => command === 'mkdir' && args.join(' ') === '-p /var/lib/redis');
  const override = calls.findIndex(([command]) => command === 'dpkg-statoverride');
  const child = calls.findIndex(([command, args]) => command === 'mkdir' && args.join(' ') === '-p /var/lib/redis/gh');
  assert.ok(parent >= 0 && parent < override && override < child);
});

test('failed statoverride add prevents chmod and service start', { concurrency: false }, async () => {
  const calls = [];
  const chmods = [];
  await withFsStubs({
    lstat: async () => directoryStat(0o750),
    readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    chmod: async (...args) => { chmods.push(args); },
  }, async () => {
    await assert.rejects(
      new RedisExecutor({
        async execute(command, args) {
          calls.push([command, args]);
          if (command === 'dpkg-statoverride') throw new Error('dpkg add failed');
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }).siteStart({ siteName: 'gh' }),
      /dpkg add failed/,
    );
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'dpkg-statoverride');
  assert.deepEqual(chmods, []);
});
