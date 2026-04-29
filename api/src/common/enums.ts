/**
 * Локальные enum-типы, заменяющие Prisma-enum после миграции на SQLite.
 * SQLite-провайдер Prisma не поддерживает enum, поэтому в schema.prisma
 * соответствующие поля объявлены как String. Значения валидируются в рантайме.
 */

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export enum UserRole {
  ADMIN = 'ADMIN',
  MANAGER = 'MANAGER',
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

// Meowbox поддерживает только MODX (Revo/3) и CUSTOM (пустой шаблон).
// Остальные типы выпилены; существующие записи в БД мигрируются в CUSTOM.
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

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

export enum DatabaseType {
  MARIADB = 'MARIADB',
  MYSQL = 'MYSQL',
  POSTGRESQL = 'POSTGRESQL',
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

export enum BackupType {
  FULL = 'FULL',
  DIFFERENTIAL = 'DIFFERENTIAL',
  FILES_ONLY = 'FILES_ONLY',
  DB_ONLY = 'DB_ONLY',
}

export enum BackupStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export enum BackupStorageType {
  LOCAL = 'LOCAL',
  S3 = 'S3',
  YANDEX_DISK = 'YANDEX_DISK',
  CLOUD_MAIL_RU = 'CLOUD_MAIL_RU',
}

// Движок бэкапа. TAR — tar.gz + upload. RESTIC — дедупликация (LOCAL/S3).
export enum BackupEngine {
  TAR = 'TAR',
  RESTIC = 'RESTIC',
}

// Режим экспорта бэкапа в скачиваемый архив.
export enum BackupExportMode {
  // API сама спавнит restic dump --archive tar и стримит stdout в HTTP response.
  // Без диска, без сокетов. Single-host инсталляции.
  STREAM = 'STREAM',
  // Агент дампит в S3 как exports/<id>.tar → API возвращает pre-signed URL.
  // Браузер качает напрямую из S3, минуя VPS. Только для S3-хранилищ.
  S3_PRESIGNED = 'S3_PRESIGNED',
}

export enum BackupExportStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  READY = 'READY',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
}

// ---------------------------------------------------------------------------
// SSL
// ---------------------------------------------------------------------------

export enum SslStatus {
  ACTIVE = 'ACTIVE',
  EXPIRING_SOON = 'EXPIRING_SOON',
  EXPIRED = 'EXPIRED',
  PENDING = 'PENDING',
  NONE = 'NONE',
}

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

export enum DeployStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  ROLLED_BACK = 'ROLLED_BACK',
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

export enum CronJobStatus {
  ACTIVE = 'ACTIVE',
  DISABLED = 'DISABLED',
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export enum NotificationChannel {
  TELEGRAM = 'TELEGRAM',
  EMAIL = 'EMAIL',
  WEBHOOK = 'WEBHOOK',
}

// ---------------------------------------------------------------------------
// Firewall
// ---------------------------------------------------------------------------

export enum FirewallRuleAction {
  ALLOW = 'ALLOW',
  DENY = 'DENY',
}

export enum FirewallProtocol {
  TCP = 'TCP',
  UDP = 'UDP',
  BOTH = 'BOTH',
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export enum AuditAction {
  LOGIN = 'LOGIN',
  LOGOUT = 'LOGOUT',
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  DEPLOY = 'DEPLOY',
  BACKUP = 'BACKUP',
  RESTORE = 'RESTORE',
  SSL_ISSUE = 'SSL_ISSUE',
  SERVICE_START = 'SERVICE_START',
  SERVICE_STOP = 'SERVICE_STOP',
  SERVICE_RESTART = 'SERVICE_RESTART',
}
