import { lstat, realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

/**
 * RPP-020 is deliberately a fixture-only boundary.  Keep this schema small and
 * explicit so a production environment cannot be accidentally repurposed as a
 * test environment.
 */
export const FIXTURE_ENV_SCHEMA = Object.freeze({
  MEOWBOX_RPP_FIXTURE_MODE: Object.freeze({ required: true, value: 'rpp-020' }),
  MEOWBOX_RPP_ROOT: Object.freeze({ required: true, kind: 'temporary-directory' }),
  MEOWBOX_RPP_NETWORK: Object.freeze({ required: true, value: 'disabled' }),
  MEOWBOX_RPP_ALLOW_NETWORK: Object.freeze({ forbidden: true }),
  MEOWBOX_RPP_REAL_HOSTS: Object.freeze({ kind: 'deny-list' }),
  MEOWBOX_RPP_REAL_PANEL_ORIGIN: Object.freeze({ kind: 'deny-list' }),
  MEOWBOX_RPP_REAL_TARGET_ORIGINS: Object.freeze({ kind: 'deny-list' }),
  MEOWBOX_RPP_PRODUCTION_ADDRESSES: Object.freeze({ kind: 'deny-list' }),
  MEOWBOX_RPP_DNS_MAP: Object.freeze({ kind: 'static-dns-json' }),
});

export const FIXTURE_MODE = 'rpp-020';
export const FIXTURE_NETWORK_MODE = 'disabled';

// These are deny-listed even when a caller accidentally supplies a path that is
// lexically inside a temporary directory through a symlink.
export const PROTECTED_PRODUCTION_ROOTS = Object.freeze([
  '/opt/meowbox',
  '/var/www',
  '/var/lib/mysql',
  '/var/lib/postgresql',
  '/etc/nginx',
  '/etc/php',
  '/run/meowbox',
  '/srv/meowbox',
]);

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const FIXTURE_HOST_SUFFIX = '.rpp.test';
const MAX_DNS_HOSTS = 128;
const MAX_DNS_ANSWERS_PER_FAMILY = 16;
const MAX_DENY_LIST_ENTRIES = 128;

export class FixtureSafetyError extends Error {
  constructor(code, message, details = undefined) {
    super(`${code}: ${message}`);
    this.name = 'FixtureSafetyError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = undefined) {
  throw new FixtureSafetyError(code, message, details);
}

function assertText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('INVALID_TEXT', `${label} must be a non-empty string`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    fail('CONTROL_CHARACTER', `${label} contains a control character`);
  }
  return value;
}

function isWithin(candidate, parent) {
  const child = relative(parent, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function hasParentSegment(value) {
  return value.split(/[\\/]+/u).some((segment) => segment === '..');
}

function normalizedRoot(value) {
  return resolve(assertText(value, 'temporary root'));
}

function assertProtectedRoot(candidate) {
  for (const protectedRoot of PROTECTED_PRODUCTION_ROOTS) {
    if (isWithin(candidate, resolve(protectedRoot))) {
      fail('PRODUCTION_PATH', 'fixture paths cannot use a production root');
    }
  }
}

/**
 * Lexically validates a path.  The asynchronous variant below additionally
 * resolves existing symlinks before a fixture directory is materialized.
 */
export function assertSafeFixturePath(value, { label = 'fixture path', tempRoot = tmpdir() } = {}) {
  const raw = assertText(value, label);
  if (!isAbsolute(raw)) {
    fail('NON_ABSOLUTE_PATH', `${label} must be absolute`);
  }
  if (hasParentSegment(raw)) {
    fail('PATH_TRAVERSAL', `${label} cannot contain a parent segment`);
  }

  const candidate = resolve(raw);
  const temporaryRoot = normalizedRoot(tempRoot);
  if (candidate === temporaryRoot) {
    fail('BROAD_TEMP_ROOT', `${label} cannot be the temporary directory itself`);
  }
  if (!isWithin(candidate, temporaryRoot)) {
    fail('NON_TEMP_PATH', `${label} must be below the operating-system temporary directory`);
  }
  assertProtectedRoot(candidate);
  return candidate;
}

async function nearestExistingPath(candidate) {
  let current = candidate;
  while (true) {
    try {
      await stat(current);
      return current;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        fail('PATH_NOT_RESOLVABLE', 'fixture path has no existing ancestor');
      }
      current = parent;
    }
  }
}

async function assertNoSymlinkComponents(candidate, temporaryRoot) {
  const components = relative(temporaryRoot, candidate)
    .split(sep)
    .filter(Boolean);
  let current = temporaryRoot;
  for (const component of components) {
    current = resolve(current, component);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        fail('SYMLINK_PATH', 'fixture roots cannot contain symbolic-link components');
      }
    } catch (error) {
      if (error instanceof FixtureSafetyError) throw error;
      if (error?.code !== 'ENOENT') throw error;
      // A non-existent descendant cannot be a symlink yet; its later creation
      // is performed only by the fixture materializer below the checked root.
      break;
    }
  }
}

/**
 * Validates a root before creating files.  Existing symlinks are canonicalized
 * so a temporary-looking path cannot escape to /opt/meowbox or another host
 * state directory.
 */
export async function assertSafeFixtureRoot(value, { label = 'fixture root' } = {}) {
  const candidate = assertSafeFixturePath(value, { label });
  const temporaryRoot = resolve(await realpath(tmpdir()));
  await assertNoSymlinkComponents(candidate, temporaryRoot);
  const existingCandidate = await nearestExistingPath(candidate);
  const canonicalAncestor = resolve(await realpath(existingCandidate));
  const canonicalCandidate = resolve(
    canonicalAncestor,
    relative(existingCandidate, candidate),
  );

  if (!isWithin(canonicalCandidate, temporaryRoot)) {
    fail('SYMLINK_ESCAPE', `${label} resolves outside the temporary directory`);
  }
  assertProtectedRoot(canonicalCandidate);

  try {
    const metadata = await stat(candidate);
    if (!metadata.isDirectory()) {
      fail('ROOT_NOT_DIRECTORY', `${label} is not a directory`);
    }
  } catch (error) {
    if (error instanceof FixtureSafetyError) {
      throw error;
    }
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  return candidate;
}

/**
 * Validates the parent used by mkdtemp before any directory is created. This
 * matters when TMPDIR itself is a symlink or has been pointed at production.
 */
export async function assertSafeFixtureTempBase() {
  const configured = resolve(tmpdir());
  const canonical = resolve(await realpath(configured));
  if (canonical === resolve('/')) {
    fail('BROAD_TEMP_ROOT', 'operating-system temporary directory cannot be the filesystem root');
  }
  assertProtectedRoot(canonical);
  const metadata = await stat(canonical);
  if (!metadata.isDirectory()) {
    fail('TEMP_ROOT_NOT_DIRECTORY', 'operating-system temporary directory is not a directory');
  }
  return canonical;
}

function normalizeHost(value, label = 'host') {
  const raw = assertText(value, label).trim().toLowerCase();
  if (raw.length === 0 || raw.includes('/') || raw.includes('\\') || raw.includes('@')) {
    fail('INVALID_HOST', `${label} is not a host name`);
  }
  const unbracketed = raw.startsWith('[') && raw.endsWith(']')
    ? raw.slice(1, -1)
    : raw;
  if (unbracketed.endsWith('.')) {
    return unbracketed.slice(0, -1);
  }
  return unbracketed;
}

function isFixtureHostname(hostname) {
  if (hostname === 'localhost') return true;
  if (!hostname.endsWith(FIXTURE_HOST_SUFFIX) || hostname.length > 253) return false;
  return hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label));
}

function parseIpv4(address) {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) {
    return undefined;
  }
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) {
    return undefined;
  }
  return octets;
}

function ipv4In(octets, first, second = undefined) {
  return octets[0] === first && (second === undefined || octets[1] === second);
}

function expandIpv6(address) {
  const normalized = address.toLowerCase();
  if (normalized.includes('%')) {
    return undefined;
  }
  const [head, tail] = normalized.split('::');
  if (normalized.split('::').length > 2) {
    return undefined;
  }

  const parsePart = (part) => {
    if (part.length === 0) return [];
    const pieces = part.split(':');
    const result = [];
    for (const piece of pieces) {
      if (piece.includes('.')) {
        const ipv4 = parseIpv4(piece);
        if (!ipv4) return undefined;
        result.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      } else if (/^[0-9a-f]{1,4}$/u.test(piece)) {
        result.push(Number.parseInt(piece, 16));
      } else {
        return undefined;
      }
    }
    return result;
  };

  const left = parsePart(head);
  const right = parsePart(tail ?? '');
  if (!left || !right) return undefined;
  if (tail === undefined) {
    return left.length === 8 ? left : undefined;
  }
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function ipv6StartsWith(words, high, bits) {
  const value = words[0] ?? 0;
  return (value >>> (16 - bits)) === (high >>> (16 - bits));
}

function ipv6IsMapped(words) {
  return words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
}

function ipv6MappedIpv4(words) {
  return [words[6] >>> 8, words[6] & 0xff, words[7] >>> 8, words[7] & 0xff].join('.');
}

function normalizeAddress(address) {
  const value = assertText(address, 'DNS answer').trim();
  if (isIP(value) === 0) {
    fail('INVALID_DNS_ANSWER', 'DNS answer is not an IPv4 or IPv6 address');
  }
  return value.toLowerCase();
}

function parseCidr(value) {
  const [address, prefixText] = value.split('/');
  const family = isIP(address);
  if (family === 0 || !/^\d{1,3}$/u.test(prefixText ?? '')) return undefined;
  const prefix = Number(prefixText);
  if ((family === 4 && prefix > 32) || (family === 6 && prefix > 128)) return undefined;
  return { address: normalizeAddress(address), family, prefix };
}

function addressInCidr(address, cidr) {
  const family = isIP(address);
  if (family !== cidr.family) return false;
  if (family === 4) {
    const left = parseIpv4(address);
    const right = parseIpv4(cidr.address);
    if (!left || !right) return false;
    const leftValue = left.reduce((result, octet) => (result << 8) | octet, 0) >>> 0;
    const rightValue = right.reduce((result, octet) => (result << 8) | octet, 0) >>> 0;
    const mask = cidr.prefix === 0 ? 0 : (0xffffffff << (32 - cidr.prefix)) >>> 0;
    return (leftValue & mask) === (rightValue & mask);
  }
  const left = expandIpv6(address);
  const right = expandIpv6(cidr.address);
  if (!left || !right) return false;
  const words = Math.floor(cidr.prefix / 16);
  const remaining = cidr.prefix % 16;
  for (let index = 0; index < words; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  if (remaining === 0) return true;
  const mask = (0xffff << (16 - remaining)) & 0xffff;
  return (left[words] & mask) === (right[words] & mask);
}

function normalizeAddressDenyList(values) {
  const entries = Array.isArray(values) ? values : String(values ?? '').split(/[\s,]+/u);
  const normalized = [];
  for (const entry of entries) {
    if (entry === '') continue;
    if (entry && typeof entry === 'object' && 'address' in entry && 'family' in entry && 'prefix' in entry) {
      const family = Number(entry.family);
      const prefix = Number(entry.prefix);
      if (![4, 6].includes(family) || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
        fail('INVALID_PRODUCTION_ADDRESS', 'production address deny-list entry is invalid');
      }
      normalized.push({
        address: normalizeAddress(String(entry.address)),
        family,
        prefix,
      });
      continue;
    }
    const text = assertText(String(entry), 'production address').trim();
    if (isIP(text) !== 0) {
      normalized.push({ address: normalizeAddress(text), family: isIP(text), prefix: isIP(text) === 4 ? 32 : 128 });
      continue;
    }
    const cidr = parseCidr(text);
    if (!cidr) fail('INVALID_PRODUCTION_ADDRESS', 'production address deny-list entry is invalid');
    normalized.push(cidr);
  }
  if (normalized.length > MAX_DENY_LIST_ENTRIES) {
    fail('DENY_LIST_TOO_LARGE', 'production address deny-list is too large');
  }
  return normalized;
}

/**
 * Classifies an address without consulting the network.  Public addresses are
 * never accepted as fixture answers. Private answers are only usable by the
 * explicitly disabled private-topology probe.
 */
export function classifyFixtureAddress(address, { productionAddresses = [] } = {}) {
  const normalized = normalizeAddress(address);
  const denyList = normalizeAddressDenyList(productionAddresses);
  if (denyList.some((cidr) => addressInCidr(normalized, cidr))) {
    return 'production';
  }

  const family = isIP(normalized);
  if (family === 4) {
    const octets = parseIpv4(normalized);
    if (!octets) return 'invalid';
    if (ipv4In(octets, 0)) return 'unspecified';
    if (ipv4In(octets, 127)) return 'loopback';
    if (ipv4In(octets, 10) || ipv4In(octets, 172) && octets[1] >= 16 && octets[1] <= 31 || ipv4In(octets, 192, 168)) return 'private';
    if (ipv4In(octets, 169, 254)) return octets[2] === 169 && octets[3] === 254 ? 'metadata' : 'link-local';
    if (ipv4In(octets, 100) && octets[1] >= 64 && octets[1] <= 127) return 'cgnat';
    if (ipv4In(octets, 192, 0, undefined) && octets[2] === 2) return 'documentation';
    if (ipv4In(octets, 198, 51) && octets[2] === 100) return 'documentation';
    if (ipv4In(octets, 203, 0) && octets[2] === 113) return 'documentation';
    if (octets[0] >= 224 && octets[0] <= 255) return octets[0] === 255 ? 'reserved' : 'multicast';
    return 'public';
  }

  const words = expandIpv6(normalized);
  if (!words) return 'invalid';
  if (ipv6IsMapped(words)) return classifyFixtureAddress(ipv6MappedIpv4(words), { productionAddresses });
  if (words.every((word) => word === 0)) return 'unspecified';
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return 'loopback';
  if (ipv6StartsWith(words, 0xfc00, 7)) return 'private';
  if (ipv6StartsWith(words, 0xfe80, 10)) return 'link-local';
  if (ipv6StartsWith(words, 0xff00, 8)) return 'multicast';
  if (addressInCidr(normalized, { address: '2001:db8::', family: 6, prefix: 32 })) return 'documentation';
  return 'public';
}

export function assertFixtureAddress(address, { allowPrivate = false, productionAddresses = [] } = {}) {
  const classification = classifyFixtureAddress(address, { productionAddresses });
  const allowed = classification === 'loopback' || classification === 'documentation' || (allowPrivate && classification === 'private');
  if (!allowed) {
    fail('UNSAFE_DNS_ANSWER', 'fixture DNS answers must be loopback/documentation addresses; private topology is disabled unless explicitly probing it', { classification });
  }
  return { address: normalizeAddress(address), classification, dialable: classification !== 'private' };
}

export function parseFixtureOrigin(input, {
  label = 'fixture origin',
  protectedHosts = [],
  productionAddresses = [],
  allowPrivate = false,
  allowedProtocols = ['http:', 'https:', 'ws:', 'wss:'],
} = {}) {
  const raw = assertText(input, label);
  if (raw !== raw.trim()) {
    fail('ORIGIN_WHITESPACE', `${label} cannot contain leading or trailing whitespace`);
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail('INVALID_ORIGIN', `${label} is not a valid URL`);
  }
  if (!allowedProtocols.includes(parsed.protocol)) {
    fail('UNSAFE_ORIGIN_PROTOCOL', `${label} uses a protocol outside the fixture allow-list`);
  }
  if (parsed.username || parsed.password) {
    fail('ORIGIN_CREDENTIALS', `${label} cannot contain credentials`);
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    fail('ORIGIN_COMPONENTS', `${label} must contain only scheme, host, and optional port`);
  }

  const hostname = normalizeHost(parsed.hostname, label);
  const protectedSet = new Set(normalizeProtectedHosts(protectedHosts));
  if (protectedSet.has(hostname)) {
    fail('REAL_CONFIGURED_HOST', `${label} matches a configured panel/target host`);
  }
  const family = isIP(hostname);
  if (family !== 0) {
    assertFixtureAddress(hostname, { allowPrivate, productionAddresses });
  } else if (!isFixtureHostname(hostname)) {
    fail('NON_FIXTURE_HOST', `${label} must use a *.rpp.test or localhost host`);
  }

  const port = parsed.port === ''
    ? (parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 443 : 80)
    : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    fail('UNSAFE_PORT', `${label} must use an unprivileged fixture port`);
  }
  const formattedHost = family === 6 ? `[${hostname}]` : hostname;
  const explicitPort = parsed.port === '' ? '' : `:${port}`;
  return Object.freeze({
    input: raw,
    origin: `${parsed.protocol}//${formattedHost}${explicitPort}`,
    protocol: parsed.protocol,
    hostname,
    port,
    isIpLiteral: family !== 0,
  });
}

export const assertSafeFixtureOrigin = parseFixtureOrigin;

function parseList(value, label) {
  if (value === undefined || value === null || value === '') return [];
  let entries;
  if (Array.isArray(value)) {
    entries = value;
  } else if (String(value).trim().startsWith('[')) {
    try {
      entries = JSON.parse(String(value));
    } catch {
      fail('INVALID_LIST', `${label} must be a comma-separated list or JSON array`);
    }
    if (!Array.isArray(entries)) fail('INVALID_LIST', `${label} JSON value must be an array`);
  } else {
    entries = String(value).split(/[\s,]+/u);
  }
  if (entries.length > MAX_DENY_LIST_ENTRIES) {
    fail('DENY_LIST_TOO_LARGE', `${label} has too many entries`);
  }
  return entries.map((entry) => assertText(String(entry), label).trim()).filter(Boolean);
}

export function normalizeProtectedHosts(values = []) {
  const result = new Set();
  for (const value of parseList(values, 'configured host')) {
    let host = value;
    try {
      if (value.includes('://')) host = new URL(value).hostname;
      else if (/^\[[^\]]+\]:\d+$/u.test(value)) host = value.slice(1, value.lastIndexOf(']:'));
      else if (/^[^:]+:\d+$/u.test(value)) host = value.slice(0, value.lastIndexOf(':'));
    } catch {
      fail('INVALID_CONFIGURED_ORIGIN', 'configured panel/target origin is invalid');
    }
    result.add(normalizeHost(host, 'configured host'));
  }
  return [...result];
}

function parseDnsFamilyAnswers(value, label, expectedFamily = undefined) {
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value];
  if (entries.length > MAX_DNS_ANSWERS_PER_FAMILY) {
    fail('DNS_MAP_TOO_LARGE', `${label} has too many answers`);
  }
  return entries.map((entry) => {
    const address = normalizeAddress(String(entry));
    if (expectedFamily !== undefined && isIP(address) !== expectedFamily) {
      fail('DNS_FAMILY_MISMATCH', `${label} contains an answer from the wrong address family`);
    }
    return address;
  });
}

export function parseStaticDnsMap(value) {
  if (value === undefined || value === null || value === '') return {};
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      fail('INVALID_DNS_MAP', 'static fixture DNS map must be valid JSON');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('INVALID_DNS_MAP', 'static fixture DNS map must be an object');
  }
  const entries = Object.entries(parsed);
  if (entries.length > MAX_DNS_HOSTS) {
    fail('DNS_MAP_TOO_LARGE', 'static fixture DNS map has too many hosts');
  }
  const result = {};
  for (const [rawHost, rawAnswers] of entries) {
    const host = normalizeHost(rawHost, 'DNS map host');
    if (!isFixtureHostname(host)) {
      fail('NON_FIXTURE_HOST', 'static fixture DNS map contains a non-fixture host');
    }
    const families = Array.isArray(rawAnswers) ? { A: rawAnswers, AAAA: [] } : rawAnswers;
    if (!families || typeof families !== 'object') {
      fail('INVALID_DNS_MAP', 'DNS map host entry must contain A/AAAA answers');
    }
    result[host] = Object.freeze({
      A: Object.freeze(parseDnsFamilyAnswers(families.A, `${host} A`, 4)),
      AAAA: Object.freeze(parseDnsFamilyAnswers(families.AAAA, `${host} AAAA`, 6)),
    });
  }
  return Object.freeze(result);
}

export function createStaticFixtureResolver(value) {
  const map = parseStaticDnsMap(value);
  const resolveFamily = (family) => async (host) => {
    const normalized = normalizeHost(host, 'DNS query host');
    const answers = map[normalized]?.[family] ?? [];
    return [...answers];
  };
  return Object.freeze({ resolve4: resolveFamily('A'), resolve6: resolveFamily('AAAA') });
}

/**
 * Resolve every fixture hostname through an injected resolver.  There is no
 * fallback to node:dns: an absent resolver is a hard failure, which keeps tests
 * and fixture invocations non-networked by construction.
 */
export async function resolveFixtureOrigins(origins, {
  resolver,
  protectedHosts = [],
  productionAddresses = [],
  allowPrivate = false,
} = {}) {
  if (!Array.isArray(origins) || origins.length === 0) {
    fail('NO_FIXTURE_ORIGINS', 'at least one fixture origin is required');
  }
  const parsedOrigins = origins.map((origin, index) => parseFixtureOrigin(origin, {
    label: `fixture origin ${index + 1}`,
    protectedHosts,
    productionAddresses,
    allowPrivate,
  }));
  const hosts = [...new Set(parsedOrigins.map(({ hostname }) => hostname))];
  const resolved = [];
  for (const hostname of hosts) {
    const literalFamily = isIP(hostname);
    const answers = literalFamily === 0
      ? await resolveHostname(hostname, resolver)
      : { A: literalFamily === 4 ? [hostname] : [], AAAA: literalFamily === 6 ? [hostname] : [] };
    const allAnswers = [...answers.A, ...answers.AAAA];
    if (allAnswers.length === 0) {
      fail('DNS_UNRESOLVED', 'fixture hostname has no A or AAAA answers');
    }
    const checked = allAnswers.map((address) => assertFixtureAddress(address, {
      allowPrivate,
      productionAddresses,
    }));
    resolved.push(Object.freeze({
      hostname,
      A: Object.freeze(answers.A.map((address) => normalizeAddress(address))),
      AAAA: Object.freeze(answers.AAAA.map((address) => normalizeAddress(address))),
      answers: Object.freeze(checked),
      dialable: checked.every(({ dialable }) => dialable),
      privateProbe: checked.some(({ classification }) => classification === 'private'),
    }));
  }
  return Object.freeze({
    origins: Object.freeze(parsedOrigins),
    hosts: Object.freeze(resolved),
  });
}

async function resolveHostname(hostname, resolver) {
  if (!resolver || typeof resolver.resolve4 !== 'function' || typeof resolver.resolve6 !== 'function') {
    fail('NETWORK_RESOLVER_REQUIRED', 'fixture DNS resolution requires injected resolve4 and resolve6 functions');
  }
  const [rawA, rawAAAA] = await Promise.all([
    resolver.resolve4(hostname),
    resolver.resolve6(hostname),
  ]);
  const A = parseDnsFamilyAnswers(rawA, `${hostname} A`, 4);
  const AAAA = parseDnsFamilyAnswers(rawAAAA, `${hostname} AAAA`, 6);
  return { A, AAAA };
}

function configuredDenyList(environment) {
  return normalizeProtectedHosts([
    ...parseList(environment.MEOWBOX_RPP_REAL_HOSTS, 'configured host'),
    ...parseList(environment.MEOWBOX_RPP_REAL_PANEL_ORIGIN, 'configured panel origin'),
    ...parseList(environment.MEOWBOX_RPP_REAL_TARGET_ORIGINS, 'configured target origin'),
  ]);
}

export function parseFixtureEnvironment(environment = {}) {
  const mode = environment.MEOWBOX_RPP_FIXTURE_MODE;
  if (mode !== FIXTURE_MODE) {
    fail('FIXTURE_MODE_REQUIRED', 'MEOWBOX_RPP_FIXTURE_MODE must be exactly rpp-020');
  }
  if (environment.MEOWBOX_RPP_NETWORK !== FIXTURE_NETWORK_MODE) {
    fail('NETWORK_DISABLED_REQUIRED', 'MEOWBOX_RPP_NETWORK must be exactly disabled');
  }
  if (['1', 'true', 'yes', 'on'].includes(String(environment.MEOWBOX_RPP_ALLOW_NETWORK ?? '').toLowerCase())) {
    fail('NETWORK_FORBIDDEN', 'network access is forbidden for RPP-020 fixtures');
  }
  if (String(environment.NODE_ENV ?? '').toLowerCase() === 'production' || String(environment.MEOWBOX_ENV ?? '').toLowerCase() === 'production') {
    fail('PRODUCTION_ENVIRONMENT', 'RPP-020 fixtures cannot run in a production environment');
  }

  const root = assertSafeFixturePath(environment.MEOWBOX_RPP_ROOT, { label: 'MEOWBOX_RPP_ROOT' });
  return Object.freeze({
    mode,
    network: FIXTURE_NETWORK_MODE,
    root,
    protectedHosts: Object.freeze(configuredDenyList(environment)),
    productionAddresses: Object.freeze(normalizeAddressDenyList(environment.MEOWBOX_RPP_PRODUCTION_ADDRESSES)),
    dnsMap: parseStaticDnsMap(environment.MEOWBOX_RPP_DNS_MAP),
  });
}

export async function validateFixtureEnvironment(environment = {}, options = {}) {
  const parsed = parseFixtureEnvironment(environment);
  await assertSafeFixtureRoot(parsed.root, { label: 'MEOWBOX_RPP_ROOT' });
  const protectedHosts = normalizeProtectedHosts([
    ...parsed.protectedHosts,
    ...(options.protectedHosts ?? []),
  ]);
  const productionAddresses = normalizeAddressDenyList([
    ...parsed.productionAddresses,
    ...(options.productionAddresses ?? []),
  ]);
  const origins = options.origins ?? [];
  if (origins.length > 0 && options.resolver === undefined && Object.keys(parsed.dnsMap).length === 0) {
    fail('NETWORK_RESOLVER_REQUIRED', 'fixture origins require a static DNS map or an injected resolver');
  }
  const resolver = options.resolver ?? createStaticFixtureResolver(parsed.dnsMap);
  const resolution = origins.length > 0
    ? await resolveFixtureOrigins(origins, { resolver, protectedHosts, productionAddresses, allowPrivate: options.allowPrivate === true })
    : undefined;
  return Object.freeze({ ...parsed, protectedHosts: Object.freeze(protectedHosts), productionAddresses: Object.freeze(productionAddresses), resolution });
}
