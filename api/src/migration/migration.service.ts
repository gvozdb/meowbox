import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import * as dns from 'dns/promises';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { Agent as UndiciAgent, type Dispatcher } from 'undici';
import { Prisma } from '@prisma/client';
import {
  BackupEngine,
  BackupStatus,
  BackupStorageType,
  CronJobStatus,
  DatabasePurpose,
  DatabaseType,
  DomainApplicationStatus,
  SiteType,
  SslStatus,
  UserRole,
} from '../common/enums';
import { PrismaService } from '../common/prisma.service';
import { ProxyService } from '../proxy/proxy.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { SiteDomainsService } from '../sites/site-domains.service';
import { ServicesService } from '../services/services.service';
import { SiteNodeService } from '../site-node/site-node.service';
import { assertSafeFilePath } from '../common/validators/safe-path';
import { decryptJson, encryptJson } from '../common/crypto/credentials-cipher';
import { hashPassword } from '../common/crypto/argon2.helper';
import {
  parseSiteAliases,
  parseStringArray,
  stringifySiteAliases,
  stringifyStringArray,
} from '../common/json-array';
import { safeErrorMessage, type NodeProcessesResult } from '@meowbox/shared';
import {
  replaceHostnameClaims,
  rethrowHostnameClaimConflict,
} from '../sites/hostname-registry';

// ─── Interfaces ───

export interface MigrateParams {
  siteId: string;
  sourceServerId: string;
  targetServerId: string;
  reissueSsl: boolean;
  stopSource: boolean;
  panelUrl?: string; // Required when source='main' — frontend sends window.location.origin
  targetName?: string;
  targetDomain?: string;
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
  sourceId?: string;
  sourceSiteDomainId?: string;
  sourceDomain?: string;
  name: string;
  sourceName?: string;
  type: string;
  dbUser: string;
  purpose: string;
  dbPasswordEnc?: string;
  /** Legacy v1 compatibility only. New snapshots never transport plaintext. */
  dbPassword?: string;
}

export interface SiteDomainSnapshot {
  sourceId?: string;
  domain: string;
  isPrimary: boolean;
  position: number;
  aliases: string;
  filesRelPath: string;
  preset: string;
  appStatus: string;
  appErrorMessage: string | null;
  phpVersion: string | null;
  phpPoolCustom: string | null;
  runtimeKey: string;
  gitRepository: string | null;
  deployBranch: string | null;
  envVars: string;
  cmsAdminUser: string | null;
  cmsAdminPasswordEnc: string | null;
  managerPath: string | null;
  connectorsPath: string | null;
  cmsTablePrefix: string | null;
  modxVersion: string | null;
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
  node: NodeRuntimeSnapshot;
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
  domain: string;
  domains: string;
  status: string;
  issuer: string;
  isWildcard: boolean;
  issuedAt: string | null;
  expiresAt: string | null;
  daysRemaining: number | null;
  certPem: string | null;
  chainPem: string | null;
  keyPem: string | null;
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
  manifestVersion: 2;
  schemaVersion: 'domain-applications-v2';
  checksum: string;
  site: Record<string, unknown>;
  domains: SiteDomainSnapshot[];
  databases: DatabaseSnapshot[];
  backupConfigs: BackupConfigSnapshot[];
  services: SiteServiceSnapshot[];
  dnsZones: DnsZoneSnapshot[];
  sslCertificates: SslCertificateSnapshot[];
  /** Legacy v1 runtime. normalizeSnapshot maps it to the primary domain. */
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

interface TargetDomainForSslReissue {
  id: string;
  domain: string;
}

const RE_SITE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const RE_DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;

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

const MIN_MIGRATION_VERSION = 'v0.6.59';

const MIGRATION_DOWNLOAD_PATH_RE =
  /^\/api\/migration\/download\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isBlockedMigrationIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedMigrationIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  if (lower.startsWith('ff')) return true;
  const mapped = lower.match(/^::ffff:([0-9.]+)$/);
  return mapped ? isBlockedMigrationIPv4(mapped[1]) : false;
}

function isBlockedMigrationHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
  const family = net.isIP(lower);
  if (family === 4) return isBlockedMigrationIPv4(lower);
  if (family === 6) return isBlockedMigrationIPv6(lower);
  return false;
}

async function assertMigrationDownloadUrl(input: string): Promise<URL> {
  if (!input || typeof input !== 'string') {
    throw new BadRequestException('URL is required');
  }
  if (input.length > 2048 || /[\s\0\r\n]/.test(input)) {
    throw new BadRequestException('Invalid migration download URL');
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new BadRequestException('Invalid migration download URL');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new BadRequestException('Migration download URL must be http(s)');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new BadRequestException('Migration download URL must not contain credentials, query or fragment');
  }
  if (!MIGRATION_DOWNLOAD_PATH_RE.test(url.pathname)) {
    throw new BadRequestException('Migration download URL has invalid path');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || isBlockedMigrationHost(hostname)) {
    throw new BadRequestException('Migration download URL points to a blocked address');
  }

  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    for (const record of records) {
      if (isBlockedMigrationHost(record.address)) {
        throw new BadRequestException('Migration download URL resolves to a blocked address');
      }
    }
  } catch (err) {
    if (err instanceof BadRequestException) throw err;
    throw new BadRequestException('Unable to resolve migration download URL hostname');
  }

  return url;
}

@Injectable()
export class MigrationService {
  private readonly logger = new Logger('MigrationService');
  private readonly migrations = new Map<string, MigrationState>();
  private readonly downloadTokens = new Map<string, DownloadToken>();
  private readonly pullStates = new Map<string, PullState>();
  private readonly insecureIpTlsDispatcher = new UndiciAgent({
    connect: { rejectUnauthorized: false },
  });

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
    this.validateTargetOverrides(params);

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
    let createdTargetSiteId: string | undefined;
    let migrationCompleted = false;

    try {
      this.updateState(migrationId, 'preflight');
      const sourceSnapshot = this.normalizeSnapshot(
        await this.getSiteSnapshotFromServer(sourceServerId, siteId),
      );
      const sourceRootPath = typeof sourceSnapshot.site.rootPath === 'string'
        ? sourceSnapshot.site.rootPath
        : undefined;
      const siteSnapshot = this.applyTargetOverrides(sourceSnapshot, params);
      await this.assertTargetConflicts(targetServerId, siteSnapshot);

      // ══════════ Step 1: Trigger LOCAL backup on source ══════════
      this.updateState(migrationId, 'backup');

      let backupId: string;

      if (sourceServerId === 'main') {
        const result = await this.localPost('/backups/trigger', {
          siteId,
          engine: BackupEngine.TAR,
          type: 'FULL',
          storageType: BackupStorageType.LOCAL,
        }, userId);
        backupId = this.extractBackupId(result);
      } else {
        const server = this.proxy.getServer(sourceServerId)!;
        const { status, data } = await this.proxy.proxyRequest(server, 'POST', '/backups/trigger', {
          siteId,
          engine: BackupEngine.TAR,
          type: 'FULL',
          storageType: BackupStorageType.LOCAL,
        });
        if (status >= 400) {
          throw new Error(this.extractResponseError(data, `Ошибка запуска бэкапа на source: HTTP ${status}`));
        }
        backupId = this.extractBackupId(data);
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
        sourceBaseUrl = panelUrl!.replace(/\/+$/, '');
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

      const createBody = {
        name: siteMeta.name,
        displayName: siteMeta.displayName || undefined,
        metadata: {
          migrationId,
          importedFrom: 'meowbox',
          sourceServerId,
          sourceSiteId: siteId,
          createdAt: new Date().toISOString(),
        },
        domains: [...siteSnapshot.domains]
          .sort((a, b) => a.position - b.position)
          .map((domain) => ({
            domain: domain.domain,
            aliases: parseSiteAliases(domain.aliases),
            preset: domain.preset,
            filesRelPath: domain.filesRelPath,
            phpVersion: domain.phpVersion || undefined,
            phpPoolCustom: domain.phpPoolCustom || undefined,
            httpsRedirect: domain.httpsRedirect,
            gitRepository: domain.gitRepository || undefined,
            deployBranch: domain.deployBranch || undefined,
            envVars: stringRecordFromJson(domain.envVars),
            skipInstall: true,
            modxVersion: domain.modxVersion || undefined,
            cmsAdminUser: domain.cmsAdminUser || undefined,
            cmsTablePrefix: domain.cmsTablePrefix || undefined,
            managerPath: domain.managerPath || undefined,
            connectorsPath: domain.connectorsPath || undefined,
          })),
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
      createdTargetSiteId = targetSiteId;
      this.updateState(migrationId, 'create_site', undefined, { targetSiteId });
      await this.waitTargetSiteProvisioned(targetServerId, targetSiteId);

      // ══════════ Step 6: Tell target to pull from source ══════════
      this.updateState(migrationId, 'import_pull');

      const databases = siteSnapshot.databases;
      let pullId: string;

      if (targetServerId === 'main') {
        const result = await this.startImportPull(targetSiteId, sourceDownloadUrl, databases, sourceRootPath);
        pullId = result.pullId;
      } else {
        const server = this.proxy.getServer(targetServerId)!;
        const { status, data } = await this.proxy.proxyRequest(server, 'POST', '/migration/import-pull', {
          siteId: targetSiteId,
          sourceUrl: sourceDownloadUrl,
          databases,
          sourceRootPath,
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
          await this.reissueTargetSsl(targetServerId, targetSiteId, userId);
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
      migrationCompleted = true;
      this.updateState(migrationId, 'done', 'Миграция завершена успешно', { targetSiteId });
      this.logger.log(`Migration ${migrationId} completed: site ${siteId} → ${targetSiteId}`);
    } catch (err) {
      if (createdTargetSiteId && !migrationCompleted) {
        await this.cleanupCreatedTargetSite(targetServerId, createdTargetSiteId, userId, migrationId);
      }
      throw err;
    }
  }

  async getSiteSnapshot(siteId: string): Promise<SiteSnapshot> {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      include: {
        domains: {
          orderBy: { position: 'asc' },
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
          select: {
            domains: true,
            status: true,
            issuer: true,
            isWildcard: true,
            issuedAt: true,
            expiresAt: true,
            daysRemaining: true,
            certPath: true,
            keyPath: true,
            domain: { select: { domain: true } },
          },
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
      domains,
      databases,
      backupConfigs,
      services,
      dnsZones,
      sslCertificates,
      cronJobs,
      quickCommands,
    } = site;

    const sslSnapshot = await Promise.all(sslCertificates.map(async (cert) => {
      const pem = await this.readSslPemBundle(cert.status, cert.certPath, cert.keyPath);
      return {
        domain: cert.domain?.domain || firstDomainFromJson(cert.domains),
        domains: cert.domains,
        status: cert.status,
        issuer: cert.issuer,
        isWildcard: cert.isWildcard,
        issuedAt: cert.issuedAt?.toISOString() || null,
        expiresAt: cert.expiresAt?.toISOString() || null,
        daysRemaining: cert.daysRemaining,
        certPem: pem.certPem,
        chainPem: pem.chainPem,
        keyPem: pem.keyPem,
      };
    }));

    const domainSnapshots: SiteDomainSnapshot[] = await Promise.all(
      domains.map(async (domain) => ({
        sourceId: domain.id,
        domain: domain.domain,
        isPrimary: domain.isPrimary,
        position: domain.position,
        aliases: domain.aliases,
        filesRelPath: domain.filesRelPath,
        preset: domain.preset,
        appStatus: domain.appStatus,
        appErrorMessage: domain.appErrorMessage,
        phpVersion: domain.phpVersion,
        phpPoolCustom: domain.phpPoolCustom,
        runtimeKey: domain.runtimeKey,
        gitRepository: domain.gitRepository,
        deployBranch: domain.deployBranch,
        envVars: domain.envVars,
        cmsAdminUser: domain.cmsAdminUser,
        cmsAdminPasswordEnc: domain.cmsAdminPasswordEnc,
        managerPath: domain.managerPath,
        connectorsPath: domain.connectorsPath,
        cmsTablePrefix: domain.cmsTablePrefix,
        modxVersion: domain.modxVersion,
        appPort: domain.appPort,
        httpsRedirect: domain.httpsRedirect,
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
        node:
          domain.preset === SiteType.CUSTOM
            ? await this.getNodeRuntimeSnapshot(
                site.id,
                domain.id,
                domain.filesRelPath,
              )
            : emptyNodeRuntime(),
      })),
    );
    const domainById = new Map(
      domainSnapshots
        .filter((domain) => domain.sourceId)
        .map((domain) => [domain.sourceId as string, domain.domain]),
    );
    const snapshotWithoutChecksum = {
      manifestVersion: 2 as const,
      schemaVersion: 'domain-applications-v2' as const,
      site: {
        name: site.name,
        displayName: site.displayName,
        status: site.status,
        errorMessage: site.errorMessage,
        rootPath: site.rootPath,
        nginxConfigPath: site.nginxConfigPath,
        systemUser: site.systemUser,
        sshPasswordEnc: site.sshPasswordEnc,
        backupExcludes: site.backupExcludes,
        backupExcludeTables: site.backupExcludeTables,
        metadata: site.metadata,
      },
      domains: domainSnapshots,
      databases: databases.map((db) => ({
        sourceId: db.id,
        sourceSiteDomainId: db.siteDomainId,
        sourceDomain: domainById.get(db.siteDomainId),
        name: db.name,
        type: db.type,
        dbUser: db.dbUser,
        purpose: db.purpose,
        dbPasswordEnc: db.dbPasswordEnc || undefined,
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
      sslCertificates: sslSnapshot,
      node: emptyNodeRuntime(),
      cronJobs,
      quickCommands,
    };
    return {
      ...snapshotWithoutChecksum,
      checksum: snapshotChecksum(snapshotWithoutChecksum),
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

  private snapshotHasSsl(snapshot: SiteSnapshot): boolean {
    return snapshot.sslCertificates.some((cert) => isMigratableSslStatus(cert.status));
  }

  private withSslReissueWarning(metadata: string | null): string {
    const current = metadata ? parseJsonObjectString(metadata) : {};
    return JSON.stringify({
      ...current,
      requiresSslReissue: true,
      sslMigrationSource: current.importedFrom === 'hostpanel' ? 'hostpanel' : 'meowbox',
      sslReissueWarningCreatedAt:
        typeof current.sslReissueWarningCreatedAt === 'string'
          ? current.sslReissueWarningCreatedAt
          : new Date().toISOString(),
    });
  }

  private async readSslPemBundle(
    status: string,
    certPath: string | null,
    keyPath: string | null,
  ): Promise<{ certPem: string | null; chainPem: string | null; keyPem: string | null }> {
    if (!isMigratableSslStatus(status) || !certPath || !keyPath) {
      return { certPem: null, chainPem: null, keyPem: null };
    }

    try {
      const [certPem, keyPem] = await Promise.all([
        readAllowedSslFile(certPath),
        readAllowedSslFile(keyPath),
      ]);
      let chainPem: string | null = null;
      const chainPath = chainPathForFullchain(certPath);
      if (chainPath) {
        chainPem = await readAllowedSslFile(chainPath).catch((err) => {
          this.logger.warn(`SSL chain read skipped during migration snapshot: ${(err as Error).message}`);
          return null;
        });
      }
      return { certPem, chainPem, keyPem };
    } catch (err) {
      this.logger.warn(`SSL certificate read skipped during migration snapshot: ${(err as Error).message}`);
      return { certPem: null, chainPem: null, keyPem: null };
    }
  }

  private async getNodeRuntimeSnapshot(
    siteId: string,
    domainId: string,
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
      processes = await this.siteNode.getProcesses(siteId, domainId);
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

      const file = buildTargetEcosystemPath(group.filesRelPath || filesRelPath, group.dir, group.ecosystemFile);
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
    const rawSite = isObjectRecord(raw.site) ? raw.site : {};
    const manifestVersion = numberValue(raw.manifestVersion, 1);
    if (manifestVersion !== 1 && manifestVersion !== 2) {
      throw new BadRequestException(
        `Unsupported migration manifest version: ${manifestVersion}`,
      );
    }
    if (manifestVersion === 2) {
      const suppliedChecksum = String(raw.checksum || '');
      const payload = { ...raw };
      delete payload.checksum;
      if (
        !/^[a-f0-9]{64}$/.test(suppliedChecksum) ||
        snapshotChecksum(payload) !== suppliedChecksum
      ) {
        throw new BadRequestException('Migration manifest checksum mismatch');
      }
      if (raw.schemaVersion !== 'domain-applications-v2') {
        throw new BadRequestException('Unsupported migration schema version');
      }
    }

    const site: Record<string, unknown> = {
      name: String(rawSite.name || '').trim(),
      displayName: nullableString(rawSite.displayName),
      status: String(rawSite.status || 'RUNNING'),
      errorMessage: nullableString(rawSite.errorMessage),
      rootPath: String(rawSite.rootPath || ''),
      nginxConfigPath: String(rawSite.nginxConfigPath || ''),
      systemUser: nullableString(rawSite.systemUser),
      sshPasswordEnc: nullableString(rawSite.sshPasswordEnc),
      backupExcludes: nullableString(rawSite.backupExcludes),
      backupExcludeTables: nullableString(rawSite.backupExcludeTables),
      metadata: nullableString(rawSite.metadata),
    };
    if (!RE_SITE_NAME.test(String(site.name))) {
      throw new BadRequestException('Migration manifest has invalid Site name');
    }

    const legacyNode = normalizeNodeRuntime(raw.node);
    const legacyFilesRelPath =
      safeRelativePath(nullableString(rawSite.filesRelPath)) || 'www';
    const legacyPreset = normalizePreset(rawSite.type);
    const rawDomains = Array.isArray(raw.domains)
      ? raw.domains.filter(isObjectRecord)
      : [];
    if (rawDomains.length === 0 && typeof rawSite.domain === 'string') {
      rawDomains.push({
        domain: rawSite.domain,
        aliases: rawSite.aliases,
        isPrimary: true,
        position: 0,
      });
    }
    if (rawDomains.length === 0) {
      throw new BadRequestException('Migration manifest has no domains');
    }

    const explicitPrimaryIndex = rawDomains.findIndex(
      (domain) => domain.isPrimary === true,
    );
    const primaryIndex = explicitPrimaryIndex >= 0 ? explicitPrimaryIndex : 0;
    const domains = rawDomains
      .map((domain, index): SiteDomainSnapshot => {
        const isPrimary = index === primaryIndex;
        const hostname = String(domain.domain || '').trim().toLowerCase();
        const legacy = manifestVersion === 1;
        const preset = legacy
          ? isPrimary
            ? legacyPreset
            : SiteType.CUSTOM
          : normalizePreset(domain.preset, true);
        const filesRelPath =
          safeRelativePath(nullableString(domain.filesRelPath)) ||
          legacyFilesRelPath;
        const inherited = <T>(domainValue: unknown, siteValue: unknown): T =>
          (domainValue !== undefined && domainValue !== null
            ? domainValue
            : siteValue) as T;
        const runtimeKey =
          nullableString(domain.runtimeKey) ||
          (isPrimary
            ? String(site.name)
            : legacyRuntimeKey(hostname, index));
        const appStatus = normalizeAppStatus(
          legacy ? rawSite.status : domain.appStatus,
        );

        return {
          sourceId:
            nullableString(domain.sourceId) || nullableString(domain.id) || undefined,
          domain: hostname,
          isPrimary,
          position: isPrimary ? 0 : numberValue(domain.position, index),
          aliases:
            normalizeAliasesJson(domain.aliases),
          filesRelPath,
          preset,
          appStatus,
          appErrorMessage: nullableString(
            legacy
              ? inherited(domain.appErrorMessage, rawSite.errorMessage)
              : domain.appErrorMessage,
          ),
          phpVersion: nullableString(
            legacy
              ? inherited(domain.phpVersion, rawSite.phpVersion)
              : domain.phpVersion,
          ),
          phpPoolCustom: nullableString(
            legacy
              ? inherited(domain.phpPoolCustom, rawSite.phpPoolCustom)
              : domain.phpPoolCustom,
          ),
          runtimeKey,
          gitRepository: nullableString(
            legacy && isPrimary
              ? inherited(domain.gitRepository, rawSite.gitRepository)
              : domain.gitRepository,
          ),
          deployBranch: nullableString(
            legacy && isPrimary
              ? inherited(domain.deployBranch, rawSite.deployBranch)
              : domain.deployBranch,
          ),
          envVars: jsonObjectStringValue(
            legacy && isPrimary
              ? inherited(domain.envVars, rawSite.envVars)
              : domain.envVars,
          ),
          cmsAdminUser: nullableString(
            legacy && isPrimary
              ? inherited(domain.cmsAdminUser, rawSite.cmsAdminUser)
              : domain.cmsAdminUser,
          ),
          cmsAdminPasswordEnc: nullableString(
            legacy && isPrimary
              ? inherited(
                  domain.cmsAdminPasswordEnc,
                  rawSite.cmsAdminPasswordEnc,
                )
              : domain.cmsAdminPasswordEnc,
          ),
          managerPath: nullableString(
            legacy && isPrimary
              ? inherited(domain.managerPath, rawSite.managerPath)
              : domain.managerPath,
          ),
          connectorsPath: nullableString(
            legacy && isPrimary
              ? inherited(domain.connectorsPath, rawSite.connectorsPath)
              : domain.connectorsPath,
          ),
          cmsTablePrefix: nullableString(
            legacy && isPrimary
              ? inherited(domain.cmsTablePrefix, rawSite.cmsTablePrefix)
              : domain.cmsTablePrefix,
          ),
          modxVersion: nullableString(
            legacy && isPrimary
              ? inherited(domain.modxVersion, rawSite.modxVersion)
              : domain.modxVersion,
          ),
          appPort: nullableNumber(
            legacy
              ? inherited(domain.appPort, rawSite.appPort)
              : domain.appPort,
          ),
          httpsRedirect: boolValue(
            legacy
              ? inherited(domain.httpsRedirect, rawSite.httpsRedirect)
              : domain.httpsRedirect,
            true,
          ),
          nginxClientMaxBodySize: nullableString(
            legacy
              ? inherited(
                  domain.nginxClientMaxBodySize,
                  rawSite.nginxClientMaxBodySize,
                )
              : domain.nginxClientMaxBodySize,
          ),
          nginxFastcgiReadTimeout: nullableNumber(
            legacy
              ? inherited(
                  domain.nginxFastcgiReadTimeout,
                  rawSite.nginxFastcgiReadTimeout,
                )
              : domain.nginxFastcgiReadTimeout,
          ),
          nginxFastcgiSendTimeout: nullableNumber(
            legacy
              ? inherited(
                  domain.nginxFastcgiSendTimeout,
                  rawSite.nginxFastcgiSendTimeout,
                )
              : domain.nginxFastcgiSendTimeout,
          ),
          nginxFastcgiConnectTimeout: nullableNumber(
            legacy
              ? inherited(
                  domain.nginxFastcgiConnectTimeout,
                  rawSite.nginxFastcgiConnectTimeout,
                )
              : domain.nginxFastcgiConnectTimeout,
          ),
          nginxFastcgiBufferSizeKb: nullableNumber(
            legacy
              ? inherited(
                  domain.nginxFastcgiBufferSizeKb,
                  rawSite.nginxFastcgiBufferSizeKb,
                )
              : domain.nginxFastcgiBufferSizeKb,
          ),
          nginxFastcgiBufferCount: nullableNumber(
            legacy
              ? inherited(
                  domain.nginxFastcgiBufferCount,
                  rawSite.nginxFastcgiBufferCount,
                )
              : domain.nginxFastcgiBufferCount,
          ),
          nginxHttp2: boolValue(
            legacy
              ? inherited(domain.nginxHttp2, rawSite.nginxHttp2)
              : domain.nginxHttp2,
            true,
          ),
          nginxHsts: boolValue(
            legacy
              ? inherited(domain.nginxHsts, rawSite.nginxHsts)
              : domain.nginxHsts,
            false,
          ),
          nginxGzip: boolValue(
            legacy
              ? inherited(domain.nginxGzip, rawSite.nginxGzip)
              : domain.nginxGzip,
            true,
          ),
          nginxRateLimitEnabled: boolValue(
            legacy
              ? inherited(
                  domain.nginxRateLimitEnabled,
                  rawSite.nginxRateLimitEnabled,
                )
              : domain.nginxRateLimitEnabled,
            true,
          ),
          nginxRateLimitRps: nullableNumber(
            legacy
              ? inherited(domain.nginxRateLimitRps, rawSite.nginxRateLimitRps)
              : domain.nginxRateLimitRps,
          ),
          nginxRateLimitBurst: nullableNumber(
            legacy
              ? inherited(
                  domain.nginxRateLimitBurst,
                  rawSite.nginxRateLimitBurst,
                )
              : domain.nginxRateLimitBurst,
          ),
          nginxCustomConfig: nullableString(
            legacy
              ? inherited(domain.nginxCustomConfig, rawSite.nginxCustomConfig)
              : domain.nginxCustomConfig,
          ),
          node:
            legacy && isPrimary
              ? legacyNode
              : normalizeNodeRuntime(domain.node),
        };
      })
      .sort((a, b) => {
        if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
        return a.position - b.position;
      })
      .map((domain, position) => ({
        ...domain,
        isPrimary: position === 0,
        position,
      }));

    const hostnames = new Set<string>();
    const runtimeKeys = new Set<string>();
    for (const domain of domains) {
      if (!RE_DOMAIN.test(domain.domain)) {
        throw new BadRequestException(
          `Migration manifest has invalid domain "${domain.domain}"`,
        );
      }
      if (!safeRelativePath(domain.filesRelPath)) {
        throw new BadRequestException(
          `Migration manifest has unsafe filesRelPath for "${domain.domain}"`,
        );
      }
      if (!/^[a-z][a-z0-9._-]{0,63}$/.test(domain.runtimeKey)) {
        throw new BadRequestException(
          `Migration manifest has invalid runtimeKey for "${domain.domain}"`,
        );
      }
      if (runtimeKeys.has(domain.runtimeKey)) {
        throw new BadRequestException(
          `Migration manifest has duplicate runtimeKey "${domain.runtimeKey}"`,
        );
      }
      runtimeKeys.add(domain.runtimeKey);
      for (const hostname of [
        domain.domain,
        ...parseSiteAliases(domain.aliases).map((alias) =>
          alias.domain.trim().toLowerCase(),
        ),
      ]) {
        if (!RE_DOMAIN.test(hostname) || hostnames.has(hostname)) {
          throw new BadRequestException(
            `Migration manifest has invalid or duplicate hostname "${hostname}"`,
          );
        }
        hostnames.add(hostname);
      }
      if (
        (domain.preset === SiteType.MODX_REVO ||
          domain.preset === SiteType.MODX_3) &&
        !domain.phpVersion
      ) {
        throw new BadRequestException(
          `MODX application "${domain.domain}" has no PHP version`,
        );
      }
      if (
        domain.appPort !== null &&
        (!Number.isInteger(domain.appPort) ||
          domain.appPort < 1024 ||
          domain.appPort > 65535)
      ) {
        throw new BadRequestException(
          `Application "${domain.domain}" has invalid appPort`,
        );
      }
    }

    const domainBySourceId = new Map(
      domains
        .filter((domain) => domain.sourceId)
        .map((domain) => [domain.sourceId as string, domain.domain]),
    );
    const primaryDomain = domains[0];
    const databases = Array.isArray(raw.databases)
      ? raw.databases
          .filter(isObjectRecord)
          .map((database, index): DatabaseSnapshot => {
            const sourceSiteDomainId =
              nullableString(database.sourceSiteDomainId) ||
              nullableString(database.siteDomainId) ||
              undefined;
            const sourceDomain =
              nullableString(database.sourceDomain)?.toLowerCase() ||
              (sourceSiteDomainId
                ? domainBySourceId.get(sourceSiteDomainId)
                : undefined) ||
              (manifestVersion === 1 ? primaryDomain.domain : undefined);
            const purpose =
              manifestVersion === 1
                ? index === 0
                  ? DatabasePurpose.APP_PRIMARY
                  : DatabasePurpose.AUXILIARY
                : normalizeDatabasePurpose(database.purpose);
            return {
              sourceId:
                nullableString(database.sourceId) ||
                nullableString(database.id) ||
                undefined,
              sourceSiteDomainId,
              sourceDomain,
              name: String(database.name || '').trim(),
              sourceName:
                nullableString(database.sourceName) || undefined,
              type: String(database.type || '').trim(),
              dbUser: String(database.dbUser || '').trim(),
              purpose,
              dbPasswordEnc:
                nullableString(database.dbPasswordEnc) || undefined,
              dbPassword:
                manifestVersion === 1
                  ? nullableString(database.dbPassword) || undefined
                  : undefined,
            };
          })
          .filter((database) => database.name && database.type)
      : [];
    for (const database of databases) {
      if (
        database.type !== DatabaseType.MARIADB &&
        database.type !== DatabaseType.MYSQL &&
        database.type !== DatabaseType.POSTGRESQL
      ) {
        throw new BadRequestException(
          `Database "${database.name}" has invalid type "${database.type}"`,
        );
      }
      if (
        !database.sourceDomain ||
        !domains.some((domain) => domain.domain === database.sourceDomain)
      ) {
        throw new BadRequestException(
          `Database "${database.name}" has no valid domain owner`,
        );
      }
      if (!database.dbPasswordEnc && !database.dbPassword) {
        throw new BadRequestException(
          `Database "${database.name}" has no transferable credential`,
        );
      }
    }
    for (const domain of domains) {
      const owned = databases.filter(
        (database) => database.sourceDomain === domain.domain,
      );
      const primaryDatabases = owned.filter(
        (database) => database.purpose === DatabasePurpose.APP_PRIMARY,
      );
      if (primaryDatabases.length > 1) {
        throw new BadRequestException(
          `Application "${domain.domain}" has multiple APP_PRIMARY databases`,
        );
      }
      if (
        (domain.preset === SiteType.MODX_REVO ||
          domain.preset === SiteType.MODX_3) &&
        primaryDatabases.length !== 1
      ) {
        throw new BadRequestException(
          `MODX application "${domain.domain}" must have one APP_PRIMARY database`,
        );
      }
    }

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
            domain: String(cert.domain || firstDomainFromJson(cert.domains)).trim().toLowerCase(),
            domains: stringJsonArrayValue(cert.domains),
            status: String(cert.status || SslStatus.NONE),
            issuer: String(cert.issuer || ''),
            isWildcard: boolValue(cert.isWildcard, false),
            issuedAt: nullableDateIso(cert.issuedAt),
            expiresAt: nullableDateIso(cert.expiresAt),
            daysRemaining: nullableNumber(cert.daysRemaining),
            certPem: nullableString(cert.certPem),
            chainPem: nullableString(cert.chainPem),
            keyPem: nullableString(cert.keyPem),
          }))
          .filter((cert) => cert.status !== SslStatus.NONE)
      : [];

    const node = legacyNode;

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

    const normalized = {
      manifestVersion: 2 as const,
      schemaVersion: 'domain-applications-v2' as const,
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
    return {
      ...normalized,
      checksum: snapshotChecksum(normalized),
    };
  }

  private snapshotDomainNames(snapshot: SiteSnapshot): string[] {
    const names = new Set<string>();
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
    const targetRootPath = String(snapshot.site.rootPath || '');
    if (targetRootPath) {
      const siteByRoot = await this.prisma.site.findFirst({
        where: { rootPath: targetRootPath },
        select: { name: true },
      });
      if (siteByRoot) {
        errors.push(
          `путь "${targetRootPath}" уже принадлежит сайту "${siteByRoot.name}"`,
        );
      }
    }

    for (const domain of domainNames) {
      const [siteDomain, aliasCandidates] = await Promise.all([
        this.prisma.siteDomain.findFirst({
          where: { domain },
          select: { domain: true },
        }),
        this.prisma.siteDomain.findMany({
          where: { aliases: { contains: `"${domain}"` } },
          select: { aliases: true },
          take: 10,
        }),
      ]);
      if (siteDomain) errors.push(`на целевом сервере уже есть основной домен "${domain}"`);
      if (
        aliasCandidates.some((candidate) =>
          parseSiteAliases(candidate.aliases).some(
            (alias) => alias.domain.trim().toLowerCase() === domain,
          ),
        )
      ) {
        errors.push(`на целевом сервере уже занят алиас "${domain}"`);
      }
    }

    for (const domain of snapshot.domains) {
      const runtime = await this.prisma.siteDomain.findFirst({
        where: { runtimeKey: domain.runtimeKey },
        select: { domain: true },
      });
      if (runtime) {
        errors.push(
          `runtimeKey "${domain.runtimeKey}" уже принадлежит домену "${runtime.domain}"`,
        );
      }
      if (domain.appPort) {
        const portOwner = await this.prisma.siteDomain.findFirst({
          where: { appPort: domain.appPort },
          select: { domain: true },
        });
        if (portOwner) {
          errors.push(
            `порт ${domain.appPort} уже используется доменом "${portOwner.domain}"`,
          );
        }
      }
    }

    const phpDomains = snapshot.domains.filter((domain) => !!domain.phpVersion);
    if (phpDomains.length > 0) {
      try {
        const runtimePreflight = await this.agentRelay.emitToAgent<{
          phpVersions: string[];
          poolCount: number;
        }>(
          'php:preflight-pools',
          {
            pools: phpDomains.map((domain) => ({
              siteDomainId: domain.sourceId || domain.runtimeKey,
              siteName,
              domain: domain.domain,
              phpVersion: domain.phpVersion!,
              runtimeKey: domain.runtimeKey,
              user: String(snapshot.site.systemUser || siteName),
              rootPath: targetRootPath,
              filesRelPath: domain.filesRelPath,
              sslEnabled: false,
              customConfig: domain.phpPoolCustom,
            })),
          },
          30_000,
        );
        if (!runtimePreflight.success) {
          errors.push(
            `PHP runtime preflight failed: ${safeErrorMessage(
              runtimePreflight.error,
              'unknown agent error',
              2000,
            )}`,
          );
        }
      } catch (err) {
        errors.push(
          `PHP runtime preflight unavailable: ${safeErrorMessage(
            err,
            'agent unavailable',
            1000,
          )}`,
        );
      }
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
          this.logger.warn(`Backup storage "${name}" not found on target during migration preflight`);
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
      this.logger.warn(
        `Site has linked DNS zones (${snapshot.dnsZones.map((z) => z.domain).join(', ')}); DNS providers are not migrated automatically`,
      );
    }

    const orphanProcesses = uniqueStrings(
      snapshot.domains.flatMap((domain) => domain.node.orphanProcesses),
    );
    if (orphanProcesses.length > 0) {
      errors.push(
        `у сайта есть PM2-процессы без ecosystem-файла (${orphanProcesses.join(', ')}); опиши их в ecosystem.config.js перед миграцией`,
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
    sslCertificates: number;
    nodeApps: number;
  }> {
    snapshot = this.normalizeSnapshot(snapshot);

    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { id: true, name: true, systemUser: true, metadata: true },
    });
    if (!site) throw new BadRequestException('Целевой сайт не найден');
    const systemUser = site.systemUser || site.name;

    const siteUpdate = this.buildSiteConfigUpdate(snapshot.site);
    if (this.snapshotHasSsl(snapshot)) {
      siteUpdate.metadata = this.withSslReissueWarning(site.metadata);
    }

    await this.prisma.site.update({
      where: { id: siteId },
      data: siteUpdate,
    });
    await this.applySiteDomains(siteId, snapshot.domains);
    await this.normalizeTargetSitePermissions(siteId);
    const sslCertificates = await this.applySslCertificates(siteId, snapshot.sslCertificates);
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

    const nodeApps = await this.applyNodeRuntime(siteId, snapshot.domains);
    await this.verifyTargetApplications(siteId);
    await this.prisma.site.update({
      where: { id: siteId },
      data: { status: 'RUNNING', errorMessage: null },
    });

    return {
      cronJobs: cronCount,
      quickCommands: snapshot.quickCommands.length,
      backupConfigs,
      services,
      sslCertificates,
      nodeApps,
    };
  }

  private async applySslCertificates(
    siteId: string,
    certificates: SslCertificateSnapshot[],
  ): Promise<number> {
    const importable = certificates.filter((cert) =>
      isMigratableSslStatus(cert.status) && !!cert.certPem && !!cert.keyPem,
    );
    if (importable.length === 0) return 0;

    const targetDomains = await this.prisma.siteDomain.findMany({
      where: { siteId },
      select: { id: true, domain: true },
    });
    const byDomain = new Map(targetDomains.map((domain) => [domain.domain.toLowerCase(), domain]));
    let count = 0;

    for (const cert of importable) {
      const names = uniqueStrings([cert.domain, ...parseStringArray(cert.domains)])
        .map((domain) => domain.toLowerCase());
      const targetDomain = names.map((domain) => byDomain.get(domain)).find(Boolean);
      if (!targetDomain) {
        this.logger.warn(`SSL certificate skipped during migration: target domain not found for ${cert.domain || names[0] || 'unknown'}`);
        continue;
      }

      try {
        const raw = await this.agentRelay.emitToAgent<unknown>('ssl:install-custom', {
          domain: targetDomain.domain,
          certPem: cert.certPem,
          chainPem: cert.chainPem || undefined,
          keyPem: cert.keyPem,
        });
        const ack = raw as unknown as {
          success?: boolean;
          certPath?: string;
          keyPath?: string;
          expiresAt?: string;
          domains?: string[];
          error?: string;
        };

        if (!ack.success || !ack.certPath || !ack.keyPath) {
          this.logger.warn(`SSL certificate skipped during migration for ${targetDomain.domain}: ${ack.error || raw.error || 'install failed'}`);
          continue;
        }

        const sanDomains = uniqueStrings(
          Array.isArray(ack.domains) && ack.domains.length
            ? ack.domains
            : parseStringArray(cert.domains),
        );
        const expiresAt = dateFromIsoOrNull(ack.expiresAt) || dateFromIsoOrNull(cert.expiresAt);
        const issuedAt = dateFromIsoOrNull(cert.issuedAt) || new Date();
        const daysRemaining = calcDaysRemaining(expiresAt);
        const data = {
          domains: stringifyStringArray(sanDomains.length ? sanDomains : names),
          status: sslStatusFromDaysRemaining(daysRemaining, cert.status),
          issuer: cert.issuer || 'Custom',
          isWildcard: cert.isWildcard,
          issuedAt,
          expiresAt,
          daysRemaining,
          certPath: ack.certPath,
          keyPath: ack.keyPath,
        };

        const existing = await this.prisma.sslCertificate.findFirst({
          where: { siteId, domainId: targetDomain.id },
          select: { id: true },
        });
        if (existing) {
          await this.prisma.sslCertificate.update({
            where: { id: existing.id },
            data,
          });
        } else {
          await this.prisma.sslCertificate.create({
            data: {
              siteId,
              domainId: targetDomain.id,
              ...data,
            },
          });
        }
        count += 1;
      } catch (err) {
        this.logger.warn(`SSL certificate skipped during migration for ${targetDomain.domain}: ${(err as Error).message}`);
      }
    }

    if (count > 0) {
      await this.siteDomains.regenerateNginx(siteId).catch((err) => {
        this.logger.warn(`SSL nginx reconfigure after migration failed: ${(err as Error).message}`);
      });
    }

    return count;
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
          if (id) {
            storageLocationIds.push(id);
          } else {
            this.logger.warn(`Backup storage "${name}" not found on target during migration; skipping link`);
          }
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
    sourceDomains: SiteDomainSnapshot[],
  ): Promise<number> {
    const targetDomains = await this.prisma.siteDomain.findMany({
      where: { siteId },
      select: { id: true, domain: true, preset: true },
    });
    const targetByDomain = new Map(
      targetDomains.map((domain) => [domain.domain.toLowerCase(), domain]),
    );
    let count = 0;
    let autostartDomainId: string | null = null;
    for (const sourceDomain of sourceDomains) {
      const target = targetByDomain.get(sourceDomain.domain.toLowerCase());
      if (!target) {
        throw new Error(
          `Target domain "${sourceDomain.domain}" is missing for Node runtime`,
        );
      }
      if (
        sourceDomain.node.ecosystems.length > 0 &&
        target.preset !== SiteType.CUSTOM
      ) {
        throw new Error(
          `Node runtime cannot be restored into ${target.preset} domain "${target.domain}"`,
        );
      }
      for (const ecosystem of sourceDomain.node.ecosystems) {
        await this.siteNode.startEcosystem(
          siteId,
          target.id,
          ecosystem.file,
          ecosystem.only,
        );
        count += 1;
      }
      for (const name of sourceDomain.node.processesToStop) {
        await this.siteNode.controlProcess(siteId, target.id, 'stop', name);
      }
      if (sourceDomain.node.autostartEnabled) {
        autostartDomainId = target.id;
      }
    }
    if (autostartDomainId) {
      await this.siteNode.setAutostart(siteId, autostartDomainId, true);
    }
    return count;
  }

  private async applySiteDomains(
    siteId: string,
    sourceDomains: SiteDomainSnapshot[],
  ): Promise<void> {
    const ordered = [...sourceDomains].sort((a, b) => a.position - b.position);
    if (ordered.length === 0) {
      throw new Error('Migration snapshot has no domain applications');
    }
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: {
        id: true,
        name: true,
        rootPath: true,
        systemUser: true,
        domains: {
          select: { id: true, domain: true },
        },
      },
    });
    if (!site) throw new Error('Target Site not found while applying domains');
    if (site.domains.length !== ordered.length) {
      throw new Error(
        `Target domain count mismatch: expected ${ordered.length}, got ${site.domains.length}`,
      );
    }
    const targetByDomain = new Map(
      site.domains.map((domain) => [domain.domain.toLowerCase(), domain]),
    );
    for (const sourceDomain of ordered) {
      if (!targetByDomain.has(sourceDomain.domain.toLowerCase())) {
        throw new Error(`Target domain "${sourceDomain.domain}" is missing`);
      }
    }

    await this.prisma.$transaction(async (tx) => {
      for (const [index, sourceDomain] of ordered.entries()) {
        const target = targetByDomain.get(sourceDomain.domain.toLowerCase())!;
        await tx.siteDomain.update({
          where: { id: target.id },
          data: {
            runtimeKey: `import-${target.id.replace(/-/g, '').slice(0, 24)}`,
            position: -(index + 1),
          },
        });
      }
      for (const [index, sourceDomain] of ordered.entries()) {
        const target = targetByDomain.get(sourceDomain.domain.toLowerCase())!;
        const aliases = parseSiteAliases(sourceDomain.aliases);
        await tx.siteDomain.update({
          where: { id: target.id },
          data: {
            ...this.buildDomainConfigUpdate(sourceDomain),
            isPrimary: index === 0,
            position: index,
            aliases: stringifySiteAliases(aliases),
            appStatus: DomainApplicationStatus.PROVISIONING,
            appErrorMessage: null,
          },
        });
        await replaceHostnameClaims(tx, {
          siteDomainId: target.id,
          domain: target.domain,
          aliases: stringifySiteAliases(aliases),
        });
        await tx.sslCertificate.updateMany({
          where: { siteId, domainId: target.id },
          data: {
            domains: stringifyStringArray([
              sourceDomain.domain,
              ...aliases.map((alias) => alias.domain),
            ]),
          },
        });
      }
    }).catch(rethrowHostnameClaimConflict);

    const configuredDomains = await this.prisma.siteDomain.findMany({
      where: { siteId },
      orderBy: { position: 'asc' },
    });
    for (const domain of configuredDomains) {
      if (!domain.phpVersion) continue;
      const pool = await this.agentRelay.emitToAgent('php:create-pool', {
        siteDomainId: domain.id,
        runtimeKey: domain.runtimeKey,
        siteName: site.name,
        domain: domain.domain,
        phpVersion: domain.phpVersion,
        user: site.systemUser || site.name,
        rootPath: site.rootPath,
        filesRelPath: domain.filesRelPath,
        sslEnabled: false,
        customConfig: domain.phpPoolCustom,
      });
      if (!pool.success) {
        await this.prisma.siteDomain.update({
          where: { id: domain.id },
          data: {
            appStatus: DomainApplicationStatus.ERROR,
            appErrorMessage: (
              pool.error || 'PHP pool creation failed during migration'
            ).substring(0, 2000),
          },
        });
        throw new Error(
          `PHP pool creation failed for "${domain.domain}": ${
            pool.error || 'unknown agent error'
          }`,
        );
      }
    }

    await this.siteDomains.syncPrimaryPhpCliShim(siteId);
    await this.siteDomains.regenerateGlobalZones();
    await this.siteDomains.regenerateNginx(siteId);
  }

  private async normalizeTargetSitePermissions(siteId: string): Promise<void> {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: {
        name: true,
        rootPath: true,
        systemUser: true,
        domains: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            domain: true,
            preset: true,
            filesRelPath: true,
          },
        },
      },
    });
    if (!site) throw new Error('Целевой сайт не найден для нормализации прав');

    for (const domain of site.domains) {
      const result = await this.agentRelay.emitToAgent<{
        steps: Array<{ cmd: string; ok: boolean; error?: string }>;
        modxCorePath?: string;
      }>(
        'site:normalize-permissions',
        {
          siteDomainId: domain.id,
          rootPath: site.rootPath,
          filesRelPath: domain.filesRelPath,
          systemUser: site.systemUser || site.name,
          siteType: domain.preset,
        },
        120_000,
      );
      if (!result.success) {
        throw new Error(
          `Нормализация прав "${domain.domain}" не удалась: ${
            result.error || 'unknown error'
          }`,
        );
      }
    }
  }

  private async verifyTargetApplications(siteId: string): Promise<void> {
    const domains = await this.prisma.siteDomain.findMany({
      where: { siteId },
      orderBy: { position: 'asc' },
      select: { id: true, domain: true },
    });
    const failures: string[] = [];
    for (const domain of domains) {
      const health = await this.agentRelay.emitToAgent<{
        reachable: boolean;
        statusCode: number | null;
      }>('site:health-check', { domain: domain.domain, port: null }, 15_000);
      const statusCode = health.data?.statusCode ?? 0;
      const healthy =
        health.success &&
        health.data?.reachable === true &&
        statusCode > 0 &&
        statusCode < 500;
      await this.prisma.siteDomain.update({
        where: { id: domain.id },
        data: healthy
          ? {
              appStatus: DomainApplicationStatus.RUNNING,
              appErrorMessage: null,
            }
          : {
              appStatus: DomainApplicationStatus.ERROR,
              appErrorMessage: `Post-migration health check failed${
                statusCode ? ` (HTTP ${statusCode})` : ''
              }`,
            },
      });
      if (!healthy) {
        failures.push(
          `${domain.domain}${statusCode ? `: HTTP ${statusCode}` : ''}`,
        );
      }
    }
    if (failures.length > 0) {
      await this.prisma.site.update({
        where: { id: siteId },
        data: {
          status: 'ERROR',
          errorMessage: `Post-migration health check failed: ${failures.join(', ')}`.substring(
            0,
            2000,
          ),
        },
      });
      throw new Error(
        `Post-migration health check failed: ${failures.join(', ')}`,
      );
    }
  }

  private buildSiteConfigUpdate(site: Record<string, unknown>): Prisma.SiteUpdateInput {
    const data: Prisma.SiteUpdateInput = {};

    if ('backupExcludes' in site) data.backupExcludes = nullableString(site.backupExcludes);
    if ('backupExcludeTables' in site) data.backupExcludeTables = nullableString(site.backupExcludeTables);

    return data;
  }

  private buildDomainConfigUpdate(domain: SiteDomainSnapshot): Prisma.SiteDomainUpdateInput {
    return {
      preset: domain.preset,
      appStatus: DomainApplicationStatus.PROVISIONING,
      appErrorMessage: null,
      filesRelPath: domain.filesRelPath,
      phpVersion: domain.phpVersion,
      phpPoolCustom: domain.phpPoolCustom,
      runtimeKey: domain.runtimeKey,
      gitRepository: domain.gitRepository,
      deployBranch: domain.deployBranch,
      envVars: domain.envVars,
      cmsAdminUser: domain.cmsAdminUser,
      cmsAdminPasswordEnc: domain.cmsAdminPasswordEnc,
      managerPath: domain.managerPath,
      connectorsPath: domain.connectorsPath,
      cmsTablePrefix: domain.cmsTablePrefix,
      modxVersion: domain.modxVersion,
      appPort: domain.appPort,
      httpsRedirect: domain.httpsRedirect,
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
    sourceRootPath?: string,
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
    this.downloadAndRestore(pullState, site, sourceUrl, databases, sourceRootPath).catch((err) => {
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
    sourceRootPath?: string,
  ) {
    const localPath = path.join(BACKUP_DIR, `migration_${pullState.pullId}.tar.gz`);

    // ── Phase 1: Download ──
    pullState.phase = 'downloading';

    // Ensure backup dir exists
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const safeUrl = await assertMigrationDownloadUrl(sourceUrl);

    const request: RequestInit = {};
    const dispatcher = this.getMigrationDownloadDispatcher(safeUrl);
    if (dispatcher) {
      (request as RequestInit & { dispatcher: Dispatcher }).dispatcher = dispatcher;
    }

    let response: Response;
    try {
      response = await fetch(safeUrl.toString(), request);
    } catch (err) {
      throw new Error(
        `Ошибка скачивания с source (${this.safeUrlHost(safeUrl)}): ${this.fetchErrorMessage(err)}`,
      );
    }

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
      sourceRootPath,
      filePath: localPath,
      storageType: 'LOCAL',
      storageConfig: {},
      databases: databases.map((database) => ({
        name: database.name,
        sourceName: database.sourceName || database.name,
        type: database.type,
      })),
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
    const domains = await this.prisma.siteDomain.findMany({
      where: { siteId },
      select: { id: true, domain: true, preset: true },
    });
    const domainByName = new Map(
      domains.map((domain) => [domain.domain.toLowerCase(), domain]),
    );
    for (const db of databases) {
      if (!db.name || !db.type || !db.dbUser || !db.sourceDomain) {
        throw new Error(`Неполный snapshot БД "${db.name || 'unknown'}"`);
      }
      const owner = domainByName.get(db.sourceDomain.toLowerCase());
      if (!owner) {
        throw new Error(
          `Владелец БД "${db.name}" (${db.sourceDomain}) не найден`,
        );
      }
      const password = db.dbPassword || decryptTransferPassword(db);
      const purpose = normalizeDatabasePurpose(db.purpose);
      if (
        purpose === DatabasePurpose.APP_PRIMARY &&
        (owner.preset === SiteType.MODX_REVO ||
          owner.preset === SiteType.MODX_3) &&
        db.type !== DatabaseType.MARIADB &&
        db.type !== DatabaseType.MYSQL
      ) {
        throw new Error(`MODX database "${db.name}" must be MariaDB or MySQL`);
      }

      const existing = await this.prisma.database.findFirst({
        where: { name: db.name, type: db.type },
        select: {
          id: true,
          siteId: true,
          siteDomainId: true,
          purpose: true,
        },
      });

      if (existing) {
        if (
          existing.siteId !== siteId ||
          existing.siteDomainId !== owner.id ||
          existing.purpose !== purpose
        ) {
          throw new Error(`БД "${db.name}" (${db.type}) уже привязана к другому сайту`);
        }
        continue;
      }

      const passwordHash = await hashPassword(password);
      const passwordEnc =
        db.dbPasswordEnc || encryptJson({ password });
      const record = await this.prisma.database.create({
        data: {
          name: db.name,
          type: db.type as DatabaseType,
          dbUser: db.dbUser,
          dbPasswordHash: passwordHash,
          dbPasswordEnc: passwordEnc,
          siteId,
          siteDomainId: owner.id,
          purpose,
        },
      });

      const result = await this.agentRelay.emitToAgent('db:create', {
        name: db.name,
        type: db.type,
        dbUser: db.dbUser,
        password,
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

  private validateTargetOverrides(params: MigrateParams): void {
    const targetName = params.targetName?.trim();
    if (targetName && !RE_SITE_NAME.test(targetName)) {
      throw new BadRequestException('targetName должен быть валидным именем сайта');
    }

    const targetDomain = params.targetDomain?.trim().toLowerCase();
    if (targetDomain && !RE_DOMAIN.test(targetDomain)) {
      throw new BadRequestException('targetDomain должен быть валидным доменом');
    }
  }

  private applyTargetOverrides(snapshot: SiteSnapshot, params: MigrateParams): SiteSnapshot {
    const targetName = params.targetName?.trim();
    const targetDomain = params.targetDomain?.trim().toLowerCase();
    if (!targetName && !targetDomain) return snapshot;

    const oldPrimaryDomain =
      snapshot.domains.find((domain) => domain.isPrimary)?.domain ||
      snapshot.domains[0]?.domain ||
      '';
    const next = {
      manifestVersion: 2 as const,
      schemaVersion: 'domain-applications-v2' as const,
      site: { ...snapshot.site },
      domains: snapshot.domains.map((domain) => ({
        ...domain,
        node: {
          ...domain.node,
          ecosystems: domain.node.ecosystems.map((ecosystem) => ({
            ...ecosystem,
          })),
          processesToStop: [...domain.node.processesToStop],
          orphanProcesses: [...domain.node.orphanProcesses],
        },
      })),
      databases: snapshot.databases.map((db) => ({ ...db })),
      backupConfigs: snapshot.backupConfigs.map((cfg) => ({ ...cfg })),
      services: snapshot.services.map((service) => ({ ...service })),
      dnsZones: snapshot.dnsZones.map((zone) => ({ ...zone })),
      sslCertificates: snapshot.sslCertificates.map((cert) => ({ ...cert })),
      cronJobs: snapshot.cronJobs.map((job) => ({ ...job })),
      quickCommands: snapshot.quickCommands.map((cmd) => ({ ...cmd })),
      node: {
        ...snapshot.node,
        ecosystems: snapshot.node.ecosystems.map((eco) => ({ ...eco })),
        processesToStop: [...snapshot.node.processesToStop],
        orphanProcesses: [...snapshot.node.orphanProcesses],
      },
    };

    if (targetName) {
      next.site.name = targetName;
      next.site.rootPath = `/var/www/${targetName}`;
      next.site.nginxConfigPath = `/etc/nginx/sites-available/${targetName}.conf`;
      next.site.systemUser = targetName;
      const primary = next.domains.find((domain) => domain.isPrimary);
      if (primary) primary.runtimeKey = targetName;
      next.databases = next.databases.map((db, index) => {
        const mappedName = this.targetDatabaseName(targetName, index);
        const mappedUser = this.targetDatabaseUserName(targetName, index);
        return {
          ...db,
          sourceName: db.sourceName || db.name,
          name: mappedName,
          dbUser: mappedUser,
        };
      });
    }

    if (targetDomain) {
      const primary = next.domains.find((domain) => domain.isPrimary);
      if (!primary) {
        throw new BadRequestException('Migration snapshot has no primary domain');
      }
      const aliases = parseSiteAliases(primary.aliases).filter(
        (alias) =>
          alias.domain.toLowerCase() !== oldPrimaryDomain.toLowerCase() &&
          alias.domain.toLowerCase() !== targetDomain,
      );
      primary.domain = targetDomain;
      primary.aliases = stringifySiteAliases(aliases);
      next.databases = next.databases.map((database) => ({
        ...database,
        sourceDomain:
          database.sourceDomain?.toLowerCase() ===
          oldPrimaryDomain.toLowerCase()
            ? targetDomain
            : database.sourceDomain,
      }));
      // Existing certificate material never matches an overridden hostname.
      next.sslCertificates = [];
    }

    const runtimeKeys = new Set<string>();
    for (const domain of next.domains) {
      if (runtimeKeys.has(domain.runtimeKey)) {
        throw new BadRequestException(
          `targetName creates duplicate runtimeKey "${domain.runtimeKey}"`,
        );
      }
      runtimeKeys.add(domain.runtimeKey);
    }
    return {
      ...next,
      checksum: snapshotChecksum(next),
    };
  }

  private targetDatabaseName(targetName: string, index: number): string {
    const base = this.targetDatabaseBaseName(targetName);
    if (index === 0) return base.slice(0, 64);
    const suffix = `_${index + 1}`;
    return `${base.slice(0, 64 - suffix.length)}${suffix}`;
  }

  private targetDatabaseUserName(targetName: string, index: number): string {
    const base = this.targetDatabaseBaseName(targetName);
    if (index === 0) return base.slice(0, 32);
    const suffix = `_${index + 1}`;
    return `${base.slice(0, 32 - suffix.length)}${suffix}`;
  }

  private targetDatabaseBaseName(targetName: string): string {
    return targetName.replace(/-/g, '_');
  }

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

  private async cleanupCreatedTargetSite(
    targetServerId: string,
    targetSiteId: string,
    userId: string,
    migrationId: string,
  ): Promise<void> {
    try {
      const metadata = await this.getTargetSiteMetadata(targetServerId, targetSiteId);
      if (metadata.migrationId !== migrationId || metadata.importedFrom !== 'meowbox') {
        this.logger.warn(
          `Migration ${migrationId}: target cleanup skipped, metadata mismatch for site ${targetSiteId}`,
        );
        return;
      }

      this.logger.warn(`Migration ${migrationId}: cleanup target site ${targetSiteId}`);
      if (targetServerId === 'main') {
        await this.localRequest('DELETE', `/sites/${targetSiteId}`, {}, userId, 300_000);
        return;
      }

      const server = this.proxy.getServer(targetServerId);
      if (!server) {
        this.logger.warn(`Migration ${migrationId}: target cleanup skipped, server not found`);
        return;
      }

      const { status, data } = await this.proxy.proxyRequest(
        server,
        'DELETE',
        `/sites/${targetSiteId}`,
        {},
        { 'X-Migration-User': userId },
        300_000,
      );
      if (status >= 400) {
        const errMsg = (data as { error?: { message?: string } })?.error?.message || `HTTP ${status}`;
        this.logger.warn(`Migration ${migrationId}: target cleanup failed: ${errMsg}`);
      }
    } catch (err) {
      this.logger.warn(`Migration ${migrationId}: target cleanup failed: ${(err as Error).message}`);
    }
  }

  private async getTargetSiteMetadata(
    targetServerId: string,
    targetSiteId: string,
  ): Promise<Record<string, unknown>> {
    if (targetServerId === 'main') {
      const site = await this.prisma.site.findUnique({
        where: { id: targetSiteId },
        select: { metadata: true },
      });
      return site?.metadata ? parseJsonObjectString(site.metadata) : {};
    }

    const server = this.proxy.getServer(targetServerId);
    if (!server) return {};
    const { status, data } = await this.proxy.proxyRequest(server, 'GET', `/sites/${targetSiteId}`);
    if (status >= 400) return {};
    const site = (data as { data?: { metadata?: unknown } })?.data;
    return jsonObjectValue(site?.metadata);
  }

  private getMigrationDownloadDispatcher(url: URL): Dispatcher | undefined {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol === 'https:' && net.isIP(hostname) !== 0) {
      return this.insecureIpTlsDispatcher;
    }
    return undefined;
  }

  private safeUrlHost(url: URL): string {
    return url.host || 'unknown';
  }

  private fetchErrorMessage(err: unknown): string {
    const error = err as { message?: unknown; cause?: unknown };
    const message = typeof error.message === 'string' ? error.message : String(err);
    const cause = error.cause as { message?: unknown } | undefined;
    if (cause && typeof cause.message === 'string' && cause.message && cause.message !== message) {
      return `${message}: ${cause.message}`;
    }
    return message;
  }

  private async localPost(path: string, body: unknown, userId: string): Promise<Record<string, unknown>> {
    return this.localRequest('POST', path, body, userId);
  }

  private extractBackupId(payload: unknown): string {
    if (!payload || typeof payload !== 'object') return '';

    const data = payload as {
      backupId?: unknown;
      backups?: unknown;
      data?: unknown;
    };

    if (typeof data.backupId === 'string' && data.backupId) {
      return data.backupId;
    }

    if (Array.isArray(data.backups)) {
      const backup = data.backups.find(
        (item): item is { id: string } =>
          !!item &&
          typeof item === 'object' &&
          typeof (item as { id?: unknown }).id === 'string' &&
          !!(item as { id?: string }).id,
      );
      if (backup) return backup.id;
    }

    return this.extractBackupId(data.data);
  }

  private extractResponseError(payload: unknown, fallback: string): string {
    if (!payload || typeof payload !== 'object') return fallback;

    const data = payload as {
      message?: unknown;
      error?: unknown;
      data?: unknown;
    };

    if (typeof data.message === 'string' && data.message) {
      return data.message;
    }

    if (data.error && typeof data.error === 'object') {
      const errorMessage = (data.error as { message?: unknown }).message;
      if (typeof errorMessage === 'string' && errorMessage) {
        return errorMessage;
      }
    }

    const nested = this.extractResponseError(data.data, '');
    return nested || fallback;
  }

  private async localRequest(
    method: string,
    path: string,
    body: unknown,
    userId: string,
    timeoutMs = 300_000,
  ): Promise<Record<string, unknown>> {
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

    const request: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
      request.body = JSON.stringify(body);
    }

    const response = await fetch(url, request);

    const data = await response.json().catch(() => null);
    if (response.status >= 400) {
      const errMsg = (data as { error?: { message?: string } })?.error?.message || `HTTP ${response.status}`;
      throw new Error(errMsg);
    }

    return (data as { data?: Record<string, unknown> })?.data || {};
  }

  private async reissueTargetSsl(targetServerId: string, siteId: string, userId: string): Promise<void> {
    const domains = await this.getTargetDomainsForSslReissue(targetServerId, siteId);
    if (domains.length === 0) {
      throw new Error('У целевого сайта нет доменов для SSL');
    }

    const errors: string[] = [];
    for (const domain of domains) {
      try {
        await this.issueTargetDomainSsl(targetServerId, siteId, domain.id, userId);
      } catch (err) {
        errors.push(`${domain.domain}: ${(err as Error).message}`);
      }
    }

    if (errors.length === domains.length) {
      throw new Error(errors.join('; '));
    }
    if (errors.length > 0) {
      this.logger.warn(`Partial SSL reissue during migration: ${errors.join('; ')}`);
    }
  }

  private async getTargetDomainsForSslReissue(
    targetServerId: string,
    siteId: string,
  ): Promise<TargetDomainForSslReissue[]> {
    if (targetServerId === 'main') {
      return this.prisma.siteDomain.findMany({
        where: { siteId },
        orderBy: { position: 'asc' },
        select: { id: true, domain: true },
      });
    }

    const server = this.proxy.getServer(targetServerId);
    if (!server) throw new Error('Целевой сервер не найден');

    const { status, data } = await this.proxy.proxyRequest(server, 'GET', `/sites/${siteId}`);
    if (status >= 400) {
      const errMsg = (data as { error?: { message?: string } })?.error?.message || `HTTP ${status}`;
      throw new Error(errMsg);
    }

    const domains = (data as { data?: { domains?: unknown[] } })?.data?.domains || [];
    return domains
      .map((domain) => {
        const item = domain as { id?: unknown; domain?: unknown };
        return typeof item.id === 'string' && typeof item.domain === 'string'
          ? { id: item.id, domain: item.domain }
          : null;
      })
      .filter((domain): domain is TargetDomainForSslReissue => domain !== null);
  }

  private async issueTargetDomainSsl(
    targetServerId: string,
    siteId: string,
    domainId: string,
    userId: string,
  ): Promise<void> {
    const path = `/sites/${siteId}/domains/${domainId}/ssl/issue`;
    if (targetServerId === 'main') {
      await this.localPost(path, {}, userId);
      return;
    }

    const server = this.proxy.getServer(targetServerId);
    if (!server) throw new Error('Целевой сервер не найден');

    const { status, data } = await this.proxy.proxyRequest(server, 'POST', path, {});
    if (status >= 400) {
      const errMsg = (data as { error?: { message?: string } })?.error?.message || `HTTP ${status}`;
      throw new Error(errMsg);
    }
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

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function snapshotChecksum(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function emptyNodeRuntime(): NodeRuntimeSnapshot {
  return {
    autostartEnabled: false,
    ecosystems: [],
    processesToStop: [],
    orphanProcesses: [],
  };
}

function normalizeNodeRuntime(value: unknown): NodeRuntimeSnapshot {
  const raw = isObjectRecord(value) ? value : {};
  return {
    autostartEnabled: boolValue(raw.autostartEnabled, false),
    ecosystems: Array.isArray(raw.ecosystems)
      ? raw.ecosystems
          .filter(isObjectRecord)
          .map((ecosystem) => ({
            file: String(ecosystem.file || ''),
            only:
              typeof ecosystem.only === 'string' && ecosystem.only
                ? ecosystem.only
                : undefined,
          }))
          .filter((ecosystem) => !!safeRelativePath(ecosystem.file))
      : [],
    processesToStop: stringArrayValue(raw.processesToStop),
    orphanProcesses: stringArrayValue(raw.orphanProcesses),
  };
}

function normalizePreset(value: unknown, strict = false): SiteType {
  if (
    value === SiteType.MODX_REVO ||
    value === SiteType.MODX_3 ||
    value === SiteType.CUSTOM
  ) {
    return value;
  }
  if (strict) {
    throw new BadRequestException(`Invalid application preset "${String(value)}"`);
  }
  return SiteType.CUSTOM;
}

function normalizeAppStatus(value: unknown): DomainApplicationStatus {
  if (
    value === DomainApplicationStatus.PROVISIONING ||
    value === DomainApplicationStatus.RUNNING ||
    value === DomainApplicationStatus.DEPLOYING ||
    value === DomainApplicationStatus.UPDATING ||
    value === DomainApplicationStatus.ERROR
  ) {
    return value;
  }
  return value === 'ERROR'
    ? DomainApplicationStatus.ERROR
    : DomainApplicationStatus.RUNNING;
}

function normalizeDatabasePurpose(value: unknown): DatabasePurpose {
  if (value === DatabasePurpose.APP_PRIMARY) {
    return DatabasePurpose.APP_PRIMARY;
  }
  if (value === DatabasePurpose.AUXILIARY) {
    return DatabasePurpose.AUXILIARY;
  }
  throw new BadRequestException(`Invalid database purpose "${String(value)}"`);
}

function legacyRuntimeKey(domain: string, position: number): string {
  return `legacy-${createHash('sha256')
    .update(`${position}:${domain}`)
    .digest('hex')
    .slice(0, 24)}`;
}

function normalizeAliasesJson(value: unknown): string {
  if (typeof value === 'string') {
    return stringifySiteAliases(
      parseSiteAliases(value).map((alias) => ({
        domain: alias.domain.trim().toLowerCase(),
        redirect: alias.redirect,
      })),
    );
  }
  if (!Array.isArray(value)) return '[]';
  return stringifySiteAliases(
    value
      .map((alias) => {
        if (typeof alias === 'string') {
          return { domain: alias.trim().toLowerCase(), redirect: false };
        }
        if (!isObjectRecord(alias) || typeof alias.domain !== 'string') {
          return null;
        }
        return {
          domain: alias.domain.trim().toLowerCase(),
          redirect: alias.redirect === true,
        };
      })
      .filter(
        (
          alias,
        ): alias is {
          domain: string;
          redirect: boolean;
        } => !!alias?.domain,
      ),
  );
}

function stringRecordFromJson(value: string): Record<string, string> {
  const record = parseJsonObjectString(value);
  const result: Record<string, string> = {};
  for (const [key, nested] of Object.entries(record)) {
    if (typeof nested !== 'string') {
      throw new BadRequestException(
        `Environment variable "${key}" must be a string`,
      );
    }
    result[key] = nested;
  }
  return result;
}

function decryptTransferPassword(database: DatabaseSnapshot): string {
  if (!database.dbPasswordEnc) {
    throw new BadRequestException(
      `Database "${database.name}" has no encrypted password`,
    );
  }
  const decrypted = decryptJson<{ password?: string }>(database.dbPasswordEnc);
  if (!decrypted?.password) {
    throw new BadRequestException(
      `Database "${database.name}" password cannot be decrypted`,
    );
  }
  return decrypted.password;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableDateIso(value: unknown): string | null {
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return null;
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

function jsonObjectValue(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    return parseJsonObjectString(value);
  }
  if (isObjectRecord(value)) {
    return value;
  }
  return {};
}

function parseJsonObjectString(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return isObjectRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function firstDomainFromJson(value: unknown): string {
  return parseStringArray(typeof value === 'string' ? value : '[]')[0]?.trim().toLowerCase() || '';
}

function isMigratableSslStatus(status: string): boolean {
  return status === SslStatus.ACTIVE
    || status === SslStatus.EXPIRING_SOON
    || status === SslStatus.EXPIRED;
}

function dateFromIsoOrNull(value?: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function calcDaysRemaining(expiresAt: Date | null): number | null {
  if (!expiresAt) return null;
  return Math.floor((expiresAt.getTime() - Date.now()) / 86_400_000);
}

function sslStatusFromDaysRemaining(daysRemaining: number | null, fallback: string): SslStatus {
  if (daysRemaining === null) {
    return isMigratableSslStatus(fallback) ? fallback as SslStatus : SslStatus.ACTIVE;
  }
  if (daysRemaining <= 0) return SslStatus.EXPIRED;
  if (daysRemaining <= 30) return SslStatus.EXPIRING_SOON;
  return SslStatus.ACTIVE;
}

function chainPathForFullchain(certPath: string | null): string | null {
  if (!certPath || certPath.includes('\0')) return null;
  const resolved = path.resolve(certPath);
  if (path.basename(resolved) !== 'fullchain.pem') return null;
  return path.join(path.dirname(resolved), 'chain.pem');
}

const SSL_FILE_ALLOWED_PREFIXES = [
  '/etc/letsencrypt/live',
  '/etc/letsencrypt/archive',
  '/etc/ssl/meowbox',
];
const MAX_SSL_FILE_BYTES = 512 * 1024;

async function readAllowedSslFile(input: string): Promise<string> {
  if (!input || typeof input !== 'string') {
    throw new Error('SSL path is empty');
  }
  if (input.includes('\0') || !path.isAbsolute(input)) {
    throw new Error('SSL path is invalid');
  }
  const resolved = path.resolve(input);
  if (!isUnderAnyPrefix(resolved, SSL_FILE_ALLOWED_PREFIXES)) {
    throw new Error('SSL path is outside allowed directories');
  }

  const real = await fs.promises.realpath(resolved);
  if (!isUnderAnyPrefix(real, SSL_FILE_ALLOWED_PREFIXES)) {
    throw new Error('SSL path resolves outside allowed directories');
  }

  const stat = await fs.promises.stat(real);
  if (!stat.isFile()) {
    throw new Error('SSL path is not a file');
  }
  if (stat.size > MAX_SSL_FILE_BYTES) {
    throw new Error('SSL file is too large');
  }

  return fs.promises.readFile(real, 'utf8');
}

function isUnderAnyPrefix(filePath: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => {
    const normalizedPrefix = path.resolve(prefix);
    return filePath === normalizedPrefix || filePath.startsWith(normalizedPrefix + path.sep);
  });
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
  if (
    parts.some(
      (part) =>
        part === '.' ||
        part === '..' ||
        !/^[A-Za-z0-9._-]+$/.test(part),
    )
  ) {
    return null;
  }
  return parts.join('/');
}
