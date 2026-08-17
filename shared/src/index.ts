// Constants (единая точка истины для магических значений, дублируемых
// между api/agent/web).
export {
  SUPPORTED_PHP_VERSIONS,
  DEFAULT_PHP_VERSION,
  DEFAULT_MODX_REVO_VERSION,
  DEFAULT_MODX_3_VERSION,
  modxDownloadZipUrl,
  MODX_VERSION_REGEX,
  PASSWORD_POLICY,
  SAFE_IDENT_REGEX,
  SITE_NAME_REGEX,
  DOMAIN_REGEX,
  CRON_SCHEDULE_REGEX,
  DEFAULT_SITES_BASE_PATH,
  DEFAULT_BACKUP_LOCAL_PATH,
  PHP_FPM_SERVICE_PREFIX,
  PHP_FPM_SERVICE_SUFFIX,
  UPLOAD_BLOCKED_EXTENSIONS,
  MODX_DB_DEFAULTS,
} from './constants';

export type { SupportedPhpVersion } from './constants';

export {
  redactSensitiveText,
  safeErrorMessage,
} from './safe-error-message';

export {
  RESTORE_INCLUDE_PATH_LIMIT,
  RESTORE_INCLUDE_PATH_MAX_LENGTH,
  normalizeRestoreIncludePaths,
} from './backup-restore';

export {
  MINIO_SERVICE_KEY,
  MINIO_SERVICE_USER,
  MINIO_SYSTEMD_UNIT,
  MINIO_SYSTEMD_UNIT_PATH,
  MINIO_RUNTIME_DIR,
  MINIO_SERVER_BINARY,
  MINIO_CLIENT_BINARY,
  MINIO_DATA_DIR,
  MINIO_HOME_DIR,
  MINIO_CONFIG_DIR,
  MINIO_ROOT_CREDENTIALS_PATH,
  MINIO_API_HOST,
  MINIO_API_PORT,
  MINIO_API_ENDPOINT,
  MINIO_CONSOLE_HOST,
  MINIO_CONSOLE_PORT,
  MINIO_DEFAULT_REGION,
  minioSystemdUnitContent,
} from './minio';

// Artifact helpers (anchor for nginx/PHP-FPM/socket paths).
export {
  artifactAnchor,
  runtimeArtifactAnchor,
  artifactAnchorOrEmpty,
  sanitizeDomainForFilename,
  siteDomainLogBase,
} from './site-artifacts';
export type { AnchorParams } from './site-artifacts';

// Size/limit defaults — могут быть переопределены panel-settings в runtime.
export {
  DEFAULT_NGINX_CLIENT_MAX_BODY_SIZE,
  DEFAULT_NGINX_CLIENT_MAX_BODY_MB,
  DEFAULT_PHP_MEMORY_LIMIT_MB,
  DEFAULT_PHP_UPLOAD_MAX_FILESIZE_MB,
  DEFAULT_PHP_POST_MAX_SIZE_MB,
  MODX_SETUP_PHP_MEMORY_LIMIT_MB,
  DEFAULT_API_JSON_LIMIT_MB,
  DEFAULT_API_UPLOAD_LIMIT_MB,
} from './size-limits';

// Layered nginx defaults + CMS initial custom blocks.
export {
  NGINX_DEFAULTS,
  resolveNginxSettings,
  siteNginxOverrides,
  nginxZoneName,
  CMS_INITIAL_CUSTOM_CONFIG,
  initialCustomConfigFor,
} from './nginx-defaults';
export type {
  NginxDefaults,
  SiteNginxOverrides,
  SiteNginxColumns,
  ResolvedNginxSettings,
} from './nginx-defaults';

// Enums
export {
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
export type { PhpVersion } from './enums';

export {
  hostpanelPresetFromSource,
  normalizeHostpanelPreset,
  isModxPreset,
} from './domain-presets';

// Entity interfaces
export type {
  User,
  Site,
  SiteAlias,
  SiteDomain,
  Database,
  Backup,
  BackupConfig,
  BackupStorageConfig,
  SslCertificate,
  DeployLog,
  HealthCheckPing,
  AuditLog,
  CronJob,
  NotificationSetting,
  TelegramNotificationConfig,
  EmailNotificationConfig,
  WebhookNotificationConfig,
  NotificationChannelConfig,
  FirewallRule,
  SystemMetrics,
  DiskMetrics,
  NetworkMetrics,
  SiteMetrics,
} from './entities';

// API types
export type {
  ApiResponse,
  ApiErrorResponse,
  ApiPaginationMeta,
  PaginationQuery,
  LoginRequest,
  LoginResponse,
  RefreshTokenRequest,
  RefreshTokenResponse,
  CreateUserRequest,
  UpdateUserRequest,
  CreateSiteRequest,
  UpdateSiteRequest,
  CreateSiteDomainRequest,
  UpdateSiteDomainRequest,
  SiteListQuery,
  CreateDatabaseRequest,
  DatabaseResponse,
  CreateBackupRequest,
  CreateBackupConfigRequest,
  UpdateBackupConfigRequest,
  RestoreBackupRequest,
  IssueSslRequest,
  UploadSslRequest,
  TriggerDeployRequest,
  RollbackDeployRequest,
  DeployListQuery,
  CreateCronJobRequest,
  UpdateCronJobRequest,
  UpdateNotificationSettingRequest,
  CreateFirewallRuleRequest,
  SystemStatusResponse,
  ServiceStatus,
  PhpServiceStatus,
  InstallPhpVersionRequest,
  PhpSettingsRequest,
  LogQuery,
} from './api';

// VPN management
export { VpnProtocol, VpnServiceStatus } from './vpn-types';
export type {
  VpnInstallOptions,
  VpnRealityServiceConfig,
  VpnAmneziaWgServiceConfig,
  VpnServiceConfig,
  VpnRealityUserCreds,
  VpnAmneziaWgUserCreds,
  VpnUserCreds,
  VpnUserCredsView,
  SniValidationResult,
} from './vpn-types';
export {
  DEFAULT_SNI_MASKS,
  DEFAULT_VPN_PORTS,
  RESERVED_WEB_TCP_PORTS,
  isVpnPortReserved,
  DEFAULT_AMNEZIA_NETWORK,
  DEFAULT_AMNEZIA_DNS,
  DEFAULT_AMNEZIA_MTU,
  DEFAULT_REALITY_FINGERPRINT,
  VPN_STATE_DIR,
  VPN_RUNTIME_USER,
  XRAY_SYSTEMD_PREFIX,
  AMNEZIAWG_IFACE_PREFIX,
  XRAY_BINARY_PATH,
  VPN_CLIENT_LINKS,
  VPN_USER_NAME_REGEX,
  IPV4_CIDR_REGEX,
} from './vpn-defaults';

// Node.js / PM2 application management
export {
  NODE_COMMAND_SOURCES,
  PM2_ECOSYSTEM_FILENAMES,
} from './node-app';
export type {
  NodeCommandSource,
  NodeAppDefinition,
  NodeProcessRuntime,
  NodeDomainRef,
  NodeProcessView,
  NodeEcosystemGroup,
  NodeProcessesResult,
  DiscoveredCommand,
  DiscoveredCommandGroup,
  QuickCommand,
  QuickCommandRunResult,
} from './node-app';

// WebSocket types
export { WsEvents } from './ws';

export type {
  WsEventName,
  WsSiteStatusPayload,
  WsDeployLogPayload,
  WsSiteLogsPayload,
  WsSystemMetricsPayload,
  WsBackupProgressPayload,
  WsTerminalDataPayload,
  WsNotificationPayload,
  ServerToClientEvents,
  ClientToServerEvents,
} from './ws';
