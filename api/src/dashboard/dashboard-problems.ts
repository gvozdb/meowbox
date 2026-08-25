import {
  DASHBOARD_LIMITS,
  redactSensitiveText,
  safeErrorMessage,
  type DashboardActionTarget,
  type DashboardOverallState,
  type DashboardProblem,
  type DashboardProblemCategory,
  type DashboardProblemCode,
  type DashboardProblemCollection,
  type DashboardProblemSeverity,
  type DashboardResourceSection,
  type DashboardRole,
  type DashboardServiceItem,
  type DashboardSourceState,
} from '@meowbox/shared';
import type { MetricsInput } from '../monitoring/monitoring.service';
import type {
  DashboardAdminStateData,
  DashboardOperationsData,
  DashboardProtectionData,
  DashboardSitesData,
} from './dashboard-query.service';

const GIB = 1024 ** 3;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const SEVERITY_RANK: Record<DashboardProblemSeverity, number> = {
  CRITICAL: 0,
  WARNING: 1,
  INFO: 2,
};

const OPERATION_TIMEOUT_MS: Readonly<Record<string, number>> = {
  DOMAIN_DEPLOY: HOUR_MS,
  DOMAIN_DEPLOY_ROLLBACK: HOUR_MS,
  BACKUP_RESTORE: 4 * HOUR_MS,
};

const PM2_GRACE_OPERATION_TYPES = new Set([
  'SITE_CREATE',
  'DOMAIN_PROVISION',
  'DOMAIN_DEPLOY',
  'DOMAIN_DEPLOY_ROLLBACK',
  'DOMAIN_APPLICATION_RETRY',
  'DOMAIN_APPLICATION_DUPLICATE',
  'DOMAIN_APPLICATION_DELETE',
]);

export interface DashboardNginxDiagnostic {
  source: DashboardSourceState;
  valid: boolean | null;
  errorMessage: string | null;
  drift: Array<{
    id: string;
    siteId: string | null;
    label: string;
    missing: boolean;
    observedAt: string;
  }>;
}

export interface DashboardDnsDriftDiagnostic {
  source: DashboardSourceState;
  items: Array<{
    recordId: string;
    providerId: string;
    label: string;
    confirmedChecks: number;
    observedAt: string;
  }>;
}

export interface DashboardDiagnosticsInput {
  source: DashboardSourceState;
  agentConnected: boolean;
  agentDisconnectedAt: string | null;
  services: DashboardServiceItem[];
  nginx: DashboardNginxDiagnostic;
  dns: DashboardDnsDriftDiagnostic;
}

export interface DashboardProblemInput {
  generatedAt: string;
  role: DashboardRole;
  metrics: MetricsInput | null;
  resources: DashboardResourceSection;
  sites: DashboardSitesData;
  operations: DashboardOperationsData;
  protection: DashboardProtectionData;
  admin: DashboardAdminStateData;
  diagnostics: DashboardDiagnosticsInput;
  sourceStates: DashboardSourceState[];
  unsupportedCapabilityCount: number;
}

interface ProblemParams {
  code: DashboardProblemCode;
  severity: DashboardProblemSeverity;
  category: DashboardProblemCategory;
  title: string;
  summary: string;
  entity: DashboardProblem['entity'];
  occurredAt?: string | null;
  observedAt: string;
  action?: {
    target: DashboardActionTarget;
    entityId?: string | null;
    label: string;
  } | null;
}

export function sanitizeDashboardText(
  value: unknown,
  fallback: string,
  maxLength: number,
): string {
  const raw =
    value instanceof Error
      ? safeErrorMessage(value, fallback, maxLength)
      : typeof value === 'string'
        ? value
        : fallback;
  const normalized = redactSensitiveText(raw, maxLength)
    .replace(/\s+/g, ' ')
    .trim();
  return (normalized || fallback).slice(0, maxLength);
}

export function createDashboardProblem(params: ProblemParams): DashboardProblem {
  const entityId = params.entity.id ?? 'server';
  return {
    id: `${params.code}:${params.entity.kind}:${entityId}`,
    code: params.code,
    severity: params.severity,
    category: params.category,
    title: sanitizeDashboardText(params.title, 'Требуется внимание', 100),
    summary: sanitizeDashboardText(
      params.summary,
      'Подробности временно недоступны',
      240,
    ),
    entity: {
      ...params.entity,
      label: sanitizeDashboardText(params.entity.label, 'Объект', 120),
    },
    occurredAt: params.occurredAt ?? null,
    observedAt: params.observedAt,
    action: params.action
      ? {
          kind: 'NAVIGATE',
          target: params.action.target,
          entityId: params.action.entityId ?? null,
          label: sanitizeDashboardText(params.action.label, 'Открыть', 80),
        }
      : null,
  };
}

export function sortDashboardProblems(
  problems: DashboardProblem[],
): DashboardProblem[] {
  return problems.sort((left, right) => {
    const severity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
    if (severity !== 0) return severity;
    if (left.occurredAt && right.occurredAt) {
      const time = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
      if (time !== 0) return time;
    } else if (left.occurredAt) {
      return -1;
    } else if (right.occurredAt) {
      return 1;
    }
    const code = left.code.localeCompare(right.code);
    return code || left.id.localeCompare(right.id);
  });
}

function detectorAgent(input: DashboardProblemInput): DashboardProblem[] {
  if (input.role !== 'ADMIN' || input.diagnostics.agentConnected) return [];
  const disconnectedAt = input.diagnostics.agentDisconnectedAt;
  if (!disconnectedAt) return [];
  const ageSeconds = Math.max(
    0,
    (Date.parse(input.generatedAt) - Date.parse(disconnectedAt)) / 1000,
  );
  if (ageSeconds < 30) return [];
  return [
    createDashboardProblem({
      code: 'AGENT_OFFLINE',
      severity: ageSeconds >= 120 ? 'CRITICAL' : 'WARNING',
      category: 'AGENT',
      title: 'Agent не подключён',
      summary: `Нет соединения с Agent ${Math.floor(ageSeconds)} сек. Серверные операции недоступны.`,
      entity: { kind: 'SERVER', id: null, label: 'Meowbox Agent' },
      occurredAt: disconnectedAt,
      observedAt: input.generatedAt,
      action: { target: 'MONITORING', label: 'Открыть мониторинг' },
    }),
  ];
}

function detectorMetrics(input: DashboardProblemInput): DashboardProblem[] {
  if (input.role !== 'ADMIN') return [];
  const problems: DashboardProblem[] = [];
  if (input.metrics && input.diagnostics.agentConnected) {
    const ageSeconds = Math.max(
      0,
      (Date.parse(input.generatedAt) - Date.parse(input.metrics.collectedAt)) / 1000,
    );
    if (ageSeconds > 45) {
      problems.push(
        createDashboardProblem({
          code: 'METRICS_STALE',
          severity: ageSeconds > 120 ? 'CRITICAL' : 'WARNING',
          category: 'SYSTEM',
          title: 'Метрики устарели',
          summary: `Последний подтверждённый снимок метрик получен ${Math.floor(ageSeconds)} сек. назад.`,
          entity: { kind: 'SERVER', id: null, label: 'Метрики сервера' },
          occurredAt: input.metrics.collectedAt,
          observedAt: input.generatedAt,
          action: { target: 'MONITORING', label: 'Открыть мониторинг' },
        }),
      );
    }
  }

  for (const disk of input.resources.disks) {
    const critical = disk.usagePercent >= 95 || disk.availableBytes <= 2 * GIB;
    const warning = disk.usagePercent >= 80 || disk.availableBytes <= 5 * GIB;
    if (!critical && !warning) continue;
    problems.push(
      createDashboardProblem({
        code: critical ? 'DISK_USAGE_CRITICAL' : 'DISK_USAGE_WARNING',
        severity: critical ? 'CRITICAL' : 'WARNING',
        category: 'SYSTEM',
        title: critical ? 'Диск почти заполнен' : 'На диске мало места',
        summary: `${disk.mountPoint}: занято ${disk.usagePercent.toFixed(1)}%, свободно ${Math.max(0, disk.availableBytes / GIB).toFixed(1)} GiB.`,
        entity: { kind: 'SERVER', id: disk.mountPoint, label: disk.mountPoint },
        occurredAt: input.resources.collectedAt,
        observedAt: input.generatedAt,
        action: { target: 'MONITORING', label: 'Открыть мониторинг' },
      }),
    );
  }
  return problems;
}

function detectorSites(input: DashboardProblemInput): DashboardProblem[] {
  const problems: DashboardProblem[] = [];
  const failedDomains = new Set(input.sites.domainProblems.map((domain) => domain.id));
  for (const site of input.sites.siteProblems) {
    problems.push(
      createDashboardProblem({
        code: 'SITE_ERROR',
        severity: 'CRITICAL',
        category: 'SITE',
        title: `Сайт ${site.label} в состоянии ошибки`,
        summary: site.errorMessage || 'Сайт сообщил состояние ERROR.',
        entity: { kind: 'SITE', id: site.id, label: site.label },
        occurredAt: site.updatedAt,
        observedAt: input.generatedAt,
        action: { target: 'SITE', entityId: site.id, label: 'Открыть сайт' },
      }),
    );
  }
  for (const domain of input.sites.domainProblems) {
    problems.push(
      createDashboardProblem({
        code: 'DOMAIN_APPLICATION_ERROR',
        severity: 'CRITICAL',
        category: 'SITE',
        title: `Ошибка приложения ${domain.label}`,
        summary: domain.errorMessage || 'Приложение домена сообщило состояние ERROR.',
        entity: { kind: 'DOMAIN', id: domain.id, label: domain.label },
        occurredAt: domain.updatedAt,
        observedAt: input.generatedAt,
        action: {
          target: 'SITE',
          entityId: domain.siteId,
          label: 'Открыть сайт',
        },
      }),
    );
  }
  for (const health of input.sites.healthProblems) {
    if (failedDomains.has(health.domainId) || health.sampleCount === 0) continue;
    problems.push(
      createDashboardProblem({
        code: 'SITE_UNAVAILABLE',
        severity: 'CRITICAL',
        category: 'SITE',
        title: `${health.domain} недоступен`,
        summary: `Последние ${health.sampleCount} проверок не подтвердили доступность сайта.`,
        entity: { kind: 'DOMAIN', id: health.domainId, label: health.domain },
        occurredAt: health.observedAt,
        observedAt: input.generatedAt,
        action: { target: 'SITE', entityId: health.siteId, label: 'Открыть сайт' },
      }),
    );
  }
  return problems;
}

function detectorBackups(input: DashboardProblemInput): DashboardProblem[] {
  const problems: DashboardProblem[] = [];
  for (const backup of input.protection.backupFailures) {
    problems.push(
      createDashboardProblem({
        code: 'BACKUP_LATEST_FAILED',
        severity: 'CRITICAL',
        category: 'BACKUP',
        title: `Последний бэкап ${backup.siteLabel} завершился ошибкой`,
        summary: backup.errorMessage || 'Последняя попытка резервного копирования не завершилась успешно.',
        entity: { kind: 'BACKUP', id: backup.id, label: backup.siteLabel },
        occurredAt: backup.occurredAt,
        observedAt: input.generatedAt,
        action: { target: 'BACKUPS', entityId: backup.siteId, label: 'Открыть бэкапы' },
      }),
    );
  }
  if (input.protection.coverageGapCount > 0) {
    problems.push(
      createDashboardProblem({
        code: 'BACKUP_COVERAGE_GAP',
        severity: 'WARNING',
        category: 'BACKUP',
        title: 'Не все сайты защищены бэкапами',
        summary: `Без включённого расписания: ${input.protection.coverageGapCount}.`,
        entity: { kind: 'SERVER', id: 'backup-coverage', label: 'Покрытие бэкапами' },
        observedAt: input.generatedAt,
        action: { target: 'BACKUPS', label: 'Настроить бэкапы' },
      }),
    );
  }
  for (const overdue of input.protection.overdueBackups) {
    problems.push(
      createDashboardProblem({
        code: 'BACKUP_OVERDUE',
        severity: overdue.missedExecutions >= 2 ? 'CRITICAL' : 'WARNING',
        category: 'BACKUP',
        title: `Бэкап ${overdue.label} просрочен`,
        summary: `Пропущено ожидаемых запусков: ${overdue.missedExecutions}.`,
        entity: {
          kind: 'BACKUP',
          id: overdue.id,
          label: overdue.label,
        },
        occurredAt: overdue.expectedAt,
        observedAt: input.generatedAt,
        action: {
          target: 'BACKUPS',
          entityId: overdue.siteId,
          label: 'Открыть расписание',
        },
      }),
    );
  }
  for (const invalid of input.protection.invalidSchedules) {
    problems.push(
      createDashboardProblem({
        code: 'BACKUP_SCHEDULE_INVALID',
        severity: 'WARNING',
        category: 'BACKUP',
        title: `Некорректное расписание бэкапа ${invalid.label}`,
        summary: 'Cron-выражение не удалось разобрать в часовом поясе сервера.',
        entity: { kind: 'BACKUP', id: invalid.id, label: invalid.label },
        observedAt: input.generatedAt,
        action: { target: 'BACKUPS', entityId: invalid.siteId, label: 'Исправить расписание' },
      }),
    );
  }
  const check = input.protection.repositoryFailure;
  if (check) {
    problems.push(
      createDashboardProblem({
        code: 'BACKUP_REPOSITORY_CHECK_FAILED',
        severity: 'WARNING',
        category: 'BACKUP',
        title: `Проверка репозитория ${check.siteLabel} не пройдена`,
        summary: check.errorMessage || 'Restic check завершился ошибкой.',
        entity: { kind: 'BACKUP', id: check.id, label: check.siteLabel },
        occurredAt: check.observedAt,
        observedAt: input.generatedAt,
        action: { target: 'BACKUPS', entityId: check.siteId, label: 'Открыть проверки' },
      }),
    );
  }
  return problems;
}

function detectorSsl(input: DashboardProblemInput): DashboardProblem[] {
  const problems: DashboardProblem[] = [];
  const now = Date.parse(input.generatedAt);
  for (const certificate of input.protection.sslProblems) {
    const expiresAt = certificate.expiresAt ? Date.parse(certificate.expiresAt) : null;
    const isExpired =
      certificate.status === 'EXPIRED' ||
      (expiresAt !== null && Number.isFinite(expiresAt) && expiresAt < now);
    let code: DashboardProblemCode | null = null;
    let severity: DashboardProblemSeverity = 'WARNING';
    let title = '';
    if (isExpired) {
      code = 'SSL_EXPIRED';
      severity = 'CRITICAL';
      title = `SSL-сертификат ${certificate.domain} истёк`;
    } else if (
      certificate.daysRemaining !== null &&
      certificate.daysRemaining >= 0 &&
      certificate.daysRemaining <= 3
    ) {
      code = 'SSL_EXPIRING_CRITICAL';
      severity = 'CRITICAL';
      title = `SSL ${certificate.domain} истекает критически скоро`;
    } else if (
      certificate.daysRemaining !== null &&
      certificate.daysRemaining >= 4 &&
      certificate.daysRemaining <= 14
    ) {
      code = 'SSL_EXPIRING_WARNING';
      title = `SSL ${certificate.domain} скоро истекает`;
    } else if (!['ACTIVE', 'EXPIRING_SOON', 'PENDING', 'NONE'].includes(certificate.status)) {
      code = 'SSL_ERROR';
      severity = 'CRITICAL';
      title = `Ошибка SSL ${certificate.domain}`;
    } else if (certificate.status === 'PENDING' || certificate.expiresAt === null) {
      code = 'SSL_EXPECTED_BUT_UNKNOWN';
      title = `Состояние SSL ${certificate.domain} неизвестно`;
    }
    if (!code) continue;
    problems.push(
      createDashboardProblem({
        code,
        severity,
        category: 'SSL',
        title,
        summary:
          certificate.daysRemaining === null
            ? `Статус сертификата: ${certificate.status}.`
            : `До истечения: ${certificate.daysRemaining} дн.`,
        entity: {
          kind: 'CERTIFICATE',
          id: certificate.id,
          label: certificate.domain,
        },
        occurredAt: certificate.expiresAt ?? certificate.updatedAt,
        observedAt: input.generatedAt,
        action: { target: 'SSL', entityId: certificate.siteId, label: 'Открыть SSL' },
      }),
    );
  }
  return problems;
}

function detectorOperations(input: DashboardProblemInput): DashboardProblem[] {
  const problems: DashboardProblem[] = [];
  for (const operation of input.operations.failures) {
    const entityStillBroken =
      operation.siteId !== null &&
      input.sites.siteProblems.some((site) => site.id === operation.siteId);
    problems.push(
      createDashboardProblem({
        code: 'OPERATION_RECENTLY_FAILED',
        severity: entityStillBroken ? 'CRITICAL' : 'WARNING',
        category: 'OPERATION',
        title: `Операция ${operation.type} завершилась ошибкой`,
        summary: operation.errorMessage || 'Операция не завершилась успешно.',
        entity: {
          kind: 'OPERATION',
          id: operation.id,
          label: operation.entityLabel,
        },
        occurredAt: operation.completedAt ?? operation.updatedAt,
        observedAt: input.generatedAt,
        action: operation.siteId
          ? { target: 'SITE', entityId: operation.siteId, label: 'Открыть сайт' }
          : { target: 'ACTIVITY', label: 'Открыть операции' },
      }),
    );
  }
  for (const operation of input.operations.activeCandidates) {
    const timeoutMs = OPERATION_TIMEOUT_MS[operation.type];
    const startedAt = operation.startedAt ? Date.parse(operation.startedAt) : NaN;
    if (!timeoutMs || !Number.isFinite(startedAt)) continue;
    if (Date.parse(input.generatedAt) - startedAt <= timeoutMs) continue;
    problems.push(
      createDashboardProblem({
        code: 'OPERATION_STALE',
        severity: 'WARNING',
        category: 'OPERATION',
        title: `Операция ${operation.type} выполняется слишком долго`,
        summary: operation.currentStep
          ? `Последний подтверждённый шаг: ${operation.currentStep}.`
          : 'Прогресс операции давно не обновлялся.',
        entity: {
          kind: 'OPERATION',
          id: operation.id,
          label: operation.entityLabel,
        },
        occurredAt: operation.startedAt,
        observedAt: input.generatedAt,
        action: { target: 'ACTIVITY', label: 'Открыть операции' },
      }),
    );
  }
  return problems;
}

function detectorDiagnostics(input: DashboardProblemInput): DashboardProblem[] {
  if (input.role !== 'ADMIN') return [];
  const problems: DashboardProblem[] = [];
  const nginx = input.diagnostics.nginx;
  if (nginx.valid === false) {
    problems.push(
      createDashboardProblem({
        code: 'NGINX_CONFIG_INVALID',
        severity: 'CRITICAL',
        category: 'SYSTEM',
        title: 'Конфигурация Nginx невалидна',
        summary: nginx.errorMessage || 'Последняя фоновая проверка nginx -t завершилась ошибкой.',
        entity: { kind: 'SERVICE', id: 'nginx', label: 'Nginx' },
        occurredAt: nginx.source.observedAt,
        observedAt: input.generatedAt,
        action: { target: 'SERVICES', label: 'Открыть сервисы' },
      }),
    );
  }
  for (const drift of nginx.drift) {
    problems.push(
      createDashboardProblem({
        code: 'NGINX_MANAGED_CONFIG_DRIFT',
        severity: nginx.valid === false ? 'CRITICAL' : 'WARNING',
        category: 'SYSTEM',
        title: drift.missing ? 'Управляемый конфиг Nginx отсутствует' : 'Управляемый конфиг Nginx изменён',
        summary: `${drift.label}: фактический SHA-256 не совпадает с каноническим.`,
        entity: {
          kind: drift.siteId ? 'SITE' : 'SERVICE',
          id: drift.id,
          label: drift.label,
        },
        occurredAt: drift.observedAt,
        observedAt: input.generatedAt,
        action: drift.siteId
          ? { target: 'SITE', entityId: drift.siteId, label: 'Открыть сайт' }
          : { target: 'SERVICES', label: 'Открыть сервисы' },
      }),
    );
  }

  const activeSiteIds = new Set(
    input.operations.activeCandidates
      .filter((operation) => PM2_GRACE_OPERATION_TYPES.has(operation.type))
      .map((operation) => operation.siteId)
      .filter((id): id is string => id !== null),
  );
  for (const service of input.diagnostics.services) {
    const isPm2 = service.id.startsWith('pm2:');
    if (
      service.expectedState !== 'RUNNING' ||
      service.actualState === 'RUNNING' ||
      service.actualState === 'UNKNOWN' ||
      (isPm2 && service.siteId && activeSiteIds.has(service.siteId))
    ) {
      continue;
    }
    const missing = service.actualState === 'MISSING';
    const code: DashboardProblemCode = isPm2
      ? missing
        ? 'PM2_PROCESS_MISSING'
        : 'PM2_PROCESS_UNHEALTHY'
      : 'CORE_SERVICE_INACTIVE';
    const critical =
      service.id === 'service:nginx' ||
      service.id === 'pm2:meowbox-api' ||
      service.id === 'pm2:meowbox-agent';
    problems.push(
      createDashboardProblem({
        code,
        severity: critical ? 'CRITICAL' : 'WARNING',
        category: 'SERVICE',
        title: `${service.name} не в ожидаемом состоянии`,
        summary: `Ожидалось RUNNING, подтверждено ${service.actualState}.`,
        entity: {
          kind: 'SERVICE',
          id: service.id,
          label: service.name,
        },
        occurredAt: service.checkedAt,
        observedAt: input.generatedAt,
        action: service.siteId
          ? { target: 'SITE', entityId: service.siteId, label: 'Открыть сайт' }
          : { target: 'SERVICES', label: 'Открыть сервисы' },
      }),
    );
  }

  if (input.diagnostics.dns.source.availability !== 'OK') return problems;
  for (const drift of input.diagnostics.dns.items) {
    if (drift.confirmedChecks < 2) continue;
    problems.push(
      createDashboardProblem({
        code: 'DNS_RECORD_DRIFT',
        severity: 'WARNING',
        category: 'DNS',
        title: `DNS-запись ${drift.label} отличается`,
        summary: 'Расхождение подтверждено двумя последовательными фоновыми проверками.',
        entity: {
          kind: 'DNS_PROVIDER',
          id: drift.recordId,
          label: drift.label,
        },
        occurredAt: drift.observedAt,
        observedAt: input.generatedAt,
        action: { target: 'DNS', entityId: drift.providerId, label: 'Открыть DNS' },
      }),
    );
  }
  return problems;
}

function detectorAdminState(input: DashboardProblemInput): DashboardProblem[] {
  if (input.role !== 'ADMIN') return [];
  const problems: DashboardProblem[] = input.admin.dnsProviders.map((provider) =>
    createDashboardProblem({
      code: 'DNS_PROVIDER_ERROR',
      severity: 'WARNING',
      category: 'DNS',
      title: `Ошибка DNS-провайдера ${provider.label}`,
      summary: provider.errorMessage || `Статус провайдера: ${provider.status}.`,
      entity: {
        kind: 'DNS_PROVIDER',
        id: provider.id,
        label: provider.label,
      },
      occurredAt: provider.observedAt,
      observedAt: input.generatedAt,
      action: { target: 'DNS', entityId: provider.id, label: 'Открыть DNS' },
    }),
  );
  if (input.admin.update?.status === 'failed') {
    problems.push(
      createDashboardProblem({
        code: 'UPDATE_FAILED',
        severity: 'WARNING',
        category: 'UPDATE',
        title: 'Последнее обновление панели завершилось ошибкой',
        summary: input.admin.update.errorMessage || 'Обновление не было завершено.',
        entity: { kind: 'SERVER', id: 'panel-update', label: 'Обновление панели' },
        occurredAt: input.admin.update.observedAt,
        observedAt: input.generatedAt,
        action: { target: 'UPDATES', label: 'Открыть обновления' },
      }),
    );
  }
  return problems;
}

export function detectDashboardProblems(
  input: DashboardProblemInput,
  onDetectorError?: (detector: string, error: unknown) => void,
): DashboardProblemCollection {
  const detectors: Array<[string, (value: DashboardProblemInput) => DashboardProblem[]]> = [
    ['agent', detectorAgent],
    ['metrics', detectorMetrics],
    ['sites', detectorSites],
    ['backups', detectorBackups],
    ['ssl', detectorSsl],
    ['operations', detectorOperations],
    ['diagnostics', detectorDiagnostics],
    ['admin-state', detectorAdminState],
  ];
  const deduplicated = new Map<string, DashboardProblem>();
  for (const [detectorName, detector] of detectors) {
    let detected: DashboardProblem[];
    try {
      detected = detector(input);
    } catch (error) {
      onDetectorError?.(detectorName, error);
      detected = [
        createDashboardProblem({
          code: 'DATA_SOURCE_UNAVAILABLE',
          severity: 'WARNING',
          category: 'SYSTEM',
          title: 'Одна из проверок недоступна',
          summary: `Проверка ${detectorName} не завершилась. Остальные результаты сохранены.`,
          entity: {
            kind: 'SERVER',
            id: `detector-${detectorName}`,
            label: `Проверка ${detectorName}`,
          },
          observedAt: input.generatedAt,
          action: { target: 'MONITORING', label: 'Открыть мониторинг' },
        }),
      ];
    }
    for (const problem of detected) {
      const previous = deduplicated.get(problem.id);
      if (
        !previous ||
        SEVERITY_RANK[problem.severity] < SEVERITY_RANK[previous.severity]
      ) {
        deduplicated.set(problem.id, problem);
      }
    }
  }
  const all = sortDashboardProblems([...deduplicated.values()]);
  const items = all.slice(0, DASHBOARD_LIMITS.problems);
  return {
    total: all.length,
    critical: all.filter((problem) => problem.severity === 'CRITICAL').length,
    warning: all.filter((problem) => problem.severity === 'WARNING').length,
    info: all.filter((problem) => problem.severity === 'INFO').length,
    truncated: all.length > items.length,
    items,
  };
}

export function deriveDashboardOverall(
  problems: DashboardProblemCollection,
  requiredSources: DashboardSourceState[],
  unsupportedCapabilityCount = 0,
): DashboardOverallState {
  const degradedRequired = requiredSources.filter(
    (state) => state.availability !== 'OK',
  ).length;
  const degradedSourceCount = degradedRequired + unsupportedCapabilityCount;
  return {
    state:
      problems.critical > 0
        ? 'CRITICAL'
        : problems.warning > 0
          ? 'ATTENTION'
          : degradedRequired > 0
            ? 'UNKNOWN'
            : 'HEALTHY',
    criticalCount: problems.critical,
    warningCount: problems.warning,
    infoCount: problems.info,
    degradedSourceCount,
  };
}
