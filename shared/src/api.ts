import {
  SiteType,
  SiteStatus,
  UserRole,
  PhpVersion,
  DatabaseType,
  BackupType,
  BackupStorageType,
  DeployStatus,
  NotificationChannel,
  NotificationEvent,
  FirewallRuleAction,
  FirewallProtocol,
  CronJobStatus,
} from './enums';

import type {
  User,
  Database,
  BackupStorageConfig,
  NotificationChannelConfig,
} from './entities';

// =============================================================================
// Generic API response wrappers
// =============================================================================

export interface ApiResponse<T> {
  success: true;
  data: T;
  meta?: ApiPaginationMeta;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, string[]>;
  };
}

export interface ApiPaginationMeta {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export interface PaginationQuery {
  page?: number;
  perPage?: number;
}

// =============================================================================
// Auth
// =============================================================================

export interface LoginRequest {
  username: string;
  password: string;
  totpCode?: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
}

export interface RefreshTokenRequest {
  refreshToken: string;
}

export interface RefreshTokenResponse {
  accessToken: string;
  refreshToken: string;
}

// =============================================================================
// Users
// =============================================================================

export interface CreateUserRequest {
  username: string;
  email: string;
  password: string;
  role: UserRole;
}

export interface UpdateUserRequest {
  email?: string;
  role?: UserRole;
  password?: string;
}

// =============================================================================
// Sites
// =============================================================================

export interface CreateSiteRequest {
  name: string;
  domain: string;
  aliases?: string[];
  type: SiteType;
  phpVersion?: PhpVersion;
  gitRepository?: string;
  deployBranch?: string;
  appPort?: number;
  envVars?: Record<string, string>;
}

export interface UpdateSiteRequest {
  name?: string;
  domain?: string;
  aliases?: string[];
  phpVersion?: PhpVersion;
  gitRepository?: string;
  deployBranch?: string;
  appPort?: number;
  envVars?: Record<string, string>;
}

export interface SiteListQuery extends PaginationQuery {
  type?: SiteType;
  status?: SiteStatus;
  search?: string;
}

// =============================================================================
// Databases
// =============================================================================

export interface CreateDatabaseRequest {
  name: string;
  type: DatabaseType;
  dbUser: string;
  dbPassword: string;
  siteId?: string;
}

export type DatabaseResponse = Omit<Database, 'dbPasswordHash'>;

// =============================================================================
// Backups
// =============================================================================

export interface CreateBackupRequest {
  siteId: string;
  type: BackupType;
}

export interface CreateBackupConfigRequest {
  siteId: string;
  type: BackupType;
  storageType: BackupStorageType;
  schedule?: string;
  retention: number;
  excludePaths?: string[];
  storageConfig?: BackupStorageConfig;
  enabled?: boolean;
}

export interface UpdateBackupConfigRequest {
  type?: BackupType;
  storageType?: BackupStorageType;
  schedule?: string | null;
  retention?: number;
  excludePaths?: string[];
  storageConfig?: BackupStorageConfig | null;
  enabled?: boolean;
}

export interface RestoreBackupRequest {
  backupId: string;
}

// =============================================================================
// SSL
// =============================================================================

export interface IssueSslRequest {
  wildcard?: boolean;
}

export interface UploadSslRequest {
  certificate: string;
  privateKey: string;
  chain?: string;
}

// =============================================================================
// Deploy
// =============================================================================

export interface TriggerDeployRequest {
  commitSha?: string;
}

export interface RollbackDeployRequest {
  deployLogId: string;
}

export interface DeployListQuery extends PaginationQuery {
  siteId?: string;
  status?: DeployStatus;
}

// =============================================================================
// Cron Jobs
// =============================================================================

export interface CreateCronJobRequest {
  siteId: string;
  name: string;
  schedule: string;
  command: string;
}

export interface UpdateCronJobRequest {
  name?: string;
  schedule?: string;
  command?: string;
  status?: CronJobStatus;
}

// =============================================================================
// Notifications
// =============================================================================

export interface UpdateNotificationSettingRequest {
  channel: NotificationChannel;
  events: NotificationEvent[];
  enabled: boolean;
  config: NotificationChannelConfig;
}

// =============================================================================
// Firewall
// =============================================================================

export interface CreateFirewallRuleRequest {
  action: FirewallRuleAction;
  protocol: FirewallProtocol;
  port?: string;
  sourceIp?: string;
  comment?: string;
}

// =============================================================================
// System
// =============================================================================

export interface ServiceStatus {
  running: boolean;
  version: string | null;
  uptimeSeconds: number | null;
}

export interface PhpServiceStatus extends ServiceStatus {
  version: PhpVersion;
  poolCount: number;
}

export interface SystemStatusResponse {
  nginx: ServiceStatus;
  php: PhpServiceStatus[];
  mariadb: ServiceStatus;
  mysql: ServiceStatus;
  postgresql: ServiceStatus; // пользовательские сайты, не сама панель
  pm2: ServiceStatus;
  meowboxApi: ServiceStatus;
  meowboxAgent: ServiceStatus;
}

// =============================================================================
// PHP Management
// =============================================================================

export interface InstallPhpVersionRequest {
  version: PhpVersion;
  extensions?: string[];
}

export interface PhpSettingsRequest {
  memoryLimit?: string;
  uploadMaxFilesize?: string;
  postMaxSize?: string;
  maxExecutionTime?: number;
  opcacheEnabled?: boolean;
  opcacheMemory?: number;
}

// =============================================================================
// Log Viewer
// =============================================================================

export interface LogQuery {
  lines?: number;
  search?: string;
  logType?: 'access' | 'error' | 'php' | 'pm2' | 'deploy';
}
