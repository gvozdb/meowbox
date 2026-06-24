import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { Prisma } from '@prisma/client';
import { BackupStatus, BackupStorageType, CronJobStatus, DatabaseType, SslStatus, UserRole } from '../common/enums';
import { PrismaService } from '../common/prisma.service';
import { ProxyService } from '../proxy/proxy.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { SiteDomainsService } from '../sites/site-domains.service';
import { ServicesService } from '../services/services.service';
import { SiteNodeService } from '../site-node/site-node.service';
import { assertSafeFilePath } from '../common/validators/safe-path';
import { assertPublicHttpUrl } from '../common/validators/safe-url';
import { decryptJson, encryptJson } from '../common/crypto/credentials-cipher';
import { hashPassword } from '../common/crypto/argon2.helper';
import { parseSiteAliases, parseStringArray, stringifyStringArray } from '../common/json-array';
import type { NodeProcessesResult } from '@meowbox/shared';

// ─── Interfaces ───

export interface MigrateParams {
  siteId: string;
  sourceServerId: string;
  targetServerId: string;
  reissueSsl: boolean;
  stopSource: boolean;
  panelUrl?: string; // Required when source='main' — frontend sends window.location.origin
}

export interface MigrationState {
  id: string;
  siteId: string;
  sourceServerId: string;
  targetServerId: string;
  step: string;
  stepIndex: number;
  totalSteps: number;
  message: string;
  error?: string;
  targetSiteId?: string;
  startedAt: string;
  completedAt?: string;
}

interface DownloadToken {
  filePath: string;
  fileSize: number;
  expiresAt: Date;
  used: boolean;
}

export interface PullState {
  pullId: string;
  siteId: string;
  backupId: string;
  phase: 'downloading' | 'restoring' | 'completed' | 'failed';
  downloadProgress: number;
  restoreProgress: number;
  error?: string;
}

export interface DatabaseSnapshot {
  name: string;
  type: string;
  dbUser: string;
  dbPassword: string;
}

export interface SiteDomainSnapshot {
  domain: string;
  isPrimary: boolean;
  position: number;
  aliases: string;
  filesRelPath: string | null;
  appPort: number | null;
  httpsRedirect: boolean;
  nginxClientMaxBodySize: string | null;
  nginxFastcgiReadTimeout: number | null;
  nginxFastcgiSendTimeout: number | null;
  nginxFastcgiConnectTimeout: number | null;
  nginxFastcgiBufferSizeKb: number | null;
  nginxFastcgiBufferCount: number | null;
  nginxHttp2: boolean;
  nginxHsts: boolean;
  nginxGzip: boolean;
  nginxRateLimitEnabled: boolean;
  nginxRateLimitRps: number | null;
  nginxRateLimitBurst: number | null;
  nginxCustomConfig: string | null;
}

export interface BackupConfigSnapshot {
  type: string;
  engine: string;
  storageLocationNames: string[];
  storageType: string | null;
  storageConfig: string | null;
  schedule: string | null;
  retention: number;
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
  keepYearly: number;
  excludePaths: string;
  excludeTableData: string;
  keepLocalCopy: boolean;
  enabled: boolean;
}

export interface SiteServiceSnapshot {
  serviceKey: string;
  status: string;
  config: string;
}

export interface DnsZoneSnapshot {
  domain: string;
  status: string;
}

export interface SslCertificateSnapshot {
  domains: string;
  status: string;
  issuer: string;
  isWildcard: boolean;
}

export interface NodeEcosystemSnapshot {
  file: string;
  only?: string;
}

export interface NodeRuntimeSnapshot {
  autostartEnabled: boolean;
  ecosystems: NodeEcosystemSnapshot[];
  processesToStop: string[];
  orphanProcesses: string[];
}

export interface SiteSnapshot {
  site: Record<string, unknown>;
  domains: SiteDomainSnapshot[];
  databases: DatabaseSnapshot[];
  backupConfigs: BackupConfigSnapshot[];
  services: SiteServiceSnapshot[];
  dnsZones: DnsZoneSnapshot[];
  sslCertificates: SslCertificateSnapshot[];
  node: NodeRuntimeSnapshot;
  cronJobs: Array<{ name: string; schedule: string; command: string; status: string }>;
  quickCommands: Array<{
    label: string;
    source: string;
    target: string;
    cwd: string;
    sortOrder: number;
  }>;
}

// ─── Steps ───

const STEPS = [
  { key: 'preflight', label: 'Проверка серверов и конфликтов' },
  { key: 'backup', label: 'Создание бэкапа' },
  { key: 'waiting_backup', label: 'Ожидание завершения бэкапа' },
  { key: 'download_token', label: 'Подготовка передачи файла' },
  { key: 'metadata', label: 'Получение метаданных сайта' },
  { key: 'create_site', label: 'Создание сайта на целевом сервере' },
  { key: 'import_pull', label: 'Передача и восстановление из бэкапа' },
  { key: 'waiting_pull', label: 'Ожидание завершения передачи' },
  { key: 'apply_config', label: 'Перенос настроек сайта и runtime' },
  { key: 'ssl', label: 'Перевыпуск SSL-сертификата' },
  { key: 'cleanup', label: 'Остановка оригинала' },
  { key: 'done', label: 'Миграция завершена' },
];

/**
 * Путь локальных бэкапов. Совпадает с `BACKUP_LOCAL_PATH` в agent/src/config.ts.
 * Переопределяется env BACKUP_LOCAL_PATH (единая переменная для агента и API).
 */
const BACKUP_DIR = (process.env.BACKUP_LOCAL_PATH || '/var/meowbox/backups').replace(/\/+$/, '');

/**
 * Сколько живёт одноразовый download-токен для бэкапа. 1 час даёт запас
 * даже на медленных соединениях, при этом token single-use (см. consume).
 * Переопределяется MIGRATION_DOWNLOAD_TOKEN_TTL_MS.
 */
const DOWNLOAD_TOKEN_TTL_MS = Number(
  process.env.MIGRATION_DOWNLOAD_TOKEN_TTL_MS,
) || 60 * 60 * 1000;

/** Сколько живёт state pull-операции в памяти после старта. */
const PULL_STATE_TTL_MS = Number(
  process.env.MIGRATION_PULL_STATE_TTL_MS,
) || 10 * 60 * 1000;

/**
 * Лимит файла, который тянем через import-pull. По умолчанию 20 ГБ —
 * переопределяется `MIGRATION_MAX_IMPORT_SIZE_BYTES`. Защищает от DoS
 * диска, когда админ (или скомпрометированный токен) направляет URL
 * на бесконечный стрим.
 */
const MIGRATION_MAX_IMPORT_SIZE_BYTES = Number(
  process.env.MIGRATION_MAX_IMPORT_SIZE_BYTES,
) || 20 * 1024 * 1024 * 1024;

/** Poll-шаг при ожидании backup/restore у агента. */
const AGENT_POLL_INTERVAL_MS = Number(
  process.env.MIGRATION_AGENT_POLL_INTERVAL_MS,
) || 5000;

const RESTORE_TIMEOUT_MS = Number(
  process.env.MIGRATION_RESTORE_TIMEOUT_MS,
) || 6 * 60 * 60 * 1000;

const MIN_MIGRATION_VERSION = 'v0.6.52';

@Injectable()
export class MigrationService {
  private readonly logger = new Logger('MigrationService');
  private readonly migrations = new Map<string, MigrationState>();
  private readonly downloadTokens = new Map<string, DownloadToken>();
  private readonly pullStates = new Map<string, PullState>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly proxy: ProxyService,
    private readonly agentRelay: AgentRelayService,
    private readonly siteDomains: SiteDomainsService,
    private readonly services: ServicesService,
    private readonly siteNode: SiteNodeService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // Migration orchestration (runs on main server)
  // ═══════════════════════════════════════════════════════════════════════════

  async getStatus(migrationId: string): Promise<MigrationState | undefined> {
    return this.migrations.get(migrationId);
  }

  async startMigration(params: MigrateParams, userId: string): Promise<string> {
    if (params.sourceServerId === params.targetServerId) {
      throw new BadRequestException('Исходный и целевой серверы совпадают');
    }
    if (params.stopSource) {
      throw new BadRequestException(
        'Авто-остановка исходного сайта временно отключена: нужен отдельный verify после миграции',
      );
    }

    if (params.sourceServerId === 'main' && !params.panelUrl) {
      throw new BadRequestException('panelUrl обязателен при миграции с основного сервера');
    }

    if (params.targetServerId !== 'main') {
      const target = this.proxy.getServer(params.targetServerId);
      if (!target) throw new BadRequestException('Целевой сервер не найден');
    }
    if (params.sourceServerId !== 'main') {
      const source = this.proxy.getServer(params.sourceServerId);
      if (!source) throw new BadRequestException('Исходный сервер не найден');
    }

    await this.assertServerVersions(params);

    const migrationId = randomUUID().slice(0, 12);

    const state: MigrationState = {
      id: migrationId,
      siteId: params.siteId,
      sourceServerId: params.sourceServerId,
      targetServerId: params.targetServerId,
      step: 'preflight',
      stepIndex: 0,
      totalSteps: STEPS.length,
      message: STEPS[0].label,
      startedAt: new Date().toISOString(),
    };

    this.migrations.set(migrationId, state);

    this.runMigration(migrationId, params, userId).catch((err) => {
      this.logger.error(`Migration ${migrationId} fatal error: ${(err as Error).message}`);
      this.updateState(migrationId, 'failed', (err as Error).message);
    });

    return migrationId;
  }

  private updateState(id: string, step: string, message?: string, extra?: Partial<MigrationState>) {
    const state = this.migrations.get(id);
    if (!state) return;

    const stepIdx = STEPS.findIndex(s => s.key === step);
    state.step = step;
    state.stepIndex = stepIdx >= 0 ? stepIdx : state.stepIndex;
    state.message = message || STEPS[stepIdx]?.label || step;
    if (extra) Object.assign(state, extra);

    if (step === 'done' || step === 'failed') {
      state.completedAt = new Date().toISOString();
      if (step === 'failed') state.error = message;
      setTimeout(() => this.migrations.delete(id), PULL_STATE_TTL_MS);
    }
  }

  private async runMigration(migrationId: string, params: MigrateParams, userId: string) {
    const { siteId, sourceServerId, targetServerId, reissueSsl, stopSource, panelUrl } = params;

    this.updateState(migrationId, 'preflight');
    const siteSnapshot = this.normalizeSnapshot(
      await this.getSiteSnapshotFromServer(sourceServerId, siteId),
    );
    this.assertSslPlan(siteSnapshot, reissueSsl);
    await this.assertTargetConflicts(targetServerId, siteSnapshot);

    // ══════════ Step 1: Trigger LOCAL backup on source ══════════
    this.updateState(migrationId, 'backup');

    let backupId: string;

    if (sourceServerId === 'main') {
      const result = await this.localPost('/backups/trigger', {
        siteId,
        type: 'FULL',
        storageType: 'LOCAL',
      }, userId);
      backupId = result?.backupId as string;
    } else {
      const server = this.proxy.getServer(sourceServerId)!;
      const { data } = await this.proxy.proxyRequest(server, 'POST', '/backups/trigger', {
        siteId,
        type: 'FULL',
        storageType: 'LOCAL',
      });
      backupId = (data as { data?: { backupId?: string } })?.data?.backupId || '';
    }

    if (!backupId) throw new Error('Не удалось запустить бэкап');

    // ══════════ Step 2: Wait for backup ══════════
    this.updateState(migrationId, 'waiting_backup');

    const backupResult = await this.pollBackupStatus(sourceServerId, siteId, backupId);
    if (!backupResult.success) {
      throw new Error(`Бэкап не удался: ${backupResult.error || 'неизвестная ошибка'}`);
    }

    const backupFilePath = backupResult.filePath;
    if (!backupFilePath) throw new Error('Бэкап завершён, но путь к файлу не получен');

    // ══════════ Step 3: Create download token on source ══════════
    this.updateState(migrationId, 'download_token');

    let downloadToken: string;
    let sourceBaseUrl: string;

    if (sourceServerId === 'main') {
      const tokenResult = this.createDownloadToken(backupFilePath);
      downloadToken = tokenResult.token;
      sourceBaseUrl = panelUrl!;
    } else {
      const server = this.proxy.getServer(sourceServerId)!;
      const { status, data } = await this.proxy.proxyRequest(server, 'POST', '/migration/download-token', {
        filePath: backupFilePath,
      });
      if (status >= 400) {
        throw new Error((data as { error?: { message?: string } })?.error?.message || 'Ошибка создания токена');
      }
      downloadToken = (data as { data?: { token?: string } })?.data?.token || '';
      sourceBaseUrl = server.url;
    }

    if (!downloadToken) throw new Error('Не удалось создать токен загрузки');
    const sourceDownloadUrl = `${sourceBaseUrl}/api/migration/download/${downloadToken}`;

    // ══════════ Step 4: Get site metadata ══════════
    this.updateState(migrationId, 'metadata');

    const siteMeta = siteSnapshot.site;

    // ══════════ Step 5: Create site on target (skipInstall) ══════════
    this.updateState(migrationId, 'create_site');

    // siteMeta может прийти из локальной БД (SQLite строки) или через proxy API (уже parsed).
    // Нормализуем чтобы sites.create получил нативные типы.
    const rawAliases = siteMeta.aliases;
    const aliases = Array.isArray(rawAliases)
      ? rawAliases
      : typeof rawAliases === 'string'
      ? (() => { try { const v = JSON.parse(rawAliases); return Array.isArray(v) ? v : []; } catch { return []; } })()
      : [];
    const rawEnv = siteMeta.envVars;
    const envVars =
      rawEnv && typeof rawEnv === 'object'
        ? rawEnv
        : typeof rawEnv === 'string'
        ? (() => { try { return JSON.parse(rawEnv); } catch { return {}; } })()
        : {};

    const createBody = {
      name: siteMeta.name,
      displayName: siteMeta.displayName || undefined,
      domain: siteMeta.domain,
      aliases,
      type: siteMeta.type,
      phpEnabled: !!siteMeta.phpVersion,
      phpVersion: siteMeta.phpVersion || undefined,
      dbEnabled: siteSnapshot.databases.length > 0 || siteMeta.dbEnabled === true,
      dbType: siteSnapshot.databases[0]?.type,
      dbName: siteSnapshot.databases[0]?.name,
      dbUser: siteSnapshot.databases[0]?.dbUser,
      dbPassword: siteSnapshot.databases[0]?.dbPassword,
      httpsRedirect: siteMeta.httpsRedirect !== false,
      gitRepository: siteMeta.gitRepository || undefined,
      deployBranch: siteMeta.deployBranch || undefined,
      appPort: siteMeta.appPort || undefined,
      envVars,
      filesRelPath: siteMeta.filesRelPath || undefined,
      modxVersion: siteMeta.modxVersion || undefined,
      cmsTablePrefix: siteMeta.cmsTablePrefix || undefined,
      managerPath: siteMeta.managerPath || undefined,
      connectorsPath: siteMeta.connectorsPath || undefined,
      skipInstall: true,
    };

    let targetSiteId: string;

    if (targetServerId === 'main') {
      const result = await this.localPost('/sites', createBody, userId);
      targetSiteId = result?.id as string;
    } else {
      const server = this.proxy.getServer(targetServerId)!;
      const { status, data } = await this.proxy.proxyRequest(server, 'POST', '/sites', createBody);
      if (status >= 400) {
        const errMsg = (data as { error?: { message?: string } })?.error?.message || 'Ошибка создания сайта';
        throw new Error(errMsg);
      }
      targetSiteId = ((data as { data?: { id?: string } })?.data?.id) || '';
    }

    if (!targetSiteId) throw new Error('Не удалось создать сайт на целевом сервере');
    this.updateState(migrationId, 'create_site', undefined, { targetSiteId });
    await this.waitTargetSiteProvisioned(targetServerId, targetSiteId);

    // ══════════ Step 6: Tell target to pull from source ══════════
    this.updateState(migrationId, 'import_pull');

    const databases = siteSnapshot.databases;
    let pullId: string;

    if (targetServerId === 'main') {
      const result = await this.startImportPull(targetSiteId, sourceDownloadUrl, databases);
      pullId = result.pullId;
    } else {
      const server = this.proxy.getServer(targetServerId)!;
      const { status, data } = await this.proxy.proxyRequest(server, 'POST', '/migration/import-pull', {
        siteId: targetSiteId,
        sourceUrl: sourceDownloadUrl,
        databases,
      });
      if (status >= 400) {
        const errMsg = (data as { error?: { message?: string } })?.error?.message || 'Ошибка передачи';
        throw new Error(errMsg);
      }
      pullId = (data as { data?: { pullId?: string } })?.data?.pullId || '';
    }

    if (!pullId) throw new Error('Не удалось запустить передачу');

    // ══════════ Step 7: Wait for pull (download + restore) ══════════
    this.updateState(migrationId, 'waiting_pull');

    const pullResult = await this.pollPullStatus(targetServerId, pullId);
    if (!pullResult.success) {
      throw new Error(`Передача не удалась: ${pullResult.error || 'неизвестная ошибка'}`);
    }

    // ══════════ Step 8: Copy DB-only extras that are not inside archive ══════════
    this.updateState(migrationId, 'apply_config');
    if (targetServerId === 'main') {
      await this.applySiteExtras(targetSiteId, siteSnapshot);
    } else {
      const server = this.proxy.getServer(targetServerId)!;
      const { status, data } = await this.proxy.proxyRequest(server, 'POST', '/migration/apply-site-extras', {
        siteId: targetSiteId,
        snapshot: siteSnapshot,
      });
      if (status >= 400) {
        const errMsg = (data as { error?: { message?: string } })?.error?.message || 'Ошибка переноса настроек сайта';
        throw new Error(errMsg);
      }
    }

    // ══════════ Step 8: Optional SSL ══════════
    if (reissueSsl) {
      this.updateState(migrationId, 'ssl');
      try {
        if (targetServerId === 'main') {
          await this.localPost(`/sites/${targetSiteId}/ssl/issue`, {}, userId);
        } else {
          const server = this.proxy.getServer(targetServerId)!;
          await this.proxy.proxyRequest(server, 'POST', `/sites/${targetSiteId}/ssl/issue`, {});
        }
      } catch (err) {
        this.logger.warn(`SSL reissue failed during migration: ${(err as Error).message}`);
      }
    }

    // ══════════ Step 9: Optional stop source ══════════
    if (stopSource) {
      this.updateState(migrationId, 'cleanup');
      try {
        if (sourceServerId === 'main') {
          await this.localPost(`/sites/${siteId}/stop`, {}, userId);
        } else {
          const server = this.proxy.getServer(sourceServerId)!;
          await this.proxy.proxyRequest(server, 'POST', `/sites/${siteId}/stop`, {});
        }
      } catch (err) {
        this.logger.warn(`Source site stop failed: ${(err as Error).message}`);
      }
    }

    // ══════════ Done ══════════
    this.updateState(migrationId, 'done', 'Миграция завершена успешно', { targetSiteId });
    this.logger.log(`Migration ${migrationId} completed: site ${siteId} → ${targetSiteId}`);
  }

  async getSiteSnapshot(siteId: string): Promise<SiteSnapshot> {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      include: {
        domains: {
          orderBy: { position: 'asc' },
          select: {
            domain: true,
            isPrimary: true,
            position: true,
            aliases: true,
            filesRelPath: true,
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
          },
        },
        databases: true,
        backupConfigs: {
          include: {
            storageLocations: {
              select: { id: true, name: true },
            },
          },
        },
        services: {
          select: { serviceKey: true, status: true, config: true },
        },
        dnsZones: {
          select: { domain: true, status: true },
        },
        sslCertificates: {
          select: { domains: true, status: true, issuer: true, isWildcard: true },
        },
        cronJobs: {
          select: { name: true, schedule: true, command: true, status: true },
        },
        quickCommands: {
          select: {
            label: true,
            source: true,
            target: true,
            cwd: true,
            sortOrder: true,
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    if (!site) throw new NotFoundException('Сайт не найден');

    const {
      sshPasswordEnc: _ssh,
      cmsAdminPasswordEnc: _cms,
      domains,
      databases,
      backupConfigs,
      services,
      dnsZones,
      sslCertificates,
      cronJobs,
      quickCommands,
      ...safeSite
    } = site;
    void _ssh; void _cms;

    return {
      site: safeSite as unknown as Record<string, unknown>,
      domains,
      databases: databases.map((db) => ({
        name: db.name,
        type: db.type,
        dbUser: db.dbUser,
        dbPassword: this.decryptDbPassword(db),
      })),
      backupConfigs: backupConfigs.map((config) => {
        const locationById = new Map(
          config.storageLocations.map((location) => [location.id, location.name]),
        );
        return {
          type: config.type,
          engine: config.engine,
          storageLocationNames: parseStringArray(config.storageLocationIds)
            .map((id) => locationById.get(id))
            .filter((name): name is string => !!name),
          storageType: config.storageType,
          storageConfig: config.storageConfig,
          schedule: config.schedule,
          retention: config.retention,
          keepDaily: config.keepDaily,
          keepWeekly: config.keepWeekly,
          keepMonthly: config.keepMonthly,
          keepYearly: config.keepYearly,
          excludePaths: config.excludePaths,
          excludeTableData: config.excludeTableData,
          keepLocalCopy: config.keepLocalCopy,
          enabled: config.enabled,
        };
      }),
      services,
      dnsZones,
      sslCertificates,
      node: await this.getNodeRuntimeSnapshot(site.id, safeSite.filesRelPath),
      cronJobs,
      quickCommands,
    };
  }

  private decryptDbPassword(db: { dbPasswordEnc: string | null; name: string }): string {
    if (!db.dbPasswordEnc) {
      throw new BadRequestException(
        `У базы "${db.name}" нет зашифрованного пароля. Сначала сделай reset password у БД.`,
      );
    }
    const value = decryptJson<{ password?: string }>(db.dbPasswordEnc);
    if (!value?.password) {
      throw new BadRequestException(`Не удалось расшифровать пароль БД "${db.name}"`);
    }
    return value.password;
  }

  private async getNodeRuntimeSnapshot(
    siteId: string,
    filesRelPath: string,
  ): Promise<NodeRuntimeSnapshot> {
    const snapshot: NodeRuntimeSnapshot = {
      autostartEnabled: false,
      ecosystems: [],
      processesToStop: [],
      orphanProcesses: [],
    };

    let processes: NodeProcessesResult;
    try {
      processes = await this.siteNode.getProcesses(siteId);
      snapshot.autostartEnabled = processes.autostartEnabled === true;
    } catch (err) {
      throw new BadRequestException(
        `Не удалось прочитать Node/PM2 runtime сайта: ${(err as Error).message}`,
      );
    }

    const loadedByFile = new Map<string, Array<{ name: string; status: string | null }>>();
    const definedCountByFile = new Map<string, number>();

    for (const group of processes.groups || []) {
      if (!group.ecosystemFile) {
        for (const proc of group.processes || []) {
          if (proc.loaded && proc.name) snapshot.orphanProcesses.push(proc.name);
        }
        continue;
      }

      const file = buildTargetEcosystemPath(filesRelPath, group.dir, group.ecosystemFile);
      if (!file) continue;

      const defined = (group.processes || []).filter((proc) => proc.defined && proc.name);
      const loaded = (group.processes || [])
        .filter((proc) => proc.loaded && proc.name)
        .map((proc) => ({ name: proc.name, status: proc.runtime?.status || null }));

      definedCountByFile.set(file, defined.length);
      if (loaded.length > 0) loadedByFile.set(file, loaded);
    }

    for (const [file, loaded] of loadedByFile.entries()) {
      const definedCount = definedCountByFile.get(file) || 0;
      if (definedCount > 0 && loaded.length === definedCount) {
        snapshot.ecosystems.push({ file });
      } else {
        for (const proc of loaded) snapshot.ecosystems.push({ file, only: proc.name });
      }

      for (const proc of loaded) {
        if (proc.status === 'stopped') snapshot.processesToStop.push(proc.name);
      }
    }

    return snapshot;
  }

  private async getSiteSnapshotFromServer(serverId: string, siteId: string): Promise<SiteSnapshot> {
    if (serverId === 'main') return this.getSiteSnapshot(siteId);

    const server = this.proxy.getServer(serverId);
    if (!server) throw new Error('Исходный сервер не найден');
    const { status, data } = await this.proxy.proxyRequest(server, 'GET', `/migration/site-snapshot/${siteId}`);
    if (status >= 400) {
      throw new Error((data as { error?: { message?: string } })?.error?.message || 'Ошибка получения snapshot сайта');
    }
    return (data as { data?: SiteSnapshot })?.data as SiteSnapshot;
  }

  private normalizeSnapshot(input: SiteSnapshot): SiteSnapshot {
    const raw = (input || {}) as unknown as Record<string, unknown>;
    const site = isObjectRecord(raw.site) ? raw.site : {};

    const domains = Array.isArray(raw.domains)
      ? raw.domains
          .filter(isObjectRecord)
          .map((d, idx) => ({
            domain: String(d.domain || '').trim().toLowerCase(),
            isPrimary: d.isPrimary === true,
            position: numberValue(d.position, idx),
            aliases: typeof d.aliases === 'string' ? d.aliases : '[]',
            filesRelPath: nullableString(d.filesRelPath),
            appPort: nullableNumber(d.appPort),
            httpsRedirect: boolValue(d.httpsRedirect, true),
            nginxClientMaxBodySize: nullableString(d.nginxClientMaxBodySize),
            nginxFastcgiReadTimeout: nullableNumber(d.nginxFastcgiReadTimeout),
            nginxFastcgiSendTimeout: nullableNumber(d.nginxFastcgiSendTimeout),
            nginxFastcgiConnectTimeout: nullableNumber(d.nginxFastcgiConnectTimeout),
            nginxFastcgiBufferSizeKb: nullableNumber(d.nginxFastcgiBufferSizeKb),
            nginxFastcgiBufferCount: nullableNumber(d.nginxFastcgiBufferCount),
            nginxHttp2: boolValue(d.nginxHttp2, true),
            nginxHsts: boolValue(d.nginxHsts, false),
            nginxGzip: boolValue(d.nginxGzip, true),
            nginxRateLimitEnabled: boolValue(d.nginxRateLimitEnabled, true),
            nginxRateLimitRps: nullableNumber(d.nginxRateLimitRps),
            nginxRateLimitBurst: nullableNumber(d.nginxRateLimitBurst),
            nginxCustomConfig: nullableString(d.nginxCustomConfig),
          }))
          .filter((d) => d.domain)
      : [];

    const databases = Array.isArray(raw.databases)
      ? raw.databases
          .filter(isObjectRecord)
          .map((db) => ({
            name: String(db.name || ''),
            type: String(db.type || ''),
            dbUser: String(db.dbUser || ''),
            dbPassword: String(db.dbPassword || ''),
          }))
          .filter((db) => db.name && db.type)
      : [];

    const backupConfigs = Array.isArray(raw.backupConfigs)
      ? raw.backupConfigs
          .filter(isObjectRecord)
          .map((config) => ({
            type: String(config.type || ''),
            engine: String(config.engine || 'TAR'),
            storageLocationNames: stringArrayValue(config.storageLocationNames),
            storageType: nullableString(config.storageType),
            storageConfig: nullableString(config.storageConfig),
            schedule: nullableString(config.schedule),
            retention: numberValue(config.retention, 7),
            keepDaily: numberValue(config.keepDaily, 7),
            keepWeekly: numberValue(config.keepWeekly, 4),
            keepMonthly: numberValue(config.keepMonthly, 6),
            keepYearly: numberValue(config.keepYearly, 1),
            excludePaths: stringJsonArrayValue(config.excludePaths),
            excludeTableData: stringJsonArrayValue(config.excludeTableData),
            keepLocalCopy: boolValue(config.keepLocalCopy, false),
            enabled: boolValue(config.enabled, true),
          }))
          .filter((config) => config.type)
      : [];

    const services = Array.isArray(raw.services)
      ? raw.services
          .filter(isObjectRecord)
          .map((service) => ({
            serviceKey: String(service.serviceKey || ''),
            status: String(service.status || 'STOPPED'),
            config: jsonObjectStringValue(service.config),
          }))
          .filter((service) => service.serviceKey)
      : [];

    const dnsZones = Array.isArray(raw.dnsZones)
      ? raw.dnsZones
          .filter(isObjectRecord)
          .map((zone) => ({
            domain: String(zone.domain || '').trim().toLowerCase(),
            status: String(zone.status || ''),
          }))
          .filter((zone) => zone.domain)
      : [];

    const sslCertificates = Array.isArray(raw.sslCertificates)
      ? raw.sslCertificates
          .filter(isObjectRecord)
          .map((cert) => ({
            domains: stringJsonArrayValue(cert.domains),
            status: String(cert.status || SslStatus.NONE),
            issuer: String(cert.issuer || ''),
            isWildcard: boolValue(cert.isWildcard, false),
          }))
          .filter((cert) => cert.status !== SslStatus.NONE)
      : [];

    const nodeRaw = isObjectRecord(raw.node) ? raw.node : {};
    const node: NodeRuntimeSnapshot = {
      autostartEnabled: boolValue(nodeRaw.autostartEnabled, false),
      ecosystems: Array.isArray(nodeRaw.ecosystems)
        ? nodeRaw.ecosystems
            .filter(isObjectRecord)
            .map((eco) => ({
              file: String(eco.file || ''),
              only: typeof eco.only === 'string' && eco.only ? eco.only : undefined,
            }))
            .filter((eco) => eco.file)
        : [],
      processesToStop: stringArrayValue(nodeRaw.processesToStop),
      orphanProcesses: stringArrayValue(nodeRaw.orphanProcesses),
    };

    const cronJobs = Array.isArray(raw.cronJobs)
      ? raw.cronJobs
          .filter(isObjectRecord)
          .map((cron) => ({
            name: String(cron.name || ''),
            schedule: String(cron.schedule || ''),
            command: String(cron.command || ''),
            status: String(cron.status || CronJobStatus.ACTIVE),
          }))
          .filter((cron) => cron.name && cron.schedule && cron.command)
      : [];

    const quickCommands = Array.isArray(raw.quickCommands)
      ? raw.quickCommands
          .filter(isObjectRecord)
          .map((cmd, idx) => ({
            label: String(cmd.label || ''),
            source: String(cmd.source || 'npm'),
            target: String(cmd.target || ''),
            cwd: String(cmd.cwd || ''),
            sortOrder: numberValue(cmd.sortOrder, idx),
          }))
          .filter((cmd) => cmd.label && cmd.target && cmd.cwd)
      : [];

    return {
      site,
      domains,
      databases,
      backupConfigs,
      services,
      dnsZones,
      sslCertificates,
      node,
      cronJobs,
      quickCommands,
    };
  }

  private snapshotDomainNames(snapshot: SiteSnapshot): string[] {
    const names = new Set<string>();
    const primaryDomain = String(snapshot.site.domain || '').trim().toLowerCase();
    if (primaryDomain) names.add(primaryDomain);
    for (const domain of snapshot.domains) {
      if (domain.domain) names.add(domain.domain);
      for (const alias of parseSiteAliases(domain.aliases)) {
        names.add(alias.domain.trim().toLowerCase());
      }
    }
    return [...names].filter(Boolean);
  }

  async preflightTarget(snapshot: SiteSnapshot): Promise<{ ok: true }> {
    await this.assertLocalTargetConflicts(this.normalizeSnapshot(snapshot));
    return { ok: true };
  }

  private assertSslPlan(snapshot: SiteSnapshot, reissueSsl: boolean): void {
    const activeCerts = snapshot.sslCertificates.filter((cert) =>
      cert.status === SslStatus.ACTIVE || cert.status === SslStatus.EXPIRING_SOON,
    );
    if (activeCerts.length > 0 && !reissueSsl) {
      throw new BadRequestException(
        'У исходного сайта активен SSL. Приватные ключи не копируются; включи перевыпуск SSL на целевом сервере.',
      );
    }
  }

  private async assertTargetConflicts(targetServerId: string, snapshot: SiteSnapshot): Promise<void> {
    if (targetServerId === 'main') {
      await this.assertLocalTargetConflicts(snapshot);
      return;
    }

    const server = this.proxy.getServer(targetServerId);
    if (!server) throw new Error('Целевой сервер не найден');
    const { status, data } = await this.proxy.proxyRequest(server, 'POST', '/migration/target-preflight', {
      snapshot,
    });
    if (status >= 400) {
      const errMsg = (data as { error?: { message?: string } })?.error?.message || 'Ошибка preflight целевого сервера';
      throw new BadRequestException(errMsg);
    }
  }

  private async assertLocalTargetConflicts(snapshot: SiteSnapshot): Promise<void> {
    const siteName = String(snapshot.site.name || '');
    const domainNames = this.snapshotDomainNames(snapshot);
    const errors: string[] = [];

    const siteByName = await this.prisma.site.findUnique({
      where: { name: siteName },
      select: { name: true },
    });
    if (siteByName) errors.push(`на целевом сервере уже есть сайт с именем "${siteName}"`);

    for (const domain of domainNames) {
      const [siteByDomain, siteDomain] = await Promise.all([
        this.prisma.site.findFirst({ where: { domain }, select: { name: true } }),
        this.prisma.siteDomain.findFirst({ where: { domain }, select: { domain: true } }),
      ]);
      if (siteByDomain) errors.push(`на целевом сервере уже занят домен "${domain}"`);
      if (siteDomain) errors.push(`на целевом сервере уже есть основной домен "${domain}"`);
    }

    for (const db of snapshot.databases) {
      const existing = await this.prisma.database.findFirst({
        where: { name: db.name, type: db.type },
        select: { name: true, type: true },
      });
      if (existing) {
        errors.push(`на целевом сервере уже есть БД "${db.name}" (${db.type})`);
      }
    }

    const storageNames = uniqueStrings(
      snapshot.backupConfigs.flatMap((config) => config.storageLocationNames),
    );
    if (storageNames.length > 0) {
      const existingStorages = await this.prisma.storageLocation.findMany({
        where: { name: { in: storageNames } },
        select: { name: true },
      });
      const existingNames = new Set(existingStorages.map((storage) => storage.name));
      for (const name of storageNames) {
        if (!existingNames.has(name)) {
          errors.push(`на целевом сервере нет backup-хранилища "${name}"`);
        }
      }
    }

    const serviceKeys = uniqueStrings(snapshot.services.map((service) => service.serviceKey));
    if (serviceKeys.length > 0) {
      for (const key of serviceKeys) {
        const service = await this.services.getServerService(key).catch(() => null);
        if (!service?.installed) {
          errors.push(`на целевом сервере не установлен сервис "${key}"`);
        }
      }
    }

    if (snapshot.dnsZones.length > 0) {
      errors.push(
        `у сайта есть привязанные DNS-зоны (${snapshot.dnsZones.map((z) => z.domain).join(', ')}); DNS-провайдеры не переносятся автоматически`,
      );
    }

    if (snapshot.node.orphanProcesses.length > 0) {
      errors.push(
        `у сайта есть PM2-процессы без ecosystem-файла (${snapshot.node.orphanProcesses.join(', ')}); опиши их в ecosystem.config.js перед миграцией`,
      );
    }

    if (errors.length > 0) {
      throw new BadRequestException(`Preflight failed: ${errors.join('; ')}`);
    }
  }

  async applySiteExtras(siteId: string, snapshot: SiteSnapshot): Promise<{
    cronJobs: number;
    quickCommands: number;
    backupConfigs: number;
    services: number;
    nodeApps: number;
  }> {
    snapshot = this.normalizeSnapshot(snapshot);

    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { id: true, name: true, systemUser: true, userId: true },
    });
    if (!site) throw new BadRequestException('Целевой сайт не найден');
    const systemUser = site.systemUser || site.name;

    await this.prisma.site.update({
      where: { id: siteId },
      data: this.buildSiteConfigUpdate(snapshot.site),
    });
    await this.applySiteDomains(siteId, site.userId, snapshot.domains);
    const backupConfigs = await this.applyBackupConfigs(siteId, snapshot.backupConfigs);
    const services = await this.applySiteServices(siteId, snapshot.services);

    await this.prisma.$transaction([
      this.prisma.siteQuickCommand.deleteMany({ where: { siteId } }),
      ...(snapshot.quickCommands.length > 0
        ? [
            this.prisma.siteQuickCommand.createMany({
              data: snapshot.quickCommands.map((cmd, idx) => ({
                siteId,
                label: String(cmd.label).slice(0, 60),
                source: cmd.source === 'make' ? 'make' : 'npm',
                target: String(cmd.target).slice(0, 100),
                cwd: String(cmd.cwd).slice(0, 512),
                sortOrder: typeof cmd.sortOrder === 'number' ? cmd.sortOrder : idx,
              })),
            }),
          ]
        : []),
    ]);

    await this.prisma.cronJob.deleteMany({ where: { siteId } });
    let cronCount = 0;
    for (const cron of snapshot.cronJobs) {
      const status = cron.status === CronJobStatus.DISABLED
        ? CronJobStatus.DISABLED
        : CronJobStatus.ACTIVE;
      const created = await this.prisma.cronJob.create({
        data: {
          siteId,
          name: cron.name,
          schedule: cron.schedule,
          command: cron.command,
          status,
        },
      });

      const result = await this.agentRelay.emitToAgent('cron:add', {
        id: created.id,
        schedule: cron.schedule,
        command: cron.command,
        enabled: status === CronJobStatus.ACTIVE,
        user: systemUser,
      });
      if (!result.success) {
        await this.prisma.cronJob.delete({ where: { id: created.id } }).catch(() => {});
        throw new Error(`Cron "${cron.name}" не применён: ${result.error || 'unknown error'}`);
      }
      cronCount += 1;
    }

    const nodeApps = await this.applyNodeRuntime(siteId, snapshot.node);

    return {
      cronJobs: cronCount,
      quickCommands: snapshot.quickCommands.length,
      backupConfigs,
      services,
      nodeApps,
    };
  }

  private async applyBackupConfigs(
    siteId: string,
    configs: BackupConfigSnapshot[],
  ): Promise<number> {
    await this.prisma.backupConfig.deleteMany({ where: { siteId } });
    let count = 0;

    for (const config of configs) {
      const storageLocationIds: string[] = [];
      if (config.storageLocationNames.length > 0) {
        const locations = await this.prisma.storageLocation.findMany({
          where: { name: { in: config.storageLocationNames } },
          select: { id: true, name: true },
        });
        const byName = new Map(locations.map((location) => [location.name, location.id]));
        for (const name of config.storageLocationNames) {
          const id = byName.get(name);
          if (!id) throw new Error(`Backup-хранилище "${name}" не найдено на target`);
          storageLocationIds.push(id);
        }
      }

      await this.prisma.backupConfig.create({
        data: {
          siteId,
          type: config.type,
          engine: config.engine,
          storageLocationIds: stringifyStringArray(storageLocationIds),
          storageType: config.storageType,
          storageConfig: config.storageConfig,
          schedule: config.schedule,
          retention: config.retention,
          keepDaily: config.keepDaily,
          keepWeekly: config.keepWeekly,
          keepMonthly: config.keepMonthly,
          keepYearly: config.keepYearly,
          excludePaths: config.excludePaths,
          excludeTableData: config.excludeTableData,
          keepLocalCopy: config.keepLocalCopy,
          enabled: config.enabled,
          ...(storageLocationIds.length > 0
            ? { storageLocations: { connect: storageLocationIds.map((id) => ({ id })) } }
            : {}),
        },
      });
      count += 1;
    }

    return count;
  }

  private async applySiteServices(
    siteId: string,
    services: SiteServiceSnapshot[],
  ): Promise<number> {
    let count = 0;
    for (const service of services) {
      const config = parseJsonObjectString(service.config);
      const existing = await this.prisma.siteService.findUnique({
        where: { siteId_serviceKey: { siteId, serviceKey: service.serviceKey } },
        select: { id: true },
      });

      if (!existing) {
        await this.services.enableSiteService(siteId, service.serviceKey, config);
      } else {
        await this.services.reconfigureSiteService(siteId, service.serviceKey, config);
      }

      if (service.status === 'STOPPED') {
        await this.services.stopSiteService(siteId, service.serviceKey);
      } else if (service.status === 'RUNNING' || service.status === 'STARTING') {
        await this.services.startSiteService(siteId, service.serviceKey);
      }
      count += 1;
    }
    return count;
  }

  private async applyNodeRuntime(
    siteId: string,
    node: NodeRuntimeSnapshot,
  ): Promise<number> {
    let count = 0;
    for (const ecosystem of node.ecosystems) {
      await this.siteNode.startEcosystem(siteId, ecosystem.file, ecosystem.only);
      count += 1;
    }
    for (const name of node.processesToStop) {
      await this.siteNode.controlProcess(siteId, 'stop', name);
    }
    if (node.autostartEnabled) {
      await this.siteNode.setAutostart(siteId, true);
    }
    return count;
  }

  private async applySiteDomains(
    siteId: string,
    userId: string,
    sourceDomains: SiteDomainSnapshot[],
  ): Promise<void> {
    if (sourceDomains.length === 0) {
      await this.siteDomains.regenerateGlobalZones();
      await this.siteDomains.regenerateNginx(siteId);
      return;
    }

    const ordered = [...sourceDomains].sort((a, b) => a.position - b.position);
    const primarySource = ordered.find((d) => d.isPrimary) || ordered[0];

    for (const sourceDomain of ordered) {
      let targetDomain = await this.findTargetDomain(siteId, sourceDomain, primarySource);

      if (!targetDomain) {
        await this.siteDomains.createDomain(
          siteId,
          { domain: sourceDomain.domain },
          userId,
          UserRole.ADMIN,
        );
        targetDomain = await this.prisma.siteDomain.findFirst({
          where: { siteId, domain: sourceDomain.domain },
          select: { id: true, domain: true, isPrimary: true },
        });
      }
      if (!targetDomain) {
        throw new Error(`Не удалось создать домен "${sourceDomain.domain}"`);
      }

      await this.siteDomains.updateDomain(
        siteId,
        targetDomain.id,
        {
          domain: sourceDomain.domain,
          filesRelPath: sourceDomain.filesRelPath,
          appPort: sourceDomain.appPort,
          httpsRedirect: sourceDomain.httpsRedirect,
        },
        userId,
        UserRole.ADMIN,
      );

      const refreshed = await this.prisma.siteDomain.findFirst({
        where: { siteId, domain: sourceDomain.domain },
        select: { id: true },
      });
      if (!refreshed) throw new Error(`Домен "${sourceDomain.domain}" не найден после update`);

      await this.siteDomains.updateAliases(
        siteId,
        refreshed.id,
        { aliases: parseSiteAliases(sourceDomain.aliases) },
        userId,
        UserRole.ADMIN,
      );

      await this.prisma.siteDomain.update({
        where: { id: refreshed.id },
        data: this.buildDomainConfigUpdate(sourceDomain),
      });
    }

    await this.siteDomains.syncPrimaryMirror(siteId);
    await this.siteDomains.regenerateGlobalZones();
    await this.siteDomains.regenerateNginx(siteId);
  }

  private async findTargetDomain(
    siteId: string,
    sourceDomain: SiteDomainSnapshot,
    primarySource: SiteDomainSnapshot,
  ): Promise<{ id: string; domain: string; isPrimary: boolean } | null> {
    if (sourceDomain.isPrimary || sourceDomain.domain === primarySource.domain) {
      return this.prisma.siteDomain.findFirst({
        where: { siteId, isPrimary: true },
        select: { id: true, domain: true, isPrimary: true },
      });
    }
    return this.prisma.siteDomain.findFirst({
      where: { siteId, domain: sourceDomain.domain },
      select: { id: true, domain: true, isPrimary: true },
    });
  }

  private buildSiteConfigUpdate(site: Record<string, unknown>): Prisma.SiteUpdateInput {
    const data: Prisma.SiteUpdateInput = {};

    if ('phpPoolCustom' in site) data.phpPoolCustom = nullableString(site.phpPoolCustom);
    if ('nginxClientMaxBodySize' in site) data.nginxClientMaxBodySize = nullableString(site.nginxClientMaxBodySize);
    if ('nginxFastcgiReadTimeout' in site) data.nginxFastcgiReadTimeout = nullableNumber(site.nginxFastcgiReadTimeout);
    if ('nginxFastcgiSendTimeout' in site) data.nginxFastcgiSendTimeout = nullableNumber(site.nginxFastcgiSendTimeout);
    if ('nginxFastcgiConnectTimeout' in site) data.nginxFastcgiConnectTimeout = nullableNumber(site.nginxFastcgiConnectTimeout);
    if ('nginxFastcgiBufferSizeKb' in site) data.nginxFastcgiBufferSizeKb = nullableNumber(site.nginxFastcgiBufferSizeKb);
    if ('nginxFastcgiBufferCount' in site) data.nginxFastcgiBufferCount = nullableNumber(site.nginxFastcgiBufferCount);
    if ('nginxHttp2' in site) data.nginxHttp2 = boolValue(site.nginxHttp2, true);
    if ('nginxHsts' in site) data.nginxHsts = boolValue(site.nginxHsts, false);
    if ('nginxGzip' in site) data.nginxGzip = boolValue(site.nginxGzip, true);
    if ('nginxRateLimitEnabled' in site) data.nginxRateLimitEnabled = boolValue(site.nginxRateLimitEnabled, true);
    if ('nginxRateLimitRps' in site) data.nginxRateLimitRps = nullableNumber(site.nginxRateLimitRps);
    if ('nginxRateLimitBurst' in site) data.nginxRateLimitBurst = nullableNumber(site.nginxRateLimitBurst);
    if ('nginxCustomConfig' in site) data.nginxCustomConfig = nullableString(site.nginxCustomConfig);
    if ('backupExcludes' in site) data.backupExcludes = nullableString(site.backupExcludes);
    if ('backupExcludeTables' in site) data.backupExcludeTables = nullableString(site.backupExcludeTables);

    return data;
  }

  private buildDomainConfigUpdate(domain: SiteDomainSnapshot): Prisma.SiteDomainUpdateInput {
    return {
      position: domain.position,
      nginxClientMaxBodySize: domain.nginxClientMaxBodySize,
      nginxFastcgiReadTimeout: domain.nginxFastcgiReadTimeout,
      nginxFastcgiSendTimeout: domain.nginxFastcgiSendTimeout,
      nginxFastcgiConnectTimeout: domain.nginxFastcgiConnectTimeout,
      nginxFastcgiBufferSizeKb: domain.nginxFastcgiBufferSizeKb,
      nginxFastcgiBufferCount: domain.nginxFastcgiBufferCount,
      nginxHttp2: domain.nginxHttp2,
      nginxHsts: domain.nginxHsts,
      nginxGzip: domain.nginxGzip,
      nginxRateLimitEnabled: domain.nginxRateLimitEnabled,
      nginxRateLimitRps: domain.nginxRateLimitRps,
      nginxRateLimitBurst: domain.nginxRateLimitBurst,
      nginxCustomConfig: domain.nginxCustomConfig,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Download token management (runs on SOURCE server)
  // ═══════════════════════════════════════════════════════════════════════════

  createDownloadToken(filePath: string): { token: string; fileSize: number; expiresAt: string } {
    // assertSafeFilePath: resolve + lstat + symlink-block + extension check.
    // Без этого `/var/meowbox/backups/../../etc/shadow` + symlink внутри
    // BACKUP_DIR давали произвольное чтение файлов по публичному токену.
    const resolved = assertSafeFilePath(filePath, [BACKUP_DIR], {
      mustExist: true,
      extensions: ['gz', 'tar', 'zip', 'bz2', 'xz'],
      forbidSymlinks: true,
    });
    if (!fs.existsSync(resolved)) {
      throw new NotFoundException('Файл бэкапа не найден');
    }

    const stat = fs.statSync(resolved);
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + DOWNLOAD_TOKEN_TTL_MS);

    this.downloadTokens.set(token, {
      filePath: resolved,
      fileSize: stat.size,
      expiresAt,
      used: false,
    });

    // Auto-cleanup
    setTimeout(() => this.downloadTokens.delete(token), DOWNLOAD_TOKEN_TTL_MS);

    return { token, fileSize: stat.size, expiresAt: expiresAt.toISOString() };
  }

  consumeDownloadToken(token: string): DownloadToken | null {
    const data = this.downloadTokens.get(token);
    if (!data) return null;
    if (data.used) return null;
    if (new Date() > data.expiresAt) {
      this.downloadTokens.delete(token);
      return null;
    }
    data.used = true;
    return data;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Import-pull: download file from source + trigger restore (runs on TARGET)
  // ═══════════════════════════════════════════════════════════════════════════

  getPullStatus(pullId: string): PullState | undefined {
    return this.pullStates.get(pullId);
  }

  async startImportPull(
    siteId: string,
    sourceUrl: string,
    databases: DatabaseSnapshot[],
  ): Promise<{ pullId: string; backupId: string }> {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { id: true, name: true, rootPath: true },
    });
    if (!site) throw new BadRequestException('Целевой сайт не найден');

    // Create backup record (will be updated after download)
    const backup = await this.prisma.backup.create({
      data: {
        siteId,
        type: 'FULL',
        status: BackupStatus.PENDING,
        storageType: BackupStorageType.LOCAL,
        filePath: '',
        sizeBytes: BigInt(0),
      },
    });

    const pullId = randomUUID().slice(0, 12);
    const pullState: PullState = {
      pullId,
      siteId,
      backupId: backup.id,
      phase: 'downloading',
      downloadProgress: 0,
      restoreProgress: 0,
    };
    this.pullStates.set(pullId, pullState);

    // Run async — download file, then trigger restore
    this.downloadAndRestore(pullState, site, sourceUrl, databases).catch((err) => {
      this.logger.error(`Import-pull ${pullId} failed: ${(err as Error).message}`);
      pullState.phase = 'failed';
      pullState.error = (err as Error).message;
      // Update backup record to FAILED
      this.prisma.backup.update({
        where: { id: backup.id },
        data: { status: BackupStatus.FAILED, errorMessage: (err as Error).message, completedAt: new Date() },
      }).catch(() => {});
    });

    // Cleanup pull state after TTL
    setTimeout(() => this.pullStates.delete(pullId), PULL_STATE_TTL_MS);

    return { pullId, backupId: backup.id };
  }

  private async downloadAndRestore(
    pullState: PullState,
    site: { id: string; name: string; rootPath: string },
    sourceUrl: string,
    databases: DatabaseSnapshot[],
  ) {
    const localPath = path.join(BACKUP_DIR, `migration_${pullState.pullId}.tar.gz`);

    // ── Phase 1: Download ──
    pullState.phase = 'downloading';

    // Ensure backup dir exists
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    // SSRF guard: запрещаем приватные/loopback/link-local адреса.
    // Без этого attacker c ADMIN-правами мог направить import-pull на
    // http://127.0.0.1:... или AWS IMDS и выкачать ответ на диск.
    const safeUrl = await assertPublicHttpUrl(sourceUrl);

    const response = await fetch(safeUrl.toString());

    if (!response.ok) {
      throw new Error(`Ошибка скачивания: HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new Error('Пустой ответ от источника');
    }

    const totalBytes = parseInt(response.headers.get('content-length') || '0', 10);
    if (totalBytes > MIGRATION_MAX_IMPORT_SIZE_BYTES) {
      throw new Error(
        `Источник сообщает размер ${totalBytes}B, больше лимита ${MIGRATION_MAX_IMPORT_SIZE_BYTES}B`,
      );
    }
    const writeStream = fs.createWriteStream(localPath);
    let receivedBytes = 0;

    // Stream with progress tracking + runtime size cap (защита, когда источник
    // не отдаёт Content-Length или соврал).
    const readable = Readable.fromWeb(response.body as import('stream/web').ReadableStream);
    const progressTracker = new (await import('stream')).Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > MIGRATION_MAX_IMPORT_SIZE_BYTES) {
          callback(
            new Error(
              `Скачивание превысило лимит ${MIGRATION_MAX_IMPORT_SIZE_BYTES}B`,
            ),
          );
          return;
        }
        if (totalBytes > 0) {
          pullState.downloadProgress = Math.round((receivedBytes / totalBytes) * 100);
        }
        callback(null, chunk);
      },
    });

    await pipeline(readable, progressTracker, writeStream);
    pullState.downloadProgress = 100;

    // Update backup record
    const stat = fs.statSync(localPath);
    await this.prisma.backup.update({
      where: { id: pullState.backupId },
      data: {
        status: BackupStatus.COMPLETED,
        storageType: BackupStorageType.LOCAL,
        filePath: localPath,
        sizeBytes: BigInt(stat.size),
        completedAt: new Date(),
      },
    });

    // ── Phase 2: Restore ──
    pullState.phase = 'restoring';

    await this.ensureTargetDatabases(site.id, databases);

    const restoreResult = await this.agentRelay.emitToAgent<{ success: boolean; error?: string }>('backup:restore', {
      backupId: pullState.backupId,
      siteId: site.id,
      siteName: site.name,
      rootPath: site.rootPath,
      filePath: localPath,
      storageType: 'LOCAL',
      storageConfig: {},
      databases,
    }, RESTORE_TIMEOUT_MS);

    if (!restoreResult.success || restoreResult.data?.success === false) {
      throw new Error(restoreResult.error || restoreResult.data?.error || 'Restore failed');
    }

    // Cleanup downloaded file
    try { fs.unlinkSync(localPath); } catch { /* ignore */ }

    pullState.phase = 'completed';
    pullState.restoreProgress = 100;
  }

  private async ensureTargetDatabases(siteId: string, databases: DatabaseSnapshot[]): Promise<void> {
    for (const db of databases) {
      if (!db.name || !db.type || !db.dbUser || !db.dbPassword) {
        throw new Error(`Неполный snapshot БД "${db.name || 'unknown'}"`);
      }

      const existing = await this.prisma.database.findFirst({
        where: { name: db.name, type: db.type },
        select: { id: true, siteId: true },
      });

      if (existing) {
        if (existing.siteId !== siteId) {
          throw new Error(`БД "${db.name}" (${db.type}) уже привязана к другому сайту`);
        }
        continue;
      }

      const passwordHash = await hashPassword(db.dbPassword);
      const passwordEnc = encryptJson({ password: db.dbPassword });
      const record = await this.prisma.database.create({
        data: {
          name: db.name,
          type: db.type as DatabaseType,
          dbUser: db.dbUser,
          dbPasswordHash: passwordHash,
          dbPasswordEnc: passwordEnc,
          siteId,
        },
      });

      const result = await this.agentRelay.emitToAgent('db:create', {
        name: db.name,
        type: db.type,
        dbUser: db.dbUser,
        password: db.dbPassword,
      });
      if (!result.success) {
        await this.prisma.database.delete({ where: { id: record.id } }).catch(() => {});
        throw new Error(`Создание БД "${db.name}" не удалось: ${result.error || 'unknown error'}`);
      }
    }
  }

  private async waitTargetSiteProvisioned(serverId: string, siteId: string): Promise<void> {
    const maxAttempts = 150;
    for (let i = 0; i < maxAttempts; i++) {
      const status = await this.getTargetSiteStatus(serverId, siteId);
      if (status === 'RUNNING') return;
      if (status === 'ERROR') {
        throw new Error('Создание сайта на целевом сервере завершилось ошибкой');
      }
      await this.sleep(2000);
    }
    throw new Error('Целевой сайт слишком долго не переходит в RUNNING');
  }

  private async getTargetSiteStatus(serverId: string, siteId: string): Promise<string> {
    if (serverId === 'main') {
      const site = await this.prisma.site.findUnique({
        where: { id: siteId },
        select: { status: true, errorMessage: true },
      });
      if (!site) throw new Error('Целевой сайт не найден');
      if (site.status === 'ERROR' && site.errorMessage) {
        throw new Error(`Создание сайта на target: ${site.errorMessage}`);
      }
      return site.status;
    }

    const server = this.proxy.getServer(serverId);
    if (!server) throw new Error('Целевой сервер не найден');
    const { status, data } = await this.proxy.proxyRequest(server, 'GET', `/sites/${siteId}`);
    if (status >= 400) {
      throw new Error('Не удалось получить статус целевого сайта');
    }
    const site = (data as { data?: { status?: string; errorMessage?: string | null } })?.data;
    if (site?.status === 'ERROR' && site.errorMessage) {
      throw new Error(`Создание сайта на target: ${site.errorMessage}`);
    }
    return site?.status || 'UNKNOWN';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  private async assertServerVersions(params: MigrateParams): Promise<void> {
    const checks = await Promise.all([
      this.getPanelVersion(params.sourceServerId),
      this.getPanelVersion(params.targetServerId),
    ]);

    for (const check of checks) {
      if (!check.online) {
        throw new BadRequestException(`Сервер "${check.label}" офлайн: ${check.error || 'нет ответа'}`);
      }
      if (!check.version || compareSemver(check.version, MIN_MIGRATION_VERSION) < 0) {
        throw new BadRequestException(
          `Сервер "${check.label}" должен быть не ниже ${MIN_MIGRATION_VERSION}, сейчас ${check.version || 'unknown'}`,
        );
      }
    }
  }

  private async getPanelVersion(serverId: string): Promise<{
    label: string;
    online: boolean;
    version?: string;
    error?: string;
  }> {
    if (serverId === 'main') {
      return { label: 'Этот сервер', online: true, version: readLocalVersion() };
    }
    const server = this.proxy.getServer(serverId);
    if (!server) {
      return { label: serverId, online: false, error: 'сервер не найден' };
    }
    const ping = await this.proxy.pingServer(server);
    return {
      label: server.name,
      online: ping.online,
      version: ping.version,
      error: ping.lastError,
    };
  }

  private async localPost(path: string, body: unknown, userId: string): Promise<Record<string, unknown>> {
    const port = process.env.API_PORT || process.env.PANEL_PORT || '11860';
    const url = `http://127.0.0.1:${port}/api${path}`;

    const token = process.env.PROXY_TOKEN;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['X-Proxy-Token'] = token;
    }
    // Подпись операции в аудит-логах; принимающая сторона этот заголовок не
    // парсит, но оставляем для трассировки запросов в nginx access-log.
    headers['X-Migration-User'] = userId;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });

    const data = await response.json().catch(() => null);
    if (response.status >= 400) {
      const errMsg = (data as { error?: { message?: string } })?.error?.message || `HTTP ${response.status}`;
      throw new Error(errMsg);
    }

    return (data as { data?: Record<string, unknown> })?.data || {};
  }

  private async pollBackupStatus(
    serverId: string,
    siteId: string,
    backupId: string,
  ): Promise<{ success: boolean; filePath?: string; error?: string }> {
    const maxAttempts = 360;
    const interval = 5000;

    for (let i = 0; i < maxAttempts; i++) {
      await this.sleep(interval);

      let backups: Array<{ id: string; status: string; filePath?: string; errorMessage?: string | null }>;

      if (serverId === 'main') {
        backups = await this.prisma.backup.findMany({
          where: { siteId },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { id: true, status: true, filePath: true, errorMessage: true },
        });
      } else {
        const server = this.proxy.getServer(serverId);
        if (!server) throw new Error('Сервер не найден');
        const { data } = await this.proxy.proxyRequest(server, 'GET', `/sites/${siteId}/backups`);
        backups = ((data as { data?: unknown[] })?.data || []) as typeof backups;
      }

      const backup = backups.find(b => b.id === backupId);
      if (!backup) continue;

      if (backup.status === 'COMPLETED') {
        return { success: true, filePath: backup.filePath };
      }
      if (backup.status === 'FAILED') {
        return { success: false, error: backup.errorMessage || undefined };
      }
    }

    return { success: false, error: 'Превышено время ожидания (30 минут)' };
  }

  private async pollPullStatus(
    serverId: string,
    pullId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const maxAttempts = 720; // 60 min (5s intervals) — download can be slow for large files
    const interval = 5000;

    for (let i = 0; i < maxAttempts; i++) {
      await this.sleep(interval);

      let state: PullState | undefined;

      if (serverId === 'main') {
        state = this.pullStates.get(pullId);
      } else {
        const server = this.proxy.getServer(serverId);
        if (!server) throw new Error('Сервер не найден');
        const { data } = await this.proxy.proxyRequest(server, 'GET', `/migration/pull-status/${pullId}`);
        state = (data as { data?: PullState })?.data;
      }

      if (!state) continue;

      if (state.phase === 'completed') {
        return { success: true };
      }
      if (state.phase === 'failed') {
        return { success: false, error: state.error };
      }
    }

    return { success: false, error: 'Превышено время ожидания передачи (60 минут)' };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

function readLocalVersion(): string {
  try {
    return fs.readFileSync(path.join(process.cwd(), '..', 'VERSION'), 'utf8').trim();
  } catch {
    return MIN_MIGRATION_VERSION;
  }
}

function compareSemver(a: string, b: string): number {
  const aa = a.replace(/^v/i, '').split(/[.-]/);
  const bb = b.replace(/^v/i, '').split(/[.-]/);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const av = aa[i] ?? '0';
    const bv = bb[i] ?? '0';
    const an = Number(av);
    const bn = Number(bv);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) {
      if (an !== bn) return an < bn ? -1 : 1;
    } else if (av !== bv) {
      return av < bv ? -1 : 1;
    }
  }
  return 0;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function stringArrayValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueStrings(value.filter((item): item is string => typeof item === 'string'));
  }
  if (typeof value === 'string') {
    return uniqueStrings(parseStringArray(value));
  }
  return [];
}

function stringJsonArrayValue(value: unknown): string {
  if (typeof value === 'string') {
    return stringifyStringArray(parseStringArray(value));
  }
  if (Array.isArray(value)) {
    return stringifyStringArray(value.filter((item): item is string => typeof item === 'string'));
  }
  return '[]';
}

function jsonObjectStringValue(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = parseJsonObjectString(value);
    return JSON.stringify(parsed);
  }
  if (isObjectRecord(value)) {
    return JSON.stringify(value);
  }
  return '{}';
}

function parseJsonObjectString(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return isObjectRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildTargetEcosystemPath(
  filesRelPath: string,
  sourceDir: string | null,
  sourceFile: string,
): string | null {
  const root = safeRelativePath(filesRelPath) || 'www';
  const dir = safeRelativePath(sourceDir);
  const fileName = path.posix.basename(sourceFile.replace(/\\/g, '/'));
  if (!fileName || !/^[A-Za-z0-9._-]+$/.test(fileName)) return null;
  return [root, dir, fileName].filter((part): part is string => !!part).join('/');
}

function safeRelativePath(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!trimmed || trimmed === '.') return null;
  const parts = trimmed.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) return null;
  return parts.join('/');
}
