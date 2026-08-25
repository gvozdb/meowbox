import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import {
  DASHBOARD_LIMITS,
  nginxZoneName,
  type DashboardServiceItem,
  type DashboardSourceState,
} from '@meowbox/shared';
import { PrismaService } from '../common/prisma.service';
import { safeErrorMessage } from '@meowbox/shared';
import {
  dashboardDiagnosticFailureReason,
  dashboardDiagnosticMetricSamples,
  type DashboardDiagnostic,
  type DashboardDiagnosticFailureReason,
} from '../common/dashboard-observability';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { buildMultiDomainNginxPayload } from '../sites/site-domains.helper';
import {
  managedDnsExpectedHash,
  managedDnsRecordHash,
} from '../dns/dns-managed-record';
import type { DashboardDiagnosticsInput } from './dashboard-problems';

const CORE_INTERVAL_MS = 30_000;
const NGINX_VALIDATION_INTERVAL_MS = 60_000;
const PM2_INTERVAL_MS = 60_000;
const NGINX_DRIFT_INTERVAL_MS = 5 * 60_000;
const DNS_INTERVAL_MS = 10 * 60_000;
const MAX_ZONE_MANIFEST = 500;
const MAX_DNS_RECORDS = 100;
const MAX_CACHED_SERVICES = 200;

interface AgentDiagnosticsResponse {
  observedAt: string;
  services: Array<{
    id: string;
    name: string;
    siteId: string | null;
    installed: boolean | null;
    expectedState: 'RUNNING' | 'STOPPED' | 'OPTIONAL';
    actualState: 'RUNNING' | 'STOPPED' | 'FAILED' | 'MISSING' | 'UNKNOWN';
    checkedAt: string;
  }>;
  nginx: {
    valid: boolean | null;
    error: string | null;
    files: Array<{
      id: string;
      siteId: string | null;
      label: string;
      exists: boolean;
      actualSha256: string | null;
      expectedSha256: string;
      matches: boolean;
    }>;
    partial: boolean;
  };
}

function unavailable(message: string): DashboardSourceState {
  return {
    availability: 'UNAVAILABLE',
    observedAt: null,
    staleAfterSeconds: null,
    message,
  };
}

function supportedSource(
  observedAt: string,
  staleAfterSeconds: number,
  now = Date.now(),
): DashboardSourceState {
  const ageMs = Math.max(0, now - Date.parse(observedAt));
  return {
    availability:
      ageMs > staleAfterSeconds * 1000 ? 'STALE' : 'OK',
    observedAt,
    staleAfterSeconds,
    message:
      ageMs > staleAfterSeconds * 1000
        ? 'Последняя успешная фоновая проверка устарела'
        : null,
  };
}

@Injectable()
export class DashboardDiagnosticsService implements OnModuleInit {
  private readonly logger = new Logger(DashboardDiagnosticsService.name);
  private coreInFlight: Promise<void> | null = null;
  private nginxValidationInFlight: Promise<void> | null = null;
  private pm2InFlight: Promise<void> | null = null;
  private nginxDriftInFlight: Promise<void> | null = null;
  private dnsInFlight: Promise<void> | null = null;
  private agentDisconnectedAt: string | null = null;
  private installedVersion: string | null = null;
  private lastCoreAt: string | null = null;
  private lastPm2At: string | null = null;
  private lastNginxValidationAt: string | null = null;
  private lastNginxDriftAt: string | null = null;
  private lastCoreFailure: string | null = null;
  private lastNginxValidationFailure: string | null = null;
  private lastPm2Failure: string | null = null;
  private lastNginxDriftFailure: string | null = null;
  private nginxValid: boolean | null = null;
  private nginxError: string | null = null;
  private pm2Cursor: string | null = null;
  private nginxDriftCursor: string | null = null;
  private pm2Partial = true;
  private nginxDriftPartial = true;
  private services = new Map<string, DashboardServiceItem>();
  private nginxFiles = new Map<
    string,
    { id: string; siteId: string | null; label: string; missing: boolean; observedAt: string }
  >();
  private dnsSource: DashboardSourceState = {
    availability: 'UNSUPPORTED',
    observedAt: null,
    staleAfterSeconds: null,
    message: 'Нет DNS-записей с контрактом управления Meowbox',
  };
  private dnsMismatchCounts = new Map<
    string,
    { confirmedChecks: number; observedAt: string }
  >();
  private dnsDrifts: DashboardDiagnosticsInput['dns']['items'] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
  ) {}

  onModuleInit(): void {
    this.installedVersion = null;
    void this.loadInstalledVersion();
    this.trackAgentState();
    void this.refreshCore();
    void this.refreshNginxValidation();
    void this.refreshPm2();
    void this.refreshNginxDrift();
    void this.refreshDns();
  }

  @Interval(CORE_INTERVAL_MS)
  refreshCore(): Promise<void> {
    if (this.coreInFlight) return this.coreInFlight;
    this.coreInFlight = this.runCoreRefresh().finally(() => {
      this.coreInFlight = null;
    });
    return this.coreInFlight;
  }

  @Interval(NGINX_VALIDATION_INTERVAL_MS)
  refreshNginxValidation(): Promise<void> {
    if (this.nginxValidationInFlight) return this.nginxValidationInFlight;
    this.nginxValidationInFlight = this.runNginxValidation().finally(() => {
      this.nginxValidationInFlight = null;
    });
    return this.nginxValidationInFlight;
  }

  @Interval(PM2_INTERVAL_MS)
  refreshPm2(): Promise<void> {
    if (this.pm2InFlight) return this.pm2InFlight;
    this.pm2InFlight = this.runPm2Refresh().finally(() => {
      this.pm2InFlight = null;
    });
    return this.pm2InFlight;
  }

  @Interval(NGINX_DRIFT_INTERVAL_MS)
  refreshNginxDrift(): Promise<void> {
    if (this.nginxDriftInFlight) return this.nginxDriftInFlight;
    this.nginxDriftInFlight = this.runNginxDriftRefresh().finally(() => {
      this.nginxDriftInFlight = null;
    });
    return this.nginxDriftInFlight;
  }

  @Interval(DNS_INTERVAL_MS)
  refreshDns(): Promise<void> {
    if (this.dnsInFlight) return this.dnsInFlight;
    this.dnsInFlight = this.runDnsRefresh().finally(() => {
      this.dnsInFlight = null;
    });
    return this.dnsInFlight;
  }

  getInstalledVersion(): string | null {
    return this.installedVersion;
  }

  isPartial(): boolean {
    return this.pm2Partial || this.nginxDriftPartial;
  }

  getSnapshot(): DashboardDiagnosticsInput {
    const connected = this.agentRelay.isAgentConnected();
    const diagnosticsObservedAt = this.lastCoreAt && this.lastPm2At
      ? [this.lastCoreAt, this.lastPm2At].sort()[0]
      : null;
    const diagnosticsFailure =
      this.lastCoreFailure ||
      this.lastPm2Failure ||
      (this.pm2Partial ? 'PM2-проверка большого списка ещё не завершена' : null);
    const coreSource = diagnosticsObservedAt
      ? !connected || diagnosticsFailure
        ? {
            availability: 'STALE' as const,
            observedAt: diagnosticsObservedAt,
            staleAfterSeconds: 90,
            message: !connected ? 'Agent не подключён; показана последняя проверка' : diagnosticsFailure,
          }
        : supportedSource(diagnosticsObservedAt, 90)
      : connected
        ? unavailable('Фоновая диагностика ещё не завершилась')
        : unavailable('Agent не подключён');
    const nginxObservedAt = this.lastNginxValidationAt && this.lastNginxDriftAt
      ? [this.lastNginxValidationAt, this.lastNginxDriftAt].sort()[0]
      : null;
    const nginxFailure =
      this.lastNginxValidationFailure ||
      this.lastNginxDriftFailure ||
      (this.nginxDriftPartial
        ? 'Проверка управляемых конфигов большого списка ещё не завершена'
        : null);
    const nginxSource = nginxObservedAt
      ? !connected || nginxFailure
        ? {
            availability: 'STALE' as const,
            observedAt: nginxObservedAt,
            staleAfterSeconds: 600,
            message: !connected ? 'Agent не подключён; показана последняя проверка' : nginxFailure,
          }
        : supportedSource(nginxObservedAt, 600)
      : connected
        ? unavailable('Проверка Nginx ещё не завершилась')
        : unavailable('Agent не подключён');
    return {
      source: coreSource,
      agentConnected: connected,
      agentDisconnectedAt: this.agentDisconnectedAt,
      services: [...this.services.values()].slice(0, MAX_CACHED_SERVICES),
      nginx: {
        source: nginxSource,
        valid: this.nginxValid,
        errorMessage: this.nginxError,
        drift: [...this.nginxFiles.values()]
          .slice(0, 100)
          .map((file) => ({ ...file })),
      },
      dns: {
        source: this.dnsSource,
        items: this.dnsDrifts,
      },
    };
  }

  private async runCoreRefresh(): Promise<void> {
    const startedAt = Date.now();
    let failureReason: DashboardDiagnosticFailureReason | null = null;
    try {
      this.trackAgentState();
      if (!this.agentRelay.isAgentConnected()) {
        failureReason = 'agent_disconnected';
        return;
      }
      const [databaseTypes, phpVersions, siteServices] = await Promise.all([
        this.prisma.database.groupBy({ by: ['type'], _count: { _all: true } }),
        this.prisma.siteDomain.groupBy({
          by: ['phpVersion'],
          where: { phpVersion: { not: null } },
          _count: { _all: true },
        }),
        this.prisma.siteService.findMany({
          where: {
            status: { in: ['RUNNING', 'ERROR', 'STARTING'] },
            serviceKey: { in: ['manticore', 'redis'] },
          },
          orderBy: { updatedAt: 'desc' },
          take: 6,
          select: {
            siteId: true,
            serviceKey: true,
            site: { select: { name: true, displayName: true } },
          },
        }),
      ]);
      const usedDatabases = new Set(databaseTypes.map((row) => row.type));
      const services: Array<{
        id: string;
        unit: string;
        name: string;
        expectedState: 'RUNNING' | 'STOPPED' | 'OPTIONAL';
        siteId?: string | null;
      }> = [
        {
          id: 'service:nginx',
          unit: 'nginx',
          name: 'Nginx',
          expectedState: 'RUNNING',
        },
        {
          id: 'service:mariadb',
          unit: 'mariadb',
          name: 'MariaDB',
          expectedState:
            usedDatabases.has('MARIADB') || usedDatabases.has('MYSQL')
              ? 'RUNNING'
              : 'OPTIONAL',
        },
        {
          id: 'service:postgresql',
          unit: 'postgresql',
          name: 'PostgreSQL',
          expectedState: usedDatabases.has('POSTGRESQL') ? 'RUNNING' : 'OPTIONAL',
        },
      ];
      for (const php of phpVersions) {
        if (!php.phpVersion || !/^\d(?:\.\d)?$/.test(php.phpVersion)) continue;
        services.push({
          id: `service:php${php.phpVersion}-fpm`,
          unit: `php${php.phpVersion}-fpm`,
          name: `PHP-FPM ${php.phpVersion}`,
          expectedState: 'RUNNING',
        });
      }
      for (const service of siteServices) {
        services.push({
          id: `service:${service.serviceKey}:${service.siteId}`,
          unit: `${service.serviceKey}@${service.site.name}`,
          name: `${service.serviceKey} · ${service.site.displayName || service.site.name}`,
          expectedState: 'RUNNING',
          siteId: service.siteId,
        });
      }
      const response = await this.agentRelay.emitToAgent<AgentDiagnosticsResponse>(
        'dashboard:diagnostics',
        {
          services: services.slice(0, 16),
          rootProcesses: [],
          sites: [],
          includeSiteProcesses: false,
          validateNginx: false,
          compareNginx: false,
        },
        5_000,
      );
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Agent rejected dashboard diagnostics');
      }
      if (!this.agentRelay.isAgentConnected()) {
        throw new Error('Agent disconnected during dashboard diagnostics');
      }
      this.mergeAgentResponse(response.data, false);
      this.lastCoreAt = response.data.observedAt;
      this.lastCoreFailure = null;
    } catch (error) {
      failureReason = dashboardDiagnosticFailureReason(error);
      this.lastCoreFailure = safeErrorMessage(error, 'Фоновая диагностика недоступна', 240);
      this.logger.warn(`Core dashboard diagnostics failed: ${this.lastCoreFailure}`);
    } finally {
      this.logDiagnosticCompletion('core', startedAt, failureReason);
    }
  }

  private async runNginxValidation(): Promise<void> {
    const startedAt = Date.now();
    let failureReason: DashboardDiagnosticFailureReason | null = null;
    try {
      this.trackAgentState();
      if (!this.agentRelay.isAgentConnected()) {
        failureReason = 'agent_disconnected';
        return;
      }
      const response = await this.agentRelay.emitToAgent<AgentDiagnosticsResponse>(
        'dashboard:diagnostics',
        {
          services: [],
          rootProcesses: [],
          sites: [],
          includeSiteProcesses: false,
          validateNginx: true,
          compareNginx: false,
        },
        10_000,
      );
      if (!response.success || !response.data || response.data.nginx.valid === null) {
        throw new Error(response.error || 'Agent rejected Nginx validation');
      }
      if (!this.agentRelay.isAgentConnected()) {
        throw new Error('Agent disconnected during Nginx validation');
      }
      this.mergeAgentResponse(response.data, false);
      this.lastNginxValidationAt = response.data.observedAt;
      this.lastNginxValidationFailure = null;
    } catch (error) {
      failureReason = dashboardDiagnosticFailureReason(error);
      this.lastNginxValidationFailure = safeErrorMessage(
        error,
        'Проверка Nginx недоступна',
        240,
      );
      this.logger.warn(`Nginx validation failed: ${this.lastNginxValidationFailure}`);
    } finally {
      this.logDiagnosticCompletion('nginx_validation', startedAt, failureReason);
    }
  }

  private dashboardSiteSelect() {
    return {
      id: true,
      name: true,
      status: true,
      rootPath: true,
      systemUser: true,
      domains: {
        orderBy: { position: 'asc' as const },
        select: {
          id: true,
          domain: true,
          isPrimary: true,
          position: true,
          aliases: true,
          preset: true,
          appStatus: true,
          appErrorMessage: true,
          filesRelPath: true,
          phpVersion: true,
          runtimeKey: true,
          appPort: true,
          httpsRedirect: true,
          nginxClientMaxBodySize: true,
          nginxFastcgiReadTimeout: true,
          nginxFastcgiSendTimeout: true,
          nginxFastcgiConnectTimeout: true,
          nginxFastcgiBufferSizeKb: true,
          nginxFastcgiBufferCount: true,
          nginxHttp2: true,
          nginxHsts: true,
          nginxGzip: true,
          nginxRateLimitEnabled: true,
          nginxRateLimitRps: true,
          nginxRateLimitBurst: true,
          nginxCustomConfig: true,
          sslCertificate: {
            select: { status: true, certPath: true, keyPath: true },
          },
        },
      },
    };
  }

  private async loadSiteBatch(cursor: string | null, batchSize: number) {
    const rows = await this.prisma.site.findMany({
      where: cursor ? { id: { gt: cursor } } : undefined,
      orderBy: { id: 'asc' },
      take: batchSize + 1,
      select: this.dashboardSiteSelect(),
    });
    return {
      sites: rows.slice(0, batchSize),
      hasMore: rows.length > batchSize,
    };
  }

  private async runPm2Refresh(): Promise<void> {
    const startedAt = Date.now();
    let failureReason: DashboardDiagnosticFailureReason | null = null;
    const cursor = this.pm2Cursor;
    try {
      this.trackAgentState();
      if (!this.agentRelay.isAgentConnected()) {
        failureReason = 'agent_disconnected';
        return;
      }
      const { sites, hasMore } = await this.loadSiteBatch(
        cursor,
        DASHBOARD_LIMITS.pm2DiagnosticSites,
      );
      const payloadSites = sites.map((site) => ({
        ...buildMultiDomainNginxPayload(site),
        siteId: site.id,
        stopped: site.status === 'STOPPED',
      }));
      const response = await this.agentRelay.emitToAgent<AgentDiagnosticsResponse>(
        'dashboard:diagnostics',
        {
          services: [],
          rootProcesses: [
            { name: 'meowbox-api', label: 'Meowbox API' },
            { name: 'meowbox-agent', label: 'Meowbox Agent' },
            { name: 'meowbox-web', label: 'Meowbox Web' },
          ],
          sites: payloadSites,
          includeSiteProcesses: true,
          validateNginx: false,
          compareNginx: false,
        },
        20_000,
      );
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Agent rejected PM2 diagnostics');
      }
      if (!this.agentRelay.isAgentConnected()) {
        throw new Error('Agent disconnected during PM2 diagnostics');
      }
      for (const site of sites) {
        for (const key of [...this.services.keys()]) {
          if (key.startsWith(`pm2:${site.id}:`)) this.services.delete(key);
        }
      }
      this.mergeAgentResponse(response.data, false);
      this.pm2Cursor = hasMore && sites.length > 0 ? sites[sites.length - 1].id : null;
      this.pm2Partial = this.pm2Partial && hasMore;
      this.lastPm2At = response.data.observedAt;
      this.lastPm2Failure = null;
    } catch (error) {
      failureReason = dashboardDiagnosticFailureReason(error);
      this.lastPm2Failure = safeErrorMessage(error, 'PM2-диагностика недоступна', 240);
      this.logger.warn(`PM2 dashboard diagnostics failed: ${this.lastPm2Failure}`);
    } finally {
      this.logDiagnosticCompletion('pm2', startedAt, failureReason);
    }
  }

  private async runNginxDriftRefresh(): Promise<void> {
    const startedAt = Date.now();
    let failureReason: DashboardDiagnosticFailureReason | null = null;
    const cursor = this.nginxDriftCursor;
    try {
      this.trackAgentState();
      if (!this.agentRelay.isAgentConnected()) {
        failureReason = 'agent_disconnected';
        return;
      }
      const { sites, hasMore } = await this.loadSiteBatch(
        cursor,
        DASHBOARD_LIMITS.nginxDiagnosticSites,
      );
      const zones = await this.prisma.siteDomain.findMany({
        orderBy: { id: 'asc' },
        take: MAX_ZONE_MANIFEST + 1,
        select: {
          id: true,
          nginxRateLimitEnabled: true,
          nginxRateLimitRps: true,
        },
      });
      const zoneManifest =
        zones.length <= MAX_ZONE_MANIFEST
          ? zones.map((domain) => ({
              zoneName: nginxZoneName(domain.id),
              rps:
                domain.nginxRateLimitRps && domain.nginxRateLimitRps > 0
                  ? domain.nginxRateLimitRps
                  : 30,
              enabled: domain.nginxRateLimitEnabled !== false,
            }))
          : undefined;
      const payloadSites = sites.map((site) => ({
        ...buildMultiDomainNginxPayload(site),
        siteId: site.id,
        stopped: site.status === 'STOPPED',
      }));
      const response = await this.agentRelay.emitToAgent<AgentDiagnosticsResponse>(
        'dashboard:diagnostics',
        {
          services: [],
          rootProcesses: [],
          sites: payloadSites,
          zones: zoneManifest,
          includeSiteProcesses: false,
          validateNginx: false,
          compareNginx: true,
        },
        30_000,
      );
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Agent rejected site diagnostics');
      }
      if (!this.agentRelay.isAgentConnected()) {
        throw new Error('Agent disconnected during site diagnostics');
      }
      for (const site of sites) {
        for (const key of [...this.nginxFiles.keys()]) {
          if (key.startsWith(`${site.id}:`)) this.nginxFiles.delete(key);
        }
      }
      this.mergeAgentResponse(response.data, true);
      this.nginxDriftCursor = hasMore && sites.length > 0
        ? sites[sites.length - 1].id
        : null;
      this.lastNginxDriftAt = response.data.observedAt;
      this.nginxDriftPartial =
        (this.nginxDriftPartial && hasMore) ||
        response.data.nginx.partial ||
        zones.length > MAX_ZONE_MANIFEST;
      this.lastNginxDriftFailure = null;
    } catch (error) {
      failureReason = dashboardDiagnosticFailureReason(error);
      this.lastNginxDriftFailure = safeErrorMessage(
        error,
        'Проверка управляемых конфигов Nginx недоступна',
        240,
      );
      this.logger.warn(`Nginx drift diagnostics failed: ${this.lastNginxDriftFailure}`);
    } finally {
      this.logDiagnosticCompletion('nginx_drift', startedAt, failureReason);
    }
  }

  private async runDnsRefresh(): Promise<void> {
    const startedAt = Date.now();
    let failureReason: DashboardDiagnosticFailureReason | null = null;
    try {
      const providers = await this.prisma.dnsProviderAccount.findMany({
        select: { id: true, status: true, lastSyncAt: true },
      });
      if (providers.length === 0) {
        this.dnsSource = {
          availability: 'UNSUPPORTED',
          observedAt: null,
          staleAfterSeconds: null,
          message: 'DNS-провайдеры не настроены',
        };
        this.dnsDrifts = [];
        return;
      }
      if (providers.some((provider) => provider.status !== 'ACTIVE')) {
        this.dnsSource = unavailable('DNS-провайдер временно недоступен');
        this.dnsDrifts = [];
        return;
      }
      const records = await this.prisma.dnsRecord.findMany({
        where: { comment: { contains: 'meowbox-managed:v1:' } },
        orderBy: { updatedAt: 'desc' },
        take: MAX_DNS_RECORDS,
        select: {
          id: true,
          type: true,
          name: true,
          content: true,
          priority: true,
          proxied: true,
          comment: true,
          updatedAt: true,
          zone: {
            select: {
              domain: true,
              accountId: true,
              recordsCachedAt: true,
            },
          },
        },
      });
      if (records.length === 0) {
        this.dnsSource = {
          availability: 'UNSUPPORTED',
          observedAt: null,
          staleAfterSeconds: null,
          message: 'Нет DNS-записей с контрактом управления Meowbox',
        };
        this.dnsDrifts = [];
        return;
      }
      const observedAt = records.reduce<Date | null>((oldest, record) => {
        const value = record.zone.recordsCachedAt ?? record.updatedAt;
        return !oldest || value < oldest ? value : oldest;
      }, null) ?? new Date();
      this.dnsSource = supportedSource(observedAt.toISOString(), 20 * 60);
      if (this.dnsSource.availability !== 'OK') {
        this.dnsDrifts = [];
        return;
      }

      const present = new Set(records.map((record) => record.id));
      for (const key of [...this.dnsMismatchCounts.keys()]) {
        if (!present.has(key)) this.dnsMismatchCounts.delete(key);
      }
      const drifts: DashboardDiagnosticsInput['dns']['items'] = [];
      for (const record of records) {
        const expected = managedDnsExpectedHash(record.comment);
        if (!expected) continue;
        const actual = managedDnsRecordHash(record);
        if (actual === expected) {
          this.dnsMismatchCounts.delete(record.id);
          continue;
        }
        const recordObservedAt = (
          record.zone.recordsCachedAt ?? record.updatedAt
        ).toISOString();
        const previous = this.dnsMismatchCounts.get(record.id);
        const confirmedChecks = previous?.observedAt === recordObservedAt
          ? previous.confirmedChecks
          : (previous?.confirmedChecks ?? 0) + 1;
        this.dnsMismatchCounts.set(record.id, {
          confirmedChecks,
          observedAt: recordObservedAt,
        });
        drifts.push({
          recordId: record.id,
          providerId: record.zone.accountId,
          label: `${record.name}.${record.zone.domain}`.replace('@.', ''),
          confirmedChecks,
          observedAt: recordObservedAt,
        });
      }
      this.dnsDrifts = drifts.slice(0, MAX_DNS_RECORDS);
    } catch (error) {
      failureReason = dashboardDiagnosticFailureReason(error);
      this.dnsSource = unavailable(safeErrorMessage(error, 'DNS-диагностика недоступна', 240));
      this.dnsDrifts = [];
      this.logger.warn(`DNS dashboard diagnostics failed: ${safeErrorMessage(error)}`);
    } finally {
      this.logDiagnosticCompletion('dns', startedAt, failureReason);
    }
  }

  private mergeAgentResponse(response: AgentDiagnosticsResponse, includeFiles: boolean): void {
    for (const service of response.services) {
      this.services.set(service.id, {
        ...service,
        scope: service.siteId ? 'SITE' : 'CORE',
      });
    }
    this.pruneServices();
    if (response.nginx.valid !== null) {
      this.nginxValid = response.nginx.valid;
      this.nginxError = response.nginx.error
        ? safeErrorMessage(response.nginx.error, 'nginx -t failed', 240)
        : null;
    }
    if (!includeFiles) return;
    for (const file of response.nginx.files) {
      if (file.matches) {
        this.nginxFiles.delete(file.id);
        continue;
      }
      this.nginxFiles.set(file.id, {
        id: file.id,
        siteId: file.siteId,
        label: file.label,
        missing: !file.exists,
        observedAt: response.observedAt,
      });
    }
  }

  private logDiagnosticCompletion(
    diagnostic: DashboardDiagnostic,
    startedAt: number,
    failureReason: DashboardDiagnosticFailureReason | null,
  ): void {
    const durationMs = Date.now() - startedAt;
    this.logger.log(JSON.stringify({
      event: 'dashboard_diagnostic_complete',
      diagnostic,
      durationMs,
      success: failureReason === null,
      metrics: dashboardDiagnosticMetricSamples({
        diagnostic,
        durationMs,
        failureReason,
      }),
    }));
  }

  private pruneServices(): void {
    if (this.services.size <= MAX_CACHED_SERVICES) return;
    const retained = [...this.services.values()]
      .sort((left, right) => {
        const leftCore = left.siteId ? 1 : 0;
        const rightCore = right.siteId ? 1 : 0;
        const scopeOrder = leftCore - rightCore;
        if (scopeOrder !== 0) return scopeOrder;
        const leftHealthy = left.actualState === 'RUNNING' ? 1 : 0;
        const rightHealthy = right.actualState === 'RUNNING' ? 1 : 0;
        return leftHealthy - rightHealthy || left.id.localeCompare(right.id);
      })
      .slice(0, MAX_CACHED_SERVICES);
    this.services = new Map(retained.map((service) => [service.id, service]));
  }

  private trackAgentState(): void {
    if (this.agentRelay.isAgentConnected()) {
      this.agentDisconnectedAt = null;
    } else if (!this.agentDisconnectedAt) {
      this.agentDisconnectedAt = new Date().toISOString();
    }
  }

  private async loadInstalledVersion(): Promise<void> {
    const panelDir = resolve(process.env.MEOWBOX_PANEL_DIR || join(process.cwd(), '..'));
    for (const candidate of [
      join(panelDir, 'current', 'VERSION'),
      join(panelDir, 'VERSION'),
    ]) {
      try {
        const value = (await readFile(candidate, 'utf8')).trim();
        if (value) {
          this.installedVersion = value.slice(0, 64);
          return;
        }
      } catch {
        // Try the next compatible layout.
      }
    }
  }
}
