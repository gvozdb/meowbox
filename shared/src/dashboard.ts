export const DASHBOARD_CONTRACT_VERSION = 1 as const;

export type DashboardRole = 'ADMIN' | 'MANAGER';

export type DashboardAvailability =
  | 'OK'
  | 'STALE'
  | 'UNAVAILABLE'
  | 'UNSUPPORTED';

export interface DashboardSourceState {
  availability: DashboardAvailability;
  observedAt: string | null;
  staleAfterSeconds: number | null;
  message: string | null;
}

export type DashboardOverallStatus =
  | 'HEALTHY'
  | 'ATTENTION'
  | 'CRITICAL'
  | 'UNKNOWN';

export interface DashboardOverallState {
  state: DashboardOverallStatus;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  degradedSourceCount: number;
}

export type DashboardProblemSeverity = 'CRITICAL' | 'WARNING' | 'INFO';

export type DashboardProblemCategory =
  | 'SYSTEM'
  | 'AGENT'
  | 'SITE'
  | 'SERVICE'
  | 'BACKUP'
  | 'SSL'
  | 'OPERATION'
  | 'SECURITY'
  | 'UPDATE'
  | 'DNS';

export type DashboardProblemCode =
  | 'AGENT_OFFLINE'
  | 'METRICS_STALE'
  | 'DISK_USAGE_WARNING'
  | 'DISK_USAGE_CRITICAL'
  | 'NGINX_CONFIG_INVALID'
  | 'NGINX_MANAGED_CONFIG_DRIFT'
  | 'CORE_SERVICE_INACTIVE'
  | 'PM2_PROCESS_UNHEALTHY'
  | 'PM2_PROCESS_MISSING'
  | 'SITE_ERROR'
  | 'DOMAIN_APPLICATION_ERROR'
  | 'SITE_UNAVAILABLE'
  | 'BACKUP_LATEST_FAILED'
  | 'BACKUP_COVERAGE_GAP'
  | 'BACKUP_OVERDUE'
  | 'BACKUP_SCHEDULE_INVALID'
  | 'BACKUP_REPOSITORY_CHECK_FAILED'
  | 'SSL_ERROR'
  | 'SSL_EXPIRED'
  | 'SSL_EXPIRING_CRITICAL'
  | 'SSL_EXPIRING_WARNING'
  | 'SSL_EXPECTED_BUT_UNKNOWN'
  | 'OPERATION_RECENTLY_FAILED'
  | 'OPERATION_STALE'
  | 'DNS_PROVIDER_ERROR'
  | 'DNS_RECORD_DRIFT'
  | 'UPDATE_FAILED'
  | 'UPDATE_BLOCKED'
  | 'DATA_SOURCE_UNAVAILABLE';

export type DashboardEntityKind =
  | 'SERVER'
  | 'SITE'
  | 'DOMAIN'
  | 'SERVICE'
  | 'BACKUP'
  | 'CERTIFICATE'
  | 'OPERATION'
  | 'DNS_PROVIDER';

export type DashboardActionTarget =
  | 'MONITORING'
  | 'SITES'
  | 'SITE'
  | 'SERVICES'
  | 'BACKUPS'
  | 'SSL'
  | 'DNS'
  | 'UPDATES'
  | 'ACTIVITY';

export interface DashboardProblemAction {
  kind: 'NAVIGATE';
  target: DashboardActionTarget;
  entityId: string | null;
  label: string;
}

export interface DashboardProblem {
  id: string;
  code: DashboardProblemCode;
  severity: DashboardProblemSeverity;
  category: DashboardProblemCategory;
  title: string;
  summary: string;
  entity: {
    kind: DashboardEntityKind;
    id: string | null;
    label: string;
  };
  occurredAt: string | null;
  observedAt: string;
  action: DashboardProblemAction | null;
}

export interface DashboardProblemCollection {
  total: number;
  critical: number;
  warning: number;
  info: number;
  truncated: boolean;
  items: DashboardProblem[];
}

export interface DashboardServerPulse {
  source: DashboardSourceState;
  id: string;
  displayName: string;
  connectionState: 'ONLINE' | 'OFFLINE' | 'UNKNOWN';
  hostname: string | null;
  uptimeSeconds: number | null;
  agentState: 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN';
  agentLastSeenAt: string | null;
  installedVersion: string | null;
  updateState: 'CURRENT' | 'AVAILABLE' | 'FAILED' | 'UNKNOWN' | 'UNSUPPORTED';
  targetVersion: string | null;
}

export interface DashboardMetricHistoryPoint {
  observedAt: string;
  value: number;
}

export interface DashboardDiskMetric {
  mountPoint: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usagePercent: number;
}

export interface DashboardResourceSection {
  source: DashboardSourceState;
  collectedAt: string | null;
  cpuUsagePercent: number | null;
  cpuCores: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  memoryUsagePercent: number | null;
  loadAverage: [number, number, number] | null;
  disks: DashboardDiskMetric[];
  network: {
    rxBytesPerSecond: number;
    txBytesPerSecond: number;
  } | null;
  history: {
    cpu: DashboardMetricHistoryPoint[];
    memory: DashboardMetricHistoryPoint[];
    rootDisk: DashboardMetricHistoryPoint[];
  };
}

export interface DashboardSiteItem {
  id: string;
  displayName: string;
  primaryDomain: string | null;
  status: string;
  affectedDomainCount: number;
  availabilityPercent: number | null;
  availabilitySampleCount: number;
  activeOperation: boolean;
  updatedAt: string;
}

export interface DashboardSitesSection {
  source: DashboardSourceState;
  total: number;
  running: number;
  error: number;
  deploying: number;
  managedDomains: number;
  items: DashboardSiteItem[];
}

export interface DashboardOperationItem {
  id: string;
  type: string;
  status: string;
  target: string;
  siteId: string | null;
  progress: number;
  currentStep: string | null;
  startedAt: string | null;
  updatedAt: string;
}

export interface DashboardServiceItem {
  id: string;
  name: string;
  scope: 'CORE' | 'SITE';
  siteId: string | null;
  installed: boolean | null;
  expectedState: 'RUNNING' | 'STOPPED' | 'OPTIONAL';
  actualState: 'RUNNING' | 'STOPPED' | 'FAILED' | 'MISSING' | 'UNKNOWN';
  checkedAt: string | null;
}

export interface DashboardRuntimeSection {
  source: DashboardSourceState;
  activeOperations: DashboardOperationItem[];
  services: DashboardServiceItem[];
  diagnosticsPartial: boolean;
}

export interface DashboardBackupSummary {
  eligibleSiteCount: number;
  protectedSiteCount: number;
  latestSuccessfulAt: string | null;
  failedLast24Hours: number;
  overdueScheduleCount: number;
  activeCount: number;
  repositoryCheckState: 'OK' | 'FAILED' | 'UNKNOWN' | 'UNCONFIGURED';
  repositoryCheckedAt: string | null;
}

export interface DashboardSslException {
  certificateId: string;
  siteId: string;
  domain: string;
  status: string;
  expiresAt: string | null;
  daysRemaining: number | null;
}

export interface DashboardSslSummary {
  valid: number;
  expiring: number;
  expiredOrError: number;
  nearestExpiryDomain: string | null;
  nearestExpiryDays: number | null;
  exceptions: DashboardSslException[];
}

export interface DashboardProtectionSection {
  source: DashboardSourceState;
  backup: DashboardBackupSummary;
  ssl: DashboardSslSummary;
}

export interface DashboardSecuritySection {
  source: DashboardSourceState;
  failedLoginsLast24Hours: number;
  activeSessionCount: number;
  lastSuccessfulLoginAt: string | null;
  lastSuccessfulLoginActor: string | null;
  firewallSummary: string | null;
}

export interface DashboardActivityItem {
  id: string;
  occurredAt: string;
  actor: string;
  action: string;
  target: string;
  targetId: string | null;
  result: 'SUCCESS' | 'FAILED' | 'UNKNOWN';
}

export interface DashboardActivitySection {
  source: DashboardSourceState;
  items: DashboardActivityItem[];
}

export type DashboardCapabilityState = 'SUPPORTED' | 'UNSUPPORTED';

export interface DashboardCapabilities {
  overviewV1: boolean;
  nginxValidation: DashboardCapabilityState;
  nginxDrift: DashboardCapabilityState;
  dnsDrift: DashboardCapabilityState;
  pm2Diagnostics: DashboardCapabilityState;
  updateReadiness: DashboardCapabilityState;
}

export interface DashboardOverview {
  contractVersion: typeof DASHBOARD_CONTRACT_VERSION;
  generatedAt: string;
  role: DashboardRole;
  server: DashboardServerPulse;
  overall: DashboardOverallState;
  problems: DashboardProblemCollection;
  resources: DashboardResourceSection;
  sites: DashboardSitesSection;
  runtime: DashboardRuntimeSection;
  protection: DashboardProtectionSection;
  security: DashboardSecuritySection | null;
  activity: DashboardActivitySection;
  capabilities: DashboardCapabilities;
}

export const DASHBOARD_LIMITS = {
  problems: 100,
  sites: 8,
  activeOperations: 5,
  services: 8,
  activity: 8,
  metricHistoryPoints: 60,
  pm2DiagnosticSites: 2,
  nginxDiagnosticSites: 20,
} as const;
