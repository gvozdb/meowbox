import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FixtureSafetyError,
  assertSafeFixtureOrigin,
  assertSafeFixturePath,
  assertSafeFixtureRoot,
  createStaticFixtureResolver,
  parseFixtureEnvironment,
  resolveFixtureOrigins,
  validateFixtureEnvironment,
} from '../index.mjs';

async function temporaryRoot(prefix = 'meowbox-rpp-test-') {
  return mkdtemp(join(tmpdir(), prefix));
}

test('fixture paths reject production roots, traversal, and broad roots', async (t) => {
  const root = await temporaryRoot('meowbox-rpp-path-');
  t.after(async () => rm(root, { recursive: true, force: true }));

  assert.throws(() => assertSafeFixturePath('/opt/meowbox/state'), (error) => {
    assert(error instanceof FixtureSafetyError);
    assert.equal(error.code, 'NON_TEMP_PATH');
    return true;
  });
  assert.throws(() => assertSafeFixturePath('/var/www/example.test'), /NON_TEMP_PATH/);
  assert.throws(() => assertSafeFixturePath(`${tmpdir()}/../opt/meowbox`), /PATH_TRAVERSAL/);
  assert.throws(() => assertSafeFixturePath(tmpdir()), /BROAD_TEMP_ROOT/);
  assert.equal(assertSafeFixturePath(join(root, 'target', 'state')).startsWith(root), true);
});

test('fixture roots reject symlink escapes before materialization', async (t) => {
  const root = await temporaryRoot('meowbox-rpp-symlink-');
  const outside = await temporaryRoot('meowbox-rpp-outside-');
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const link = join(root, 'link');
  await symlink(outside, link);

  await assert.rejects(
    () => assertSafeFixtureRoot(link),
    (error) => error instanceof FixtureSafetyError && error.code === 'SYMLINK_PATH',
  );
});

test('fixture origins reject credentials, paths, non-fixture hosts, and unsafe protocols', () => {
  assert.throws(() => assertSafeFixtureOrigin('file:///opt/meowbox/state'), /UNSAFE_ORIGIN_PROTOCOL/);
  assert.throws(() => assertSafeFixtureOrigin('https://user:password@current.rpp.test:18443'), /ORIGIN_CREDENTIALS/);
  assert.throws(() => assertSafeFixtureOrigin('https://current.rpp.test:18443/api'), /ORIGIN_COMPONENTS/);
  assert.throws(() => assertSafeFixtureOrigin('https://panel.example.com:18443'), /NON_FIXTURE_HOST/);
  assert.throws(
    () => assertSafeFixtureOrigin('https://current.rpp.test:18443', { protectedHosts: ['current.rpp.test'] }),
    /REAL_CONFIGURED_HOST/,
  );
  assert.throws(() => assertSafeFixtureOrigin('https://8.8.8.8:18443'), /UNSAFE_DNS_ANSWER/);
  assert.throws(() => assertSafeFixtureOrigin('https://current.rpp.test:443'), /UNSAFE_PORT/);
  assert.equal(assertSafeFixtureOrigin('http://current.rpp.test:18443').hostname, 'current.rpp.test');
  assert.equal(assertSafeFixtureOrigin('https://[::1]:18443').origin, 'https://[::1]:18443');
});

test('fixture DNS is injected and every A/AAAA answer is checked', async () => {
  const resolver = createStaticFixtureResolver({
    'safe.rpp.test': { A: ['127.0.0.1'], AAAA: ['::1'] },
  });
  const resolved = await resolveFixtureOrigins(['https://safe.rpp.test:18443'], { resolver });
  assert.deepEqual(resolved.hosts[0].A, ['127.0.0.1']);
  assert.deepEqual(resolved.hosts[0].AAAA, ['::1']);
  assert.equal(resolved.hosts[0].dialable, true);

  const publicResolver = createStaticFixtureResolver({
    'unsafe.rpp.test': { A: ['8.8.8.8'], AAAA: [] },
  });
  await assert.rejects(
    () => resolveFixtureOrigins(['https://unsafe.rpp.test:18443'], { resolver: publicResolver }),
    (error) => error instanceof FixtureSafetyError && error.code === 'UNSAFE_DNS_ANSWER',
  );

  const productionResolver = createStaticFixtureResolver({
    'production.rpp.test': { A: ['127.0.0.1'], AAAA: [] },
  });
  await assert.rejects(
    () => resolveFixtureOrigins(['https://production.rpp.test:18443'], {
      resolver: productionResolver,
      productionAddresses: ['127.0.0.1'],
    }),
    (error) => error instanceof FixtureSafetyError && error.code === 'UNSAFE_DNS_ANSWER',
  );

  const privateResolver = createStaticFixtureResolver({
    'private.rpp.test': { A: ['10.42.20.20'], AAAA: ['fd42:20::20'] },
  });
  await assert.rejects(
    () => resolveFixtureOrigins(['https://private.rpp.test:18443'], { resolver: privateResolver }),
    /UNSAFE_DNS_ANSWER/,
  );
  const disabledPrivate = await resolveFixtureOrigins(['https://private.rpp.test:18443'], {
    resolver: privateResolver,
    allowPrivate: true,
  });
  assert.equal(disabledPrivate.hosts[0].privateProbe, true);
  assert.equal(disabledPrivate.hosts[0].dialable, false);
});

test('explicit environment schema rejects production/network execution and real hosts', async (t) => {
  const root = await temporaryRoot('meowbox-rpp-env-');
  t.after(async () => rm(root, { recursive: true, force: true }));
  const base = {
    MEOWBOX_RPP_FIXTURE_MODE: 'rpp-020',
    MEOWBOX_RPP_ROOT: root,
    MEOWBOX_RPP_NETWORK: 'disabled',
  };

  assert.throws(() => parseFixtureEnvironment({ ...base, MEOWBOX_RPP_NETWORK: 'enabled' }), /NETWORK_DISABLED_REQUIRED/);
  assert.throws(() => parseFixtureEnvironment({ ...base, MEOWBOX_RPP_ALLOW_NETWORK: '1' }), /NETWORK_FORBIDDEN/);
  assert.throws(() => parseFixtureEnvironment({ ...base, NODE_ENV: 'production' }), /PRODUCTION_ENVIRONMENT/);
  const configured = parseFixtureEnvironment({
    ...base,
    MEOWBOX_RPP_REAL_PANEL_ORIGIN: 'https://panel.example.com:18443',
  });
  assert.deepEqual(configured.protectedHosts, ['panel.example.com']);

  const resolver = createStaticFixtureResolver({ 'current.rpp.test': { A: ['127.0.0.1'], AAAA: [] } });
  await assert.rejects(
    () => validateFixtureEnvironment({ ...base, MEOWBOX_RPP_DNS_MAP: JSON.stringify({ 'current.rpp.test': { A: ['127.0.0.1'] } }) }, {
      origins: ['https://current.rpp.test:18443'],
      resolver,
      protectedHosts: ['current.rpp.test'],
    }),
    /REAL_CONFIGURED_HOST/,
  );
});

test('environment validation never supplies an ambient DNS resolver', async (t) => {
  const root = await temporaryRoot('meowbox-rpp-no-dns-');
  t.after(async () => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    () => validateFixtureEnvironment({
      MEOWBOX_RPP_FIXTURE_MODE: 'rpp-020',
      MEOWBOX_RPP_ROOT: root,
      MEOWBOX_RPP_NETWORK: 'disabled',
    }, { origins: ['https://missing.rpp.test:18443'] }),
    (error) => error instanceof FixtureSafetyError && error.code === 'NETWORK_RESOLVER_REQUIRED',
  );
});

test('production address deny-list rejects an otherwise local fixture answer', async () => {
  const resolver = createStaticFixtureResolver({
    'configured.rpp.test': { A: ['127.0.0.1'], AAAA: [] },
  });
  await assert.rejects(
    () => resolveFixtureOrigins(['https://configured.rpp.test:18443'], {
      resolver,
      productionAddresses: ['127.0.0.0/8'],
    }),
    /UNSAFE_DNS_ANSWER/,
  );
});

test('A and AAAA maps cannot silently swap address families', () => {
  assert.throws(
    () => createStaticFixtureResolver({ 'wrong-family.rpp.test': { A: ['::1'], AAAA: [] } }),
    /DNS_FAMILY_MISMATCH/,
  );
});
