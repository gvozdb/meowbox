// =============================================================================
// Site
// =============================================================================

// Meowbox поддерживает только MODX (Revo/3) и пустой (CUSTOM) шаблон сайта.
// Для CUSTOM PHP и БД подключаются опционально через модули при создании.
// Старые типы (NUXT_3, REACT, NESTJS, STATIC_HTML) выпилены — существующие сайты
// автоматически переименовываются в CUSTOM при миграции (prisma db push + UPDATE).
export enum SiteType {
  MODX_REVO = 'MODX_REVO',
  MODX_3 = 'MODX_3',
  CUSTOM = 'CUSTOM',
}

export enum SiteStatus {
  RUNNING = 'RUNNING',
  STOPPED = 'STOPPED',
  ERROR = 'ERROR',
  DEPLOYING = 'DEPLOYING',
}

// =============================================================================
// Users
// =============================================================================

export enum UserRole {
  ADMIN = 'ADMIN',
  MANAGER = 'MANAGER',
}

// =============================================================================
// Databases (user site databases, not the panel's own PostgreSQL)
// =============================================================================

export enum DatabaseType {
  MARIADB = 'MARIADB',
  MYSQL = 'MYSQL',
  POSTGRESQL = 'POSTGRESQL',
}

// =============================================================================
// PHP
// =============================================================================

export enum PhpVersion {
  PHP_74 = '7.4',
  PHP_80 = '8.0',
  PHP_81 = '8.1',
  PHP_82 = '8.2',
  PHP_83 = '8.3',
}

// =============================================================================
// Backups
// =============================================================================

export enum BackupStorageType {
  LOCAL = 'LOCAL',
  S3 = 'S3',
  SFTP = 'SFTP',
  YANDEX_DISK = 'YANDEX_DISK',
  CLOUD_MAIL_RU = 'CLOUD_MAIL_RU',
}

// Движок бэкапа. TAR — классический tar.gz + upload в хранилище (совместим со
// всеми storage types). RESTIC — дедуплицирующий backup через `restic` (LOCAL
// и S3; рекомендуемый для авто, экономит место за счёт CDC-дедупликации).
export enum BackupEngine {
  TAR = 'TAR',
  RESTIC = 'RESTIC',
}

export enum BackupType {
  FULL = 'FULL',
  FILES_ONLY = 'FILES_ONLY',
  DB_ONLY = 'DB_ONLY',
}

export enum BackupStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

// Scope конфига бэкапа. Определяет источник данных и UI-вкладку.
//   SITE        — файлы и БД конкретного сайта (привязка к siteId).
//   SERVER_PATH — произвольный путь на сервере (`/etc`, `/opt`, ...), один путь = один config.
//   PANEL_DATA  — preset: данные самой панели (БД, master-key, .env, vpn state, LE сертификаты).
export enum BackupScope {
  SITE = 'SITE',
  SERVER_PATH = 'SERVER_PATH',
  PANEL_DATA = 'PANEL_DATA',
}

// =============================================================================
// SSL
// =============================================================================

export enum SslStatus {
  ACTIVE = 'ACTIVE',
  EXPIRING_SOON = 'EXPIRING_SOON',
  EXPIRED = 'EXPIRED',
  PENDING = 'PENDING',
  NONE = 'NONE',
}

// =============================================================================
// Deploy
// =============================================================================

export enum DeployStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  ROLLED_BACK = 'ROLLED_BACK',
}

// =============================================================================
// Notifications
// =============================================================================

export enum NotificationChannel {
  TELEGRAM = 'TELEGRAM',
  EMAIL = 'EMAIL',
  WEBHOOK = 'WEBHOOK',
}

export enum NotificationEvent {
  SITE_DOWN = 'SITE_DOWN',
  SSL_EXPIRING = 'SSL_EXPIRING',
  BACKUP_COMPLETED = 'BACKUP_COMPLETED',
  DEPLOY_SUCCESS = 'DEPLOY_SUCCESS',
  DEPLOY_FAILED = 'DEPLOY_FAILED',
  HIGH_LOAD = 'HIGH_LOAD',
  /** SNI-маска VLESS+Reality сервиса перестала отдавать TLS 1.3 + X25519. */
  VPN_SNI_FAILED = 'VPN_SNI_FAILED',
}

// =============================================================================
// Firewall
// =============================================================================

export enum FirewallRuleAction {
  ALLOW = 'ALLOW',
  DENY = 'DENY',
}

export enum FirewallProtocol {
  TCP = 'TCP',
  UDP = 'UDP',
  BOTH = 'BOTH',
}

// =============================================================================
// Country block (server-level GeoIP blocking via ipset+iptables)
// =============================================================================

/**
 * Источник CIDR-баз для GeoIP-блокировки.
 * - IPDENY:           https://www.ipdeny.com/ipblocks/  — primary, обновляется ежедневно
 * - GITHUB_HERRBISCH: https://github.com/herrbischoff/country-ip-blocks — fallback
 */
export enum CountryBlockSource {
  IPDENY = 'IPDENY',
  GITHUB_HERRBISCH = 'GITHUB_HERRBISCH',
}

// =============================================================================
// Cron
// =============================================================================

export enum CronJobStatus {
  ACTIVE = 'ACTIVE',
  DISABLED = 'DISABLED',
}
