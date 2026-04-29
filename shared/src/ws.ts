import {
  SiteStatus,
  BackupStatus,
  NotificationEvent,
} from './enums';

import type { SystemMetrics } from './entities';

// =============================================================================
// WebSocket event name constants
// =============================================================================

export const WsEvents = {
  SITE_STATUS: 'site:status',
  SITE_DEPLOY_LOG: 'site:deploy:log',
  SITE_LOGS: 'site:logs',
  SYSTEM_METRICS: 'system:metrics',
  BACKUP_PROGRESS: 'backup:progress',
  TERMINAL_DATA: 'terminal:data',
  NOTIFICATION: 'notification',
} as const;

export type WsEventName = (typeof WsEvents)[keyof typeof WsEvents];

// =============================================================================
// WebSocket event payloads
// =============================================================================

export interface WsSiteStatusPayload {
  siteId: string;
  status: SiteStatus;
  previousStatus: SiteStatus;
  timestamp: string;
}

export interface WsDeployLogPayload {
  siteId: string;
  deployLogId: string;
  line: string;
  stream: 'stdout' | 'stderr';
  timestamp: string;
}

export interface WsSiteLogsPayload {
  siteId: string;
  logType: 'access' | 'error' | 'php' | 'pm2';
  line: string;
  timestamp: string;
}

export interface WsSystemMetricsPayload extends SystemMetrics {}

export interface WsBackupProgressPayload {
  backupId: string;
  siteId: string;
  status: BackupStatus;
  progress: number;
  message: string;
  timestamp: string;
}

export interface WsTerminalDataPayload {
  sessionId: string;
  data: string;
}

export interface WsNotificationPayload {
  id: string;
  event: NotificationEvent;
  title: string;
  message: string;
  siteId: string | null;
  timestamp: string;
}

// =============================================================================
// Typed event map (for type-safe Socket.io usage)
// =============================================================================

export interface ServerToClientEvents {
  [WsEvents.SITE_STATUS]: (payload: WsSiteStatusPayload) => void;
  [WsEvents.SITE_DEPLOY_LOG]: (payload: WsDeployLogPayload) => void;
  [WsEvents.SITE_LOGS]: (payload: WsSiteLogsPayload) => void;
  [WsEvents.SYSTEM_METRICS]: (payload: WsSystemMetricsPayload) => void;
  [WsEvents.BACKUP_PROGRESS]: (payload: WsBackupProgressPayload) => void;
  [WsEvents.TERMINAL_DATA]: (payload: WsTerminalDataPayload) => void;
  [WsEvents.NOTIFICATION]: (payload: WsNotificationPayload) => void;
}

export interface ClientToServerEvents {
  'site:logs:subscribe': (payload: { siteId: string; logType: string }) => void;
  'site:logs:unsubscribe': (payload: { siteId: string }) => void;
  'site:deploy:subscribe': (payload: { siteId: string; deployLogId: string }) => void;
  'site:deploy:unsubscribe': (payload: { siteId: string }) => void;
  'terminal:input': (payload: { sessionId: string; data: string }) => void;
  'terminal:resize': (payload: { sessionId: string; cols: number; rows: number }) => void;
  'terminal:open': (callback: (payload: { sessionId: string }) => void) => void;
  'terminal:close': (payload: { sessionId: string }) => void;
}
