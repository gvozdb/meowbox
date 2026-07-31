export type SiteTypePreset = 'MODX_REVO' | 'MODX_3' | 'CUSTOM';
export type DbEngine = 'MARIADB' | 'POSTGRESQL';

export interface SelectOption {
  value: string;
  label: string;
}

export interface DbEngineOption {
  value: DbEngine;
  label: string;
  engineKey: 'mariadb' | 'postgresql';
}

export interface EnvVarItem {
  key: string;
  value: string;
}

export interface DomainApplicationDraft {
  id: number | string;
  domain: string;
  aliases: string[];
  preset: SiteTypePreset;
  filesRelPath: string;
  phpEnabled: boolean;
  phpVersion: string;
  dbEnabled: boolean;
  dbType: '' | DbEngine;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  sslEnabled: boolean;
  httpsRedirect: boolean;
  gitRepository: string;
  deployBranch: string;
  envVars: EnvVarItem[];
  modxVersion: string;
  cmsAdminUser: string;
  cmsAdminPassword: string;
  cmsTablePrefix: string;
  managerPath: string;
  connectorsPath: string;
  showDbPassword: boolean;
  showCmsPassword: boolean;
}

export interface DomainApplicationPayload {
  domain: string;
  aliases?: string[];
  preset: SiteTypePreset;
  filesRelPath: string;
  phpVersion?: string;
  dbType?: DbEngine;
  dbName?: string;
  dbUser?: string;
  dbPassword?: string;
  sslEnabled?: boolean;
  httpsRedirect?: boolean;
  gitRepository?: string;
  deployBranch?: string;
  envVars?: Record<string, string>;
  modxVersion?: string;
  cmsAdminUser?: string;
  cmsAdminPassword?: string;
  cmsTablePrefix?: string;
  managerPath?: string;
  connectorsPath?: string;
}

export const SITE_TYPE_OPTIONS: Array<{ value: SiteTypePreset; label: string }> = [
  { value: 'MODX_REVO', label: 'MODX Revolution' },
  { value: 'MODX_3', label: 'MODX 3' },
  { value: 'CUSTOM', label: 'Custom' },
];

export const DEFAULT_PHP_VERSIONS: SelectOption[] = [
  { value: '8.4', label: 'PHP 8.4' },
  { value: '8.3', label: 'PHP 8.3' },
  { value: '8.2', label: 'PHP 8.2' },
  { value: '8.1', label: 'PHP 8.1' },
  { value: '8.0', label: 'PHP 8.0' },
  { value: '7.4', label: 'PHP 7.4 (EOL)' },
];

export const DEFAULT_MODX_REVO_VERSIONS: SelectOption[] = [
  { value: '2.8.8-pl', label: 'MODX Revolution 2.8.8 (latest)' },
];

export const DEFAULT_MODX_3_VERSIONS: SelectOption[] = [
  { value: '3.1.2-pl', label: 'MODX 3.1.2 (latest)' },
];

export const ALL_DB_ENGINES: DbEngineOption[] = [
  { value: 'MARIADB', label: 'MySQL / MariaDB', engineKey: 'mariadb' },
  { value: 'POSTGRESQL', label: 'PostgreSQL', engineKey: 'postgresql' },
];

const DOMAIN_PATTERN =
  /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const FILES_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

interface CreateDraftOptions {
  id: number | string;
  preset?: SiteTypePreset;
  filesRelPath?: string;
  phpVersion?: string;
  modxRevoVersion?: string;
  modx3Version?: string;
}

export function isModxApplication(
  application: Pick<DomainApplicationDraft, 'preset'>,
): boolean {
  return application.preset === 'MODX_REVO' || application.preset === 'MODX_3';
}

export function presetLabel(preset: SiteTypePreset): string {
  return SITE_TYPE_OPTIONS.find((option) => option.value === preset)?.label || preset;
}

export function createDomainApplicationDraft(
  options: CreateDraftOptions,
): DomainApplicationDraft {
  const preset = options.preset || 'CUSTOM';
  const application: DomainApplicationDraft = {
    id: options.id,
    domain: '',
    aliases: [],
    preset,
    filesRelPath: options.filesRelPath || 'www',
    phpEnabled: false,
    phpVersion: options.phpVersion || '8.2',
    dbEnabled: false,
    dbType: '',
    dbName: '',
    dbUser: '',
    dbPassword: '',
    sslEnabled: false,
    httpsRedirect: true,
    gitRepository: '',
    deployBranch: 'main',
    envVars: [],
    modxVersion:
      preset === 'MODX_3'
        ? options.modx3Version || '3.1.2-pl'
        : options.modxRevoVersion || '2.8.8-pl',
    cmsAdminUser: '',
    cmsAdminPassword: '',
    cmsTablePrefix: '',
    managerPath: 'manager',
    connectorsPath: 'connectors',
    showDbPassword: false,
    showCmsPassword: false,
  };
  applyDomainPreset(application, {
    modxRevoVersion: options.modxRevoVersion,
    modx3Version: options.modx3Version,
  });
  return application;
}

export function applyDomainPreset(
  application: DomainApplicationDraft,
  versions: { modxRevoVersion?: string; modx3Version?: string } = {},
): void {
  if (!isModxApplication(application)) return;

  application.phpEnabled = true;
  application.dbEnabled = true;
  application.dbType = 'MARIADB';
  if (!application.modxVersion) {
    application.modxVersion =
      application.preset === 'MODX_3'
        ? versions.modx3Version || '3.1.2-pl'
        : versions.modxRevoVersion || '2.8.8-pl';
  }
}

export function dbEngineOptionsForApplication(
  application: Pick<DomainApplicationDraft, 'preset'>,
  installedEngines: ReadonlySet<string>,
): DbEngineOption[] {
  const installed = ALL_DB_ENGINES.filter((option) =>
    installedEngines.has(option.engineKey),
  );
  return isModxApplication(application)
    ? installed.filter((option) => option.engineKey === 'mariadb')
    : installed;
}

export function dbTypeLabel(application: DomainApplicationDraft): string {
  if (isModxApplication(application)) return 'MariaDB';
  if (!application.dbType) return '';
  return application.dbType === 'MARIADB' ? 'MariaDB' : 'PostgreSQL';
}

export function isDomainValid(value: string): boolean {
  return DOMAIN_PATTERN.test(value.trim().toLowerCase());
}

export function isFilesRelPathValid(value: string): boolean {
  return FILES_PATTERN.test(value.trim());
}

export function validateDomainApplication(
  application: DomainApplicationDraft,
  installedEngines: ReadonlySet<string>,
): string | null {
  if (!isDomainValid(application.domain)) return 'Укажите валидный домен.';
  if (!application.filesRelPath.trim() || !isFilesRelPathValid(application.filesRelPath)) {
    return 'Проверьте filesRelPath.';
  }
  const hostnames = new Set([application.domain.trim().toLowerCase()]);
  for (const alias of application.aliases) {
    const hostname = alias.trim().toLowerCase();
    if (!hostname) continue;
    if (!isDomainValid(hostname)) return `Невалидный алиас: ${alias}`;
    if (hostnames.has(hostname)) return `Hostname ${hostname} указан повторно.`;
    hostnames.add(hostname);
  }
  const envKeys = new Set<string>();
  for (const pair of application.envVars) {
    const key = pair.key.trim();
    if (!key && !pair.value) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) {
      return `Невалидное имя env: ${key || '(пусто)'}`;
    }
    if (envKeys.has(key)) return `Переменная ${key} указана повторно.`;
    if (pair.value.length > 8192 || pair.value.includes('\0')) {
      return `Невалидное значение env: ${key}`;
    }
    envKeys.add(key);
  }
  if (
    (application.dbEnabled || isModxApplication(application)) &&
    dbEngineOptionsForApplication(application, installedEngines).length === 0
  ) {
    return isModxApplication(application)
      ? 'Для MODX нужен установленный MySQL/MariaDB.'
      : 'Не найден совместимый движок БД.';
  }
  return null;
}

function collectAliases(application: DomainApplicationDraft): string[] {
  return application.aliases
    .map((alias) => alias.trim().toLowerCase())
    .filter(Boolean);
}

function collectEnvVars(application: DomainApplicationDraft): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of application.envVars) {
    const key = pair.key.trim();
    if (key) result[key] = pair.value.trim();
  }
  return result;
}

export function buildDomainApplicationPayload(
  application: DomainApplicationDraft,
  fallbackPhpVersion = '8.2',
): DomainApplicationPayload {
  const isModx = isModxApplication(application);
  const payload: DomainApplicationPayload = {
    domain: application.domain.trim().toLowerCase(),
    preset: application.preset,
    filesRelPath: application.filesRelPath.trim(),
    sslEnabled: application.sslEnabled,
    httpsRedirect: application.httpsRedirect,
  };

  const aliases = collectAliases(application);
  if (aliases.length) payload.aliases = aliases;

  if (isModx || application.phpEnabled) {
    payload.phpVersion = application.phpVersion || fallbackPhpVersion;
  }

  if (isModx || application.dbEnabled) {
    if (application.dbType) payload.dbType = application.dbType;
    if (application.dbName.trim()) payload.dbName = application.dbName.trim();
    if (application.dbUser.trim()) payload.dbUser = application.dbUser.trim();
    if (application.dbPassword.trim()) payload.dbPassword = application.dbPassword.trim();
  }

  if (!isModx && application.gitRepository.trim()) {
    payload.gitRepository = application.gitRepository.trim();
    payload.deployBranch = application.deployBranch.trim() || 'main';
  }

  const envVars = collectEnvVars(application);
  if (Object.keys(envVars).length) payload.envVars = envVars;

  if (isModx) {
    if (application.modxVersion.trim()) payload.modxVersion = application.modxVersion.trim();
    if (application.cmsAdminUser.trim()) payload.cmsAdminUser = application.cmsAdminUser.trim();
    if (application.cmsAdminPassword.trim()) {
      payload.cmsAdminPassword = application.cmsAdminPassword.trim();
    }
    if (application.cmsTablePrefix.trim()) {
      payload.cmsTablePrefix = application.cmsTablePrefix.trim();
    }
    if (application.managerPath.trim()) payload.managerPath = application.managerPath.trim();
    if (application.connectorsPath.trim()) {
      payload.connectorsPath = application.connectorsPath.trim();
    }
  }

  return payload;
}

export function generateTablePrefix(): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const values = new Uint32Array(7);
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(values);
  } else {
    for (let index = 0; index < values.length; index++) {
      values[index] = Math.floor(Math.random() * 0xffffffff);
    }
  }
  return `${Array.from(values, (value) => letters[value % letters.length]).join('')}_`;
}
