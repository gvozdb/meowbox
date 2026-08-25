import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_NAMES,
  PROFILE_CATALOG,
  PROFILE_DNS_MAP,
  REQUIRED_PROFILE_NAMES,
  assertSafeFixtureOrigin,
  createStaticFixtureResolver,
  getFixtureProfile,
  listFixtureProfiles,
  resolveFixtureOrigins,
  validateProfileCatalog,
} from '../index.mjs';

test('RPP-020 reserves and validates every required disposable profile', () => {
  assert.equal(validateProfileCatalog(), true);
  assert.deepEqual(listFixtureProfiles().map(({ name }) => name), REQUIRED_PROFILE_NAMES);
  assert.equal(new Set(REQUIRED_PROFILE_NAMES).size, REQUIRED_PROFILE_NAMES.length);

  for (const name of REQUIRED_PROFILE_NAMES) {
    const profile = getFixtureProfile(name);
    assert.equal(profile.name, name);
    assert.match(profile.id, /^rpp-target-/u);
    assert.ok(profile.version);
    assert.ok(profile.protocol);
    assert.ok(profile.compatibility);
    assert.ok(profile.origins.api);
    assert.ok(profile.origins.ws);
    assert.ok(profile.origins.browser);
    assert.ok(profile.origins.transfer);
    assert.ok(profile.origins.public);
    assert.ok(profile.dns.A.length + profile.dns.AAAA.length > 0);
    assert.ok(profile.roots.state.startsWith('targets/'));
    assert.deepEqual(Object.keys(profile.capabilities).sort(), [...CAPABILITY_NAMES].sort());
    assert.deepEqual([...profile.restartableServices].sort(), ['agent', 'api', 'socketIo'].sort());
    for (const service of ['api', 'agent', 'socketIo', 'nginx', 'phpFpm', 'adminer', 'tls', 'stream', 's3', 'webhook']) {
      assert.ok(profile.services[service]);
    }
  }
});

test('profile origins are fixture-only and static DNS is complete', async () => {
  const resolver = createStaticFixtureResolver(PROFILE_DNS_MAP);
  for (const name of REQUIRED_PROFILE_NAMES) {
    const profile = getFixtureProfile(name);
    for (const origin of Object.values(profile.origins)) {
      assertSafeFixtureOrigin(origin);
    }
    const resolution = await resolveFixtureOrigins(Object.values(profile.origins), {
      resolver,
      allowPrivate: profile.topology === 'TRUSTED_PRIVATE' && profile.activation === 'disabled',
    });
    assert.equal(resolution.hosts.length, 1);
    if (profile.topology === 'TRUSTED_PRIVATE') {
      assert.equal(resolution.hosts[0].privateProbe, true);
      assert.equal(resolution.hosts[0].dialable, false);
    } else {
      assert.equal(resolution.hosts[0].dialable, true);
    }
  }
});

test('required status probes have deterministic meanings', () => {
  assert.equal(getFixtureProfile('current').compatibility, 'current');
  assert.equal(getFixtureProfile('legacy').legacyStatic, true);
  assert.equal(getFixtureProfile('newer-compatible').compatibility, 'compatible');
  assert.equal(getFixtureProfile('newer-incompatible').compatibility, 'incompatible');
  assert.equal(getFixtureProfile('offline').availability, 'offline');
  assert.equal(getFixtureProfile('auth-failed').auth, 'auth-failed');
  assert.equal(getFixtureProfile('ip-blocked').network, 'ip-blocked');
  assert.equal(getFixtureProfile('partial-capability').compatibility, 'partial');
  assert.equal(getFixtureProfile('no-admin').adminPresent, false);
  assert.equal(getFixtureProfile('custom-port').ports.api, 19443);
  assert.equal(getFixtureProfile('browser-reachable').browserReachability, 'reachable');
  assert.equal(getFixtureProfile('browser-unreachable').browserReachability, 'unreachable');
  assert.equal(getFixtureProfile('public').topology, 'PUBLIC');
  assert.equal(getFixtureProfile('disabled-private').activation, 'disabled');
  assert.equal(getFixtureProfile('fresh-no-admin').provisioning, 'fresh-no-admin');
  assert.equal(getFixtureProfile('existing-env').provisioning, 'existing-env');
  assert.equal(getFixtureProfile('token-mismatch').auth, 'token-mismatch');
});

test('catalog completeness fails closed for an incomplete replacement', () => {
  const incomplete = { ...PROFILE_CATALOG };
  delete incomplete.current;
  assert.throws(() => validateProfileCatalog(incomplete), /missing: current/);
});
