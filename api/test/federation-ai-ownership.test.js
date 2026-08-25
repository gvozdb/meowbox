'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PrismaClient } = require('@prisma/client');

const { AiController } = require('../src/ai/ai.controller');
const { AiService } = require('../src/ai/ai.service');
const { FederatedPrincipalService } = require('../src/federation/federated-principal.service');

const ISSUER_INSTALLATION_ID = '11111111-2222-4333-8444-555555555555';
const TARGET_INSTALLATION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-rpp-ai-owner-'));
  const databaseUrl = `file:${path.join(root, 'fixture.db')}`;
  execFileSync(path.resolve(__dirname, '../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  t.after(async () => {
    await prisma.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await prisma.federationIssuer.create({
    data: {
      issuerInstallationId: ISSUER_INSTALLATION_ID,
      targetInstallationId: TARGET_INSTALLATION_ID,
      state: 'ACTIVE',
      principalVersion: 1,
      permissionPolicyJson: JSON.stringify([
        'http.get.ai-sessions',
        'http.get.ai-sessions-id',
        'http.patch.ai-sessions-id',
        'http.delete.ai-sessions-id',
        'ws.browser-command.ai-start',
        'ws.browser-command.ai-message',
      ]),
    },
  });
  const principals = new FederatedPrincipalService(prisma);
  const operator = async (subject) => principals.resolveVerifiedOperator({
    issuerInstallationId: ISSUER_INSTALLATION_ID,
    targetInstallationId: TARGET_INSTALLATION_ID,
    subject,
    principalVersion: 1,
  });
  return { prisma, operator };
}

function activeSession(userId, messages) {
  return {
    userId,
    dbSessionId: '',
    messages,
  };
}

test('CF6/A2 federated AI history and mutations stay isolated by stable shadow User', async (t) => {
  const { prisma, operator } = await fixture(t);
  const first = await operator('master-user:first');
  const firstAgain = await operator('master-user:first');
  const second = await operator('master-user:second');
  assert.equal(first.userId, firstAgain.userId);
  assert.notEqual(first.userId, second.userId);

  const service = new AiService(prisma);
  const controller = new AiController(service);
  const firstProcess = activeSession(first.userId, [
    { role: 'user', text: 'first turn' },
    { role: 'assistant', text: 'first answer' },
    { role: 'user', text: 'second turn' },
    { role: 'assistant', text: 'second answer' },
  ]);
  const secondProcess = activeSession(second.userId, [
    { role: 'user', text: 'private second operator prompt' },
  ]);
  await service.saveSession(firstProcess, 'claude-first-session');
  await service.saveSession(secondProcess, 'claude-second-session');

  const firstList = await controller.listSessions({ id: first.userId, role: 'MANAGER' });
  const secondList = await controller.listSessions({ id: second.userId, role: 'MANAGER' });
  assert.deepEqual(firstList.data.map(({ id }) => id), [firstProcess.dbSessionId]);
  assert.deepEqual(secondList.data.map(({ id }) => id), [secondProcess.dbSessionId]);

  const firstHistory = await controller.getSession(firstProcess.dbSessionId, {
    id: first.userId,
    role: 'MANAGER',
  });
  assert.equal(firstHistory.data.messages.length, 4);
  assert.equal((await controller.getSession(firstProcess.dbSessionId, {
    id: second.userId,
    role: 'MANAGER',
  })).data, null);

  await controller.renameSession(firstProcess.dbSessionId, { title: 'Owner title' }, {
    id: second.userId,
    role: 'MANAGER',
  });
  assert.equal((await service.getSession(firstProcess.dbSessionId, first.userId)).title, null);
  await controller.renameSession(firstProcess.dbSessionId, { title: 'Owner title' }, {
    id: first.userId,
    role: 'MANAGER',
  });
  assert.equal((await service.getSession(firstProcess.dbSessionId, first.userId)).title, 'Owner title');

  await controller.deleteSession(firstProcess.dbSessionId, { id: second.userId, role: 'MANAGER' });
  assert.notEqual(await service.getSession(firstProcess.dbSessionId, first.userId), null);
  await controller.deleteSession(firstProcess.dbSessionId, { id: first.userId, role: 'MANAGER' });
  assert.equal(await service.getSession(firstProcess.dbSessionId, first.userId), null);
});
