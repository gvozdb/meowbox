import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  DASHBOARD_CONTRACT_VERSION,
  DASHBOARD_LIMITS,
  safeErrorMessage,
  type DashboardActivitySection,
  type DashboardCapabilities,
  type DashboardOverview,
  type DashboardProtectionSection,
  type DashboardResourceSection,
  type DashboardRole,
  type DashboardRuntimeSection,
  type DashboardSecuritySection,
  type DashboardSitesSection,
  type DashboardSourceState,
} from '@meowbox/shared';
import { MonitoringService } from '../monitoring/monitoring.service';
import {
  dashboardOverviewMetricSamples,
  type DashboardOverviewSource,
} from '../common/dashboard-observability';
import { DashboardDiagnosticsService } from './dashboard-diagnostics.service';
import {
  DashboardQueryService,
  type DashboardAdminStateData,
  type DashboardOperationsData,
  type DashboardProtectionData,
  type DashboardRequestContext,
  type DashboardSitesData,
} from './dashboard-query.service';
import {
  deriveDashboardOverall,
  detectDashboardProblems,
} from './dashboard-problems';

const MAX_RESPONSE_BYTES = 128 * 1024;

function unavailableState(error: unknown, label: string): DashboardSourceState {
  return {
    availability: 'UNAVAILABLE',
    observedAt: null,
    staleAfterSeconds: null,
    message: safeErrorMessage(error, `${label} временно недоступны`, 240),
  };
}

function unsupportedState(message: string): DashboardSourceState {
  return {
    availability: 'UNSUPPORTED',
    observedAt: null,
    staleAfterSeconds: null,
    message,
  };
}

function emptySites(state: DashboardSourceState): DashboardSitesData {
  return {
    section: {
      source: state,
      total: 0,
      running: 0,
      error: 0,
      deploying: 0,
      managedDomains: 0,
      items: [],
    },
    siteProblems: [],
    domainProblems: [],
    healthProblems: [],
  };
}

function emptyOperations(): DashboardOperationsData {
  return { active: [], failures: [], activeCandidates: [] };
}

function emptyProtection(state: DashboardSourceState): DashboardProtectionData {
  return {
    section: {
      source: state,
      backup: {
        eligibleSiteCount: 0,
        protectedSiteCount: 0,
        latestSuccessfulAt: null,
        failedLast24Hours: 0,
        overdueScheduleCount: 0,
        activeCount: 0,
        repositoryCheckState: 'UNKNOWN',
        repositoryCheckedAt: null,
      },
      ssl: {
        valid: 0,
        expiring: 0,
        expiredOrError: 0,
        nearestExpiryDomain: null,
        nearestExpiryDays: null,
        exceptions: [],
      },
    },
    backupFailures: [],
    overdueBackups: [],
    invalidSchedules: [],
    coverageGapCount: 0,
    repositoryFailure: null,
    sslProblems: [],
  };
}

function emptyActivity(state: DashboardSourceState): DashboardActivitySection {
  return { source: state, items: [] };
}

function emptySecurity(state: DashboardSourceState): DashboardSecuritySection {
  return {
    source: state,
    failedLoginsLast24Hours: 0,
    activeSessionCount: 0,
    lastSuccessfulLoginAt: null,
    lastSuccessfulLoginActor: null,
    firewallSummary: null,
  };
}

function emptyResources(state: DashboardSourceState): DashboardResourceSection {
  return {
    source: state,
    collectedAt: null,
    cpuUsagePercent: null,
    cpuCores: null,
    memoryUsedBytes: null,
    memoryTotalBytes: null,
    memoryUsagePercent: null,
    loadAverage: null,
    disks: [],
    network: null,
    history: { cpu: [], memory: [], rootDisk: [] },
  };
}

function isFulfilled<T>(
  result: PromiseSettledResult<T>,
): result is PromiseFulfilledResult<T> {
  return result.status === 'fulfilled';
}

export function enforceDashboardResponseCap(
  overview: DashboardOverview,
  maxBytes = MAX_RESPONSE_BYTES,
): DashboardOverview {
  const exceedsLimit = () => Buffer.byteLength(JSON.stringify(overview), 'utf8') > maxBytes;
  const boundedLists: unknown[][] = [
    overview.problems.items,
    overview.activity.items,
    overview.resources.history.cpu,
    overview.resources.history.memory,
    overview.resources.history.rootDisk,
    overview.runtime.services,
    overview.runtime.activeOperations,
    overview.sites.items,
    overview.protection.ssl.exceptions,
    overview.resources.disks,
  ];
  for (const list of boundedLists) {
    while (exceedsLimit() && list.length > 0) {
      list.pop();
      if (list === overview.problems.items) overview.problems.truncated = true;
    }
  }
  if (exceedsLimit()) {
    overview.server.hostname = null;
    overview.protection.ssl.nearestExpiryDomain = null;
    if (overview.security) overview.security.lastSuccessfulLoginActor = null;
  }
  return overview;
}

@Injectable()
export class DashboardOverviewService {
  private readonly logger = new Logger(DashboardOverviewService.name);

  constructor(
    private readonly query: DashboardQueryService,
    private readonly monitoring: MonitoringService,
    private readonly diagnostics: DashboardDiagnosticsService,
  ) {}

  async getOverview(userId: string, roleValue: string): Promise<DashboardOverview> {
    const startedAt = Date.now();
    const correlationId = randomUUID();
    if (roleValue !== 'ADMIN' && roleValue !== 'MANAGER') {
      throw new ForbiddenException('Dashboard Overview is not available for this role');
    }
    const role: DashboardRole = roleValue;
    const generatedAt = new Date().toISOString();
    const context: DashboardRequestContext = { userId, role };

    const [sitesResult, operationsResult, protectionResult, securityResult, activityResult, adminResult, resourcesResult] =
      await Promise.allSettled([
        this.query.loadSites(context, generatedAt),
        this.query.loadOperations(context, generatedAt),
        this.query.loadProtection(context, generatedAt),
        this.query.loadSecurity(context, generatedAt),
        this.query.loadActivity(context, generatedAt),
        this.query.loadAdminState(context, generatedAt),
        this.buildResources(role, generatedAt),
      ]);

    const sites = isFulfilled(sitesResult)
      ? sitesResult.value
      : emptySites(unavailableState(sitesResult.reason, 'Данные сайтов'));
    const operations = isFulfilled(operationsResult)
      ? operationsResult.value
      : emptyOperations();
    const operationSource: DashboardSourceState = isFulfilled(operationsResult)
      ? {
          availability: 'OK',
          observedAt: generatedAt,
          staleAfterSeconds: 60,
          message: null,
        }
      : unavailableState(operationsResult.reason, 'Операции');
    const protection = isFulfilled(protectionResult)
      ? protectionResult.value
      : emptyProtection(unavailableState(protectionResult.reason, 'Данные защиты'));
    const activity = isFulfilled(activityResult)
      ? activityResult.value
      : emptyActivity(unavailableState(activityResult.reason, 'Активность'));
    const security = role === 'MANAGER'
      ? null
      : isFulfilled(securityResult) && securityResult.value
        ? securityResult.value
        : emptySecurity(
            unavailableState(
              isFulfilled(securityResult) ? 'Источник не вернул данные' : securityResult.reason,
              'Данные безопасности',
            ),
          );
    const admin: DashboardAdminStateData = isFulfilled(adminResult)
      ? adminResult.value
      : { dnsProviders: [], update: null };
    const diagnostics = this.diagnostics.getSnapshot();
    const resources = isFulfilled(resourcesResult)
      ? resourcesResult.value
      : emptyResources(unavailableState(resourcesResult.reason, 'Метрики'));

    const capabilities: DashboardCapabilities = {
      overviewV1: true,
      nginxValidation: role === 'ADMIN' ? 'SUPPORTED' : 'UNSUPPORTED',
      nginxDrift: role === 'ADMIN' ? 'SUPPORTED' : 'UNSUPPORTED',
      dnsDrift:
        role === 'ADMIN' && diagnostics.dns.source.availability !== 'UNSUPPORTED'
          ? 'SUPPORTED'
          : 'UNSUPPORTED',
      pm2Diagnostics: role === 'ADMIN' ? 'SUPPORTED' : 'UNSUPPORTED',
      updateReadiness: 'UNSUPPORTED',
    };
    const runtimeSource = role === 'MANAGER'
      ? operationSource
      : operationSource.availability !== 'OK'
        ? operationSource
        : diagnostics.source;
    const runtime: DashboardRuntimeSection = {
      source: runtimeSource,
      activeOperations: operations.active.slice(0, DASHBOARD_LIMITS.activeOperations),
      services:
        role === 'ADMIN'
          ? diagnostics.services.slice(0, DASHBOARD_LIMITS.services)
          : [],
      diagnosticsPartial: role === 'ADMIN' && this.diagnostics.isPartial(),
    };
    const sourceStates = [
      resources.source,
      sites.section.source,
      protection.section.source,
      activity.source,
      runtime.source,
      ...(security ? [security.source] : []),
    ];
    const unsupportedCapabilityCount = Object.values(capabilities).filter(
      (value) => value === 'UNSUPPORTED',
    ).length;
    const problems = detectDashboardProblems(
      {
        generatedAt,
        role,
        metrics: role === 'ADMIN' ? this.monitoring.getLatestMetrics() : null,
        resources,
        sites,
        operations,
        protection,
        admin,
        diagnostics,
        sourceStates,
        unsupportedCapabilityCount,
      },
      (detector, error) => {
        this.logger.error(
          JSON.stringify({
            event: 'dashboard_detector_failed',
            correlationId,
            detector,
            error: safeErrorMessage(error, 'Detector failed', 240),
          }),
        );
      },
    );
    const installedVersion = role === 'ADMIN'
      ? this.diagnostics.getInstalledVersion()
      : null;
    const metrics = role === 'ADMIN' ? this.monitoring.getLatestMetrics() : null;
    const updateState = role !== 'ADMIN'
      ? 'UNSUPPORTED' as const
      : admin.update?.status === 'failed'
        ? 'FAILED' as const
        : 'UNKNOWN' as const;

    const overview: DashboardOverview = {
      contractVersion: DASHBOARD_CONTRACT_VERSION,
      generatedAt,
      role,
      server: {
        source: {
          availability: 'OK',
          observedAt: generatedAt,
          staleAfterSeconds: 60,
          message: null,
        },
        id: 'main',
        displayName: 'Этот сервер',
        connectionState: 'ONLINE',
        hostname: role === 'ADMIN' ? metrics?.hostname ?? null : null,
        uptimeSeconds: role === 'ADMIN' ? metrics?.uptimeSeconds ?? null : null,
        agentState:
          role !== 'ADMIN'
            ? 'UNKNOWN'
            : diagnostics.agentConnected
              ? 'CONNECTED'
              : 'DISCONNECTED',
        agentLastSeenAt:
          role === 'ADMIN' ? metrics?.collectedAt ?? diagnostics.source.observedAt : null,
        installedVersion,
        updateState,
        targetVersion: admin.update?.toVersion ?? null,
      },
      overall: deriveDashboardOverall(
        problems,
        sourceStates,
        unsupportedCapabilityCount,
      ),
      problems,
      resources,
      sites: sites.section,
      runtime,
      protection: protection.section,
      security,
      activity,
      capabilities,
    };
    enforceDashboardResponseCap(overview);

    const sectionStates = sourceStates.map((state) => state.availability).join(',');
    const partialSources = new Set<DashboardOverviewSource>();
    const observedSources: Array<{
      source: DashboardOverviewSource;
      state: DashboardSourceState;
    }> = [
      { source: 'resources', state: resources.source },
      { source: 'sites', state: sites.section.source },
      { source: 'runtime', state: runtime.source },
      { source: 'protection', state: protection.section.source },
      { source: 'activity', state: activity.source },
      ...(security ? [{ source: 'security' as const, state: security.source }] : []),
    ];
    for (const source of observedSources) {
      if (source.state.availability === 'STALE' || source.state.availability === 'UNAVAILABLE') {
        partialSources.add(source.source);
      }
    }
    if (!isFulfilled(operationsResult)) partialSources.add('operations');
    if (!isFulfilled(adminResult)) partialSources.add('admin');
    const durationMs = Date.now() - startedAt;
    this.logger.log(
      JSON.stringify({
        event: 'dashboard_overview_complete',
        correlationId,
        durationMs,
        role,
        sectionStates,
        problemCounts: {
          critical: problems.critical,
          warning: problems.warning,
          info: problems.info,
        },
        metrics: dashboardOverviewMetricSamples({
          durationMs,
          role,
          localOrProxy: 'local',
          partialSources,
          problems: problems.items,
        }),
      }),
    );
    return overview;
  }

  private async buildResources(
    role: DashboardRole,
    generatedAt: string,
  ): Promise<DashboardResourceSection> {
    if (role !== 'ADMIN') {
      return emptyResources(
        unsupportedState('Метрики сервера доступны только администратору'),
      );
    }
    const metrics = this.monitoring.getLatestMetrics();
    if (!metrics) {
      return emptyResources(
        unavailableState('Agent ещё не передал метрики', 'Метрики'),
      );
    }
    const ageSeconds = Math.max(
      0,
      (Date.parse(generatedAt) - Date.parse(metrics.collectedAt)) / 1000,
    );
    const coreMetricsAvailable =
      metrics.cpuPercent !== null &&
      metrics.memoryUsed !== null &&
      metrics.memoryTotal !== null &&
      metrics.memoryPercent !== null &&
      metrics.disks.length > 0;
    const history = await this.monitoring.getHistory('1h').catch((error) => {
      this.logger.warn(`Dashboard metric history unavailable: ${safeErrorMessage(error)}`);
      return [];
    });
    const points = history.slice(-DASHBOARD_LIMITS.metricHistoryPoints);
    return {
      source: {
        availability: !coreMetricsAvailable
          ? 'UNAVAILABLE'
          : ageSeconds > 45
            ? 'STALE'
            : 'OK',
        observedAt: metrics.collectedAt,
        staleAfterSeconds: 45,
        message: !coreMetricsAvailable
          ? 'Agent передал неполный снимок метрик'
          : ageSeconds > 45
            ? 'Метрики устарели'
            : null,
      },
      collectedAt: metrics.collectedAt,
      cpuUsagePercent: metrics.cpuPercent,
      cpuCores: metrics.cpuCores,
      memoryUsedBytes: metrics.memoryUsed,
      memoryTotalBytes: metrics.memoryTotal,
      memoryUsagePercent: metrics.memoryPercent,
      loadAverage: metrics.loadAverage,
      disks: metrics.disks.map((disk) => ({
        mountPoint: disk.mountPoint,
        totalBytes: disk.totalBytes,
        usedBytes: disk.usedBytes,
        availableBytes: disk.availableBytes,
        usagePercent: disk.usagePercent,
      })),
      network:
        metrics.networkRx !== null && metrics.networkTx !== null
          ? {
              rxBytesPerSecond: metrics.networkRx,
              txBytesPerSecond: metrics.networkTx,
            }
          : null,
      history: {
        cpu: points.map((point) => ({ observedAt: point.t, value: point.cpu })),
        memory: points.map((point) => ({ observedAt: point.t, value: point.mem })),
        rootDisk: points.map((point) => ({ observedAt: point.t, value: point.disk })),
      },
    };
  }
}
