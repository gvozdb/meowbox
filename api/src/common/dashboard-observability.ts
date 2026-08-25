import type {
  DashboardProblem,
  DashboardProblemCode,
  DashboardProblemSeverity,
  DashboardRole,
} from '@meowbox/shared';

export type DashboardMetricName =
  | 'dashboard_overview_duration_ms'
  | 'dashboard_overview_partial_failure_total'
  | 'dashboard_problem_count'
  | 'dashboard_diagnostic_duration_ms'
  | 'dashboard_diagnostic_failure_total';

export type DashboardOverviewSource =
  | 'resources'
  | 'sites'
  | 'operations'
  | 'runtime'
  | 'protection'
  | 'security'
  | 'activity'
  | 'admin';

export type DashboardDiagnostic =
  | 'core'
  | 'nginx_validation'
  | 'pm2'
  | 'nginx_drift'
  | 'dns';

export type DashboardDiagnosticFailureReason =
  | 'agent_disconnected'
  | 'agent_rejected'
  | 'timeout'
  | 'database'
  | 'permission'
  | 'invalid_response'
  | 'unexpected';

export interface DashboardMetricSample {
  name: DashboardMetricName;
  value: number;
  labels: Readonly<Record<string, string>>;
}

function duration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

export function dashboardOverviewMetricSamples(input: {
  durationMs: number;
  role: DashboardRole;
  localOrProxy: 'local' | 'proxy';
  partialSources?: Iterable<DashboardOverviewSource>;
  problems?: Iterable<DashboardProblem>;
}): DashboardMetricSample[] {
  const samples: DashboardMetricSample[] = [
    {
      name: 'dashboard_overview_duration_ms',
      value: duration(input.durationMs),
      labels: {
        role: input.role,
        local_or_proxy: input.localOrProxy,
      },
    },
  ];

  for (const source of new Set(input.partialSources ?? [])) {
    samples.push({
      name: 'dashboard_overview_partial_failure_total',
      value: 1,
      labels: { source },
    });
  }

  const problemCounts = new Map<
    string,
    { code: DashboardProblemCode; severity: DashboardProblemSeverity; count: number }
  >();
  for (const problem of input.problems ?? []) {
    const key = `${problem.code}:${problem.severity}`;
    const current = problemCounts.get(key);
    if (current) {
      current.count += 1;
    } else {
      problemCounts.set(key, {
        code: problem.code,
        severity: problem.severity,
        count: 1,
      });
    }
  }
  for (const item of problemCounts.values()) {
    samples.push({
      name: 'dashboard_problem_count',
      value: item.count,
      labels: { code: item.code, severity: item.severity },
    });
  }
  return samples;
}

export function dashboardDiagnosticMetricSamples(input: {
  diagnostic: DashboardDiagnostic;
  durationMs: number;
  failureReason?: DashboardDiagnosticFailureReason | null;
}): DashboardMetricSample[] {
  const samples: DashboardMetricSample[] = [
    {
      name: 'dashboard_diagnostic_duration_ms',
      value: duration(input.durationMs),
      labels: { diagnostic: input.diagnostic },
    },
  ];
  if (input.failureReason) {
    samples.push({
      name: 'dashboard_diagnostic_failure_total',
      value: 1,
      labels: {
        diagnostic: input.diagnostic,
        reason: input.failureReason,
      },
    });
  }
  return samples;
}

export function dashboardDiagnosticFailureReason(
  error: unknown,
): DashboardDiagnosticFailureReason {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes('disconnect') || message.includes('no agent')) return 'agent_disconnected';
  if (message.includes('timeout') || message.includes('timed out')) return 'timeout';
  if (message.includes('reject')) return 'agent_rejected';
  if (message.includes('prisma') || message.includes('database') || message.includes('sqlite')) {
    return 'database';
  }
  if (message.includes('eacces') || message.includes('eperm') || message.includes('permission')) {
    return 'permission';
  }
  if (message.includes('invalid') || message.includes('malformed')) return 'invalid_response';
  return 'unexpected';
}
