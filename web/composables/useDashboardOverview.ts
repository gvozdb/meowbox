import type {
  DashboardOverview,
  DashboardSourceState,
} from '@meowbox/shared';
import {
  emitDashboardTelemetry,
  type DashboardRefreshFailureReason,
  type DashboardTelemetrySection,
} from '~/utils/dashboard-telemetry';

const POLL_INTERVAL_MS = 30_000;
const DASHBOARD_CONTRACT_VERSION = 1 as const;
const SOURCE_STATES = new Set(['OK', 'STALE', 'UNAVAILABLE', 'UNSUPPORTED']);
const OVERALL_STATES = new Set(['HEALTHY', 'ATTENTION', 'CRITICAL', 'UNKNOWN']);
const ACTION_TARGETS = new Set([
  'MONITORING', 'SITES', 'SITE', 'SERVICES', 'BACKUPS',
  'SSL', 'DNS', 'UPDATES', 'ACTIVITY',
]);
const SERVICE_STATES = new Set(['RUNNING', 'STOPPED', 'FAILED', 'MISSING', 'UNKNOWN']);

interface ApiStatusError extends Error {
  status?: number;
  statusCode?: number;
  response?: { status?: number };
}

interface LegacyMetrics {
  cpuUsagePercent?: unknown;
  memoryTotalBytes?: unknown;
  memoryUsedBytes?: unknown;
  memoryUsagePercent?: unknown;
  uptimeSeconds?: unknown;
  cpuCores?: unknown;
  hostname?: unknown;
  loadAverage?: unknown;
  collectedAt?: unknown;
  disks?: unknown;
  network?: unknown;
}

interface LegacySite {
  id?: unknown;
  name?: unknown;
  displayName?: unknown;
  status?: unknown;
  updatedAt?: unknown;
  primaryDomain?: { domain?: unknown } | null;
}

function statusOf(error: unknown): number | undefined {
  const value = error as ApiStatusError;
  return value.status ?? value.statusCode ?? value.response?.status;
}

function refreshFailureReason(error: unknown): DashboardRefreshFailureReason {
  const status = statusOf(error);
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (typeof status === 'number') return 'http_error';
  const message = error instanceof Error ? error.message : '';
  if (/Dashboard Overview|контракт|секци|сводк|списк|capability/i.test(message)) {
    return 'invalid_contract';
  }
  if (error instanceof TypeError) return 'network';
  return 'unexpected';
}

function finite(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

function text(value: unknown, max = 160): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function source(availability: DashboardSourceState['availability'], message: string | null): DashboardSourceState {
  return { availability, observedAt: null, staleAfterSeconds: null, message };
}

function isSourceState(value: unknown): value is DashboardSourceState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return SOURCE_STATES.has(String(candidate.availability))
    && (
      candidate.observedAt === null ||
      (typeof candidate.observedAt === 'string' && Number.isFinite(Date.parse(candidate.observedAt)))
    )
    && (
      candidate.staleAfterSeconds === null ||
      finite(candidate.staleAfterSeconds) !== null
    )
    && (
      candidate.message === null ||
      (typeof candidate.message === 'string' && candidate.message.length <= 240)
    );
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nullableFinite(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): boolean {
  return value === null || finite(value, min, max) !== null;
}

function validHistoryPoint(value: unknown): boolean {
  const point = object(value);
  return Boolean(
    point &&
    typeof point.observedAt === 'string' &&
    Number.isFinite(Date.parse(point.observedAt)) &&
    finite(point.value, 0, 100) !== null,
  );
}

export function validateDashboardOverview(value: unknown): DashboardOverview {
  if (!value || typeof value !== 'object') throw new Error('Некорректный ответ Dashboard Overview');
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 128 * 1024) {
    throw new Error('Dashboard Overview превысил допустимый размер');
  }
  const item = value as Record<string, unknown>;
  if (item.contractVersion !== DASHBOARD_CONTRACT_VERSION) {
    throw new Error(`Неподдерживаемая версия Dashboard Overview: ${String(item.contractVersion)}`);
  }
  if (!['ADMIN', 'MANAGER'].includes(String(item.role)) || typeof item.generatedAt !== 'string' || !Number.isFinite(Date.parse(item.generatedAt))) {
    throw new Error('Некорректный контекст Dashboard Overview');
  }
  for (const key of ['server', 'overall', 'problems', 'resources', 'sites', 'runtime', 'protection', 'activity', 'capabilities']) {
    if (!item[key] || typeof item[key] !== 'object') throw new Error(`Отсутствует секция ${key}`);
  }
  const sections = ['server', 'resources', 'sites', 'runtime', 'protection', 'activity'];
  for (const key of sections) {
    if (!isSourceState((item[key] as Record<string, unknown>).source)) {
      throw new Error(`Некорректное состояние секции ${key}`);
    }
  }
  const server = item.server as Record<string, unknown>;
  const overall = item.overall as Record<string, unknown>;
  const capabilities = item.capabilities as Record<string, unknown>;
  if (
    typeof server.id !== 'string' || server.id.length > 128 ||
    typeof server.displayName !== 'string' || server.displayName.length > 160 ||
    !['ONLINE', 'OFFLINE', 'UNKNOWN'].includes(String(server.connectionState)) ||
    !['CONNECTED', 'DISCONNECTED', 'UNKNOWN'].includes(String(server.agentState)) ||
    !nullableFinite(server.uptimeSeconds) ||
    !OVERALL_STATES.has(String(overall.state)) ||
    finite(overall.criticalCount) === null ||
    finite(overall.warningCount) === null ||
    finite(overall.infoCount) === null ||
    finite(overall.degradedSourceCount) === null ||
    typeof capabilities.overviewV1 !== 'boolean'
  ) {
    throw new Error('Некорректная сводка Dashboard Overview');
  }
  for (const key of [
    'nginxValidation', 'nginxDrift', 'dnsDrift', 'pm2Diagnostics', 'updateReadiness',
  ]) {
    if (!['SUPPORTED', 'UNSUPPORTED'].includes(String(capabilities[key]))) {
      throw new Error(`Некорректная capability ${key}`);
    }
  }
  if (!Array.isArray((item.problems as Record<string, unknown>).items)
    || !Array.isArray((item.sites as Record<string, unknown>).items)
    || !Array.isArray((item.runtime as Record<string, unknown>).activeOperations)
    || !Array.isArray((item.runtime as Record<string, unknown>).services)
    || !Array.isArray((item.activity as Record<string, unknown>).items)) {
    throw new Error('Некорректные списки Dashboard Overview');
  }
  const problems = (item.problems as Record<string, unknown>).items as unknown[];
  const sites = (item.sites as Record<string, unknown>).items as unknown[];
  const runtime = item.runtime as Record<string, unknown>;
  const activity = (item.activity as Record<string, unknown>).items as unknown[];
  const protection = item.protection as Record<string, unknown>;
  const ssl = protection.ssl as Record<string, unknown> | undefined;
  if (
    problems.length > 100 || sites.length > 8 ||
    (runtime.activeOperations as unknown[]).length > 5 ||
    (runtime.services as unknown[]).length > 8 || activity.length > 8 ||
    (Array.isArray(ssl?.exceptions) && ssl.exceptions.length > 8)
  ) {
    throw new Error('Dashboard Overview превысил контрактные лимиты');
  }
  const validProblems = problems.every((entry) => {
    const problem = object(entry);
    const entity = object(problem?.entity);
    const action = problem?.action === null ? null : object(problem?.action);
    return Boolean(
      problem && typeof problem.id === 'string' && typeof problem.title === 'string' &&
      problem.title.length <= 100 && typeof problem.summary === 'string' && problem.summary.length <= 240 &&
      ['CRITICAL', 'WARNING', 'INFO'].includes(String(problem.severity)) &&
      entity && typeof entity.label === 'string' && entity.label.length <= 120 &&
      (
        action === null ||
        (
          action.kind === 'NAVIGATE' &&
          ACTION_TARGETS.has(String(action.target)) &&
          typeof action.label === 'string' &&
          action.label.length <= 80
        )
      ),
    );
  });
  const validSites = sites.every((entry) => {
    const site = object(entry);
    return Boolean(
      site &&
      typeof site.id === 'string' && site.id.length <= 128 &&
      typeof site.displayName === 'string' && site.displayName.length <= 160 &&
      typeof site.status === 'string' &&
      nullableFinite(site.availabilityPercent, 0, 100),
    );
  });
  const validServices = (runtime.services as unknown[]).every((entry) => {
    const service = object(entry);
    return Boolean(
      service &&
      typeof service.id === 'string' && service.id.length <= 256 &&
      typeof service.name === 'string' && service.name.length <= 160 &&
      SERVICE_STATES.has(String(service.actualState)),
    );
  });
  const validOperations = (runtime.activeOperations as unknown[]).every((entry) => {
    const operation = object(entry);
    return Boolean(
      operation &&
      typeof operation.id === 'string' &&
      typeof operation.type === 'string' &&
      typeof operation.status === 'string' &&
      typeof operation.target === 'string' &&
      finite(operation.progress, 0, 100) !== null,
    );
  });
  const validActivity = activity.every((entry) => {
    const event = object(entry);
    return Boolean(
      event &&
      typeof event.id === 'string' &&
      typeof event.action === 'string' &&
      typeof event.occurredAt === 'string' && Number.isFinite(Date.parse(event.occurredAt)) &&
      ['SUCCESS', 'FAILED', 'UNKNOWN'].includes(String(event.result)),
    );
  });
  const resources = item.resources as Record<string, unknown>;
  const history = object(resources.history);
  const loadAverage = resources.loadAverage;
  const validLoadAverage = loadAverage === null || (
    Array.isArray(loadAverage) &&
    loadAverage.length === 3 &&
    loadAverage.every((entry) => finite(entry) !== null)
  );
  const network = resources.network === null ? null : object(resources.network);
  const validNetwork = resources.network === null || Boolean(
    network &&
    finite(network.rxBytesPerSecond) !== null &&
    finite(network.txBytesPerSecond) !== null,
  );
  const disks = Array.isArray(resources.disks) ? resources.disks : [];
  const validDisks = disks.every((entry) => {
    const disk = object(entry);
    const totalBytes = disk ? finite(disk.totalBytes, 1) : null;
    const usedBytes = disk ? finite(disk.usedBytes) : null;
    const availableBytes = disk ? finite(disk.availableBytes) : null;
    return Boolean(
      disk &&
      typeof disk.mountPoint === 'string' && disk.mountPoint.length <= 256 &&
      totalBytes !== null &&
      usedBytes !== null && usedBytes <= totalBytes &&
      availableBytes !== null && availableBytes <= totalBytes &&
      finite(disk.usagePercent, 0, 100) !== null,
    );
  });
  const historyLists = history
    ? [history.cpu, history.memory, history.rootDisk]
    : [];
  const validHistory = historyLists.length === 3 && historyLists.every(
    (list) => Array.isArray(list) && list.length <= 60 && list.every(validHistoryPoint),
  );
  const backup = object(protection.backup);
  const validBackup = Boolean(backup) && [
    'eligibleSiteCount', 'protectedSiteCount', 'failedLast24Hours',
    'overdueScheduleCount', 'activeCount',
  ].every((key) => finite(backup?.[key]) !== null);
  const validSsl = Boolean(ssl) && [
    'valid', 'expiring', 'expiredOrError',
  ].every((key) => finite(ssl?.[key]) !== null) &&
    (ssl?.nearestExpiryDays === null || finite(ssl?.nearestExpiryDays, -100_000, 100_000) !== null) &&
    Array.isArray(ssl?.exceptions) && ssl.exceptions.every((entry) => {
      const exception = object(entry);
      return Boolean(
        exception &&
        typeof exception.certificateId === 'string' &&
        typeof exception.siteId === 'string' &&
        typeof exception.domain === 'string' &&
        typeof exception.status === 'string' &&
        nullableFinite(exception.daysRemaining, -100_000, 100_000),
      );
    });
  const security = item.security === null ? null : object(item.security);
  const validSecurity = item.security === null || Boolean(
    security &&
    isSourceState(security.source) &&
    finite(security.failedLoginsLast24Hours) !== null &&
    finite(security.activeSessionCount) !== null,
  );
  if (
    !validProblems || !validSites || !validServices || !validOperations || !validActivity ||
    !validDisks || !validHistory || !validLoadAverage || !validNetwork ||
    !nullableFinite(resources.cpuUsagePercent, 0, 100) ||
    !nullableFinite(resources.cpuCores, 1, 4096) ||
    !nullableFinite(resources.memoryUsedBytes) ||
    !nullableFinite(resources.memoryTotalBytes, 1) ||
    !nullableFinite(resources.memoryUsagePercent, 0, 100) ||
    !validBackup || !validSsl || !validSecurity
  ) {
    throw new Error('Некорректное содержимое Dashboard Overview');
  }
  return value as DashboardOverview;
}

function normalizeLegacyDisk(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const disk = value as Record<string, unknown>;
  const mountPoint = text(disk.mountPoint, 100);
  const totalBytes = finite(disk.totalBytes);
  const usedBytes = finite(disk.usedBytes);
  const usagePercent = finite(disk.usagePercent, 0, 100);
  if (
    !mountPoint ||
    totalBytes === null ||
    totalBytes <= 0 ||
    usedBytes === null ||
    usedBytes > totalBytes ||
    usagePercent === null
  ) return null;
  return {
    mountPoint,
    totalBytes,
    usedBytes,
    availableBytes: Math.max(0, totalBytes - usedBytes),
    usagePercent,
  };
}

async function loadLegacyOverview(api: ReturnType<typeof useApi>, signal: AbortSignal): Promise<DashboardOverview> {
  const results = await Promise.allSettled([
    api.get<unknown>('/dashboard/summary', { signal }),
    api.get<LegacyMetrics>('/system/metrics', { signal }),
    api.get<LegacySite[]>('/sites', { signal }),
  ]);
  for (const result of results) {
    if (result.status === 'rejected' && [401, 403].includes(statusOf(result.reason) ?? 0)) throw result.reason;
  }

  const now = new Date().toISOString();
  const metrics = results[1].status === 'fulfilled' ? results[1].value : null;
  const legacySites = results[2].status === 'fulfilled' && Array.isArray(results[2].value) ? results[2].value : [];
  const metricState = metrics ? source('STALE', 'Legacy API: свежесть метрик не подтверждается') : source('UNAVAILABLE', 'Legacy API не вернул метрики');
  const siteState = results[2].status === 'fulfilled' ? source('STALE', 'Legacy API: снимок сайтов неатомарный') : source('UNAVAILABLE', 'Legacy API не вернул сайты');
  const unsupported = source('UNSUPPORTED', 'Выбранный сервер не поддерживает Dashboard Overview v1');
  const disks = Array.isArray(metrics?.disks) ? metrics.disks.map(normalizeLegacyDisk).filter((item): item is NonNullable<typeof item> => Boolean(item)) : [];
  const networkValue = metrics?.network && typeof metrics.network === 'object' ? metrics.network as Record<string, unknown> : null;
  const rx = finite(networkValue?.rxBytesPerSecond ?? networkValue?.rxBytesPerSec);
  const tx = finite(networkValue?.txBytesPerSecond ?? networkValue?.txBytesPerSec);
  const memoryTotal = finite(metrics?.memoryTotalBytes);
  const memoryUsed = finite(metrics?.memoryUsedBytes);
  const rawLoad = Array.isArray(metrics?.loadAverage) && metrics.loadAverage.length === 3
    ? metrics.loadAverage.map((item) => finite(item))
    : null;
  const loadAverage: [number, number, number] | null = rawLoad?.every((item) => item !== null)
    ? [rawLoad[0] as number, rawLoad[1] as number, rawLoad[2] as number]
    : null;
  const sites = legacySites.flatMap((raw) => {
    const id = text(raw?.id, 128);
    const name = text(raw?.displayName) ?? text(raw?.name);
    const status = text(raw?.status, 40);
    if (!id || !name || !status) return [];
    return [{
      id,
      displayName: name,
      primaryDomain: text(raw.primaryDomain?.domain, 253),
      status,
      affectedDomainCount: 0,
      availabilityPercent: null,
      availabilitySampleCount: 0,
      activeOperation: false,
      updatedAt: text(raw.updatedAt, 40) ?? now,
    }];
  }).slice(0, 8);

  return {
    contractVersion: DASHBOARD_CONTRACT_VERSION,
    generatedAt: now,
    role: 'ADMIN',
    server: {
      source: unsupported,
      id: 'main',
      displayName: 'Выбранный сервер',
      connectionState: 'UNKNOWN',
      hostname: text(metrics?.hostname),
      uptimeSeconds: finite(metrics?.uptimeSeconds),
      agentState: 'UNKNOWN',
      agentLastSeenAt: text(metrics?.collectedAt, 40),
      installedVersion: null,
      updateState: 'UNSUPPORTED',
      targetVersion: null,
    },
    overall: { state: 'UNKNOWN', criticalCount: 0, warningCount: 0, infoCount: 0, degradedSourceCount: 6 },
    problems: { total: 0, critical: 0, warning: 0, info: 0, truncated: false, items: [] },
    resources: {
      source: metricState,
      collectedAt: text(metrics?.collectedAt, 40),
      cpuUsagePercent: finite(metrics?.cpuUsagePercent, 0, 100),
      cpuCores: finite(metrics?.cpuCores, 1, 4096),
      memoryUsedBytes: memoryUsed,
      memoryTotalBytes: memoryTotal,
      memoryUsagePercent: finite(metrics?.memoryUsagePercent, 0, 100),
      loadAverage,
      disks,
      network: rx !== null && tx !== null ? { rxBytesPerSecond: rx, txBytesPerSecond: tx } : null,
      history: { cpu: [], memory: [], rootDisk: [] },
    },
    sites: {
      source: siteState,
      total: legacySites.length,
      running: legacySites.filter((item) => item?.status === 'RUNNING').length,
      error: legacySites.filter((item) => item?.status === 'ERROR').length,
      deploying: legacySites.filter((item) => item?.status === 'DEPLOYING').length,
      managedDomains: legacySites.filter((item) => text(item?.primaryDomain?.domain, 253)).length,
      items: sites,
    },
    runtime: { source: unsupported, activeOperations: [], services: [], diagnosticsPartial: false },
    protection: {
      source: unsupported,
      backup: {
        eligibleSiteCount: legacySites.length,
        protectedSiteCount: 0,
        latestSuccessfulAt: null,
        failedLast24Hours: 0,
        overdueScheduleCount: 0,
        activeCount: 0,
        repositoryCheckState: 'UNKNOWN',
        repositoryCheckedAt: null,
      },
      ssl: { valid: 0, expiring: 0, expiredOrError: 0, nearestExpiryDomain: null, nearestExpiryDays: null, exceptions: [] },
    },
    security: null,
    activity: { source: unsupported, items: [] },
    capabilities: {
      overviewV1: false,
      nginxValidation: 'UNSUPPORTED',
      nginxDrift: 'UNSUPPORTED',
      dnsDrift: 'UNSUPPORTED',
      pm2Diagnostics: 'UNSUPPORTED',
      updateReadiness: 'UNSUPPORTED',
    },
  };
}

export function useDashboardOverview() {
  const api = useApi();
  const { metrics: socketMetrics } = useSocket();
  const serverStore = useServerStore();
  const snapshots = new Map<string, DashboardOverview>();
  const successfulAt = new Map<string, string>();
  const criticalCounts = new Map<string, number>();
  const reportedContractUnsupported = new Set<string>();
  const reportedRefreshFailures = new Map<string, DashboardRefreshFailureReason>();
  const reportedUnavailableSections = new Set<string>();
  const snapshot = shallowRef<DashboardOverview | null>(null);
  const initialLoading = ref(true);
  const refreshing = ref(false);
  const error = ref<string | null>(null);
  const lastSuccessAt = ref<string | null>(null);
  const liveMessage = ref('');
  let request: { key: string; token: number; controller: AbortController } | null = null;
  let token = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  function decorate(value: DashboardOverview, serverKey: string): DashboardOverview {
    const selected = serverStore.serverOptions.find((item) => item.id === serverKey);
    return {
      ...value,
      server: {
        ...value.server,
        id: serverKey,
        displayName: selected?.name ?? (serverKey === 'main' ? 'Этот сервер' : 'Выбранный сервер'),
        connectionState: selected?.online === false ? 'OFFLINE' : value.server.connectionState,
      },
    };
  }

  function reportContractUnsupported(serverKey: string): void {
    if (reportedContractUnsupported.has(serverKey)) return;
    reportedContractUnsupported.add(serverKey);
    emitDashboardTelemetry({ event: 'dashboard_contract_unsupported' });
  }

  function reportUnavailableSections(value: DashboardOverview, serverKey: string): void {
    const sections: Array<{
      source: DashboardTelemetrySection;
      state: DashboardSourceState;
    }> = [
      { source: 'server', state: value.server.source },
      { source: 'resources', state: value.resources.source },
      { source: 'sites', state: value.sites.source },
      { source: 'runtime', state: value.runtime.source },
      { source: 'protection', state: value.protection.source },
      { source: 'activity', state: value.activity.source },
      ...(value.security ? [{ source: 'security' as const, state: value.security.source }] : []),
    ];
    for (const section of sections) {
      const key = `${serverKey}:${section.source}`;
      if (section.state.availability === 'UNAVAILABLE') {
        if (!reportedUnavailableSections.has(key)) {
          reportedUnavailableSections.add(key);
          emitDashboardTelemetry({
            event: 'dashboard_section_unavailable',
            source: section.source,
          });
        }
      } else {
        reportedUnavailableSections.delete(key);
      }
    }
  }

  async function refresh(manual = false): Promise<void> {
    if (!import.meta.client || document.hidden) return;
    const serverKey = serverStore.currentServerId || 'main';
    if (request?.key === serverKey) return;
    if (request) request.controller.abort();

    const currentToken = ++token;
    const controller = new AbortController();
    request = { key: serverKey, token: currentToken, controller };
    refreshing.value = Boolean(snapshot.value);
    initialLoading.value = !snapshots.has(serverKey);
    error.value = null;

    try {
      let overview: DashboardOverview;
      try {
        const raw = await api.get<unknown>('/dashboard/overview', {
          headers: { 'X-Dashboard-Contract': '1' },
          signal: controller.signal,
        });
        overview = validateDashboardOverview(raw);
      } catch (overviewError) {
        if (statusOf(overviewError) !== 404) {
          if (refreshFailureReason(overviewError) === 'invalid_contract') {
            reportContractUnsupported(serverKey);
          }
          throw overviewError;
        }
        reportContractUnsupported(serverKey);
        overview = await loadLegacyOverview(api, controller.signal);
      }
      if (
        controller.signal.aborted ||
        currentToken !== token ||
        (serverStore.currentServerId || 'main') !== serverKey
      ) return;
      const decorated = decorate(overview, serverKey);
      const previousCritical = criticalCounts.get(serverKey);
      snapshots.set(serverKey, decorated);
      criticalCounts.set(serverKey, decorated.problems.critical);
      snapshot.value = decorated;
      if (decorated.capabilities.overviewV1) reportedContractUnsupported.delete(serverKey);
      reportedRefreshFailures.delete(serverKey);
      reportUnavailableSections(decorated, serverKey);
      const succeededAt = new Date().toISOString();
      successfulAt.set(serverKey, succeededAt);
      lastSuccessAt.value = succeededAt;
      if (previousCritical !== undefined && decorated.problems.critical > previousCritical) {
        liveMessage.value = `Критических проблем стало ${decorated.problems.critical}`;
      } else if (manual) {
        liveMessage.value = `Данные обновлены: ${decorated.server.displayName}`;
      }
    } catch (cause) {
      if (controller.signal.aborted || currentToken !== token) return;
      const failureReason = refreshFailureReason(cause);
      if (reportedRefreshFailures.get(serverKey) !== failureReason) {
        reportedRefreshFailures.set(serverKey, failureReason);
        emitDashboardTelemetry({
          event: 'dashboard_full_refresh_failure',
          reason: failureReason,
        });
      }
      const cached = snapshots.get(serverKey);
      if (cached) {
        snapshot.value = {
          ...cached,
          overall: {
            ...cached.overall,
            state: cached.overall.state === 'HEALTHY' ? 'UNKNOWN' : cached.overall.state,
            degradedSourceCount: cached.overall.degradedSourceCount + 1,
          },
          server: {
            ...cached.server,
            source: source('STALE', 'Не удалось обновить снимок'),
          },
        };
      } else {
        snapshot.value = null;
      }
      const status = statusOf(cause);
      error.value = status === 403
        ? 'Нет доступа к обзору выбранного сервера'
        : status === 401
          ? 'Требуется повторная авторизация'
          : 'Обзор выбранного сервера недоступен';
      if (manual) liveMessage.value = error.value;
    } finally {
      if (request?.token === currentToken) request = null;
      if (currentToken === token) {
        initialLoading.value = false;
        refreshing.value = false;
      }
    }
  }

  function selectSnapshotAndRefresh() {
    const serverKey = serverStore.currentServerId || 'main';
    token += 1;
    request?.controller.abort();
    request = null;
    snapshot.value = snapshots.get(serverKey) ?? null;
    lastSuccessAt.value = successfulAt.get(serverKey) ?? null;
    initialLoading.value = !snapshot.value;
    error.value = null;
    void refresh();
  }

  function onVisibilityChange() {
    if (!document.hidden) void refresh();
  }

  function applySocketMetrics(envelope: { readonly serverId: string; readonly data: unknown } | null) {
    if (!envelope || error.value || envelope.serverId !== (serverStore.currentServerId || 'main')) return;
    const current = snapshots.get(envelope.serverId);
    if (!current || current.role !== 'ADMIN' || !envelope.data || typeof envelope.data !== 'object') return;
    const raw = envelope.data as Record<string, unknown>;
    const collectedAt = text(raw.collectedAt, 40);
    if (!collectedAt || !Number.isFinite(Date.parse(collectedAt))) return;
    const previousAt = Date.parse(current.resources.collectedAt || current.generatedAt);
    if (Date.parse(collectedAt) <= previousAt) return;

    const diskValues = Array.isArray(raw.disks)
      ? raw.disks.map(normalizeLegacyDisk).filter((item): item is NonNullable<typeof item> => Boolean(item))
      : [];
    const network = raw.network && typeof raw.network === 'object'
      ? raw.network as Record<string, unknown>
      : null;
    const rx = finite(network?.rxBytesPerSecond ?? network?.rxBytesPerSec);
    const tx = finite(network?.txBytesPerSecond ?? network?.txBytesPerSec);
    const cpuUsagePercent = finite(raw.cpuUsagePercent, 0, 100);
    const cpuCores = finite(raw.cpuCores, 1, 4096);
    const memoryUsedBytes = finite(raw.memoryUsedBytes);
    const memoryTotalBytes = finite(raw.memoryTotalBytes, 1);
    const memoryUsagePercent = finite(raw.memoryUsagePercent, 0, 100);
    if (
      cpuUsagePercent === null || cpuCores === null ||
      memoryUsedBytes === null || memoryTotalBytes === null ||
      memoryUsedBytes > memoryTotalBytes || memoryUsagePercent === null ||
      diskValues.length === 0
    ) return;
    const rawLoad = Array.isArray(raw.loadAverage) && raw.loadAverage.length === 3
      ? raw.loadAverage.map((item) => finite(item))
      : null;
    const loadAverage: [number, number, number] | null = rawLoad?.every((item) => item !== null)
      ? [rawLoad[0] as number, rawLoad[1] as number, rawLoad[2] as number]
      : null;
    const updated: DashboardOverview = {
      ...current,
      server: {
        ...current.server,
        uptimeSeconds: finite(raw.uptimeSeconds),
        agentLastSeenAt: collectedAt,
      },
      resources: {
        ...current.resources,
        source: { availability: 'OK', observedAt: collectedAt, staleAfterSeconds: 45, message: null },
        collectedAt,
        cpuUsagePercent,
        cpuCores,
        memoryUsedBytes,
        memoryTotalBytes,
        memoryUsagePercent,
        loadAverage,
        disks: diskValues,
        network: rx !== null && tx !== null ? { rxBytesPerSecond: rx, txBytesPerSecond: tx } : null,
      },
    };
    snapshots.set(envelope.serverId, updated);
    snapshot.value = updated;
  }

  onMounted(() => {
    selectSnapshotAndRefresh();
    timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
  });
  const stopServerWatch = watch(() => serverStore.currentServerId, selectSnapshotAndRefresh);
  const stopMetricsWatch = watch(socketMetrics, applySocketMetrics);
  onUnmounted(() => {
    stopServerWatch();
    stopMetricsWatch();
    request?.controller.abort();
    if (timer) clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  });

  return {
    snapshot: computed(() => snapshot.value),
    initialLoading: readonly(initialLoading),
    refreshing: readonly(refreshing),
    error: readonly(error),
    lastSuccessAt: readonly(lastSuccessAt),
    liveMessage: readonly(liveMessage),
    legacy: computed(() => snapshot.value?.capabilities.overviewV1 === false),
    refresh: () => refresh(true),
  };
}
