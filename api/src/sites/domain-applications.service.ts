import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import {
  AgentJobTerminalError,
  AgentRelayService,
} from '../gateway/agent-relay.service';
import { encryptCmsPassword, decryptCmsPassword } from '../common/crypto/cms-cipher';
import { DomainContextService } from './domain-context.service';
import { UpdateModxVersionDto } from './sites.dto';
import { canonicalizeHostname } from './domain-validation';
import {
  DB_IDENT_REGEX,
  MODX_VERSION_REGEX,
  SITE_NAME_REGEX,
} from '../common/validators/site-names';
import { SiteDomainsService } from './site-domains.service';
import { OperationsService } from '../operations/operations.service';
import { AppHandoffDelivery, safeErrorMessage } from '@meowbox/shared';
import { PanelIdentityService } from '../federation/panel-identity.service';
import { PublicDeliveryOriginService } from '../public-delivery/public-delivery-origin.service';
import { OperationAdmissionService } from '../operations/operation-admission.service';
import {
  OperationsWorkerService,
  type OperationExecutionContext,
} from '../operations/operations-worker.service';
import {
  OperationFailedError,
  OperationNeedsAttentionError,
} from '../operations/operation-errors';

const MODX_PRESETS = new Set(['MODX_REVO', 'MODX_3']);
const LOGIN_HANDOFF_TTL_MS = 60_000;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,128}$/;
const ACTIVE_SSL_STATUSES = new Set(['ACTIVE', 'EXPIRING_SOON']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SITE_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const RELATIVE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]{1,512}$/;
const ABSOLUTE_PATH_RE = /^\/[^\0]{0,4095}$/;
const RUNTIME_KEY_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const PHP_VERSION_RE = /^[0-9]{1,2}\.[0-9]{1,2}$/;
const DOMAIN_APPLICATION_OPERATION_ACTIONS = {
  MODX_UPDATE: 'domain.modx.update',
  MODX_DOCTOR: 'domain.modx.doctor',
  MODX_SETUP_CLEANUP: 'domain.modx.cleanup_setup',
  PERMISSIONS_NORMALIZE: 'domain.permissions.normalize',
} as const;
const DOMAIN_APPLICATION_AGENT_ACTIONS = {
  APPLICATION_SNAPSHOT: 'agent.application.snapshot',
  APPLICATION_RESTORE: 'agent.application.restore_snapshot',
  MODX_UPDATE: 'agent.modx.update',
  SITE_HEALTH_CHECK: 'agent.site.health_check',
  MODX_DOCTOR: 'agent.modx.doctor',
  MODX_SETUP_CLEANUP: 'agent.modx.cleanup_setup',
  PERMISSIONS_NORMALIZE: 'agent.domain.permissions_normalize',
} as const;

interface DomainOperationBase {
  siteId: string;
  domainId: string;
  rootPath: string;
  filesRelPath: string;
}

interface ModxDoctorOperationRequest extends DomainOperationBase {
  systemUser: string | null;
  managerPath: string;
  connectorsPath: string;
}

interface PermissionNormalizeOperationRequest extends DomainOperationBase {
  systemUser: string;
  siteType: string;
}

interface ModxUpdateOperationRequest extends DomainOperationBase {
  siteName: string;
  runtimeKey: string;
  preset: 'MODX_REVO' | 'MODX_3';
  phpVersion: string;
  targetVersion: string;
  previousVersion: string | null;
  domain: string;
  systemUser: string | null;
  managerPath: string;
  connectorsPath: string;
  database: {
    name: string;
    type: 'MARIADB' | 'MYSQL' | 'POSTGRESQL';
  };
}

function validateDomainOperationBase(
  value: Record<string, unknown>,
): DomainOperationBase {
  if (
    typeof value.siteId !== 'string' ||
    !UUID_RE.test(value.siteId) ||
    typeof value.domainId !== 'string' ||
    !UUID_RE.test(value.domainId) ||
    typeof value.rootPath !== 'string' ||
    !ABSOLUTE_PATH_RE.test(value.rootPath) ||
    typeof value.filesRelPath !== 'string' ||
    !RELATIVE_PATH_RE.test(value.filesRelPath)
  ) {
    throw new BadRequestException('Domain operation request is invalid');
  }
  return value as unknown as DomainOperationBase;
}

function validateModxDoctorRequest(request: unknown): ModxDoctorOperationRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new BadRequestException('MODX doctor operation request is invalid');
  }
  const value = request as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !==
      'connectorsPath,domainId,filesRelPath,managerPath,rootPath,siteId,systemUser' ||
    (value.systemUser !== null &&
      (typeof value.systemUser !== 'string' || !SITE_USER_RE.test(value.systemUser))) ||
    typeof value.managerPath !== 'string' ||
    !RELATIVE_PATH_RE.test(value.managerPath) ||
    typeof value.connectorsPath !== 'string' ||
    !RELATIVE_PATH_RE.test(value.connectorsPath)
  ) {
    throw new BadRequestException('MODX doctor operation request is invalid');
  }
  validateDomainOperationBase(value);
  return value as unknown as ModxDoctorOperationRequest;
}

function validateCleanupRequest(request: unknown): DomainOperationBase {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new BadRequestException('MODX cleanup operation request is invalid');
  }
  const value = request as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !==
      'domainId,filesRelPath,rootPath,siteId'
  ) {
    throw new BadRequestException('MODX cleanup operation request is invalid');
  }
  return validateDomainOperationBase(value);
}

function validatePermissionNormalizeRequest(
  request: unknown,
): PermissionNormalizeOperationRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new BadRequestException('Permission normalization request is invalid');
  }
  const value = request as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !==
      'domainId,filesRelPath,rootPath,siteId,siteType,systemUser' ||
    typeof value.systemUser !== 'string' ||
    !SITE_USER_RE.test(value.systemUser) ||
    typeof value.siteType !== 'string' ||
    !/^[A-Z][A-Z0-9_]{1,31}$/.test(value.siteType)
  ) {
    throw new BadRequestException('Permission normalization request is invalid');
  }
  validateDomainOperationBase(value);
  return value as unknown as PermissionNormalizeOperationRequest;
}

function validateModxUpdateRequest(request: unknown): ModxUpdateOperationRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new BadRequestException('MODX update operation request is invalid');
  }
  const value = request as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !==
      'connectorsPath,database,domain,domainId,filesRelPath,managerPath,phpVersion,preset,previousVersion,rootPath,runtimeKey,siteId,siteName,systemUser,targetVersion' ||
    typeof value.siteName !== 'string' ||
    !SITE_NAME_REGEX.test(value.siteName) ||
    typeof value.runtimeKey !== 'string' ||
    !RUNTIME_KEY_RE.test(value.runtimeKey) ||
    (value.preset !== 'MODX_REVO' && value.preset !== 'MODX_3') ||
    typeof value.phpVersion !== 'string' ||
    !PHP_VERSION_RE.test(value.phpVersion) ||
    typeof value.targetVersion !== 'string' ||
    !MODX_VERSION_REGEX.test(value.targetVersion) ||
    (value.previousVersion !== null &&
      (typeof value.previousVersion !== 'string' || value.previousVersion.length > 64)) ||
    typeof value.domain !== 'string' ||
    value.domain.length > 253 ||
    canonicalizeHostname(value.domain) !== value.domain ||
    (value.systemUser !== null &&
      (typeof value.systemUser !== 'string' || !SITE_USER_RE.test(value.systemUser))) ||
    typeof value.managerPath !== 'string' ||
    !RELATIVE_PATH_RE.test(value.managerPath) ||
    typeof value.connectorsPath !== 'string' ||
    !RELATIVE_PATH_RE.test(value.connectorsPath) ||
    !value.database ||
    typeof value.database !== 'object' ||
    Array.isArray(value.database)
  ) {
    throw new BadRequestException('MODX update operation request is invalid');
  }
  const database = value.database as Record<string, unknown>;
  if (
    Object.keys(database).sort().join(',') !== 'name,type' ||
    typeof database.name !== 'string' ||
    database.name.length > 64 ||
    !DB_IDENT_REGEX.test(database.name) ||
    typeof database.type !== 'string' ||
    !['MARIADB', 'MYSQL', 'POSTGRESQL'].includes(String(database.type))
  ) {
    throw new BadRequestException('MODX update database request is invalid');
  }
  validateDomainOperationBase(value);
  return value as unknown as ModxUpdateOperationRequest;
}

function validateSnapshotResult(result: unknown): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new OperationNeedsAttentionError('Application snapshot result is invalid');
  }
  const value = result as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !== 'snapshotPath' ||
    typeof value.snapshotPath !== 'string' ||
    !ABSOLUTE_PATH_RE.test(value.snapshotPath)
  ) {
    throw new OperationNeedsAttentionError('Application snapshot result is invalid');
  }
  return value.snapshotPath;
}

function validateModxUpdateResult(result: unknown, targetVersion: string): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new OperationNeedsAttentionError('MODX update result is invalid');
  }
  const value = result as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !== 'version' ||
    typeof value.version !== 'string' ||
    !MODX_VERSION_REGEX.test(value.version) ||
    value.version !== targetVersion
  ) {
    throw new OperationNeedsAttentionError('MODX update version confirmation is invalid');
  }
  return value.version;
}

function validateHealthResult(result: unknown): {
  reachable: boolean;
  statusCode: number | null;
} {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new OperationNeedsAttentionError('Application health result is invalid');
  }
  const value = result as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => !['reachable', 'statusCode', 'responseTimeMs'].includes(key),
    ) ||
    typeof value.reachable !== 'boolean' ||
    (value.statusCode !== null &&
      (typeof value.statusCode !== 'number' ||
        !Number.isInteger(value.statusCode) ||
        value.statusCode < 100 ||
        value.statusCode > 599)) ||
    typeof value.responseTimeMs !== 'number' ||
    !Number.isFinite(value.responseTimeMs) ||
    value.responseTimeMs < 0
  ) {
    throw new OperationNeedsAttentionError('Application health result is invalid');
  }
  return {
    reachable: value.reachable,
    statusCode: value.statusCode as number | null,
  };
}

function validateRestoreResult(result: unknown): void {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new OperationNeedsAttentionError('Application restore result is invalid');
  }
  const value = result as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'restored' || value.restored !== true) {
    throw new OperationNeedsAttentionError('Application restore was not confirmed');
  }
}

function validateModxDoctorResult(result: unknown): {
  modxCorePath?: string;
  modxVersion?: string;
  modxConfigOk: boolean;
  issues: Array<{
    id: string;
    level: 'critical' | 'warning' | 'info';
    title: string;
    description: string;
    details?: string[];
    fix?: 'normalize-permissions' | 'cleanup-setup-dir' | null;
  }>;
} {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new OperationNeedsAttentionError('MODX doctor returned an invalid result');
  }
  const value = result as Record<string, unknown>;
  const allowedResultKeys = new Set([
    'success',
    'modxCorePath',
    'modxVersion',
    'modxConfigOk',
    'issues',
    'error',
  ]);
  if (
    Object.keys(value).some((key) => !allowedResultKeys.has(key)) ||
    value.success !== true ||
    typeof value.modxConfigOk !== 'boolean' ||
    (value.modxCorePath !== undefined &&
      (typeof value.modxCorePath !== 'string' ||
        !ABSOLUTE_PATH_RE.test(value.modxCorePath))) ||
    (value.modxVersion !== undefined &&
      (typeof value.modxVersion !== 'string' || value.modxVersion.length > 64)) ||
    !Array.isArray(value.issues) ||
    value.issues.length > 64
  ) {
    throw new OperationNeedsAttentionError('MODX doctor returned an invalid result');
  }
  const issues = value.issues.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new OperationNeedsAttentionError('MODX doctor issue is invalid');
    }
    const issue = raw as Record<string, unknown>;
    const allowedIssueKeys = new Set([
      'id',
      'level',
      'title',
      'description',
      'details',
      'fix',
    ]);
    if (
      Object.keys(issue).some((key) => !allowedIssueKeys.has(key)) ||
      typeof issue.id !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(issue.id) ||
      !['critical', 'warning', 'info'].includes(String(issue.level)) ||
      typeof issue.title !== 'string' ||
      issue.title.length < 1 ||
      issue.title.length > 256 ||
      typeof issue.description !== 'string' ||
      issue.description.length < 1 ||
      issue.description.length > 4_096 ||
      (issue.details !== undefined &&
        (!Array.isArray(issue.details) ||
          issue.details.length > 50 ||
          issue.details.some(
            (detail) => typeof detail !== 'string' || detail.length > 4_096,
          ))) ||
      (issue.fix !== undefined &&
        issue.fix !== null &&
        issue.fix !== 'normalize-permissions' &&
        issue.fix !== 'cleanup-setup-dir')
    ) {
      throw new OperationNeedsAttentionError('MODX doctor issue is invalid');
    }
    return issue as unknown as {
      id: string;
      level: 'critical' | 'warning' | 'info';
      title: string;
      description: string;
      details?: string[];
      fix?: 'normalize-permissions' | 'cleanup-setup-dir' | null;
    };
  });
  const normalized = {
    ...(typeof value.modxCorePath === 'string'
      ? { modxCorePath: value.modxCorePath }
      : {}),
    ...(typeof value.modxVersion === 'string'
      ? { modxVersion: value.modxVersion }
      : {}),
    modxConfigOk: value.modxConfigOk,
    issues,
  };
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 512 * 1024) {
    throw new OperationNeedsAttentionError('MODX doctor result exceeds 512 KiB');
  }
  return normalized;
}

function validatePermissionNormalizeResult(result: unknown): {
  stepCount: number;
  modxCorePath?: string;
} {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new OperationNeedsAttentionError(
      'Permission normalization returned an invalid result',
    );
  }
  const value = result as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !['stepCount', 'modxCorePath'].includes(key)) ||
    typeof value.stepCount !== 'number' ||
    !Number.isInteger(value.stepCount) ||
    value.stepCount < 0 ||
    value.stepCount > 64 ||
    (value.modxCorePath !== undefined &&
      (typeof value.modxCorePath !== 'string' ||
        !ABSOLUTE_PATH_RE.test(value.modxCorePath)))
  ) {
    throw new OperationNeedsAttentionError(
      'Permission normalization returned an invalid result',
    );
  }
  return value as { stepCount: number; modxCorePath?: string };
}

function validateCleanupResult(result: unknown): {
  removed: boolean;
  reason?: string;
} {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new OperationNeedsAttentionError('MODX cleanup returned an invalid result');
  }
  const value = result as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !['removed', 'reason'].includes(key)) ||
    typeof value.removed !== 'boolean' ||
    (value.reason !== undefined &&
      (typeof value.reason !== 'string' || value.reason.length > 256))
  ) {
    throw new OperationNeedsAttentionError('MODX cleanup returned an invalid result');
  }
  return value as { removed: boolean; reason?: string };
}

interface LoginHandoff {
  siteId: string;
  domainId: string;
  expiresAt: number;
}

interface LoginHandoffReceipt extends LoginHandoff {
  delivery: AppHandoffDelivery;
}

interface ApplicationContext {
  site: {
    id: string;
    name: string;
    rootPath: string;
    systemUser: string | null;
  };
  domain: {
    id: string;
    domain: string;
    preset: string;
    appStatus: string;
    appErrorMessage: string | null;
    filesRelPath: string;
    phpVersion: string | null;
    phpPoolCustom: string | null;
    runtimeKey: string;
    gitRepository: string | null;
    deployBranch: string | null;
    cmsAdminUser: string | null;
    cmsAdminPasswordEnc: string | null;
    managerPath: string | null;
    connectorsPath: string | null;
    cmsTablePrefix: string | null;
    modxVersion: string | null;
    appPort: number | null;
    sslCertificate: { status: string } | null;
  };
  applicationRoot: string;
  isModx: boolean;
  phpEnabled: boolean;
  primaryDatabase: {
    id: string;
    name: string;
    type: string;
  } | null;
}

function assertModx(ctx: ApplicationContext): void {
  if (!ctx.isModx || !MODX_PRESETS.has(ctx.domain.preset)) {
    throw new ConflictException('Operation is available only for MODX applications');
  }
}

function normalizeModxPath(value: string | null, fallback: string): string {
  const clean = (value || fallback).trim().replace(/^\/+|\/+$/g, '');
  if (
    !clean ||
    clean.length > 255 ||
    clean.split('/').some((part) => part === '..' || part === '.' || part === '') ||
    /[\x00-\x1f\x7f]/.test(clean)
  ) {
    throw new ConflictException('Invalid MODX path');
  }
  return clean;
}

function htmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

@Injectable()
export class DomainApplicationsService implements OnModuleInit, OnModuleDestroy {
  private readonly loginHandoffs = new Map<string, LoginHandoff>();
  private readonly loginHandoffReceipts = new Map<string, LoginHandoffReceipt>();
  private unregisterOperationHandlers: Array<() => void> = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
    private readonly domains: DomainContextService,
    private readonly siteDomains: SiteDomainsService,
    private readonly operations: OperationsService,
    private readonly identity: PanelIdentityService,
    private readonly publicOrigins: PublicDeliveryOriginService,
    private readonly admission: OperationAdmissionService,
    private readonly worker: OperationsWorkerService,
  ) {}

  onModuleInit(): void {
    this.unregisterOperationHandlers.push(
      this.worker.registerHandler(
        DOMAIN_APPLICATION_OPERATION_ACTIONS.MODX_UPDATE,
        (request, context) => this.executeQueuedModxUpdate(request, context),
      ),
      this.worker.registerHandler(
        DOMAIN_APPLICATION_OPERATION_ACTIONS.MODX_DOCTOR,
        (request, context) => this.executeQueuedModxDoctor(request, context),
      ),
      this.worker.registerHandler(
        DOMAIN_APPLICATION_OPERATION_ACTIONS.MODX_SETUP_CLEANUP,
        (request, context) => this.executeQueuedCleanup(request, context),
      ),
      this.worker.registerHandler(
        DOMAIN_APPLICATION_OPERATION_ACTIONS.PERMISSIONS_NORMALIZE,
        (request, context) => this.executeQueuedPermissionNormalize(request, context),
      ),
    );
  }

  onModuleDestroy(): void {
    for (const unregister of this.unregisterOperationHandlers.splice(0)) unregister();
  }

  async getApplication(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
  ) {
    const ctx = await this.context(siteId, domainId, userId, role);
    const sslEnabled = ACTIVE_SSL_STATUSES.has(
      ctx.domain.sslCertificate?.status || '',
    );

    return {
      id: ctx.domain.id,
      domain: ctx.domain.domain,
      preset: ctx.domain.preset,
      appStatus: ctx.domain.appStatus,
      appErrorMessage: ctx.domain.appErrorMessage,
      filesRelPath: ctx.domain.filesRelPath,
      phpVersion: ctx.domain.phpVersion,
      runtimeKey: ctx.domain.runtimeKey,
      gitRepository: ctx.domain.gitRepository,
      deployBranch: ctx.domain.deployBranch,
      cmsAdminUser: ctx.domain.cmsAdminUser,
      hasCmsAdminPassword: !!ctx.domain.cmsAdminPasswordEnc,
      managerPath: ctx.domain.managerPath,
      connectorsPath: ctx.domain.connectorsPath,
      cmsTablePrefix: ctx.domain.cmsTablePrefix,
      modxVersion: ctx.domain.modxVersion,
      primaryDatabase: ctx.primaryDatabase,
      canonicalUrl: `${sslEnabled ? 'https' : 'http'}://${ctx.domain.domain}`,
    };
  }

  async getMetrics(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
  ) {
    const ctx = await this.context(siteId, domainId, userId, role);
    if (!ctx.site.systemUser) {
      return {
        cpuPercent: 0,
        memoryBytes: 0,
        diskBytes: 0,
        requestCount: 0,
        scope: 'domain',
        runtimeKey: ctx.domain.runtimeKey,
      };
    }

    const result = await this.agentRelay.emitToAgent('site:metrics', {
      siteDomainId: domainId,
      systemUser: ctx.site.systemUser,
      rootPath: ctx.site.rootPath,
      siteName: ctx.site.name,
      domain: ctx.domain.domain,
      preset: ctx.domain.preset,
      phpVersion: ctx.domain.phpVersion,
      appPort: ctx.domain.appPort,
      filesRelPath: ctx.domain.filesRelPath,
      runtimeKey: ctx.domain.runtimeKey,
    });
    if (!result.success) {
      return {
        cpuPercent: 0,
        memoryBytes: 0,
        diskBytes: 0,
        requestCount: 0,
        scope: 'domain',
        runtimeKey: ctx.domain.runtimeKey,
      };
    }
    return result.data;
  }

  async retryApplication(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    idempotencyKey?: string,
  ) {
    const ctx = await this.context(siteId, domainId, userId, role);
    const operation = await this.operations.begin({
      idempotencyKey,
      type: 'DOMAIN_APPLICATION_RETRY',
      siteId,
      siteDomainId: domainId,
      userId,
      request: {},
    });
    if (operation.replayed) {
      return {
        operationId: operation.id,
        operationStatus: operation.status,
        result: operation.result,
      };
    }
    if (ctx.domain.appStatus !== 'ERROR') {
      await this.operations.fail(
        operation.id,
        new Error('Only failed applications can be retried'),
      );
      throw new ConflictException('Only failed applications can be retried');
    }

    await this.operations.start(operation.id, 'claim');
    void (async () => {
      try {
        await this.siteDomains.retryDomainApplication(
          siteId,
          domainId,
          operation.id,
        );
        await this.operations.succeed(operation.id, {
          siteDomainId: domainId,
        });
      } catch (error) {
        await this.operations.fail(operation.id, error).catch(() => undefined);
      }
    })();
    return {
      operationId: operation.id,
      operationStatus: 'RUNNING',
      siteDomainId: domainId,
    };
  }

  async getPhpPoolConfig(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
  ) {
    const ctx = await this.context(siteId, domainId, userId, role);
    if (!ctx.domain.phpVersion) {
      throw new ConflictException('PHP is not enabled for this application');
    }

    const rendered = await this.agentRelay.emitToAgent<string | null>(
      'php:read-pool',
      {
        siteDomainId: domainId,
        runtimeKey: ctx.domain.runtimeKey,
        phpVersion: ctx.domain.phpVersion,
      },
    );

    return {
      custom: ctx.domain.phpPoolCustom ?? '',
      rendered: rendered.success ? rendered.data ?? null : null,
      phpVersion: ctx.domain.phpVersion,
      runtimeKey: ctx.domain.runtimeKey,
    };
  }

  async updatePhpPoolConfig(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    customConfig: string,
    idempotencyKey?: string,
  ) {
    const ctx = await this.context(siteId, domainId, userId, role);
    if (!ctx.domain.phpVersion) {
      throw new ConflictException('PHP is not enabled for this application');
    }
    const clean = (customConfig || '').trim();
    const dbValue = clean.length > 0 ? clean : null;
    const sslEnabled = ACTIVE_SSL_STATUSES.has(
      ctx.domain.sslCertificate?.status || '',
    );
    const poolPayload = (custom: string | null) => ({
      siteDomainId: domainId,
      runtimeKey: ctx.domain.runtimeKey,
      siteName: ctx.site.name,
      domain: ctx.domain.domain,
      phpVersion: ctx.domain.phpVersion,
      user: ctx.site.systemUser,
      rootPath: ctx.site.rootPath,
      filesRelPath: ctx.domain.filesRelPath,
      sslEnabled,
      customConfig: custom,
    });
    const operation = await this.operations.begin({
      idempotencyKey,
      type: 'DOMAIN_PHP_POOL_UPDATE',
      siteId,
      siteDomainId: domainId,
      lockSite: false,
      userId,
      request: {
        configSha256: createHash('sha256').update(clean).digest('hex'),
      },
    });
    if (operation.replayed) {
      if (operation.status !== 'SUCCEEDED') {
        throw new ConflictException(
          `PHP pool operation is ${operation.status}`,
        );
      }
      return { custom: ctx.domain.phpPoolCustom ?? '' };
    }
    await this.operations.start(operation.id, 'apply-runtime');

    let runtimeApplied = false;
    try {
      const result = await this.agentRelay.emitToAgent(
        'php:create-pool',
        poolPayload(dbValue),
      );
      if (!result.success) {
        throw new InternalServerErrorException(
          `Failed to apply PHP pool config: ${safeErrorMessage(
            result.error,
            'unknown agent error',
            800,
          )}`,
        );
      }
      runtimeApplied = true;

      await this.operations.step(operation.id, 'commit-metadata', 75);
      await this.prisma.siteDomain.update({
        where: { id: domainId },
        data: { phpPoolCustom: dbValue },
      });
      await this.operations.succeed(operation.id, { siteDomainId: domainId });
      return { custom: dbValue ?? '' };
    } catch (error) {
      const rollbackErrors: string[] = [];
      if (runtimeApplied) {
        await this.agentRelay
          .emitToAgent(
            'php:create-pool',
            poolPayload(ctx.domain.phpPoolCustom),
          )
          .then((rollback) => {
            if (!rollback.success) {
              rollbackErrors.push(
                `PHP pool: ${safeErrorMessage(
                  rollback.error,
                  'unknown agent error',
                )}`,
              );
            }
          })
          .catch((rollbackError) => {
            rollbackErrors.push(
              `PHP pool: ${safeErrorMessage(rollbackError)}`,
            );
          });
        await this.prisma.siteDomain
          .update({
            where: { id: domainId },
            data: { phpPoolCustom: ctx.domain.phpPoolCustom },
          })
          .catch((rollbackError) => {
            rollbackErrors.push(
              `metadata: ${safeErrorMessage(rollbackError)}`,
            );
          });
      }
      const failure =
        rollbackErrors.length > 0
          ? new Error(
              `${safeErrorMessage(error)}; rollback failed: ${rollbackErrors.join(
                '; ',
              )}`,
            )
          : error;
      await this.operations.fail(operation.id, failure).catch(() => undefined);
      if (rollbackErrors.length > 0) {
        throw new InternalServerErrorException(safeErrorMessage(failure));
      }
      throw error;
    }
  }

  async changeCmsAdminPassword(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    newPassword?: string,
    idempotencyKey?: string,
  ): Promise<{ password: string }> {
    const ctx = await this.context(siteId, domainId, userId, role);
    assertModx(ctx);
    if (role !== 'ADMIN') {
      throw new ForbiddenException('Admin role required');
    }
    if (!ctx.domain.cmsAdminUser) {
      throw new ConflictException('MODX administrator username is not configured');
    }

    const password = this.validateOrGeneratePassword(newPassword);
    const passwordPayload = (value: string) => ({
      siteDomainId: domainId,
      runtimeKey: ctx.domain.runtimeKey,
      rootPath: ctx.site.rootPath,
      filesRelPath: ctx.domain.filesRelPath,
      phpVersion: ctx.domain.phpVersion,
      systemUser: ctx.site.systemUser ?? undefined,
      username: ctx.domain.cmsAdminUser,
      password: value,
    });
    const operation = await this.operations.begin({
      idempotencyKey,
      type: 'MODX_ADMIN_PASSWORD_CHANGE',
      siteId,
      siteDomainId: domainId,
      lockSite: false,
      userId,
      request: {
        generated: !newPassword,
        passwordSha256: newPassword
          ? createHash('sha256').update(password).digest('hex')
          : null,
      },
    });
    if (operation.replayed) {
      if (
        operation.status !== 'SUCCEEDED' ||
        !ctx.domain.cmsAdminPasswordEnc
      ) {
        throw new ConflictException(
          `Password change operation is ${operation.status}`,
        );
      }
      return {
        password: decryptCmsPassword(ctx.domain.cmsAdminPasswordEnc),
      };
    }
    await this.operations.start(operation.id, 'commit-metadata');

    let metadataApplied = false;
    let agentApplied = false;
    try {
      await this.prisma.siteDomain.update({
        where: { id: domainId },
        data: { cmsAdminPasswordEnc: encryptCmsPassword(password) },
      });
      metadataApplied = true;
      await this.operations.step(operation.id, 'change-password', 45);

      const agentResult = await this.agentRelay.emitToAgent<{
        success: boolean;
        error?: string;
      }>('modx:change-admin-password', passwordPayload(password));
      if (!agentResult.success) {
        throw new InternalServerErrorException(
          `Failed to change MODX administrator password: ${safeErrorMessage(
            agentResult.error,
            'unknown agent error',
            800,
          )}`,
        );
      }
      agentApplied = true;
      await this.operations.succeed(operation.id, { siteDomainId: domainId });
      return { password };
    } catch (error) {
      const rollbackErrors: string[] = [];
      let agentRestored = !agentApplied;
      if (agentApplied && ctx.domain.cmsAdminPasswordEnc) {
        await this.agentRelay
          .emitToAgent(
            'modx:change-admin-password',
            passwordPayload(
              decryptCmsPassword(ctx.domain.cmsAdminPasswordEnc),
            ),
          )
          .then((rollback) => {
            agentRestored = rollback.success;
            if (!rollback.success) {
              rollbackErrors.push(
                `MODX password: ${safeErrorMessage(
                  rollback.error,
                  'unknown agent error',
                )}`,
              );
            }
          })
          .catch((rollbackError) => {
            rollbackErrors.push(
              `MODX password: ${safeErrorMessage(rollbackError)}`,
            );
          });
      } else if (agentApplied) {
        rollbackErrors.push(
          'MODX password: previous credential is unavailable',
        );
      }
      if (metadataApplied && agentRestored) {
        await this.prisma.siteDomain
          .update({
            where: { id: domainId },
            data: { cmsAdminPasswordEnc: ctx.domain.cmsAdminPasswordEnc },
          })
          .catch((rollbackError) => {
            rollbackErrors.push(
              `metadata: ${safeErrorMessage(rollbackError)}`,
            );
          });
      }
      const failure =
        rollbackErrors.length > 0
          ? new Error(
              `${safeErrorMessage(error)}; rollback failed: ${rollbackErrors.join(
                '; ',
              )}`,
            )
          : error;
      if (rollbackErrors.length > 0) {
        await this.prisma.siteDomain
          .update({
            where: { id: domainId },
            data: {
              appStatus: 'ERROR',
              appErrorMessage: safeErrorMessage(failure),
            },
          })
          .catch(() => undefined);
      }
      await this.operations.fail(operation.id, failure).catch(() => undefined);
      if (rollbackErrors.length > 0) {
        throw new InternalServerErrorException(safeErrorMessage(failure));
      }
      throw error;
    }
  }

  async updateModx(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    dto: UpdateModxVersionDto,
    idempotencyKey?: string,
  ) {
    const ctx = await this.context(siteId, domainId, userId, role);
    assertModx(ctx);
    if (!ctx.domain.phpVersion || !ctx.primaryDatabase) {
      throw new ConflictException('MODX update requires PHP and an APP_PRIMARY database');
    }

    const expectedMajor = ctx.domain.preset === 'MODX_REVO' ? '2.' : '3.';
    if (!dto.targetVersion.startsWith(expectedMajor)) {
      throw new ConflictException(
        `${ctx.domain.preset} can only be updated within major ${expectedMajor[0]}.x`,
      );
    }
    const request = validateModxUpdateRequest({
      siteId,
      domainId,
      siteName: ctx.site.name,
      rootPath: ctx.site.rootPath,
      filesRelPath: ctx.domain.filesRelPath,
      runtimeKey: ctx.domain.runtimeKey,
      preset: ctx.domain.preset,
      phpVersion: ctx.domain.phpVersion,
      targetVersion: dto.targetVersion,
      previousVersion: ctx.domain.modxVersion,
      domain: canonicalizeHostname(ctx.domain.domain),
      systemUser: ctx.site.systemUser,
      managerPath: normalizeModxPath(ctx.domain.managerPath, 'manager'),
      connectorsPath: normalizeModxPath(
        ctx.domain.connectorsPath,
        'connectors',
      ),
      database: {
        name: ctx.primaryDatabase.name,
        type: ctx.primaryDatabase.type,
      },
    });
    const accepted = await this.admission.admit({
      actionId: DOMAIN_APPLICATION_OPERATION_ACTIONS.MODX_UPDATE,
      type: 'MODX_UPDATE',
      idempotencyKey,
      actor: { userId, role },
      request,
      deadlineMs: 45 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      siteId,
      siteDomainId: domainId,
      lockSite: false,
    });
    if (!accepted.replayed && ctx.domain.appStatus !== 'RUNNING') {
      await this.operations.fail(
        accepted.operationId,
        new Error('Application must be RUNNING before update'),
      );
      throw new ConflictException('Application must be RUNNING before update');
    }
    return accepted;
  }

  async runModxDoctor(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
  ) {
    const ctx = await this.context(siteId, domainId, userId, role);
    assertModx(ctx);
    const result = await this.agentRelay.emitToAgent<{
      modxCorePath?: string;
      modxVersion?: string;
      modxConfigOk: boolean;
      issues: unknown[];
    }>(
      'site:modx-doctor',
      {
        rootPath: ctx.site.rootPath,
        filesRelPath: ctx.domain.filesRelPath,
        systemUser: ctx.site.systemUser,
        managerPath: normalizeModxPath(ctx.domain.managerPath, 'manager'),
        connectorsPath: normalizeModxPath(
          ctx.domain.connectorsPath,
          'connectors',
        ),
      },
      60_000,
    );
    if (!result.success) {
      throw new InternalServerErrorException(
        `MODX doctor failed: ${safeErrorMessage(
          result.error,
          'unknown agent error',
          800,
        )}`,
      );
    }
    return result.data || { modxConfigOk: false, issues: [] };
  }

  async enqueueModxDoctor(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    idempotencyKey?: string,
  ) {
    const ctx = await this.context(siteId, domainId, userId, role);
    assertModx(ctx);
    const request = validateModxDoctorRequest({
      siteId,
      domainId,
      rootPath: ctx.site.rootPath,
      filesRelPath: ctx.domain.filesRelPath,
      systemUser: ctx.site.systemUser,
      managerPath: normalizeModxPath(ctx.domain.managerPath, 'manager'),
      connectorsPath: normalizeModxPath(
        ctx.domain.connectorsPath,
        'connectors',
      ),
    });
    return this.admission.admit({
      actionId: DOMAIN_APPLICATION_OPERATION_ACTIONS.MODX_DOCTOR,
      type: 'MODX_DOCTOR',
      idempotencyKey,
      actor: { userId, role },
      request,
      deadlineMs: 5 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      siteId,
      lockSite: false,
    });
  }

  async cleanupSetup(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    idempotencyKey?: string,
  ) {
    const ctx = await this.context(siteId, domainId, userId, role);
    assertModx(ctx);
    if (role !== 'ADMIN') {
      throw new ForbiddenException('Admin role required');
    }
    const request = validateCleanupRequest({
      siteId,
      domainId,
      rootPath: ctx.site.rootPath,
      filesRelPath: ctx.domain.filesRelPath,
    });
    return this.admission.admit({
      actionId: DOMAIN_APPLICATION_OPERATION_ACTIONS.MODX_SETUP_CLEANUP,
      idempotencyKey,
      type: 'MODX_SETUP_CLEANUP',
      actor: { userId, role },
      request,
      deadlineMs: 5 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      siteId,
      siteDomainId: domainId,
      lockSite: false,
    });
  }

  async normalizePermissions(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    idempotencyKey?: string,
  ) {
    const ctx = await this.context(siteId, domainId, userId, role);
    if (role !== 'ADMIN') {
      throw new ForbiddenException('Admin role required');
    }
    if (!ctx.site.systemUser) {
      throw new ConflictException('Site system user is not configured');
    }
    const request = validatePermissionNormalizeRequest({
      siteId,
      domainId,
      rootPath: ctx.site.rootPath,
      filesRelPath: ctx.domain.filesRelPath,
      systemUser: ctx.site.systemUser,
      siteType: ctx.domain.preset,
    });
    return this.admission.admit({
      actionId: DOMAIN_APPLICATION_OPERATION_ACTIONS.PERMISSIONS_NORMALIZE,
      idempotencyKey,
      type: 'DOMAIN_PERMISSIONS_NORMALIZE',
      actor: { userId, role },
      request,
      deadlineMs: 10 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      siteId,
      siteDomainId: domainId,
      lockSite: false,
    });
  }

  private async executeQueuedModxUpdate(
    request: unknown,
    context: OperationExecutionContext,
  ) {
    const input = validateModxUpdateRequest(request);
    if (context.recovering) {
      const state = await this.prisma.siteDomain.findUnique({
        where: { id: input.domainId },
        select: { appStatus: true, modxVersion: true },
      });
      if (!state) {
        throw new OperationNeedsAttentionError('MODX update target no longer exists');
      }
      if (state.appStatus === 'RUNNING' && state.modxVersion === input.targetVersion) {
        return {
          version: input.targetVersion,
          previousVersion: input.previousVersion,
        };
      }
      if (state.appStatus !== 'UPDATING') {
        throw new OperationNeedsAttentionError(
          'MODX update target state changed before reconciliation',
        );
      }
    } else {
      const claimed = await this.prisma.siteDomain.updateMany({
        where: { id: input.domainId, appStatus: 'RUNNING' },
        data: { appStatus: 'UPDATING', appErrorMessage: null },
      });
      if (claimed.count !== 1) {
        throw new OperationNeedsAttentionError(
          'MODX update could not claim the application state',
        );
      }
    }

    let snapshotPath: string | null = null;
    let mutationStarted = false;
    let updateJobTerminal = false;
    try {
      await context.heartbeat('snapshot', 5);
      snapshotPath = validateSnapshotResult(
        await this.agentRelay.runAgentJob(
          {
            operationId: context.operationId,
            actionId: DOMAIN_APPLICATION_AGENT_ACTIONS.APPLICATION_SNAPSHOT,
            step: 'snapshot',
            payload: {
              operationId: context.operationId,
              siteName: input.siteName,
              siteDomainId: input.domainId,
              runtimeKey: input.runtimeKey,
              rootPath: input.rootPath,
              filesRelPath: input.filesRelPath,
              databases: [input.database],
            },
            deadlineAt: context.deadlineAt,
            cancelSafe: false,
          },
          () => context.isCancellationRequested(),
        ),
      );

      await context.heartbeat('update', 30);
      mutationStarted = true;
      let updateResult: unknown;
      try {
        updateResult = await this.agentRelay.runAgentJob(
          {
            operationId: context.operationId,
            actionId: DOMAIN_APPLICATION_AGENT_ACTIONS.MODX_UPDATE,
            step: 'update',
            payload: {
              operationId: context.operationId,
              siteId: input.siteId,
              siteDomainId: input.domainId,
              runtimeKey: input.runtimeKey,
              preset: input.preset,
              rootPath: input.rootPath,
              filesRelPath: input.filesRelPath,
              phpVersion: input.phpVersion,
              targetVersion: input.targetVersion,
              domain: input.domain,
              systemUser: input.systemUser || undefined,
              managerPath: input.managerPath,
              connectorsPath: input.connectorsPath,
            },
            deadlineAt: context.deadlineAt,
            cancelSafe: false,
          },
          () => context.isCancellationRequested(),
        );
        updateJobTerminal = true;
      } catch (error) {
        if (error instanceof AgentJobTerminalError) updateJobTerminal = true;
        throw error;
      }
      const finalVersion = validateModxUpdateResult(
        updateResult,
        input.targetVersion,
      );

      await context.heartbeat('post-update-health', 80);
      const health = await this.runModxHealthJob(
        input.domain,
        context,
        'post-update-health',
      );
      if (
        !health.reachable ||
        health.statusCode === null ||
        health.statusCode >= 500
      ) {
        throw new Error(
          `Post-update health check failed${
            health.statusCode ? ` (HTTP ${health.statusCode})` : ''
          }`,
        );
      }

      const committed = await this.prisma.siteDomain.updateMany({
        where: { id: input.domainId, appStatus: 'UPDATING' },
        data: {
          modxVersion: finalVersion,
          appStatus: 'RUNNING',
          appErrorMessage: null,
        },
      });
      if (committed.count !== 1) {
        throw new OperationNeedsAttentionError(
          'MODX update target state changed before commit',
        );
      }
      return { version: finalVersion, previousVersion: input.previousVersion };
    } catch (error) {
      if (!mutationStarted) {
        await this.prisma.siteDomain.updateMany({
          where: { id: input.domainId, appStatus: 'UPDATING' },
          data: {
            appStatus: 'RUNNING',
            appErrorMessage: null,
            modxVersion: input.previousVersion,
          },
        });
        if (error instanceof OperationNeedsAttentionError) throw error;
        throw new OperationFailedError(
          `MODX update failed before mutation: ${safeErrorMessage(error)}`,
        );
      }

      if (!updateJobTerminal || !snapshotPath) {
        const message = `MODX update outcome is unknown: ${safeErrorMessage(error)}`;
        await this.markModxUpdateAttention(input.domainId, message);
        throw new OperationNeedsAttentionError(message);
      }

      try {
        await context.heartbeat('restore', 90);
        validateRestoreResult(
          await this.agentRelay.runAgentJob(
            {
              operationId: context.operationId,
              actionId: DOMAIN_APPLICATION_AGENT_ACTIONS.APPLICATION_RESTORE,
              step: 'restore',
              payload: {
                operationId: context.operationId,
                siteDomainId: input.domainId,
                snapshotPath,
              },
              deadlineAt: context.deadlineAt,
              cancelSafe: false,
            },
            () => context.isCancellationRequested(),
          ),
        );
        await context.heartbeat('post-restore-health', 95);
        const restoredHealth = await this.runModxHealthJob(
          input.domain,
          context,
          'post-restore-health',
        );
        if (
          !restoredHealth.reachable ||
          restoredHealth.statusCode === null ||
          restoredHealth.statusCode >= 500
        ) {
          throw new OperationNeedsAttentionError(
            `Restored application failed health check${
              restoredHealth.statusCode
                ? ` (HTTP ${restoredHealth.statusCode})`
                : ''
            }`,
          );
        }
      } catch (restoreError) {
        const message = `MODX update failed and rollback is unconfirmed: ${safeErrorMessage(
          restoreError,
        )}`;
        await this.markModxUpdateAttention(input.domainId, message);
        throw new OperationNeedsAttentionError(message);
      }

      await this.prisma.siteDomain.update({
        where: { id: input.domainId },
        data: {
          appStatus: 'RUNNING',
          appErrorMessage: null,
          modxVersion: input.previousVersion,
        },
      });
      throw new OperationFailedError(
        `MODX update failed and rollback was verified: ${safeErrorMessage(error)}`,
      );
    }
  }

  private async runModxHealthJob(
    domain: string,
    context: OperationExecutionContext,
    step: string,
  ) {
    return validateHealthResult(
      await this.agentRelay.runAgentJob(
        {
          operationId: context.operationId,
          actionId: DOMAIN_APPLICATION_AGENT_ACTIONS.SITE_HEALTH_CHECK,
          step,
          payload: { domain, port: null },
          deadlineAt: context.deadlineAt,
          cancelSafe: false,
        },
        () => context.isCancellationRequested(),
      ),
    );
  }

  private async markModxUpdateAttention(
    domainId: string,
    message: string,
  ): Promise<void> {
    await this.prisma.siteDomain.updateMany({
      where: { id: domainId, appStatus: 'UPDATING' },
      data: {
        appStatus: 'ERROR',
        appErrorMessage: safeErrorMessage(message),
      },
    });
  }

  private async executeQueuedModxDoctor(
    request: unknown,
    context: OperationExecutionContext,
  ) {
    const input = validateModxDoctorRequest(request);
    await context.heartbeat('diagnose', 5);
    const result = await this.agentRelay.runAgentJob(
      {
        operationId: context.operationId,
        actionId: DOMAIN_APPLICATION_AGENT_ACTIONS.MODX_DOCTOR,
        step: 'diagnose',
        payload: {
          rootPath: input.rootPath,
          filesRelPath: input.filesRelPath,
          systemUser: input.systemUser || undefined,
          managerPath: input.managerPath,
          connectorsPath: input.connectorsPath,
        },
        deadlineAt: context.deadlineAt,
        cancelSafe: false,
      },
      () => context.isCancellationRequested(),
    );
    return validateModxDoctorResult(result);
  }

  private async executeQueuedCleanup(
    request: unknown,
    context: OperationExecutionContext,
  ) {
    const input = validateCleanupRequest(request);
    await context.heartbeat('remove-setup', 5);
    const result = await this.agentRelay.runAgentJob(
      {
        operationId: context.operationId,
        actionId: DOMAIN_APPLICATION_AGENT_ACTIONS.MODX_SETUP_CLEANUP,
        step: 'remove-setup',
        payload: {
          rootPath: input.rootPath,
          filesRelPath: input.filesRelPath,
        },
        deadlineAt: context.deadlineAt,
        cancelSafe: false,
      },
      () => context.isCancellationRequested(),
    );
    return validateCleanupResult(result);
  }

  private async executeQueuedPermissionNormalize(
    request: unknown,
    context: OperationExecutionContext,
  ) {
    const input = validatePermissionNormalizeRequest(request);
    await context.heartbeat('normalize-permissions', 5);
    const result = await this.agentRelay.runAgentJob(
      {
        operationId: context.operationId,
        actionId: DOMAIN_APPLICATION_AGENT_ACTIONS.PERMISSIONS_NORMALIZE,
        step: 'normalize-permissions',
        payload: {
          rootPath: input.rootPath,
          filesRelPath: input.filesRelPath,
          systemUser: input.systemUser,
          siteType: input.siteType,
        },
        deadlineAt: context.deadlineAt,
        cancelSafe: false,
      },
      () => context.isCancellationRequested(),
    );
    return validatePermissionNormalizeResult(result);
  }

  async createLoginHandoff(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    idempotencyKey?: string,
  ): Promise<AppHandoffDelivery> {
    const ctx = await this.context(siteId, domainId, userId, role);
    assertModx(ctx);
    if (role !== 'ADMIN') {
      throw new ForbiddenException('Admin role required');
    }
    if (!ctx.domain.cmsAdminUser || !ctx.domain.cmsAdminPasswordEnc) {
      throw new ConflictException('MODX administrator credentials are not configured');
    }
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new BadRequestException(
        'Idempotency-Key must be 8-128 printable ASCII characters',
      );
    }

    this.pruneLoginHandoffs();
    const receiptKey = `${userId}\0${idempotencyKey}`;
    const existing = this.loginHandoffReceipts.get(receiptKey);
    if (existing) {
      if (existing.siteId !== siteId || existing.domainId !== domainId) {
        throw new ConflictException(
          'Idempotency-Key is already bound to a different MODX login handoff',
        );
      }
      return existing.delivery;
    }

    const local = await this.identity.getLocalIdentity();
    const publicOrigin = this.publicOrigins.browserPublicOrigin();
    const raced = this.loginHandoffReceipts.get(receiptKey);
    if (raced) {
      if (raced.siteId !== siteId || raced.domainId !== domainId) {
        throw new ConflictException(
          'Idempotency-Key is already bound to a different MODX login handoff',
        );
      }
      return raced.delivery;
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + LOGIN_HANDOFF_TTL_MS;
    this.loginHandoffs.set(token, {
      siteId,
      domainId,
      expiresAt,
    });
    const delivery: AppHandoffDelivery = {
      kind: 'AppHandoff',
      purpose: 'MODX_LOGIN',
      targetInstallationId: local.installationId,
      resource: { kind: 'SITE_DOMAIN', id: domainId },
      method: 'GET',
      allowedHeaders: [],
      cachePolicy: 'NO_STORE',
      referrerPolicy: 'NO_REFERRER',
      expiresAt: new Date(expiresAt).toISOString(),
      browserReachabilityRequired: true,
      rangeSupported: false,
      resumeSupported: false,
      fallbackReason: null,
      oneTime: true,
      url: `${publicOrigin}/api/public/v1/modx/login#handoff=${token}`,
    };
    this.loginHandoffReceipts.set(receiptKey, {
      siteId,
      domainId,
      expiresAt,
      delivery,
    });
    return delivery;
  }

  async consumeLoginHandoff(token: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new NotFoundException('Login handoff not found');
    }
    const handoff = this.loginHandoffs.get(token);
    this.loginHandoffs.delete(token);
    if (!handoff || handoff.expiresAt <= Date.now()) {
      throw new GoneException('Login handoff expired or already used');
    }

    const domain = await this.prisma.siteDomain.findFirst({
      where: { id: handoff.domainId, siteId: handoff.siteId },
      include: { sslCertificate: true },
    });
    if (
      !domain ||
      !MODX_PRESETS.has(domain.preset) ||
      !domain.cmsAdminUser ||
      !domain.cmsAdminPasswordEnc
    ) {
      throw new GoneException('Login handoff is no longer valid');
    }

    const scheme = ACTIVE_SSL_STATUSES.has(
      domain.sslCertificate?.status || '',
    )
      ? 'https'
      : 'http';
    const hostname = canonicalizeHostname(domain.domain);
    const managerPath = normalizeModxPath(domain.managerPath, 'manager');
    const action = `${scheme}://${hostname}/${managerPath}/`;
    const password = decryptCmsPassword(domain.cmsAdminPasswordEnc);

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex,nofollow">
  <title>MODX sign-in</title>
</head>
<body onload="document.forms[0].submit()">
  <form method="post" action="${htmlEscape(action)}">
    <input type="hidden" name="username" value="${htmlEscape(domain.cmsAdminUser)}">
    <input type="hidden" name="password" value="${htmlEscape(password)}">
    <input type="hidden" name="login_context" value="mgr">
    <input type="hidden" name="rememberme" value="1">
    <input type="hidden" name="login" value="1">
    <input type="hidden" name="modhash" value="">
    <input type="hidden" name="returnUrl" value="/${htmlEscape(managerPath)}/">
    <button type="submit">Continue to MODX</button>
  </form>
</body>
</html>`;
  }

  private async context(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
  ): Promise<ApplicationContext> {
    return this.domains.requireOwnedSiteDomain(
      siteId,
      domainId,
      userId,
      role,
    ) as Promise<ApplicationContext>;
  }

  private validateOrGeneratePassword(newPassword?: string): string {
    if (!newPassword) return randomBytes(16).toString('base64url');
    if (newPassword.length < 8 || newPassword.length > 128) {
      throw new ConflictException('Password length must be between 8 and 128 characters');
    }
    if (/[\x00-\x1f\x7f]/.test(newPassword)) {
      throw new ConflictException('Password contains control characters');
    }
    return newPassword;
  }

  private pruneLoginHandoffs(): void {
    const now = Date.now();
    for (const [token, handoff] of this.loginHandoffs) {
      if (handoff.expiresAt <= now) this.loginHandoffs.delete(token);
    }
    for (const [key, receipt] of this.loginHandoffReceipts) {
      if (receipt.expiresAt <= now) this.loginHandoffReceipts.delete(key);
    }
  }
}
