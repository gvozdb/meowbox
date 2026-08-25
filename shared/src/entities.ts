import {
  SiteType,
  SiteStatus,
  DomainApplicationStatus,
  UserRole,
  DatabaseType,
  DatabasePurpose,
  BackupStorageType,
  BackupType,
  BackupStatus,
  SslStatus,
  DeployStatus,
  NotificationChannel,
  NotificationEvent,
  FirewallRuleAction,
  FirewallProtocol,
  CronJobStatus,
} from './enums';
import type { PhpVersion } from './enums';

// =============================================================================
// User
// =============================================================================

export interface User {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  totpEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Site
// =============================================================================

/**
 * Алиас домена сайта.
 *
 * - `redirect=false` (по умолчанию): домен открывает сам сайт, через отдельный URL
 *   (включается в `server_name` того же server-блока, что и основной домен).
 * - `redirect=true`: nginx отдаёт 301 на основной домен (`https://<mainDomain>$request_uri`).
 *
 * В БД хранятся объекты. Для обратной совместимости со старыми записями
 * (массив строк) все парсеры принимают оба формата и нормализуют к объектам.
 */
export interface SiteAlias {
  domain: string;
  redirect: boolean;
}

export interface Site {
  id: string;
  name: string;
  displayName: string | null;
  /** Все main domains; the application source of truth is each SiteDomain. */
  domains: SiteDomain[];
  /** Global Linux/container lifecycle; not a selected application's state. */
  status: SiteStatus;
  errorMessage: string | null;
  /** Хомдира linux-юзера — ОБЩАЯ на весь сайт (одна на все основные домены). */
  rootPath: string;
  nginxConfigPath: string;
  systemUser: string | null;
  /** Persistence/internal field; ordinary REST projections must not reveal it. */
  sshPasswordEnc: string | null;
  metadata: Record<string, unknown> | null;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Основной домен сайта. Один Site = N основных доменов (мульти-доменное
 * приложение: фронт / админка / API на разных доменах).
 *
 * Каждый основной домен — отдельный server-блок nginx, отдельный
 * SSL-сертификат, собственный набор layered nginx-настроек и 95-custom.conf.
 * Хомдира linux-юзера общая (Site.rootPath); домены различаются только
 * относительным web-root (`filesRelPath`).
 *
 * Ровно один домен в сайте помечен `isPrimary` («главный», корона в UI).
 */
export interface SiteDomain {
  id: string;
  siteId: string;
  domain: string;
  /** Главный домен сайта (ровно один, position=0, корона в UI). */
  isPrimary: boolean;
  /** Порядок в списке доменов сайта (главный — 0). */
  position: number;
  aliases: SiteAlias[];
  /** Explicit web-root relative to Site.rootPath. */
  filesRelPath: string;
  /** MODX_REVO | MODX_3 | CUSTOM. */
  preset: SiteType;
  appStatus: DomainApplicationStatus;
  appErrorMessage: string | null;
  /** PHP is derived: `phpVersion !== null`; it is never separately persisted. */
  phpVersion: PhpVersion | null;
  phpPoolCustom: string | null;
  /** Immutable, globally unique PHP pool/socket/log operation key. */
  runtimeKey: string;
  gitRepository: string | null;
  deployBranch: string | null;
  envVars: Record<string, string>;
  cmsAdminUser: string | null;
  /** Persistence/internal field; do not include in unprivileged responses. */
  cmsAdminPasswordEnc: string | null;
  managerPath: string | null;
  connectorsPath: string | null;
  cmsTablePrefix: string | null;
  modxVersion: string | null;
  /** 301 HTTP→HTTPS для этого домена (действует при активном SSL). */
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
  /** SSL-сертификат этого домена (null — не выпущен). */
  sslCertificate: SslCertificate | null;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Database (user site databases)
// =============================================================================

export interface Database {
  id: string;
  name: string;
  type: DatabaseType;
  dbUser: string;
  dbPasswordHash: string;
  siteId: string;
  siteDomainId: string;
  purpose: DatabasePurpose;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Backup
// =============================================================================

export interface BackupStorageConfig {
  /** S3 endpoint URL (also used for MinIO / Backblaze B2). */
  endpoint?: string;
  bucket?: string;
  region?: string;
  accessKey?: string;
  secretKey?: string;
  remotePath?: string;
  /** OAuth token for Yandex Disk or Cloud Mail.ru. */
  oauthToken?: string;
  /** SFTP host (e.g. backups.example.com). */
  sftpHost?: string;
  /** SFTP port (default 22). */
  sftpPort?: string;
  /** SFTP username. */
  sftpUsername?: string;
  /** Remote абсолютный путь, в котором restic создаёт репу. */
  sftpPath?: string;
  /** Режим аутентификации SFTP: 'KEY' (приватный ключ) или 'PASSWORD' (пароль). По умолчанию 'KEY'. */
  sftpAuthMode?: 'KEY' | 'PASSWORD';
  /** SSH private key (PEM, OpenSSH). Используется при sftpAuthMode='KEY'. */
  sftpPrivateKey?: string;
  /** Парольная фраза для зашифрованного SSH-ключа (опционально, только при KEY-режиме). */
  sftpPassphrase?: string;
  /** Пароль SSH-пользователя. Используется при sftpAuthMode='PASSWORD' (через sshpass). */
  sftpPassword?: string;
  /** SHA256 fingerprint удалённого SSH-сервера для StrictHostKeyChecking. */
  sftpHostKey?: string;
}

export interface BackupConfig {
  id: string;
  siteId: string;
  type: BackupType;
  storageType: BackupStorageType;
  schedule: string | null;
  retention: number;
  /** Glob patterns for paths to exclude from file backups. */
  excludePaths: string[];
  storageConfig: BackupStorageConfig | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Backup {
  id: string;
  siteId: string;
  configId: string | null;
  type: BackupType;
  status: BackupStatus;
  storageType: BackupStorageType;
  filePath: string;
  sizeBytes: number | null;
  progress: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

// =============================================================================
// SSL Certificate
// =============================================================================

export interface SslCertificate {
  id: string;
  siteId: string;
  /** Основной домен (SiteDomain), которому принадлежит сертификат (1:1). */
  domainId: string | null;
  domains: string[];
  status: SslStatus;
  issuer: string;
  isWildcard: boolean;
  issuedAt: string | null;
  expiresAt: string | null;
  daysRemaining: number | null;
  certPath: string | null;
  keyPath: string | null;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Deploy Log
// =============================================================================

export interface DeployLog {
  id: string;
  siteId: string;
  siteDomainId: string;
  status: DeployStatus;
  commitSha: string | null;
  commitMessage: string | null;
  branch: string;
  output: string;
  triggeredBy: string | null;
  durationMs: number | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}

// =============================================================================
// Domain-scoped observability
// =============================================================================

export interface HealthCheckPing {
  id: string;
  siteId: string;
  /** Null only for legacy/global Site probes with no trustworthy app target. */
  siteDomainId: string | null;
  reachable: boolean;
  statusCode: number | null;
  responseTimeMs: number;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  userId: string;
  /** Null for non-domain or pre-domain audit records. */
  siteDomainId: string | null;
  operationId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string;
  userAgent: string | null;
  createdAt: string;
}

// =============================================================================
// Cron Job
// =============================================================================

export interface CronJob {
  id: string;
  siteId: string;
  name: string;
  schedule: string;
  command: string;
  status: CronJobStatus;
  lastOutput: string | null;
  lastRunAt: string | null;
  lastExitCode: number | null;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Notification Setting
// =============================================================================

export interface TelegramNotificationConfig {
  channel: NotificationChannel.TELEGRAM;
  botToken: string;
  chatId: string;
}

export interface EmailNotificationConfig {
  channel: NotificationChannel.EMAIL;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
  useTls: boolean;
  fromAddress: string;
  toAddresses: string[];
}

export interface WebhookNotificationConfig {
  channel: NotificationChannel.WEBHOOK;
  url: string;
  secret: string | null;
  headers: Record<string, string>;
}

export type NotificationChannelConfig =
  | TelegramNotificationConfig
  | EmailNotificationConfig
  | WebhookNotificationConfig;

export interface NotificationSetting {
  id: string;
  userId: string;
  channel: NotificationChannel;
  events: NotificationEvent[];
  enabled: boolean;
  config: NotificationChannelConfig;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Firewall Rule
// =============================================================================

export interface FirewallRule {
  id: string;
  action: FirewallRuleAction;
  protocol: FirewallProtocol;
  port: string | null;
  sourceIp: string | null;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// System Metrics
// =============================================================================

export interface DiskMetrics {
  mountPoint: string;
  device: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usagePercent: number;
}

export interface NetworkMetrics {
  rxBytes: number;
  txBytes: number;
  rxBytesPerSec: number;
  txBytesPerSec: number;
}

export interface SystemMetrics {
  cpuUsagePercent: number;
  cpuCores?: number;
  hostname?: string;
  loadAverage?: [number, number, number];
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryUsagePercent: number;
  disks: DiskMetrics[];
  network: NetworkMetrics | null;
  uptimeSeconds: number;
  collectedAt: string;
}

// =============================================================================
// Site Metrics
// =============================================================================

export interface SiteMetrics {
  siteId: string;
  cpuUsagePercent: number;
  memoryUsedBytes: number;
  diskUsageBytes: number;
  dbSizeBytes: number | null;
  requestCount: number;
  collectedAt: string;
}
