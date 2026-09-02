'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');

const { dashboardAdminHealthyFixture } = require('../../shared/src/dashboard-fixtures');
const {
  formatDashboardCommand,
  formatTelegramHelp,
  parseTelegramCommand,
} = require('../src/notifications/telegram-command-formatter');
const {
  normalizeTelegramConfig,
  parseTelegramDestination,
  publicTelegramConfig,
  readTelegramConfig,
} = require('../src/notifications/telegram-config');
const { TelegramCommandsService } = require('../src/notifications/telegram-commands.service');
const { NotificationsService } = require('../src/notifications/notifications.service');
const { TelegramClientService } = require('../src/notifications/telegram-client.service');

const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi123';
const ENABLED_AT = new Date('2026-09-01T12:00:00.000Z');

function commandConfig(overrides = {}) {
  return normalizeTelegramConfig({
    botToken: TOKEN,
    chatId: '-1001234567890:77',
    commandsEnabled: true,
    commandUserId: '999001',
    ...overrides,
  }, {});
}

function workerFixture(config, updates, rowsOverride) {
  const tokenHash = createHash('sha256').update(TOKEN).digest('hex');
  const rows = rowsOverride ?? [{
    id: 'setting-1',
    userId: 'panel-user-1',
    channel: 'TELEGRAM',
    enabled: true,
    config: JSON.stringify(config),
    createdAt: new Date('2026-09-01T10:00:00.000Z'),
    user: { id: 'panel-user-1', role: 'ADMIN' },
  }];
  for (const row of rows) {
    if (!('commandBotTokenHash' in row)) row.commandBotTokenHash = tokenHash;
    if (!('telegramNextUpdateId' in row)) row.telegramNextUpdateId = null;
    if (!('telegramCommandsEnabledAt' in row)) row.telegramCommandsEnabledAt = ENABLED_AT;
    if (!('telegramLeaseOwner' in row)) row.telegramLeaseOwner = null;
    if (!('telegramLeaseExpiresAt' in row)) row.telegramLeaseExpiresAt = null;
  }
  const state = { row: rows[0] };
  const sent = [];
  const dashboardCalls = [];
  const updateCalls = [];
  const prisma = {
    notificationSetting: {
      findMany: async () => rows.map((row) => ({ ...row })),
      findUnique: async ({ where }) => {
        const row = rows.find((item) => item.id === where.id);
        if (!row) return null;
        return { ...row };
      },
      updateMany: async ({ where, data }) => {
        if (!where.id && where.telegramLeaseOwner) {
          let count = 0;
          for (const row of rows) {
            if (row.telegramLeaseOwner !== where.telegramLeaseOwner) continue;
            Object.assign(row, data);
            count += 1;
          }
          return { count };
        }
        const row = rows.find((item) => item.id === where.id);
        if (!row) return { count: 0 };
        if (data.telegramNextUpdateId !== undefined) {
          if (
            where.commandBotTokenHash !== row.commandBotTokenHash
            || where.telegramLeaseOwner !== row.telegramLeaseOwner
          ) return { count: 0 };
        } else if (data.telegramLeaseOwner) {
          const expiryBoundary = where.OR?.find(
            (entry) => entry.telegramLeaseExpiresAt?.lte,
          )?.telegramLeaseExpiresAt.lte;
          const leaseAvailable = row.telegramLeaseOwner === null
            || row.telegramLeaseOwner === data.telegramLeaseOwner
            || (row.telegramLeaseExpiresAt && expiryBoundary
              && row.telegramLeaseExpiresAt <= expiryBoundary);
          if (!row.enabled || row.channel !== 'TELEGRAM' || !row.commandBotTokenHash || !leaseAvailable) {
            return { count: 0 };
          }
        }
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  };
  const telegram = {
    getUpdates: async (token, options) => {
      updateCalls.push({ token, options });
      return typeof updates === 'function' ? updates() : updates;
    },
    getMe: async () => ({ id: 123456, is_bot: true, username: 'meowbox_bot' }),
    sendMessage: async (token, input) => {
      sent.push({ token, input });
    },
  };
  const dashboard = {
    getOverview: async (userId, role) => {
      dashboardCalls.push({ userId, role });
      return structuredClone(dashboardAdminHealthyFixture);
    },
  };
  return {
    worker: new TelegramCommandsService(prisma, telegram, dashboard),
    state,
    sent,
    dashboardCalls,
    updateCalls,
    prisma,
    telegram,
    dashboard,
  };
}

test('Telegram destination parser binds numeric chat and forum topic exactly', () => {
  assert.deepEqual(parseTelegramDestination('-1001234567890:77'), {
    chatId: '-1001234567890',
    messageThreadId: 77,
  });
  assert.deepEqual(parseTelegramDestination('-1001234567890/77'), {
    chatId: '-1001234567890',
    messageThreadId: 77,
  });
  assert.deepEqual(parseTelegramDestination('@channel_name'), {
    chatId: '@channel_name',
  });
  assert.equal(parseTelegramDestination('-100123:not-a-topic'), null);
});

test('Telegram config masks saved token and preserves it when edit input is empty', () => {
  const initial = commandConfig();
  const exposed = publicTelegramConfig(initial);
  assert.equal(exposed.botToken, '');
  assert.equal(exposed.hasBotToken, true);

  const updated = normalizeTelegramConfig({
    botToken: '',
    chatId: '-1001234567890:77',
    commandsEnabled: true,
    commandUserId: '999001',
  }, initial);
  assert.equal(readTelegramConfig(updated).botToken, TOKEN);

  const changedToken = normalizeTelegramConfig({
    botToken: '654321:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi123',
    chatId: '-1001234567890:77',
    commandsEnabled: true,
    commandUserId: '999001',
  }, updated);
  assert.notEqual(readTelegramConfig(changedToken).botToken, TOKEN);
});

test('command parser accepts BotFather suffix and help contains read-only commands only', () => {
  assert.deepEqual(parseTelegramCommand('/status@meowbox_bot'), {
    command: 'status',
    botUsername: 'meowbox_bot',
  });
  assert.deepEqual(parseTelegramCommand('/problems now'), {
    command: 'problems',
    botUsername: null,
  });
  assert.equal(parseTelegramCommand('status'), null);
  assert.deepEqual(parseTelegramCommand('/restart'), {
    command: 'unknown',
    botUsername: null,
  });
  const help = formatTelegramHelp();
  assert.doesNotMatch(help, /restart|deploy|shell/i);
});

test('formatter escapes dynamic HTML and stays within Telegram limit', () => {
  const overview = structuredClone(dashboardAdminHealthyFixture);
  overview.problems.items = Array.from({ length: 100 }, (_, index) => ({
    id: String(index),
    code: 'SITE_ERROR',
    severity: 'CRITICAL',
    category: 'SITE',
    title: `<script>${'x'.repeat(100)}</script>`,
    summary: `token=secret ${'y'.repeat(300)}`,
    entity: { kind: 'SITE', id: String(index), label: 'example.test' },
    occurredAt: ENABLED_AT.toISOString(),
    observedAt: ENABLED_AT.toISOString(),
    action: null,
  }));
  overview.problems.total = 100;
  const text = formatDashboardCommand('problems', overview);
  assert.ok(text.length <= 3900);
  assert.doesNotMatch(text, /<script>/);
  assert.match(text, /&lt;script&gt;/);
});

test('authorized command uses panel owner role, exact topic and persists cursor', async () => {
  const fixture = workerFixture(commandConfig(), [{
    update_id: 42,
    message: {
      message_id: 7,
      message_thread_id: 77,
      date: Math.floor(ENABLED_AT.getTime() / 1000),
      text: '/status@meowbox_bot',
      chat: { id: -1001234567890, type: 'supergroup' },
      from: { id: 999001, is_bot: false },
    },
  }]);

  await fixture.worker.pollOnce();

  assert.deepEqual(fixture.dashboardCalls, [{ userId: 'panel-user-1', role: 'ADMIN' }]);
  assert.equal(fixture.sent.length, 1);
  assert.equal(fixture.sent[0].input.chatId, '-1001234567890');
  assert.equal(fixture.sent[0].input.messageThreadId, 77);
  assert.equal(fixture.sent[0].input.parseMode, 'HTML');
  assert.equal(fixture.state.row.telegramNextUpdateId, '43');
});

test('wrong sender or topic receives no panel data while cursor still advances', async () => {
  const fixture = workerFixture(commandConfig(), [
    {
      update_id: 50,
      message: {
        message_id: 1,
        message_thread_id: 78,
        date: Math.floor(ENABLED_AT.getTime() / 1000),
        text: '/status',
        chat: { id: -1001234567890 },
        from: { id: 999001 },
      },
    },
    {
      update_id: 51,
      message: {
        message_id: 2,
        message_thread_id: 77,
        date: Math.floor(ENABLED_AT.getTime() / 1000),
        text: '/status',
        chat: { id: -1001234567890 },
        from: { id: 111222 },
      },
    },
  ]);

  await fixture.worker.pollOnce();

  assert.equal(fixture.dashboardCalls.length, 0);
  assert.equal(fixture.sent.length, 0);
  assert.equal(fixture.state.row.telegramNextUpdateId, '52');
});

test('/whoami works before user binding but old queued commands are discarded', async () => {
  const config = commandConfig({ commandUserId: '' });
  const fixture = workerFixture(config, [
    {
      update_id: 60,
      message: {
        message_id: 1,
        message_thread_id: 77,
        date: Math.floor(ENABLED_AT.getTime() / 1000) - 3600,
        text: '/status',
        chat: { id: -1001234567890 },
        from: { id: 555666 },
      },
    },
    {
      update_id: 61,
      message: {
        message_id: 2,
        message_thread_id: 77,
        date: Math.floor(ENABLED_AT.getTime() / 1000),
        text: '/whoami',
        chat: { id: -1001234567890 },
        from: { id: 555666 },
      },
    },
  ]);

  await fixture.worker.pollOnce();

  assert.equal(fixture.dashboardCalls.length, 0);
  assert.equal(fixture.sent.length, 1);
  assert.match(fixture.sent[0].input.text, /555666/);
  assert.match(fixture.sent[0].input.text, /Topic ID/);
  assert.equal(fixture.state.row.telegramNextUpdateId, '62');
});

test('notification update preserves durable cursor and hides token and worker state', async () => {
  const previous = commandConfig();
  let stored = null;
  const prisma = {
    notificationSetting: {
      findUnique: async () => ({
        id: 'setting-1',
        config: JSON.stringify(previous),
        enabled: true,
        telegramNextUpdateId: '700',
        telegramCommandsEnabledAt: ENABLED_AT,
      }),
      findMany: async () => [],
      upsert: async ({ update }) => {
        stored = update;
        return {
          id: 'setting-1',
          userId: 'panel-user-1',
          channel: 'TELEGRAM',
          events: '[]',
          enabled: true,
          config: update.config,
          commandBotTokenHash: update.commandBotTokenHash,
          telegramNextUpdateId: update.telegramNextUpdateId,
          telegramCommandsEnabledAt: update.telegramCommandsEnabledAt,
          telegramLeaseOwner: null,
          telegramLeaseExpiresAt: null,
        };
      },
    },
  };
  const service = new NotificationsService(prisma, {});
  const result = await service.createOrUpdate({
    channel: 'TELEGRAM',
    events: [],
    enabled: true,
    config: {
      botToken: '',
      chatId: '-1001234567890:77',
      commandsEnabled: true,
      commandUserId: '999001',
    },
  }, 'panel-user-1');

  assert.equal(stored.telegramNextUpdateId, '700');
  assert.equal(readTelegramConfig(JSON.parse(stored.config)).botToken, TOKEN);
  assert.equal(result.config.botToken, '');
  assert.equal(result.config.hasBotToken, true);
  assert.equal(result.telegramNextUpdateId, undefined);
});

test('same bot token cannot start command polling for two panel users', async () => {
  const otherConfig = commandConfig();
  const prisma = {
    notificationSetting: {
      findUnique: async () => null,
      findMany: async () => [{ id: 'setting-other', config: JSON.stringify(otherConfig) }],
    },
  };
  const service = new NotificationsService(prisma, {});
  await assert.rejects(
    () => service.createOrUpdate({
      channel: 'TELEGRAM',
      events: [],
      enabled: true,
      config: {
        botToken: TOKEN,
        chatId: '-1001234567890:77',
        commandsEnabled: true,
        commandUserId: '999001',
      },
    }, 'panel-user-2'),
    /already handles commands/,
  );
});

test('command authorization is rechecked after long poll before data is read', async () => {
  const row = {
    id: 'setting-1',
    userId: 'panel-user-1',
    channel: 'TELEGRAM',
    enabled: true,
    config: JSON.stringify(commandConfig()),
    createdAt: new Date('2026-09-01T10:00:00.000Z'),
    user: { id: 'panel-user-1', role: 'ADMIN' },
  };
  const fixture = workerFixture(commandConfig(), () => {
    row.enabled = false;
    return [{
      update_id: 80,
      message: {
        message_id: 1,
        message_thread_id: 77,
        date: Math.floor(ENABLED_AT.getTime() / 1000),
        text: '/status',
        chat: { id: -1001234567890 },
        from: { id: 999001 },
      },
    }];
  }, [row]);

  await fixture.worker.pollOnce();

  assert.equal(fixture.dashboardCalls.length, 0);
  assert.equal(fixture.sent.length, 0);
  assert.equal(fixture.state.row.telegramNextUpdateId, '81');
});

test('database lease permits only one polling process and is released on shutdown', async () => {
  const fixture = workerFixture(commandConfig(), []);
  const secondCalls = [];
  const secondTelegram = {
    ...fixture.telegram,
    getUpdates: async (...args) => {
      secondCalls.push(args);
      return [];
    },
  };
  const second = new TelegramCommandsService(
    fixture.prisma,
    secondTelegram,
    fixture.dashboard,
  );

  await fixture.worker.pollOnce();
  await second.pollOnce();

  assert.equal(fixture.updateCalls.length, 1);
  assert.equal(secondCalls.length, 0);
  assert.ok(fixture.state.row.telegramLeaseOwner);
  await fixture.worker.onModuleDestroy();
  assert.equal(fixture.state.row.telegramLeaseOwner, null);
});

test('command addressed to another bot is ignored', async () => {
  const fixture = workerFixture(commandConfig(), [{
    update_id: 90,
    message: {
      message_id: 1,
      message_thread_id: 77,
      date: Math.floor(ENABLED_AT.getTime() / 1000),
      text: '/status@another_bot',
      chat: { id: -1001234567890 },
      from: { id: 999001 },
    },
  }]);

  await fixture.worker.pollOnce();

  assert.equal(fixture.dashboardCalls.length, 0);
  assert.equal(fixture.sent.length, 0);
  assert.equal(fixture.state.row.telegramNextUpdateId, '91');
});

test('failed informational reply is retried instead of silently advancing cursor', async () => {
  const fixture = workerFixture(commandConfig(), [{
    update_id: 95,
    message: {
      message_id: 1,
      message_thread_id: 77,
      date: Math.floor(ENABLED_AT.getTime() / 1000),
      text: '/status',
      chat: { id: -1001234567890 },
      from: { id: 999001 },
    },
  }]);
  fixture.telegram.sendMessage = async () => {
    throw new Error('temporary Telegram failure');
  };

  await fixture.worker.pollOnce();

  assert.equal(fixture.state.row.telegramNextUpdateId, null);
});

test('Telegram client sends bounded topic messages and requests message updates only', async (t) => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const result = url.endsWith('/getUpdates') ? [] : { message_id: 1 };
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  t.after(() => { global.fetch = originalFetch; });

  const client = new TelegramClientService();
  await client.sendMessage(TOKEN, {
    chatId: '-1001234567890',
    messageThreadId: 77,
    text: '<b>Status</b>',
    parseMode: 'HTML',
  });
  await client.getUpdates(TOKEN, { offset: 100, timeoutSeconds: 0 });

  assert.equal(calls[0].body.chat_id, '-1001234567890');
  assert.equal(calls[0].body.message_thread_id, 77);
  assert.equal(calls[0].body.parse_mode, 'HTML');
  assert.equal(calls[1].body.offset, 100);
  assert.deepEqual(calls[1].body.allowed_updates, ['message']);
});
