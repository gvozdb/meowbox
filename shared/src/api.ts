import {
  SiteType,
  SiteStatus,
  UserRole,
  DatabaseType,
  DatabasePurpose,
  BackupType,
  BackupStorageType,
  DeployStatus,
  NotificationChannel,
  NotificationEvent,
  FirewallRuleAction,
  FirewallProtocol,
  CronJobStatus,
} from './enums';
import type { PhpVersion } from './enums';

import type {
  User,
  Database,
  BackupStorageConfig,
  NotificationChannelConfig,
  SiteAlias,
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

/**
 * Declarative application settings for one main domain. Runtime identity and
 * status are server-assigned; generic forms intentionally do not expose
 * appPort.
 */
export interface CreateSiteDomainRequest {
  domain: string;
  aliases?: SiteAlias[];
  /** Required relative path; absolute runtime paths are never client input. */
  filesRelPath: string;
  preset: SiteType;
  phpVersion?: PhpVersion | null;
  phpPoolCustom?: string | null;
  gitRepository?: string | null;
  deployBranch?: string | null;
  envVars?: Record<string, string>;
  cmsAdminUser?: string | null;
  /** Plaintext only at the API boundary; server stores encrypted data. */
  cmsAdminPassword?: string | null;
  managerPath?: string | null;
  connectorsPath?: string | null;
  cmsTablePrefix?: string | null;
  httpsRedirect?: boolean;
}

/** Domain-scoped mutable application settings; runtimeKey/status stay server-owned. */
export interface UpdateSiteDomainRequest {
  domain?: string;
  aliases?: SiteAlias[];
  filesRelPath?: string;
  phpVersion?: PhpVersion | null;
  phpPoolCustom?: string | null;
  gitRepository?: string | null;
  deployBranch?: string | null;
  envVars?: Record<string, string>;
  cmsAdminUser?: string | null;
  cmsAdminPassword?: string | null;
  managerPath?: string | null;
  connectorsPath?: string | null;
  cmsTablePrefix?: string | null;
  httpsRedirect?: boolean;
}

export interface CreateSiteRequest {
  name: string;
  displayName?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  /** At least one domain/application row; exactly one primary is selected server-side. */
  domains: CreateSiteDomainRequest[];
}

export interface UpdateSiteRequest {
  name?: string;
  displayName?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface SiteListQuery extends PaginationQuery {
  /** Matches any SiteDomain preset, not a singular Site type. */
  preset?: SiteType;
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
  siteDomainId: string;
  purpose: DatabasePurpose;
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
  siteDomainId?: string;
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
