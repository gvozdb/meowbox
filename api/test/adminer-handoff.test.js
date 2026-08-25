'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const TEST_KEY = Buffer.alloc(32, 0x5a).toString('base64');
process.env.DOTENV_PATH = path.join(os.tmpdir(), 'meowbox-adminer-test-env-does-not-exist');
process.env.ADMINER_SSO_KEY = TEST_KEY;

const {
  decryptAdminerSessionCookie,
  encryptAdminerSessionCookie,
} = require('../src/common/crypto/adminer-cipher');
const { AdminerHandoffService } = require('../src/adminer/adminer-handoff.service');
const { validatePublicDelivery } = require('../../shared/src/public-delivery');

const TARGET_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

function fixture() {
  const rows = new Map();
  const prisma = {
    adminerHandoff: {
      create: async ({ data }) => {
        const row = { ...data, consumedAt: null, createdAt: new Date() };
        rows.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }) => rows.get(where.id) ?? null,
      updateMany: async ({ where, data }) => {
        const row = rows.get(where.id);
        if (
          !row ||
          row.secretHash !== where.secretHash ||
          row.consumedAt !== null ||
          row.expiresAt <= where.expiresAt.gt
        ) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    federatedPrincipal: {
      findUnique: async () => null,
    },
  };
  const origins = { browserPublicOrigin: () => 'https://target.example' };
  const identity = {
    getLocalIdentity: async () => ({
      installationId: TARGET_ID,
      installationRole: 'TARGET',
      manifestKid: 'test',
      manifestPublicKeySpki: 'test',
      manifestPrivateKeyEnc: 'test',
    }),
  };
  return {
    rows,
    service: new AdminerHandoffService(prisma, origins, identity),
  };
}

function createDatabaseHandoff(service) {
  return service.create({
    purpose: 'ADMINER',
    resourceKind: 'DATABASE',
    resourceId: '33333333-3333-4333-8333-333333333333',
    actor: { userId: USER_ID, role: 'MANAGER' },
    credentials: {
      driver: 'server',
      host: '127.0.0.1',
      port: 3306,
      socket: null,
      user: 'app_db',
      pass: 'not-stored-in-plaintext',
      database: 'app_db',
    },
  });
}

test('T-ADM-001 issues a typed fragment handoff and stores no browser secret or credentials', async () => {
  const { service, rows } = fixture();
  const delivery = validatePublicDelivery(await createDatabaseHandoff(service));
  assert.equal(delivery.kind, 'AppHandoff');
  assert.equal(delivery.purpose, 'ADMINER');
  assert.equal(delivery.targetInstallationId, TARGET_ID);
  assert.equal(delivery.browserReachabilityRequired, true);
  assert.match(delivery.url, /^https:\/\/target\.example\/adminer\/#handoff=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(new URL(delivery.url).search, '');

  const row = [...rows.values()][0];
  const persisted = JSON.stringify(row);
  const fragmentSecret = delivery.url.split('.').at(-1);
  assert.equal(persisted.includes(fragmentSecret), false);
  assert.equal(persisted.includes('not-stored-in-plaintext'), false);
  assert.match(row.secretHash, /^[0-9a-f]{64}$/);
  assert.match(row.actorSubjectHash, /^[0-9a-f]{64}$/);
});

test('T-ADM-002 consumes exactly once and emits a fixed secure host-only cookie', async () => {
  const { service } = fixture();
  const delivery = await createDatabaseHandoff(service);
  const [handoffId, secret] = new URL(delivery.url).hash.slice('#handoff='.length).split('.');
  const consumed = await service.consume(handoffId, secret);
  assert.match(consumed.cookieHeader, /^__Secure-meowbox_adminer_session=/);
  assert.match(consumed.cookieHeader, /; Max-Age=900; Path=\/adminer; HttpOnly; Secure; SameSite=Lax$/);
  assert.equal(consumed.cookieHeader.includes('Domain='), false);
  assert.ok(Buffer.byteLength(consumed.cookieHeader) <= 3800);

  const cookieValue = consumed.cookieHeader
    .slice('__Secure-meowbox_adminer_session='.length)
    .split(';')[0];
  const session = decryptAdminerSessionCookie(cookieValue);
  assert.equal(session.v, 2);
  assert.equal(session.kind, 'session');
  assert.equal(session.audience, 'adminer');
  assert.equal(session.targetInstallationId, TARGET_ID);
  assert.equal(session.pass, 'not-stored-in-plaintext');
  assert.equal(session.expiresAt - session.issuedAt, 900_000);

  await assert.rejects(
    service.consume(handoffId, secret),
    /expired or was already consumed/,
  );
});

test('T-ADM-003 concurrent or forged handoff consumption fails closed', async () => {
  const forged = fixture();
  const forgedDelivery = await createDatabaseHandoff(forged.service);
  const [forgedId] = new URL(forgedDelivery.url).hash.slice('#handoff='.length).split('.');
  await assert.rejects(
    forged.service.consume(forgedId, Buffer.alloc(32, 0x33).toString('base64url')),
    /Adminer handoff is invalid/,
  );

  const concurrent = fixture();
  const delivery = await createDatabaseHandoff(concurrent.service);
  const [id, secret] = new URL(delivery.url).hash.slice('#handoff='.length).split('.');
  const results = await Promise.allSettled([
    concurrent.service.consume(id, secret),
    concurrent.service.consume(id, secret),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
});

test('T-ADM-004 Node v2 cookie decrypts in PHP with target-bound AAD', () => {
  const now = Date.now();
  const cookie = encryptAdminerSessionCookie({
    v: 2,
    kind: 'session',
    audience: 'adminer',
    targetInstallationId: TARGET_ID,
    purpose: 'ADMINER',
    resourceKind: 'DATABASE',
    resourceId: '33333333-3333-4333-8333-333333333333',
    driver: 'server',
    host: '127.0.0.1',
    port: 3306,
    socket: null,
    user: 'app_db',
    pass: 'php-interoperability',
    database: 'app_db',
    issuedAt: now,
    expiresAt: now + 900_000,
  }, TARGET_ID);
  const phpLibrary = path.resolve(__dirname, '../../tools/adminer-src/lib/sso.php');
  const script = [
    `require ${JSON.stringify(phpLibrary)};`,
    `$_COOKIE[MEOWBOX_COOKIE_NAME] = $argv[1];`,
    `$session = meowbox_read_session();`,
    `if (!$session) { fwrite(STDERR, 'rejected'); exit(2); }`,
    `echo json_encode(['target' => $session['targetInstallationId'], 'resource' => $session['resourceId'], 'pass' => $session['pass']]);`,
  ].join(' ');
  const decoded = JSON.parse(execFileSync('php', ['-r', script, cookie], {
    encoding: 'utf8',
    env: { ...process.env, ADMINER_SSO_KEY: TEST_KEY },
  }));
  assert.deepEqual(decoded, {
    target: TARGET_ID,
    resource: '33333333-3333-4333-8333-333333333333',
    pass: 'php-interoperability',
  });

  const wrongTarget = cookie.replace(TARGET_ID, '44444444-4444-4444-8444-444444444444');
  assert.throws(() => execFileSync('php', ['-r', script, wrongTarget], {
    stdio: 'pipe',
    env: { ...process.env, ADMINER_SSO_KEY: TEST_KEY },
  }));
});

test('T-ADM-005 PHP bootstrap strips fragment and legacy query tickets return 410', () => {
  const index = fs.readFileSync(path.resolve(__dirname, '../../tools/adminer-src/index.php'), 'utf8');
  const legacy = fs.readFileSync(path.resolve(__dirname, '../../tools/adminer-src/sso.php'), 'utf8');
  const library = fs.readFileSync(path.resolve(__dirname, '../../tools/adminer-src/lib/sso.php'), 'utf8');
  assert.match(index, /history\.replaceState/);
  assert.match(index, /\/api\/public\/v1\/adminer\/handoffs\//);
  assert.ok(index.indexOf('history.replaceState') < index.indexOf('await fetch'));
  assert.match(legacy, /http_response_code\(410\)/);
  assert.doesNotMatch(legacy, /\$_GET\['ticket'\]/);
  assert.match(library, /__Secure-meowbox_adminer_session/);
  assert.doesNotMatch(library, /sliding/i);
});
