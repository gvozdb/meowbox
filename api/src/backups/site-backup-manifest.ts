import { createHash } from 'crypto';
import * as path from 'path';
import {
  DatabasePurpose,
  DatabaseType,
  DomainApplicationStatus,
  SiteType,
} from '../common/enums';
import {
  parseSiteAliases,
  stringifySiteAliases,
} from '../common/json-array';
import {
  canonicalizeHostname,
  normalizeFilesRelPath,
  runtimeKeyForDomain,
  validateEnvVars,
} from '../sites/domain-validation';

export const SITE_BACKUP_MANIFEST_VERSION = 2 as const;
export const SITE_BACKUP_SCHEMA_VERSION = 'domain-applications-v2' as const;
export const SITE_BACKUP_MANIFEST_MAX_BYTES = 1024 * 1024;

const SITE_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const RUNTIME_KEY_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const DATABASE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DATABASE_USER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PHP_VERSION_RE = /^\d+\.\d+$/;

const PRESETS = new Set<string>(Object.values(SiteType));
const APP_STATUSES = new Set<string>(Object.values(DomainApplicationStatus));
const DATABASE_TYPES = new Set<string>(Object.values(DatabaseType));
const DATABASE_PURPOSES = new Set<string>(Object.values(DatabasePurpose));

export interface SiteBackupManifestSite {
  sourceId: string;
  name: string;
  displayName: string | null;
  status: string;
  errorMessage: string | null;
  rootPath: string;
  nginxConfigPath: string;
  systemUser: string | null;
  sshPasswordEnc: string | null;
  backupExcludes: string | null;
  backupExcludeTables: string | null;
  metadata: string | null;
}

export interface SiteBackupManifestDomain {
  sourceId: string;
  domain: string;
  isPrimary: boolean;
  position: number;
  aliases: string;
  filesRelPath: string;
  preset: string;
  appStatus: string;
  appErrorMessage: string | null;
  phpVersion: string | null;
  phpPoolCustom: string | null;
  runtimeKey: string;
  gitRepository: string | null;
  deployBranch: string | null;
  envVars: string;
  cmsAdminUser: string | null;
  cmsAdminPasswordEnc: string | null;
  managerPath: string | null;
  connectorsPath: string | null;
  cmsTablePrefix: string | null;
  modxVersion: string | null;
  appPort: number | null;
  httpsRedirect: boolean;
  nginxClientMaxBodySize: string | null;
  nginxFastcgiReadTimeout: number | null;
  nginxFastcgiSendTimeout: number | null;
  nginxFastcgiConnectTimeout: number | null;
  nginxFastcgiBufferSizeKb: number | null;
  nginxFastcgiBufferCount: number | null;
  nginxHttp2: boolean;
  nginxHsts: boolean;
  nginxGzip: boolean;
  nginxRateLimitEnabled: boolean;
  nginxRateLimitRps: number | null;
  nginxRateLimitBurst: number | null;
  nginxCustomConfig: string | null;
}

export interface SiteBackupManifestDatabase {
  sourceId: string;
  sourceSiteDomainId: string;
  name: string;
  type: string;
  dbUser: string;
  dbPasswordHash: string;
  dbPasswordEnc: string | null;
  purpose: string;
}

export interface SiteBackupManifestRoot {
  filesRelPath: string;
  siteDomainIds: string[];
}

export interface SiteBackupManifestV2 {
  manifestVersion: typeof SITE_BACKUP_MANIFEST_VERSION;
  schemaVersion: typeof SITE_BACKUP_SCHEMA_VERSION;
  createdAt: string;
  site: SiteBackupManifestSite;
  domains: SiteBackupManifestDomain[];
  databases: SiteBackupManifestDatabase[];
  roots: SiteBackupManifestRoot[];
  content: {
    backupType: string;
    includedDatabaseIds: string[];
  };
  checksum: string;
}

export interface SiteBackupManifestSource {
  id: string;
  name: string;
  displayName: string | null;
  status: string;
  errorMessage: string | null;
  rootPath: string;
  nginxConfigPath: string;
  systemUser: string | null;
  sshPasswordEnc: string | null;
  backupExcludes: string | null;
  backupExcludeTables: string | null;
  metadata: string | null;
  domains: SiteBackupManifestDomainSource[];
  databases: SiteBackupManifestDatabaseSource[];
}

export interface SiteBackupManifestDomainSource
  extends Omit<SiteBackupManifestDomain, 'sourceId'> {
  id: string;
}

export interface SiteBackupManifestDatabaseSource
  extends Omit<
    SiteBackupManifestDatabase,
    'sourceId' | 'sourceSiteDomainId'
  > {
  id: string;
  siteDomainId: string;
}

export function buildSiteBackupManifest(params: {
  site: SiteBackupManifestSource;
  backupType: string;
  includedDatabaseIds: string[];
  createdAt?: Date;
}): SiteBackupManifestV2 {
  const domains = [...params.site.domains]
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map(({ id, ...domain }) => ({ sourceId: id, ...domain }));
  const databases = [...params.site.databases]
    .sort(
      (a, b) =>
        a.siteDomainId.localeCompare(b.siteDomainId) ||
        a.type.localeCompare(b.type) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    )
    .map(({ id, siteDomainId, ...database }) => ({
      sourceId: id,
      sourceSiteDomainId: siteDomainId,
      ...database,
    }));
  const withoutChecksum = {
    manifestVersion: SITE_BACKUP_MANIFEST_VERSION,
    schemaVersion: SITE_BACKUP_SCHEMA_VERSION,
    createdAt: (params.createdAt || new Date()).toISOString(),
    site: {
      sourceId: params.site.id,
      name: params.site.name,
      displayName: params.site.displayName,
      status: params.site.status,
      errorMessage: params.site.errorMessage,
      rootPath: params.site.rootPath,
      nginxConfigPath: params.site.nginxConfigPath,
      systemUser: params.site.systemUser,
      sshPasswordEnc: params.site.sshPasswordEnc,
      backupExcludes: params.site.backupExcludes,
      backupExcludeTables: params.site.backupExcludeTables,
      metadata: params.site.metadata,
    },
    domains,
    databases,
    roots: buildRoots(domains),
    content: {
      backupType: params.backupType,
      includedDatabaseIds: [...new Set(params.includedDatabaseIds)].sort(),
    },
  };
  return normalizeSiteBackupManifest({
    ...withoutChecksum,
    checksum: manifestChecksum(withoutChecksum),
  });
}

export function parseSiteBackupManifest(raw: string): SiteBackupManifestV2 {
  if (
    typeof raw !== 'string' ||
    Buffer.byteLength(raw, 'utf8') > SITE_BACKUP_MANIFEST_MAX_BYTES
  ) {
    throw new Error('Backup manifest is missing or too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Backup manifest is not valid JSON');
  }
  return normalizeSiteBackupManifest(parsed);
}

export function stringifySiteBackupManifest(
  manifest: SiteBackupManifestV2,
): string {
  const normalized = normalizeSiteBackupManifest(manifest);
  const serialized = stableJson(normalized);
  if (Buffer.byteLength(serialized, 'utf8') > SITE_BACKUP_MANIFEST_MAX_BYTES) {
    throw new Error('Backup manifest exceeds size limit');
  }
  return serialized;
}

export function normalizeSiteBackupManifest(
  input: unknown,
): SiteBackupManifestV2 {
  const raw = record(input, 'Backup manifest');
  const version = integer(raw.manifestVersion, 1);
  if (version !== 1 && version !== SITE_BACKUP_MANIFEST_VERSION) {
    throw new Error(`Unsupported backup manifest version: ${version}`);
  }
  if (version === SITE_BACKUP_MANIFEST_VERSION) {
    if (raw.schemaVersion !== SITE_BACKUP_SCHEMA_VERSION) {
      throw new Error('Unsupported backup manifest schema version');
    }
    const suppliedChecksum = text(raw.checksum, 'checksum', 64);
    const payload = { ...raw };
    delete payload.checksum;
    if (
      !/^[a-f0-9]{64}$/.test(suppliedChecksum) ||
      manifestChecksum(payload) !== suppliedChecksum
    ) {
      throw new Error('Backup manifest checksum mismatch');
    }
  }

  const rawSite = record(raw.site, 'Backup manifest Site');
  const sourceSiteId =
    optionalId(rawSite.sourceId) ||
    optionalId(rawSite.id) ||
    'legacy-site';
  const siteName = text(rawSite.name, 'Site name', 32);
  if (!SITE_NAME_RE.test(siteName)) {
    throw new Error('Backup manifest has invalid Site name');
  }
  const rootPath = absolutePath(rawSite.rootPath, 'Site rootPath');
  const nginxConfigPath = absolutePath(
    rawSite.nginxConfigPath || `/etc/nginx/sites-available/${siteName}.conf`,
    'Site nginxConfigPath',
  );
  const site: SiteBackupManifestSite = {
    sourceId: sourceSiteId,
    name: siteName,
    displayName: nullableText(rawSite.displayName, 256),
    status: nullableText(rawSite.status, 32) || 'RUNNING',
    errorMessage: nullableText(rawSite.errorMessage, 2_000),
    rootPath,
    nginxConfigPath,
    systemUser: nullableText(rawSite.systemUser, 64),
    sshPasswordEnc: nullableText(rawSite.sshPasswordEnc, 16_384),
    backupExcludes: nullableJsonArray(rawSite.backupExcludes),
    backupExcludeTables: nullableJsonArray(rawSite.backupExcludeTables),
    metadata: nullableJsonObject(rawSite.metadata),
  };

  const rawDomains = Array.isArray(raw.domains)
    ? raw.domains.map((domain, index) =>
        record(domain, `Backup manifest domain ${index}`),
      )
    : [];
  if (rawDomains.length === 0 && typeof rawSite.domain === 'string') {
    rawDomains.push({
      domain: rawSite.domain,
      aliases: rawSite.aliases,
      isPrimary: true,
      position: 0,
    });
  }
  if (rawDomains.length === 0 || rawDomains.length > 128) {
    throw new Error('Backup manifest must contain 1-128 domains');
  }
  const explicitPrimaries = rawDomains
    .map((domain, index) => (domain.isPrimary === true ? index : -1))
    .filter((index) => index >= 0);
  if (version === 2 && explicitPrimaries.length !== 1) {
    throw new Error('Backup manifest must contain exactly one primary domain');
  }
  const primaryIndex = explicitPrimaries[0] ?? 0;
  const domains = rawDomains
    .map((domain, index) =>
      normalizeDomain(domain, rawSite, index, primaryIndex, version === 1),
    )
    .sort(
      (a, b) =>
        Number(b.isPrimary) - Number(a.isPrimary) ||
        a.position - b.position ||
        a.sourceId.localeCompare(b.sourceId),
    )
    .map((domain, position) => ({
      ...domain,
      isPrimary: position === 0,
      position,
    }));
  validateDomainSet(domains);

  const domainIds = new Set(domains.map((domain) => domain.sourceId));
  const primary = domains[0];
  const rawDatabases = Array.isArray(raw.databases)
    ? raw.databases.map((database, index) =>
        record(database, `Backup manifest database ${index}`),
      )
    : [];
  if (rawDatabases.length > 512) {
    throw new Error('Backup manifest contains too many databases');
  }
  const databases = rawDatabases
    .map((database, index) =>
      normalizeDatabase(database, index, primary, domains, version === 1),
    )
    .sort(
      (a, b) =>
        a.sourceSiteDomainId.localeCompare(b.sourceSiteDomainId) ||
        a.type.localeCompare(b.type) ||
        a.name.localeCompare(b.name) ||
        a.sourceId.localeCompare(b.sourceId),
    );
  validateDatabaseSet(databases, domains, domainIds);

  const rawContent = isRecord(raw.content) ? raw.content : {};
  const includedIdsRaw = Array.isArray(rawContent.includedDatabaseIds)
    ? rawContent.includedDatabaseIds
    : databases.map((database) => database.sourceId);
  const includedDatabaseIds = [
    ...new Set(
      includedIdsRaw.map((value) => id(value, 'included database id')),
    ),
  ].sort();
  const databaseIds = new Set(
    databases.map((database) => database.sourceId),
  );
  if (includedDatabaseIds.some((databaseId) => !databaseIds.has(databaseId))) {
    throw new Error('Backup manifest includes an unknown database id');
  }

  const createdAt =
    nullableText(raw.createdAt, 64) || new Date(0).toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error('Backup manifest has invalid createdAt');
  }
  const withoutChecksum = {
    manifestVersion: SITE_BACKUP_MANIFEST_VERSION,
    schemaVersion: SITE_BACKUP_SCHEMA_VERSION,
    createdAt: new Date(createdAt).toISOString(),
    site,
    domains,
    databases,
    roots: buildRoots(domains),
    content: {
      backupType:
        nullableText(rawContent.backupType, 32) ||
        nullableText(raw.type, 32) ||
        'FULL',
      includedDatabaseIds,
    },
  };
  const normalized: SiteBackupManifestV2 = {
    ...withoutChecksum,
    checksum: manifestChecksum(withoutChecksum),
  };
  if (
    Buffer.byteLength(stableJson(normalized), 'utf8') >
    SITE_BACKUP_MANIFEST_MAX_BYTES
  ) {
    throw new Error('Backup manifest exceeds size limit');
  }
  return normalized;
}

export function manifestChecksum(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function normalizeDomain(
  raw: Record<string, unknown>,
  rawSite: Record<string, unknown>,
  index: number,
  primaryIndex: number,
  legacy: boolean,
): SiteBackupManifestDomain {
  const isPrimary = index === primaryIndex;
  const sourceId =
    optionalId(raw.sourceId) ||
    optionalId(raw.id) ||
    `legacy-domain-${index}`;
  const domain = canonicalizeHostname(text(raw.domain, 'domain', 253));
  const aliases = parseAliases(raw.aliases);
  const filesRelPath = normalizeFilesRelPath(
    nullableText(raw.filesRelPath, 512) ||
      nullableText(rawSite.filesRelPath, 512) ||
      'www',
  );
  const presetValue = legacy
    ? isPrimary
      ? raw.preset ?? rawSite.type
      : SiteType.CUSTOM
    : raw.preset;
  const preset = nullableText(presetValue, 32) || SiteType.CUSTOM;
  if (!PRESETS.has(preset)) {
    throw new Error(`Backup manifest has invalid preset for "${domain}"`);
  }
  const runtimeKey =
    nullableText(raw.runtimeKey, 64) ||
    (isPrimary && RUNTIME_KEY_RE.test(String(rawSite.name || ''))
      ? String(rawSite.name)
      : runtimeKeyForDomain(sourceId));
  if (!RUNTIME_KEY_RE.test(runtimeKey)) {
    throw new Error(`Backup manifest has invalid runtimeKey for "${domain}"`);
  }
  const phpVersion = nullableText(
    legacy ? raw.phpVersion ?? rawSite.phpVersion : raw.phpVersion,
    16,
  );
  if (phpVersion && !PHP_VERSION_RE.test(phpVersion)) {
    throw new Error(`Backup manifest has invalid PHP version for "${domain}"`);
  }
  const rawAppStatus =
    nullableText(
      legacy ? raw.appStatus ?? rawSite.status : raw.appStatus,
      32,
    ) || DomainApplicationStatus.RUNNING;
  const appStatus = legacy
    ? rawAppStatus === DomainApplicationStatus.ERROR
      ? DomainApplicationStatus.ERROR
      : DomainApplicationStatus.RUNNING
    : rawAppStatus;
  if (!APP_STATUSES.has(appStatus)) {
    throw new Error(`Backup manifest has invalid appStatus for "${domain}"`);
  }
  const appPort = nullableInteger(
    legacy ? raw.appPort ?? rawSite.appPort : raw.appPort,
  );
  if (
    appPort !== null &&
    (appPort < 1024 || appPort > 65535)
  ) {
    throw new Error(`Backup manifest has invalid appPort for "${domain}"`);
  }
  const envVars = normalizeEnvVars(
    legacy && isPrimary ? raw.envVars ?? rawSite.envVars : raw.envVars,
  );
  return {
    sourceId,
    domain,
    isPrimary,
    position: isPrimary ? 0 : integer(raw.position, index),
    aliases: stringifySiteAliases(aliases),
    filesRelPath,
    preset,
    appStatus,
    appErrorMessage: nullableText(
      legacy ? raw.appErrorMessage ?? rawSite.errorMessage : raw.appErrorMessage,
      2_000,
    ),
    phpVersion,
    phpPoolCustom: nullableText(
      legacy ? raw.phpPoolCustom ?? rawSite.phpPoolCustom : raw.phpPoolCustom,
      256 * 1024,
    ),
    runtimeKey,
    gitRepository: nullableText(
      legacy && isPrimary
        ? raw.gitRepository ?? rawSite.gitRepository
        : raw.gitRepository,
      2_048,
    ),
    deployBranch: nullableText(
      legacy && isPrimary
        ? raw.deployBranch ?? rawSite.deployBranch
        : raw.deployBranch,
      256,
    ),
    envVars,
    cmsAdminUser: nullableText(
      legacy && isPrimary
        ? raw.cmsAdminUser ?? rawSite.cmsAdminUser
        : raw.cmsAdminUser,
      256,
    ),
    cmsAdminPasswordEnc: nullableText(
      legacy && isPrimary
        ? raw.cmsAdminPasswordEnc ?? rawSite.cmsAdminPasswordEnc
        : raw.cmsAdminPasswordEnc,
      16_384,
    ),
    managerPath: nullableText(
      legacy && isPrimary
        ? raw.managerPath ?? rawSite.managerPath
        : raw.managerPath,
      512,
    ),
    connectorsPath: nullableText(
      legacy && isPrimary
        ? raw.connectorsPath ?? rawSite.connectorsPath
        : raw.connectorsPath,
      512,
    ),
    cmsTablePrefix: nullableText(
      legacy && isPrimary
        ? raw.cmsTablePrefix ?? rawSite.cmsTablePrefix
        : raw.cmsTablePrefix,
      128,
    ),
    modxVersion: nullableText(
      legacy && isPrimary
        ? raw.modxVersion ?? rawSite.modxVersion
        : raw.modxVersion,
      64,
    ),
    appPort,
    httpsRedirect: boolean(
      legacy ? raw.httpsRedirect ?? rawSite.httpsRedirect : raw.httpsRedirect,
      true,
    ),
    nginxClientMaxBodySize: nullableText(
      legacy
        ? raw.nginxClientMaxBodySize ?? rawSite.nginxClientMaxBodySize
        : raw.nginxClientMaxBodySize,
      32,
    ),
    nginxFastcgiReadTimeout: nullableInteger(
      legacy
        ? raw.nginxFastcgiReadTimeout ?? rawSite.nginxFastcgiReadTimeout
        : raw.nginxFastcgiReadTimeout,
    ),
    nginxFastcgiSendTimeout: nullableInteger(
      legacy
        ? raw.nginxFastcgiSendTimeout ?? rawSite.nginxFastcgiSendTimeout
        : raw.nginxFastcgiSendTimeout,
    ),
    nginxFastcgiConnectTimeout: nullableInteger(
      legacy
        ? raw.nginxFastcgiConnectTimeout ?? rawSite.nginxFastcgiConnectTimeout
        : raw.nginxFastcgiConnectTimeout,
    ),
    nginxFastcgiBufferSizeKb: nullableInteger(
      legacy
        ? raw.nginxFastcgiBufferSizeKb ?? rawSite.nginxFastcgiBufferSizeKb
        : raw.nginxFastcgiBufferSizeKb,
    ),
    nginxFastcgiBufferCount: nullableInteger(
      legacy
        ? raw.nginxFastcgiBufferCount ?? rawSite.nginxFastcgiBufferCount
        : raw.nginxFastcgiBufferCount,
    ),
    nginxHttp2: boolean(
      legacy ? raw.nginxHttp2 ?? rawSite.nginxHttp2 : raw.nginxHttp2,
      true,
    ),
    nginxHsts: boolean(
      legacy ? raw.nginxHsts ?? rawSite.nginxHsts : raw.nginxHsts,
      false,
    ),
    nginxGzip: boolean(
      legacy ? raw.nginxGzip ?? rawSite.nginxGzip : raw.nginxGzip,
      true,
    ),
    nginxRateLimitEnabled: boolean(
      legacy
        ? raw.nginxRateLimitEnabled ?? rawSite.nginxRateLimitEnabled
        : raw.nginxRateLimitEnabled,
      true,
    ),
    nginxRateLimitRps: nullableInteger(
      legacy
        ? raw.nginxRateLimitRps ?? rawSite.nginxRateLimitRps
        : raw.nginxRateLimitRps,
    ),
    nginxRateLimitBurst: nullableInteger(
      legacy
        ? raw.nginxRateLimitBurst ?? rawSite.nginxRateLimitBurst
        : raw.nginxRateLimitBurst,
    ),
    nginxCustomConfig: nullableText(
      legacy
        ? raw.nginxCustomConfig ?? rawSite.nginxCustomConfig
        : raw.nginxCustomConfig,
      256 * 1024,
    ),
  };
}

function normalizeDatabase(
  raw: Record<string, unknown>,
  index: number,
  primary: SiteBackupManifestDomain,
  domains: SiteBackupManifestDomain[],
  legacy: boolean,
): SiteBackupManifestDatabase {
  const sourceId =
    optionalId(raw.sourceId) ||
    optionalId(raw.id) ||
    `legacy-database-${index}`;
  let sourceSiteDomainId =
    optionalId(raw.sourceSiteDomainId) ||
    optionalId(raw.siteDomainId) ||
    primary.sourceId;
  if (
    legacy &&
    !domains.some((domain) => domain.sourceId === sourceSiteDomainId)
  ) {
    sourceSiteDomainId = primary.sourceId;
  }
  const name = text(raw.name, 'database name', 64);
  const type = text(raw.type, 'database type', 32);
  const dbUser =
    nullableText(raw.dbUser, 64) || `u_${name}`.substring(0, 32);
  if (
    !DATABASE_NAME_RE.test(name) ||
    !DATABASE_TYPES.has(type) ||
    !DATABASE_USER_RE.test(dbUser)
  ) {
    throw new Error(`Backup manifest has invalid database "${name}"`);
  }
  const purpose = legacy
    ? index === 0
      ? DatabasePurpose.APP_PRIMARY
      : DatabasePurpose.AUXILIARY
    : nullableText(raw.purpose, 32) || DatabasePurpose.AUXILIARY;
  if (!DATABASE_PURPOSES.has(purpose)) {
    throw new Error(`Backup manifest has invalid purpose for "${name}"`);
  }
  return {
    sourceId,
    sourceSiteDomainId,
    name,
    type,
    dbUser,
    dbPasswordHash: nullableText(raw.dbPasswordHash, 4_096) || '',
    dbPasswordEnc: nullableText(raw.dbPasswordEnc, 16_384),
    purpose,
  };
}

function validateDomainSet(domains: SiteBackupManifestDomain[]): void {
  const ids = new Set<string>();
  const runtimeKeys = new Set<string>();
  const hostnames = new Set<string>();
  for (const domain of domains) {
    if (ids.has(domain.sourceId)) {
      throw new Error(`Duplicate domain id "${domain.sourceId}"`);
    }
    if (runtimeKeys.has(domain.runtimeKey)) {
      throw new Error(`Duplicate runtimeKey "${domain.runtimeKey}"`);
    }
    ids.add(domain.sourceId);
    runtimeKeys.add(domain.runtimeKey);
    const names = [
      domain.domain,
      ...parseSiteAliases(domain.aliases).map((alias) =>
        canonicalizeHostname(alias.domain),
      ),
    ];
    for (const hostname of names) {
      if (hostnames.has(hostname)) {
        throw new Error(`Duplicate hostname "${hostname}"`);
      }
      hostnames.add(hostname);
    }
  }
}

function validateDatabaseSet(
  databases: SiteBackupManifestDatabase[],
  domains: SiteBackupManifestDomain[],
  domainIds: Set<string>,
): void {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const database of databases) {
    const identity = `${database.type}:${database.name}`;
    if (ids.has(database.sourceId) || names.has(identity)) {
      throw new Error(`Duplicate database "${database.name}"`);
    }
    if (!domainIds.has(database.sourceSiteDomainId)) {
      throw new Error(
        `Database "${database.name}" has no valid domain owner`,
      );
    }
    ids.add(database.sourceId);
    names.add(identity);
  }
  for (const domain of domains) {
    const primaryCount = databases.filter(
      (database) =>
        database.sourceSiteDomainId === domain.sourceId &&
        database.purpose === DatabasePurpose.APP_PRIMARY,
    ).length;
    if (primaryCount > 1) {
      throw new Error(
        `Domain "${domain.domain}" has multiple APP_PRIMARY databases`,
      );
    }
    if (
      (domain.preset === SiteType.MODX_REVO ||
        domain.preset === SiteType.MODX_3) &&
      primaryCount !== 1
    ) {
      throw new Error(
        `MODX domain "${domain.domain}" must have one APP_PRIMARY database`,
      );
    }
  }
}

function buildRoots(
  domains: SiteBackupManifestDomain[],
): SiteBackupManifestRoot[] {
  const roots = new Map<string, string[]>();
  for (const domain of domains) {
    const ids = roots.get(domain.filesRelPath) || [];
    ids.push(domain.sourceId);
    roots.set(domain.filesRelPath, ids);
  }
  return [...roots.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filesRelPath, siteDomainIds]) => ({
      filesRelPath,
      siteDomainIds: siteDomainIds.sort(),
    }));
}

function parseAliases(
  value: unknown,
): Array<{ domain: string; redirect: boolean }> {
  const raw =
    typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? JSON.stringify(value)
        : '[]';
  const aliases = parseSiteAliases(raw);
  if (aliases.length > 64) {
    throw new Error('Backup manifest domain has too many aliases');
  }
  return aliases.map((alias) => ({
    domain: canonicalizeHostname(alias.domain),
    redirect: alias.redirect,
  }));
}

function normalizeEnvVars(value: unknown): string {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error('Backup manifest has invalid envVars');
    }
  }
  const envObject = isRecord(parsed) ? parsed : {};
  const strings: Record<string, string> = {};
  for (const [key, nested] of Object.entries(envObject)) {
    if (typeof nested !== 'string') {
      throw new Error('Backup manifest has invalid envVars');
    }
    strings[key] = nested;
  }
  return JSON.stringify(validateEnvVars(strings));
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${label} is required`);
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > max ||
    /[\0\r\n]/.test(normalized)
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

function nullableText(value: unknown, max: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) {
    throw new Error('Backup manifest contains an invalid string');
  }
  return value;
}

function id(value: unknown, label: string): string {
  const normalized = text(value, label, 128);
  if (!ID_RE.test(normalized)) throw new Error(`Invalid ${label}`);
  return normalized;
}

function optionalId(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return id(value, 'manifest id');
}

function integer(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number)) {
    throw new Error('Backup manifest contains an invalid integer');
  }
  return number;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function absolutePath(value: unknown, label: string): string {
  const raw = text(value, label, 4_096);
  if (!path.isAbsolute(raw)) {
    throw new Error(`Invalid ${label}`);
  }
  const normalized = path.resolve(raw);
  if (normalized === path.parse(normalized).root) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

function nullableJsonArray(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error('Backup manifest contains invalid JSON array');
    }
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((entry) => typeof entry !== 'string')
  ) {
    throw new Error('Backup manifest contains invalid JSON array');
  }
  return JSON.stringify(parsed);
}

function nullableJsonObject(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error('Backup manifest contains invalid JSON object');
    }
  }
  if (!isRecord(parsed)) {
    throw new Error('Backup manifest contains invalid JSON object');
  }
  return JSON.stringify(parsed);
}
