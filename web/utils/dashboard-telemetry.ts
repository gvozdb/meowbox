export type DashboardWebTelemetryEvent =
  | 'dashboard_contract_unsupported'
  | 'dashboard_full_refresh_failure'
  | 'dashboard_section_unavailable';

export type DashboardTelemetrySection =
  | 'server'
  | 'resources'
  | 'sites'
  | 'runtime'
  | 'protection'
  | 'security'
  | 'activity';

export type DashboardRefreshFailureReason =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'http_error'
  | 'network'
  | 'invalid_contract'
  | 'unexpected';

type DashboardTelemetryRecord =
  | { event: 'dashboard_contract_unsupported' }
  | { event: 'dashboard_full_refresh_failure'; reason: DashboardRefreshFailureReason }
  | { event: 'dashboard_section_unavailable'; source: DashboardTelemetrySection };

export function emitDashboardTelemetry(record: DashboardTelemetryRecord): void {
  if (!import.meta.client) return;
  console.warn(JSON.stringify(record));
}
