import { Injectable } from '@nestjs/common';
import { Prisma, type Site } from '@prisma/client';
import {
  DASHBOARD_LIMITS,
  type DashboardActivitySection,
  type DashboardOperationItem,
  type DashboardProtectionSection,
  type DashboardRole,
  type DashboardSecuritySection,
  type DashboardSitesSection,
  type DashboardSourceState,
} from '@meowbox/shared';
import { PrismaService } from '../common/prisma.service';
import { dashboardCronState } from './dashboard-backup-schedule';

const DAY_MS = 24 * 60 * 60 * 1000;
const HEALTH_LOOKBACK_MS = 60 * 60 * 1000;
const PROBLEM_CANDIDATE_LIMIT = DASHBOARD_LIMITS.problems;
const ACTIVE_OPERATION_STATUSES = ['PENDING', 'RUNNING'] as const;

export interface DashboardRequestContext {
  userId: string;
  role: DashboardRole;
}

export interface SiteProblemCandidate {
  id: string;
  label: string;
  status: string;
  errorMessage: string | null;
  updatedAt: string;
}

export interface DomainProblemCandidate {
  id: string;
  siteId: string;
  label: string;
  siteLabel: string;
  appStatus: string;
  errorMessage: string | null;
  updatedAt: string;
}

export interface HealthProblemCandidate {
  siteId: string;
  domainId: string;
  siteLabel: string;
  domain: string;
  sampleCount: number;
  reachableCount: number;
  observedAt: string;
}

export interface DashboardSitesData {
  section: DashboardSitesSection;
  siteProblems: SiteProblemCandidate[];
  domainProblems: DomainProblemCandidate[];
  healthProblems: HealthProblemCandidate[];
}

export interface OperationProblemCandidate {
  id: string;
  type: string;
  status: string;
  siteId: string | null;
  entityLabel: string;
  currentStep: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface DashboardOperationsData {
  active: DashboardOperationItem[];
  failures: OperationProblemCandidate[];
  activeCandidates: OperationProblemCandidate[];
}

export interface BackupFailureCandidate {
  id: string;
  siteId: string;
  siteLabel: string;
  errorMessage: string | null;
  occurredAt: string;
}

export interface BackupOverdueCandidate {
  id: string;
  siteId: string | null;
  label: string;
  missedExecutions: number;
  expectedAt: string;
}

export interface BackupInvalidScheduleCandidate {
  id: string;
  siteId: string | null;
  label: string;
}

export interface SslProblemCandidate {
  id: string;
  siteId: string;
  domain: string;
  status: string;
  expiresAt: string | null;
  daysRemaining: number | null;
  updatedAt: string;
}

export interface DashboardProtectionData {
  section: DashboardProtectionSection;
  backupFailures: BackupFailureCandidate[];
  overdueBackups: BackupOverdueCandidate[];
  invalidSchedules: BackupInvalidScheduleCandidate[];
  coverageGapCount: number;
  repositoryFailure: {
    id: string;
    siteId: string | null;
    siteLabel: string;
    errorMessage: string | null;
    observedAt: string;
  } | null;
  sslProblems: SslProblemCandidate[];
}

export interface DnsProblemCandidate {
  id: string;
  label: string;
  status: string;
  errorMessage: string | null;
  observedAt: string;
}

export interface UpdateProblemCandidate {
  status: string;
  fromVersion: string | null;
  toVersion: string | null;
  errorMessage: string | null;
  observedAt: string;
}

export interface DashboardAdminStateData {
  dnsProviders: DnsProblemCandidate[];
  update: UpdateProblemCandidate | null;
}

function source(
  generatedAt: string,
  staleAfterSeconds: number | null = 60,
): DashboardSourceState {
  return {
    availability: 'OK',
    observedAt: generatedAt,
    staleAfterSeconds,
    message: null,
  };
}

function unsupportedSource(message: string): DashboardSourceState {
  return {
    availability: 'UNSUPPORTED',
    observedAt: null,
    staleAfterSeconds: null,
    message,
  };
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function siteLabel(site: Pick<Site, 'name' | 'displayName'>): string {
  return site.displayName?.trim() || site.name;
}

@Injectable()
export class DashboardQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async loadSites(
    context: DashboardRequestContext,
    generatedAt: string,
  ): Promise<DashboardSitesData> {
    const siteWhere: Prisma.SiteWhereInput =
      context.role === 'MANAGER' ? { userId: context.userId } : {};
    const domainWhere: Prisma.SiteDomainWhereInput =
      context.role === 'MANAGER' ? { site: { userId: context.userId } } : {};
    const siteSelect = {
      id: true,
      name: true,
      displayName: true,
      status: true,
      updatedAt: true,
    } satisfies Prisma.SiteSelect;

    const [
      statusGroups,
      managedDomains,
      priorityRows,
      recentRows,
      siteErrors,
      domainErrors,
      activeOperations,
    ] = await Promise.all([
      this.prisma.site.groupBy({
        by: ['status'],
        where: siteWhere,
        _count: { _all: true },
      }),
      this.prisma.siteDomain.count({ where: domainWhere }),
      this.prisma.site.findMany({
        where: {
          ...siteWhere,
          status: { in: ['ERROR', 'DEPLOYING'] },
        },
        orderBy: { updatedAt: 'desc' },
        take: DASHBOARD_LIMITS.sites,
        select: siteSelect,
      }),
      this.prisma.site.findMany({
        where: siteWhere,
        orderBy: { updatedAt: 'desc' },
        take: DASHBOARD_LIMITS.sites,
        select: siteSelect,
      }),
      this.prisma.site.findMany({
        where: { ...siteWhere, status: 'ERROR' },
        orderBy: { updatedAt: 'desc' },
        take: PROBLEM_CANDIDATE_LIMIT,
        select: {
          id: true,
          name: true,
          displayName: true,
          status: true,
          errorMessage: true,
          updatedAt: true,
        },
      }),
      this.prisma.siteDomain.findMany({
        where: { ...domainWhere, appStatus: 'ERROR' },
        orderBy: { updatedAt: 'desc' },
        take: PROBLEM_CANDIDATE_LIMIT,
        select: {
          id: true,
          siteId: true,
          domain: true,
          appStatus: true,
          appErrorMessage: true,
          updatedAt: true,
          site: { select: { name: true, displayName: true } },
        },
      }),
      this.prisma.operation.findMany({
        where: {
          status: { in: [...ACTIVE_OPERATION_STATUSES] },
          siteId: { not: null },
          ...(context.role === 'MANAGER'
            ? { site: { userId: context.userId } }
            : {}),
        },
        orderBy: { updatedAt: 'desc' },
        take: PROBLEM_CANDIDATE_LIMIT,
        select: { siteId: true },
      }),
    ]);

    const priorityRank: Record<string, number> = {
      ERROR: 0,
      DEPLOYING: 1,
      RUNNING: 2,
      STOPPED: 3,
    };
    const rowMap = new Map(priorityRows.concat(recentRows).map((row) => [row.id, row]));
    const selectedRows = [...rowMap.values()]
      .sort((left, right) => {
        const status =
          (priorityRank[left.status] ?? 9) - (priorityRank[right.status] ?? 9);
        return status || right.updatedAt.getTime() - left.updatedAt.getTime();
      })
      .slice(0, DASHBOARD_LIMITS.sites);
    const selectedIds = selectedRows.map((row) => row.id);
    const problemDomainIds = domainErrors.map((domain) => domain.id);

    const [
      primaryDomains,
      affectedGroups,
      selectedHealthTotal,
      selectedHealthReachable,
      problemHealthTotal,
      problemHealthReachable,
    ] = await Promise.all([
      selectedIds.length
        ? this.prisma.siteDomain.findMany({
            where: { siteId: { in: selectedIds }, isPrimary: true },
            orderBy: [{ siteId: 'asc' }, { position: 'asc' }],
            take: DASHBOARD_LIMITS.sites * 2,
            select: { siteId: true, domain: true },
          })
        : Promise.resolve([]),
      selectedIds.length
        ? this.prisma.siteDomain.groupBy({
            by: ['siteId'],
            where: { siteId: { in: selectedIds }, appStatus: 'ERROR' },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      selectedIds.length
        ? this.prisma.healthCheckPing.groupBy({
            by: ['siteId'],
            where: {
              siteId: { in: selectedIds },
              createdAt: {
                gte: new Date(Date.parse(generatedAt) - DAY_MS),
              },
            },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      selectedIds.length
        ? this.prisma.healthCheckPing.groupBy({
            by: ['siteId'],
            where: {
              siteId: { in: selectedIds },
              reachable: true,
              createdAt: {
                gte: new Date(Date.parse(generatedAt) - DAY_MS),
              },
            },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      problemDomainIds.length
        ? this.prisma.healthCheckPing.groupBy({
            by: ['siteDomainId'],
            where: {
              siteDomainId: { in: problemDomainIds },
              createdAt: {
                gte: new Date(Date.parse(generatedAt) - HEALTH_LOOKBACK_MS),
              },
            },
            _count: { _all: true },
            _max: { createdAt: true },
          })
        : Promise.resolve([]),
      problemDomainIds.length
        ? this.prisma.healthCheckPing.groupBy({
            by: ['siteDomainId'],
            where: {
              siteDomainId: { in: problemDomainIds },
              reachable: true,
              createdAt: {
                gte: new Date(Date.parse(generatedAt) - HEALTH_LOOKBACK_MS),
              },
            },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);

    const primaryBySite = new Map(primaryDomains.map((row) => [row.siteId, row.domain]));
    const affectedBySite = new Map(
      affectedGroups.map((row) => [row.siteId, row._count._all]),
    );
    const healthTotalBySite = new Map(
      selectedHealthTotal.map((row) => [row.siteId, row._count._all]),
    );
    const healthReachableBySite = new Map(
      selectedHealthReachable.map((row) => [row.siteId, row._count._all]),
    );
    const activeSiteIds = new Set(
      activeOperations
        .map((operation) => operation.siteId)
        .filter((id): id is string => id !== null),
    );
    const statusCounts = new Map(
      statusGroups.map((group) => [group.status, group._count._all]),
    );
    const total = statusGroups.reduce((sum, group) => sum + group._count._all, 0);
    const problemHealthTotalByDomain = new Map(
      problemHealthTotal.map((row) => [row.siteDomainId, row]),
    );
    const problemHealthReachableByDomain = new Map(
      problemHealthReachable.map((row) => [row.siteDomainId, row._count._all]),
    );

    const healthProblems: HealthProblemCandidate[] = domainErrors.flatMap((domain) => {
      const totalGroup = problemHealthTotalByDomain.get(domain.id);
      const sampleCount = totalGroup?._count._all ?? 0;
      const reachable = problemHealthReachableByDomain.get(domain.id) ?? 0;
      if (reachable > 0 || sampleCount < 1) return [];
      return [{
        siteId: domain.siteId,
        domainId: domain.id,
        siteLabel: siteLabel(domain.site),
        domain: domain.domain,
        sampleCount,
        reachableCount: reachable,
        observedAt: iso(totalGroup?._max.createdAt) ?? generatedAt,
      }];
    });

    return {
      section: {
        source: source(generatedAt, 300),
        total,
        running: statusCounts.get('RUNNING') ?? 0,
        error: statusCounts.get('ERROR') ?? 0,
        deploying: statusCounts.get('DEPLOYING') ?? 0,
        managedDomains,
        items: selectedRows.map((row) => {
          const sampleCount = healthTotalBySite.get(row.id) ?? 0;
          const reachableCount = healthReachableBySite.get(row.id) ?? 0;
          return {
            id: row.id,
            displayName: siteLabel(row),
            primaryDomain: primaryBySite.get(row.id) ?? null,
            status: row.status,
            affectedDomainCount: affectedBySite.get(row.id) ?? 0,
            availabilityPercent:
              sampleCount > 0
                ? Math.round((reachableCount / sampleCount) * 10_000) / 100
                : null,
            availabilitySampleCount: sampleCount,
            activeOperation: activeSiteIds.has(row.id),
            updatedAt: row.updatedAt.toISOString(),
          };
        }),
      },
      siteProblems: siteErrors.map((site) => ({
        id: site.id,
        label: siteLabel(site),
        status: site.status,
        errorMessage: site.errorMessage,
        updatedAt: site.updatedAt.toISOString(),
      })),
      domainProblems: domainErrors.map((domain) => ({
        id: domain.id,
        siteId: domain.siteId,
        label: domain.domain,
        siteLabel: siteLabel(domain.site),
        appStatus: domain.appStatus,
        errorMessage: domain.appErrorMessage,
        updatedAt: domain.updatedAt.toISOString(),
      })),
      healthProblems,
    };
  }

  async loadOperations(
    context: DashboardRequestContext,
    generatedAt: string,
  ): Promise<DashboardOperationsData> {
    const scope: Prisma.OperationWhereInput =
      context.role === 'MANAGER'
        ? {
            OR: [
              { site: { userId: context.userId } },
              { siteDomain: { site: { userId: context.userId } } },
              { database: { siteDomain: { site: { userId: context.userId } } } },
            ],
          }
        : {};
    const select = {
      id: true,
      type: true,
      status: true,
      siteId: true,
      currentStep: true,
      progress: true,
      errorMessage: true,
      startedAt: true,
      completedAt: true,
      updatedAt: true,
      site: { select: { name: true, displayName: true } },
      siteDomain: { select: { domain: true } },
    } satisfies Prisma.OperationSelect;
    const [active, failures, successes] = await Promise.all([
      this.prisma.operation.findMany({
        where: { ...scope, status: { in: [...ACTIVE_OPERATION_STATUSES] } },
        orderBy: { updatedAt: 'desc' },
        take: PROBLEM_CANDIDATE_LIMIT,
        select,
      }),
      this.prisma.operation.findMany({
        where: {
          ...scope,
          status: 'FAILED',
          createdAt: {
            gte: new Date(Date.parse(generatedAt) - DAY_MS),
          },
        },
        orderBy: { createdAt: 'desc' },
        take: PROBLEM_CANDIDATE_LIMIT,
        select,
      }),
      this.prisma.operation.findMany({
        where: {
          ...scope,
          status: 'SUCCEEDED',
          createdAt: {
            gte: new Date(Date.parse(generatedAt) - DAY_MS),
          },
        },
        orderBy: { createdAt: 'desc' },
        take: PROBLEM_CANDIDATE_LIMIT,
        select,
      }),
    ]);

    const normalize = (operation: (typeof active)[number]): OperationProblemCandidate => ({
      id: operation.id,
      type: operation.type,
      status: operation.status,
      siteId: operation.siteId,
      entityLabel:
        operation.siteDomain?.domain ||
        (operation.site ? siteLabel(operation.site) : 'Сервер'),
      currentStep: operation.currentStep,
      errorMessage: operation.errorMessage,
      startedAt: iso(operation.startedAt),
      completedAt: iso(operation.completedAt),
      updatedAt: operation.updatedAt.toISOString(),
    });

    return {
      active: active.slice(0, DASHBOARD_LIMITS.activeOperations).map((operation) => ({
        id: operation.id,
        type: operation.type,
        status: operation.status,
        target:
          operation.siteDomain?.domain ||
          (operation.site ? siteLabel(operation.site) : 'Сервер'),
        siteId: operation.siteId,
        progress: Math.max(0, Math.min(100, operation.progress)),
        currentStep: operation.currentStep,
        startedAt: iso(operation.startedAt),
        updatedAt: operation.updatedAt.toISOString(),
      })),
      failures: failures
        .filter((failure) => {
          const failedAt = failure.completedAt ?? failure.updatedAt;
          return !successes.some((success) => {
            const successAt = success.completedAt ?? success.updatedAt;
            return (
              success.type === failure.type &&
              success.siteId === failure.siteId &&
              success.siteDomain?.domain === failure.siteDomain?.domain &&
              successAt.getTime() > failedAt.getTime()
            );
          });
        })
        .map(normalize),
      activeCandidates: active.map(normalize),
    };
  }

  async loadProtection(
    context: DashboardRequestContext,
    generatedAt: string,
  ): Promise<DashboardProtectionData> {
    const now = new Date(generatedAt);
    const dayAgo = new Date(now.getTime() - DAY_MS);
    const siteWhere: Prisma.SiteWhereInput =
      context.role === 'MANAGER' ? { userId: context.userId } : {};
    const backupWhere: Prisma.BackupWhereInput =
      context.role === 'MANAGER' ? { site: { userId: context.userId } } : {};
    const sslWhere: Prisma.SslCertificateWhereInput =
      context.role === 'MANAGER' ? { site: { userId: context.userId } } : {};

    const [
      eligibleSiteCount,
      directlyProtectedSiteCount,
      globalScheduleCount,
      latestSuccess,
      failedLast24Hours,
      activeCount,
      failureRows,
      resticCheck,
      sslRows,
      validSsl,
      expiringSsl,
      expiredOrErrorSsl,
      nearestSsl,
      siteSchedules,
      globalSchedules,
    ] = await Promise.all([
      this.prisma.site.count({ where: siteWhere }),
      this.prisma.site.count({
        where: {
          ...siteWhere,
          backupConfigs: { some: { enabled: true } },
        },
      }),
      this.prisma.siteBackupSchedule.count({ where: { enabled: true } }),
      this.prisma.backup.aggregate({
        where: { ...backupWhere, status: 'COMPLETED' },
        _max: { completedAt: true, createdAt: true },
      }),
      this.prisma.backup.count({
        where: { ...backupWhere, status: 'FAILED', createdAt: { gte: dayAgo } },
      }),
      this.prisma.backup.count({
        where: {
          ...backupWhere,
          status: { in: ['PENDING', 'IN_PROGRESS'] },
        },
      }),
      this.prisma.backup.findMany({
        where: { ...backupWhere, status: 'FAILED', createdAt: { gte: dayAgo } },
        orderBy: { createdAt: 'desc' },
        take: PROBLEM_CANDIDATE_LIMIT,
        select: {
          id: true,
          siteId: true,
          errorMessage: true,
          completedAt: true,
          createdAt: true,
          site: { select: { name: true, displayName: true } },
        },
      }),
      context.role === 'ADMIN'
        ? this.prisma.resticCheck.findFirst({
            orderBy: { startedAt: 'desc' },
            select: {
              id: true,
              siteId: true,
              siteName: true,
              success: true,
              errorMessage: true,
              completedAt: true,
              startedAt: true,
            },
          })
        : Promise.resolve(null),
      this.prisma.sslCertificate.findMany({
        where: {
          ...sslWhere,
          OR: [
            { status: { in: ['EXPIRED', 'PENDING'] } },
            { expiresAt: { lte: new Date(now.getTime() + 14 * DAY_MS) } },
          ],
        },
        orderBy: [{ expiresAt: 'asc' }, { updatedAt: 'desc' }],
        take: PROBLEM_CANDIDATE_LIMIT,
        select: {
          id: true,
          siteId: true,
          status: true,
          expiresAt: true,
          daysRemaining: true,
          updatedAt: true,
          site: { select: { name: true } },
          domain: { select: { domain: true } },
        },
      }),
      this.prisma.sslCertificate.count({
        where: {
          ...sslWhere,
          status: 'ACTIVE',
          expiresAt: { gt: new Date(now.getTime() + 14 * DAY_MS) },
        },
      }),
      this.prisma.sslCertificate.count({
        where: {
          ...sslWhere,
          status: { in: ['ACTIVE', 'EXPIRING_SOON'] },
          expiresAt: {
            gt: now,
            lte: new Date(now.getTime() + 14 * DAY_MS),
          },
        },
      }),
      this.prisma.sslCertificate.count({
        where: {
          ...sslWhere,
          OR: [{ status: 'EXPIRED' }, { expiresAt: { lte: now } }],
        },
      }),
      this.prisma.sslCertificate.findFirst({
        where: { ...sslWhere, expiresAt: { not: null } },
        orderBy: { expiresAt: 'asc' },
        select: {
          expiresAt: true,
          daysRemaining: true,
          site: { select: { name: true } },
          domain: { select: { domain: true } },
        },
      }),
      this.prisma.backupConfig.findMany({
        where: {
          enabled: true,
          schedule: { not: null },
          ...(context.role === 'MANAGER'
            ? { site: { userId: context.userId } }
            : {}),
        },
        orderBy: { updatedAt: 'desc' },
        take: PROBLEM_CANDIDATE_LIMIT,
        select: {
          id: true,
          siteId: true,
          schedule: true,
          createdAt: true,
          site: { select: { name: true, displayName: true } },
          backups: {
            where: { status: 'COMPLETED' },
            orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
            take: 1,
            select: { completedAt: true, createdAt: true },
          },
        },
      }),
      context.role === 'ADMIN'
        ? this.prisma.siteBackupSchedule.findMany({
            where: { enabled: true, schedule: { not: null } },
            orderBy: { updatedAt: 'desc' },
            take: PROBLEM_CANDIDATE_LIMIT,
            select: {
              id: true,
              name: true,
              schedule: true,
              createdAt: true,
              backups: {
                where: { status: 'COMPLETED' },
                orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
                take: 1,
                select: { completedAt: true, createdAt: true },
              },
            },
          })
        : Promise.resolve([]),
    ]);

    const failureSiteIds = [...new Set(failureRows.map((row) => row.siteId))];
    const successesAfterFailures = failureSiteIds.length
      ? await this.prisma.backup.groupBy({
          by: ['siteId'],
          where: {
            siteId: { in: failureSiteIds },
            status: 'COMPLETED',
            completedAt: { gte: dayAgo },
          },
          _max: { completedAt: true },
        })
      : [];
    const latestSuccessBySite = new Map(
      successesAfterFailures.map((row) => [row.siteId, row._max.completedAt]),
    );
    const seenFailureSites = new Set<string>();
    const backupFailures = failureRows.flatMap((row) => {
      if (seenFailureSites.has(row.siteId)) return [];
      const occurredAt = row.completedAt ?? row.createdAt;
      const laterSuccess = latestSuccessBySite.get(row.siteId);
      if (laterSuccess && laterSuccess.getTime() > occurredAt.getTime()) return [];
      seenFailureSites.add(row.siteId);
      return [{
        id: row.id,
        siteId: row.siteId,
        siteLabel: siteLabel(row.site),
        errorMessage: row.errorMessage,
        occurredAt: occurredAt.toISOString(),
      }];
    });

    const overdueBackups: BackupOverdueCandidate[] = [];
    const invalidSchedules: BackupInvalidScheduleCandidate[] = [];
    for (const config of siteSchedules) {
      if (!config.schedule) continue;
      const latest = config.backups[0];
      const baseDate = latest?.completedAt ?? latest?.createdAt ?? config.createdAt;
      const due = dashboardCronState(config.schedule, baseDate, now);
      if (due.state === 'INVALID') {
        invalidSchedules.push({ id: config.id, siteId: config.siteId, label: siteLabel(config.site) });
        continue;
      }
      if (due.state !== 'DUE') continue;
      overdueBackups.push({
        id: config.id,
        siteId: config.siteId,
        label: siteLabel(config.site),
        missedExecutions: due.missedExecutions,
        expectedAt: due.expectedAt.toISOString(),
      });
    }
    for (const schedule of globalSchedules) {
      if (!schedule.schedule) continue;
      const latest = schedule.backups[0];
      const baseDate = latest?.completedAt ?? latest?.createdAt ?? schedule.createdAt;
      const due = dashboardCronState(schedule.schedule, baseDate, now);
      if (due.state === 'INVALID') {
        invalidSchedules.push({ id: schedule.id, siteId: null, label: schedule.name });
        continue;
      }
      if (due.state !== 'DUE') continue;
      overdueBackups.push({
        id: schedule.id,
        siteId: null,
        label: schedule.name,
        missedExecutions: due.missedExecutions,
        expectedAt: due.expectedAt.toISOString(),
      });
    }

    const protectedSiteCount =
      globalScheduleCount > 0 ? eligibleSiteCount : directlyProtectedSiteCount;
    const coverageGapCount = Math.max(0, eligibleSiteCount - protectedSiteCount);
    const sslProblems: SslProblemCandidate[] = sslRows.map((certificate) => ({
      id: certificate.id,
      siteId: certificate.siteId,
      domain: certificate.domain?.domain || certificate.site.name,
      status: certificate.status,
      expiresAt: iso(certificate.expiresAt),
      daysRemaining:
        certificate.daysRemaining ??
        (certificate.expiresAt
          ? Math.ceil((certificate.expiresAt.getTime() - now.getTime()) / DAY_MS)
          : null),
      updatedAt: certificate.updatedAt.toISOString(),
    }));

    const completedResticAt = resticCheck?.completedAt ?? resticCheck?.startedAt ?? null;
    return {
      section: {
        source: source(generatedAt, 300),
        backup: {
          eligibleSiteCount,
          protectedSiteCount,
          latestSuccessfulAt: iso(
            latestSuccess._max.completedAt ?? latestSuccess._max.createdAt,
          ),
          failedLast24Hours,
          overdueScheduleCount: overdueBackups.length,
          activeCount,
          repositoryCheckState: context.role === 'MANAGER'
            ? 'UNKNOWN'
            : !resticCheck
              ? 'UNCONFIGURED'
            : resticCheck.success
              ? 'OK'
              : 'FAILED',
          repositoryCheckedAt: iso(completedResticAt),
        },
        ssl: {
          valid: validSsl,
          expiring: expiringSsl,
          expiredOrError: expiredOrErrorSsl,
          nearestExpiryDomain:
            nearestSsl?.domain?.domain || nearestSsl?.site.name || null,
          nearestExpiryDays:
            nearestSsl?.daysRemaining ??
            (nearestSsl?.expiresAt
              ? Math.ceil((nearestSsl.expiresAt.getTime() - now.getTime()) / DAY_MS)
              : null),
          exceptions: sslProblems.slice(0, 8).map((certificate) => ({
            certificateId: certificate.id,
            siteId: certificate.siteId,
            domain: certificate.domain,
            status: certificate.status,
            expiresAt: certificate.expiresAt,
            daysRemaining: certificate.daysRemaining,
          })),
        },
      },
      backupFailures,
      overdueBackups,
      invalidSchedules,
      coverageGapCount,
      repositoryFailure:
        resticCheck && !resticCheck.success && completedResticAt
          ? {
              id: resticCheck.id,
              siteId: resticCheck.siteId,
              siteLabel: resticCheck.siteName,
              errorMessage: resticCheck.errorMessage,
              observedAt: completedResticAt.toISOString(),
            }
          : null,
      sslProblems,
    };
  }

  async loadSecurity(
    context: DashboardRequestContext,
    generatedAt: string,
  ): Promise<DashboardSecuritySection | null> {
    if (context.role !== 'ADMIN') return null;
    const now = new Date(generatedAt);
    const [failedLogins, activeSessions, lastLogin] = await Promise.all([
      this.prisma.auditLog.count({
        where: {
          action: 'LOGIN',
          entity: 'auth',
          details: { contains: '"success":false' },
          createdAt: { gte: new Date(now.getTime() - DAY_MS) },
        },
      }),
      this.prisma.session.count({ where: { expiresAt: { gt: now } } }),
      this.prisma.auditLog.findFirst({
        where: {
          action: 'LOGIN',
          entity: 'auth',
          details: { contains: '"success":true' },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          createdAt: true,
          user: { select: { username: true } },
        },
      }),
    ]);
    return {
      source: source(generatedAt, 300),
      failedLoginsLast24Hours: failedLogins,
      activeSessionCount: activeSessions,
      lastSuccessfulLoginAt: iso(lastLogin?.createdAt),
      lastSuccessfulLoginActor: lastLogin?.user.username ?? null,
      firewallSummary: null,
    };
  }

  async loadActivity(
    context: DashboardRequestContext,
    generatedAt: string,
  ): Promise<DashboardActivitySection> {
    if (context.role === 'MANAGER') {
      return {
        source: unsupportedSource(
          'Журнал не содержит надёжной связи со всеми принадлежащими пользователю сайтами',
        ),
        items: [],
      };
    }
    const rows = await this.prisma.auditLog.findMany({
      where: undefined,
      orderBy: { createdAt: 'desc' },
      take: DASHBOARD_LIMITS.activity,
      select: {
        id: true,
        action: true,
        entity: true,
        entityId: true,
        createdAt: true,
        user: { select: { username: true } },
      },
    });
    return {
      source: source(generatedAt, 300),
      items: rows.map((row) => ({
        id: row.id,
        occurredAt: row.createdAt.toISOString(),
        actor: row.user.username || 'system',
        action: row.action,
        target: row.entity,
        targetId: row.entityId,
        result: 'UNKNOWN',
      })),
    };
  }

  async loadAdminState(
    context: DashboardRequestContext,
    generatedAt: string,
  ): Promise<DashboardAdminStateData> {
    if (context.role !== 'ADMIN') return { dnsProviders: [], update: null };
    const [providers, update] = await Promise.all([
      this.prisma.dnsProviderAccount.findMany({
        where: { status: { in: ['ERROR', 'UNAUTHORIZED'] } },
        orderBy: { updatedAt: 'desc' },
        take: PROBLEM_CANDIDATE_LIMIT,
        select: {
          id: true,
          label: true,
          status: true,
          lastError: true,
          lastSyncAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.panelUpdateState.findUnique({
        where: { id: 'current' },
        select: {
          status: true,
          fromVersion: true,
          toVersion: true,
          errorMessage: true,
          finishedAt: true,
          startedAt: true,
        },
      }),
    ]);
    return {
      dnsProviders: providers.map((provider) => ({
        id: provider.id,
        label: provider.label,
        status: provider.status,
        errorMessage: provider.lastError,
        observedAt: iso(provider.lastSyncAt ?? provider.updatedAt) ?? generatedAt,
      })),
      update: update
        ? {
            status: update.status,
            fromVersion: update.fromVersion,
            toVersion: update.toVersion,
            errorMessage: update.errorMessage,
            observedAt: iso(update.finishedAt ?? update.startedAt) ?? generatedAt,
          }
        : null,
    };
  }
}
