import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  FIXTURE_ENV_SCHEMA,
  FIXTURE_MODE,
  FIXTURE_NETWORK_MODE,
  assertSafeFixturePath,
  assertSafeFixtureRoot,
  assertSafeFixtureTempBase,
  createStaticFixtureResolver,
  validateFixtureEnvironment,
  resolveFixtureOrigins,
} from './fixture-safety.mjs';
import {
  PROFILE_CATALOG,
  PROFILE_DNS_MAP,
  PROFILE_NAMES,
  REQUIRED_PROFILE_NAMES,
  getFixtureProfile,
  validateProfileCatalog,
} from './profiles.mjs';

export const FIXTURE_MARKER = 'meowbox-rpp-020-disposable-fixture-v1';
const MASTER_HOST = 'master.rpp.test';
const MASTER_PORT = 18000;

function profileNamesFrom(options) {
  const requested = options.profileNames ?? PROFILE_NAMES;
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new Error('RPP-020 requires at least one named fixture profile');
  }
  const names = [...new Set(requested)];
  for (const name of names) getFixtureProfile(name);
  return names;
}

function pathSet(root, relativePaths) {
  return Object.fromEntries(Object.entries(relativePaths).map(([key, value]) => {
    const path = assertSafeFixturePath(join(root, value), { label: `fixture ${key} path` });
    return [key, path];
  }));
}

function masterPlan(root) {
  const masterRoot = join(root, 'master');
  const roots = pathSet(masterRoot, {
    root: '.',
    state: 'state',
    data: 'data',
    logs: 'logs',
    runtime: 'runtime',
  });
  return {
    name: 'master',
    id: 'rpp-master',
    role: 'master',
    originHost: MASTER_HOST,
    origins: {
      api: `http://${MASTER_HOST}:${MASTER_PORT}`,
      ws: `ws://${MASTER_HOST}:${MASTER_PORT + 1}`,
      browser: `http://${MASTER_HOST}:${MASTER_PORT + 2}`,
    },
    ports: { api: MASTER_PORT, ws: MASTER_PORT + 1, browser: MASTER_PORT + 2 },
    roots,
    networked: false,
    started: false,
  };
}

function targetPlan(root, profile, resolution) {
  const targetRoot = join(root, profile.roots.root);
  const roots = pathSet(targetRoot, profile.roots);
  return {
    ...profile,
    roots,
    rootRelative: profile.roots.root,
    root: targetRoot,
    networked: false,
    started: false,
    listening: false,
    resolution,
  };
}

function staticDnsMapFor(names) {
  const selected = Object.fromEntries(names.map((name) => {
    const profile = getFixtureProfile(name);
    return [profile.originHost, profile.dns];
  }));
  return {
    [MASTER_HOST]: { A: ['127.0.0.1'], AAAA: ['::1'] },
    ...selected,
  };
}

function environmentFor(root, supplied, dnsMap) {
  const environment = { ...supplied };
  if (environment.MEOWBOX_RPP_FIXTURE_MODE === undefined) environment.MEOWBOX_RPP_FIXTURE_MODE = FIXTURE_MODE;
  if (environment.MEOWBOX_RPP_ROOT === undefined) environment.MEOWBOX_RPP_ROOT = root;
  if (environment.MEOWBOX_RPP_NETWORK === undefined) environment.MEOWBOX_RPP_NETWORK = FIXTURE_NETWORK_MODE;
  if (environment.MEOWBOX_RPP_DNS_MAP === undefined) environment.MEOWBOX_RPP_DNS_MAP = JSON.stringify(dnsMap);
  return environment;
}

function allTargetOrigins(target) {
  return Object.values(target.origins);
}

async function materializeDirectories(root, master, targets) {
  const directories = [
    root,
    ...Object.values(master.roots),
    ...targets.flatMap((target) => Object.values(target.roots)),
  ];
  await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

async function materializeManifests(root, master, targets, environment) {
  await writeJson(join(root, '.rpp-020-fixture.json'), {
    marker: FIXTURE_MARKER,
    mode: FIXTURE_MODE,
    network: FIXTURE_NETWORK_MODE,
    root,
    schemaKeys: Object.keys(FIXTURE_ENV_SCHEMA),
    profiles: targets.map(({ name }) => name),
  });
  await writeJson(join(master.roots.runtime, 'manifest.json'), {
    marker: FIXTURE_MARKER,
    role: master.role,
    id: master.id,
    origins: master.origins,
    networked: false,
    started: false,
    targets: targets.map(({ id, name, compatibility }) => ({ id, name, compatibility })),
  });
  await Promise.all(targets.map((target) => writeJson(join(target.roots.runtime, 'manifest.json'), {
    marker: FIXTURE_MARKER,
    profile: target.name,
    id: target.id,
    version: target.version,
    protocol: target.protocol,
    compatibility: target.compatibility,
    origins: target.origins,
    ports: target.ports,
    dns: target.dns,
    status: {
      availability: target.availability,
      auth: target.auth,
      network: target.network,
      browserReachability: target.browserReachability,
      topology: target.topology,
      activation: target.activation,
    },
    capabilities: target.capabilities,
    services: target.services,
    deferredRealFixtures: target.deferredRealFixtures,
    networked: false,
    started: false,
  })));
  await writeJson(join(master.roots.runtime, 'environment.json'), {
    mode: environment.mode,
    network: environment.network,
    root,
    protectedHostCount: environment.protectedHosts.length,
    productionAddressDenyListCount: environment.productionAddresses.length,
  });
}

async function canUseExistingRoot(root) {
  try {
    const entries = await readdir(root);
    return entries.length === 0;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

function serviceState(profile, service, restartCount = 0) {
  return {
    profile: profile.name,
    service,
    state: 'not-started',
    restartCount,
    bootId: `rpp-${profile.name}-${service}-boot-${restartCount}`,
    networked: false,
  };
}

/**
 * Builds and materializes an entirely local fleet description. It intentionally
 * does not call listen(), fetch(), dns.lookup(), Docker, a package manager, or
 * any Meowbox runtime entrypoint.
 */
export async function createDisposableFleet(options = {}) {
  validateProfileCatalog();
  const names = profileNamesFrom(options);
  const requestedRoot = options.root;
  let root;
  let ownsRoot = false;
  if (requestedRoot === undefined) {
    const temporaryBase = await assertSafeFixtureTempBase();
    root = await mkdtemp(join(temporaryBase, 'meowbox-rpp-'));
    ownsRoot = true;
  } else {
    root = await assertSafeFixtureRoot(requestedRoot, { label: 'RPP-020 fixture root' });
    if (!(await canUseExistingRoot(root))) {
      throw new Error('RPP-020 fixture root must be empty or an existing RPP-020 fixture root');
    }
    await mkdir(root, { recursive: true });
  }

  try {
    const dnsMap = options.dnsMap ?? staticDnsMapFor(names);
    const environment = environmentFor(root, options.environment ?? {}, dnsMap);
    if (resolve(environment.MEOWBOX_RPP_ROOT) !== root) {
      throw new Error('MEOWBOX_RPP_ROOT must match the disposable fleet root');
    }
    const parsedEnvironment = await validateFixtureEnvironment(environment, {
      protectedHosts: options.protectedHosts ?? options.configuredHosts ?? [],
      productionAddresses: options.productionAddresses ?? [],
    });
    const resolver = options.resolver ?? createStaticFixtureResolver(parsedEnvironment.dnsMap);
    const master = masterPlan(root);
    const masterResolution = await resolveFixtureOrigins(Object.values(master.origins), {
      resolver,
      protectedHosts: parsedEnvironment.protectedHosts,
      productionAddresses: parsedEnvironment.productionAddresses,
    });
    const targets = [];
    for (const name of names) {
      const profile = getFixtureProfile(name);
      const resolution = await resolveFixtureOrigins(allTargetOrigins(profile), {
        resolver,
        protectedHosts: parsedEnvironment.protectedHosts,
        productionAddresses: parsedEnvironment.productionAddresses,
        allowPrivate: profile.topology === 'TRUSTED_PRIVATE' && profile.activation === 'disabled',
      });
      targets.push(targetPlan(root, profile, resolution));
    }

    await materializeDirectories(root, master, targets);
    await materializeManifests(root, master, targets, parsedEnvironment);

    const states = new Map();
    for (const target of targets) {
      for (const service of target.restartableServices) {
        states.set(`${target.name}:${service}`, serviceState(target, service));
      }
    }

    const fleet = {
      marker: FIXTURE_MARKER,
      mode: FIXTURE_MODE,
      networked: false,
      started: false,
      root,
      ownsRoot,
      environment: parsedEnvironment,
      master: { ...master, resolution: masterResolution },
      targets,
      serviceStates: states,
      restartService(profileName, serviceName) {
        const target = targets.find(({ name }) => name === profileName);
        if (!target) throw new Error(`Unknown RPP-020 target profile: ${profileName}`);
        if (!target.restartableServices.includes(serviceName)) {
          throw new Error(`RPP-020 service is not restartable in the plan: ${serviceName}`);
        }
        const key = `${profileName}:${serviceName}`;
        const previous = states.get(key);
        const next = serviceState(target, serviceName, (previous?.restartCount ?? 0) + 1);
        next.state = 'restarted-plan-only';
        states.set(key, next);
        return { ...next };
      },
      getServiceState(profileName, serviceName) {
        const state = states.get(`${profileName}:${serviceName}`);
        return state ? { ...state } : undefined;
      },
      async cleanup() {
        if (!ownsRoot) return false;
        await removeDisposableFixtureRoot(root);
        return true;
      },
    };
    return fleet;
  } catch (error) {
    if (ownsRoot) {
      await removeDisposableFixtureRoot(root).catch(() => undefined);
    }
    throw error;
  }
}

export const createFixtureFleet = createDisposableFleet;

export async function removeDisposableFixtureRoot(root) {
  const safeRoot = await assertSafeFixtureRoot(root, { label: 'RPP-020 fixture root' });
  let marker;
  try {
    marker = JSON.parse(await readFile(join(safeRoot, '.rpp-020-fixture.json'), 'utf8'));
  } catch {
    throw new Error('Refusing to remove a directory without an RPP-020 fixture marker');
  }
  if (marker.marker !== FIXTURE_MARKER || marker.mode !== FIXTURE_MODE || marker.network !== FIXTURE_NETWORK_MODE) {
    throw new Error('Refusing to remove a directory with a non-RPP-020 fixture marker');
  }
  await rm(safeRoot, { recursive: true, force: true });
}

export { REQUIRED_PROFILE_NAMES };
