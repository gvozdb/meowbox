const PROTOCOL_V1 = 'rpp-020-v1';
const FIXTURE_ADDRESS = '127.0.0.1';
const FIXTURE_IPV6 = '::1';
const PRIVATE_PROBE_ADDRESS = '10.42.20.20';
const PRIVATE_PROBE_IPV6 = 'fd42:20::20';

export const REQUIRED_PROFILE_NAMES = Object.freeze([
  'current',
  'legacy',
  'newer-compatible',
  'newer-incompatible',
  'offline',
  'auth-failed',
  'ip-blocked',
  'partial-capability',
  'no-admin',
  'custom-port',
  'browser-reachable',
  'browser-unreachable',
  'public',
  'disabled-private',
  'fresh-no-admin',
  'existing-env',
  'token-mismatch',
]);

export const PROFILE_NAMES = REQUIRED_PROFILE_NAMES;
export const DISPOSABLE_PROFILE_NAMES = REQUIRED_PROFILE_NAMES;

export const CAPABILITY_NAMES = Object.freeze([
  'health.read',
  'manifest.read',
  'sites.read',
  'sites.mutate',
  'domains.read',
  'domains.mutate',
  'dns.manage',
  'nginx.manage',
  'php.manage',
  'services.manage',
  'firewall.manage',
  'cron.manage',
  'processes.read',
  'monitoring.read',
  'storage.manage',
  'databases.manage',
  'backups.manage',
  'vpn.read',
  'webhooks.receive',
  'transfers.read',
  'adminer.handoff',
  'operations.read',
  'ws.connect',
]);

export const DEFERRED_REAL_FIXTURES = Object.freeze([
  'generated-nginx',
  'php-fpm',
  'adminer',
  'tls-spki',
  'dns-rebinding',
  's3-provider',
  'webhook-provider',
]);

const RESTARTABLE_SERVICES = Object.freeze(['api', 'agent', 'socketIo']);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function allCapabilities() {
  return Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, true]));
}

function partialCapabilities() {
  return Object.fromEntries(CAPABILITY_NAMES.map((name) => [
    name,
    ['health.read', 'manifest.read', 'sites.read', 'domains.read', 'monitoring.read', 'operations.read'].includes(name),
  ]));
}

function servicePlan() {
  return {
    api: { kind: 'api', restartable: true, lifecycle: 'restartable-plan-only', network: 'not-started' },
    agent: { kind: 'agent', restartable: true, lifecycle: 'restartable-plan-only', network: 'not-started' },
    socketIo: { kind: 'socket.io', restartable: true, lifecycle: 'restartable-plan-only', network: 'not-started' },
    nginx: { kind: 'nginx', restartable: false, lifecycle: 'deferred-real-fixture', network: 'not-started' },
    phpFpm: { kind: 'php-fpm', restartable: false, lifecycle: 'deferred-real-fixture', network: 'not-started' },
    adminer: { kind: 'adminer', restartable: false, lifecycle: 'deferred-real-fixture', network: 'not-started' },
    tls: { kind: 'tls', restartable: false, lifecycle: 'deferred-real-fixture', network: 'not-started' },
    stream: { kind: 'logical-stream', restartable: false, lifecycle: 'in-process-helper', network: 'not-started' },
    s3: { kind: 's3', restartable: false, lifecycle: 'deferred-real-fixture', network: 'not-started' },
    webhook: { kind: 'webhook', restartable: false, lifecycle: 'deferred-real-fixture', network: 'not-started' },
  };
}

function endpointSet(host, port) {
  return {
    api: `http://${host}:${port}`,
    ws: `ws://${host}:${port + 1}`,
    browser: `http://${host}:${port + 2}`,
    transfer: `http://${host}:${port + 3}`,
    public: `http://${host}:${port + 4}`,
  };
}

function rootLayout(name) {
  return {
    root: `targets/${name}`,
    state: `targets/${name}/state`,
    data: `targets/${name}/data`,
    logs: `targets/${name}/logs`,
    runtime: `targets/${name}/runtime`,
    sites: `targets/${name}/sites`,
    transfers: `targets/${name}/transfers`,
    webhooks: `targets/${name}/webhooks`,
  };
}

function makeProfile(name, {
  port,
  version = '0.7.35',
  protocol = PROTOCOL_V1,
  compatibility = 'current',
  availability = 'online',
  auth = 'valid',
  network = 'allowed',
  browser = 'reachable',
  topology = 'PUBLIC',
  activation = 'enabled',
  adminPresent = true,
  provisioning = 'existing',
  capabilities = allCapabilities(),
  publicDelivery = 'direct-target',
  legacyStatic = false,
  address = FIXTURE_ADDRESS,
  address6 = FIXTURE_IPV6,
} = {}) {
  const host = `${name}.rpp.test`;
  const endpoints = endpointSet(host, port);
  return {
    name,
    id: `rpp-target-${name}`,
    role: 'target',
    version,
    protocol,
    acceptedMasterProtocol: PROTOCOL_V1,
    compatibility,
    availability,
    auth,
    network,
    browserReachability: browser,
    topology,
    activation,
    adminPresent,
    provisioning,
    publicDelivery,
    legacyStatic,
    originHost: host,
    ports: {
      api: port,
      ws: port + 1,
      browser: port + 2,
      transfer: port + 3,
      public: port + 4,
    },
    origins: endpoints,
    dns: { A: [address], AAAA: [address6] },
    roots: rootLayout(name),
    capabilities,
    services: servicePlan(),
    restartableServices: RESTARTABLE_SERVICES,
    deferredRealFixtures: DEFERRED_REAL_FIXTURES,
    probes: {
      health: availability === 'online' && network === 'allowed' ? 'reachable' : 'blocked',
      auth: auth === 'valid' ? 'accepted' : 'rejected',
      browser: browser === 'reachable' ? 'reachable' : 'unreachable',
      topology: topology === 'PUBLIC' ? 'public-allowed' : 'private-disabled',
    },
  };
}

const definitions = [
  ['current', { port: 18100 }],
  ['legacy', { port: 18110, version: '0.7.30', protocol: 'legacy-static-v0', compatibility: 'legacy', legacyStatic: true }],
  ['newer-compatible', { port: 18120, version: '0.8.0', compatibility: 'compatible' }],
  ['newer-incompatible', { port: 18130, version: '0.9.0', protocol: 'rpp-020-v2', compatibility: 'incompatible' }],
  ['offline', { port: 18140, availability: 'offline', network: 'offline' }],
  ['auth-failed', { port: 18150, auth: 'auth-failed' }],
  ['ip-blocked', { port: 18160, network: 'ip-blocked' }],
  ['partial-capability', { port: 18170, compatibility: 'partial', capabilities: partialCapabilities() }],
  ['no-admin', { port: 18180, adminPresent: false, provisioning: 'fresh-no-admin', auth: 'no-admin' }],
  ['custom-port', { port: 19443, provisioning: 'existing-custom-port' }],
  ['browser-reachable', { port: 18190, browser: 'reachable' }],
  ['browser-unreachable', { port: 18200, browser: 'unreachable' }],
  ['public', { port: 18210, topology: 'PUBLIC', browser: 'reachable', publicDelivery: 'direct-target' }],
  ['disabled-private', { port: 18220, topology: 'TRUSTED_PRIVATE', activation: 'disabled', browser: 'unreachable', address: PRIVATE_PROBE_ADDRESS, address6: PRIVATE_PROBE_IPV6, publicDelivery: 'disabled' }],
  ['fresh-no-admin', { port: 18230, adminPresent: false, provisioning: 'fresh-no-admin', auth: 'no-admin' }],
  ['existing-env', { port: 18240, provisioning: 'existing-env' }],
  ['token-mismatch', { port: 18250, auth: 'token-mismatch' }],
];

export const PROFILE_CATALOG = deepFreeze(Object.fromEntries(
  definitions.map(([name, options]) => [name, makeProfile(name, options)]),
));

export const FIXTURE_PROFILES = PROFILE_CATALOG;

export const PROFILE_DNS_MAP = deepFreeze(Object.fromEntries(
  Object.values(PROFILE_CATALOG).map((profile) => [profile.originHost, profile.dns]),
));

export function getFixtureProfile(name) {
  if (typeof name !== 'string' || !Object.hasOwn(PROFILE_CATALOG, name)) {
    throw new Error(`Unknown RPP-020 fixture profile: ${String(name)}`);
  }
  return PROFILE_CATALOG[name];
}

export function listFixtureProfiles() {
  return REQUIRED_PROFILE_NAMES.map((name) => PROFILE_CATALOG[name]);
}

export function validateProfileCatalog(catalog = PROFILE_CATALOG) {
  const missing = REQUIRED_PROFILE_NAMES.filter((name) => !catalog[name]);
  if (missing.length > 0) {
    throw new Error(`RPP-020 profile catalog is missing: ${missing.join(', ')}`);
  }
  const seenIds = new Set();
  const seenPorts = new Set();
  for (const name of REQUIRED_PROFILE_NAMES) {
    const profile = catalog[name];
    const requiredFields = [
      'name', 'id', 'version', 'protocol', 'compatibility', 'availability', 'auth',
      'network', 'browserReachability', 'topology', 'activation', 'adminPresent',
      'provisioning', 'origins', 'ports', 'dns', 'roots', 'capabilities', 'services',
      'probes', 'deferredRealFixtures',
    ];
    const absent = requiredFields.filter((field) => profile[field] === undefined);
    if (absent.length > 0) {
      throw new Error(`RPP-020 profile ${name} is incomplete: ${absent.join(', ')}`);
    }
    if (profile.name !== name || seenIds.has(profile.id)) {
      throw new Error(`RPP-020 profile ${name} has a non-unique deterministic id`);
    }
    seenIds.add(profile.id);
    for (const field of ['api', 'ws', 'browser', 'transfer', 'public']) {
      if (typeof profile.origins[field] !== 'string' || !profile.origins[field].includes(profile.originHost)) {
        throw new Error(`RPP-020 profile ${name} has an invalid ${field} origin`);
      }
    }
    for (const field of ['api', 'ws', 'browser', 'transfer', 'public']) {
      const port = profile.ports[field];
      if (!Number.isInteger(port) || port < 1024 || port > 65535 || seenPorts.has(port)) {
        throw new Error(`RPP-020 profile ${name} has an invalid or duplicate ${field} port`);
      }
      seenPorts.add(port);
    }
    if (!Array.isArray(profile.dns.A) || !Array.isArray(profile.dns.AAAA) || profile.dns.A.length + profile.dns.AAAA.length === 0) {
      throw new Error(`RPP-020 profile ${name} has no DNS answers`);
    }
    for (const service of ['api', 'agent', 'socketIo', 'nginx', 'phpFpm', 'adminer', 'tls', 'stream', 's3', 'webhook']) {
      if (!profile.services[service]) {
        throw new Error(`RPP-020 profile ${name} is missing service plan ${service}`);
      }
    }
    if (!RESTARTABLE_SERVICES.every((service) => profile.restartableServices.includes(service))) {
      throw new Error(`RPP-020 profile ${name} is missing a restartable service declaration`);
    }
  }
  return true;
}

validateProfileCatalog();

