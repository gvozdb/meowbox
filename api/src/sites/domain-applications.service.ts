import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { encryptCmsPassword, decryptCmsPassword } from '../common/crypto/cms-cipher';
import { DomainContextService } from './domain-context.service';
import { UpdateModxVersionDto } from './sites.dto';
import { canonicalizeHostname } from './domain-validation';
import { SiteDomainsService } from './site-domains.service';
import { OperationsService } from '../operations/operations.service';
import { safeErrorMessage } from '@meowbox/shared';

const MODX_PRESETS = new Set(['MODX_REVO', 'MODX_3']);
const LOGIN_HANDOFF_TTL_MS = 60_000;
const ACTIVE_SSL_STATUSES = new Set(['ACTIVE', 'EXPIRING_SOON']);

interface LoginHandoff {
  siteId: string;
  domainId: string;
  expiresAt: number;
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
export class DomainApplicationsService {
  private readonly loginHandoffs = new Map<string, LoginHandoff>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
    private readonly domains: DomainContextService,
    private readonly siteDomains: SiteDomainsService,
    private readonly operations: OperationsService,
  ) {}

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

    const previousVersion = ctx.domain.modxVersion;
    const operation = await this.operations.begin({
      idempotencyKey,
      type: 'MODX_UPDATE',
      siteId,
      siteDomainId: domainId,
      lockSite: false,
      userId,
      request: { targetVersion: dto.targetVersion },
    });
    if (operation.replayed) {
      return {
        operationId: operation.id,
        operationStatus: operation.status,
        ...(operation.result &&
        typeof operation.result === 'object' &&
        !Array.isArray(operation.result)
          ? (operation.result as Record<string, unknown>)
          : {}),
      };
    }
    if (ctx.domain.appStatus !== 'RUNNING') {
      await this.operations.fail(
        operation.id,
        new Error('Application must be RUNNING before update'),
      );
      throw new ConflictException('Application must be RUNNING before update');
    }

    await this.operations.start(operation.id, 'snapshot');
    const claimed = await this.prisma.siteDomain.updateMany({
      where: { id: domainId, appStatus: 'RUNNING' },
      data: { appStatus: 'UPDATING', appErrorMessage: null },
    });
    if (claimed.count !== 1) {
      await this.operations.fail(
        operation.id,
        new Error('Application is already being changed'),
      );
      throw new ConflictException('Application is already being changed');
    }

    let snapshotPath: string | null = null;
    let mutationStarted = false;
    try {
      const snapshot = await this.agentRelay.emitToAgent<{
        snapshotPath?: string;
      }>(
        'application:snapshot',
        {
          operationId: operation.id,
          siteName: ctx.site.name,
          siteDomainId: domainId,
          runtimeKey: ctx.domain.runtimeKey,
          rootPath: ctx.site.rootPath,
          filesRelPath: ctx.domain.filesRelPath,
          databases: [
            {
              name: ctx.primaryDatabase.name,
              type: ctx.primaryDatabase.type,
            },
          ],
        },
        900_000,
      );
      if (!snapshot.success || !snapshot.data?.snapshotPath) {
        throw new Error(
          snapshot.error || 'Application snapshot did not produce a path',
        );
      }
      snapshotPath = snapshot.data.snapshotPath;
      await this.operations.step(operation.id, 'update', 30);
      mutationStarted = true;

      const result = await this.agentRelay.emitToAgent<{ version?: string }>(
        'site:update-modx',
        {
          operationId: operation.id,
          siteId,
          siteDomainId: domainId,
          runtimeKey: ctx.domain.runtimeKey,
          preset: ctx.domain.preset,
          rootPath: ctx.site.rootPath,
          filesRelPath: ctx.domain.filesRelPath,
          phpVersion: ctx.domain.phpVersion,
          targetVersion: dto.targetVersion,
          domain: ctx.domain.domain,
          systemUser: ctx.site.systemUser,
          managerPath: normalizeModxPath(ctx.domain.managerPath, 'manager'),
          connectorsPath: normalizeModxPath(
            ctx.domain.connectorsPath,
            'connectors',
          ),
          database: ctx.primaryDatabase,
        },
        900_000,
      );
      if (!result.success) {
        throw new Error(
          safeErrorMessage(result.error, 'unknown agent error'),
        );
      }

      const finalVersion = result.data?.version || dto.targetVersion;
      await this.operations.step(operation.id, 'health-check', 80);
      const health = await this.agentRelay.emitToAgent<{
        reachable: boolean;
        statusCode: number | null;
      }>(
        'site:health-check',
        { domain: ctx.domain.domain, port: null },
        15_000,
      );
      const statusCode = health.data?.statusCode ?? 0;
      if (
        !health.success ||
        !health.data?.reachable ||
        statusCode < 1 ||
        statusCode >= 500
      ) {
        throw new Error(
          `Post-update health check failed${
            statusCode ? ` (HTTP ${statusCode})` : ''
          }`,
        );
      }

      await this.prisma.siteDomain.update({
        where: { id: domainId },
        data: {
          modxVersion: finalVersion,
          appStatus: 'RUNNING',
          appErrorMessage: null,
        },
      });
      const operationResult = { version: finalVersion, previousVersion };
      await this.operations.succeed(operation.id, operationResult);
      return {
        operationId: operation.id,
        operationStatus: 'SUCCEEDED',
        ...operationResult,
      };
    } catch (error) {
      let restored = !mutationStarted;
      let restoreError: string | null = null;
      if (mutationStarted && snapshotPath) {
        await this.operations
          .step(operation.id, 'restore', 90)
          .catch(() => undefined);
        const restore = await this.agentRelay.emitToAgent(
          'application:restore-snapshot',
          {
            operationId: operation.id,
            siteDomainId: domainId,
            snapshotPath,
          },
          900_000,
        );
        restored = restore.success;
        restoreError = restore.success
          ? null
          : restore.error || 'unknown restore error';

        if (restored) {
          const health = await this.agentRelay.emitToAgent<{
            reachable: boolean;
            statusCode: number | null;
          }>(
            'site:health-check',
            { domain: ctx.domain.domain, port: null },
            15_000,
          );
          const code = health.data?.statusCode ?? 0;
          restored =
            health.success &&
            health.data?.reachable === true &&
            code > 0 &&
            code < 500;
          if (!restored) {
            restoreError = `restored files failed health check${
              code ? ` (HTTP ${code})` : ''
            }`;
          }
        }
      }

      await this.prisma.siteDomain.update({
        where: { id: domainId },
        data: restored
          ? {
              appStatus: 'RUNNING',
              appErrorMessage: null,
              modxVersion: previousVersion,
            }
          : {
              appStatus: 'ERROR',
              appErrorMessage: safeErrorMessage(
                `${safeErrorMessage(error)}; restore failed: ${
                  restoreError || 'snapshot unavailable'
                }`,
              ),
            },
      });
      await this.operations.fail(operation.id, error);
      throw new InternalServerErrorException(
        restored
          ? `MODX update failed and was restored: ${safeErrorMessage(
              error,
              'unknown update error',
              800,
            )}`
          : `MODX update failed; restore failed: ${safeErrorMessage(
              restoreError || error,
              'unknown restore error',
              800,
            )}`,
      );
    }
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
    const operation = await this.operations.begin({
      idempotencyKey,
      type: 'MODX_SETUP_CLEANUP',
      siteId,
      siteDomainId: domainId,
      lockSite: false,
      userId,
      request: {},
    });
    if (operation.replayed) {
      if (operation.status !== 'SUCCEEDED') {
        throw new ConflictException(
          `Setup cleanup operation is ${operation.status}`,
        );
      }
      const replay =
        operation.result &&
        typeof operation.result === 'object' &&
        !Array.isArray(operation.result)
          ? (operation.result as Record<string, unknown>)
          : {};
      return { removed: replay.removed === true };
    }
    await this.operations.start(operation.id, 'remove-setup');
    try {
      const result = await this.agentRelay.emitToAgent<{
        removed: boolean;
        path?: string;
        reason?: string;
      }>(
        'site:cleanup-setup-dir',
        {
          rootPath: ctx.site.rootPath,
          filesRelPath: ctx.domain.filesRelPath,
        },
        30_000,
      );
      if (!result.success) {
        throw new InternalServerErrorException(
          `Failed to remove setup directory: ${safeErrorMessage(
            result.error,
            'unknown agent error',
            800,
          )}`,
        );
      }
      const response = result.data || { removed: false };
      await this.operations.succeed(operation.id, {
        siteDomainId: domainId,
        removed: response.removed === true,
      });
      return response;
    } catch (error) {
      await this.operations.fail(operation.id, error).catch(() => undefined);
      throw error;
    }
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
    const operation = await this.operations.begin({
      idempotencyKey,
      type: 'DOMAIN_PERMISSIONS_NORMALIZE',
      siteId,
      siteDomainId: domainId,
      lockSite: false,
      userId,
      request: {},
    });
    if (operation.replayed) {
      if (operation.status !== 'SUCCEEDED') {
        throw new ConflictException(
          `Permission normalization operation is ${operation.status}`,
        );
      }
      return { steps: [] };
    }
    await this.operations.start(operation.id, 'normalize-permissions');
    try {
      const result = await this.agentRelay.emitToAgent<{
        steps: Array<{ cmd: string; ok: boolean; error?: string }>;
        modxCorePath?: string;
      }>(
        'site:normalize-permissions',
        {
          rootPath: ctx.site.rootPath,
          filesRelPath: ctx.domain.filesRelPath,
          systemUser: ctx.site.systemUser,
          siteType: ctx.domain.preset,
        },
        120_000,
      );
      if (!result.success) {
        throw new InternalServerErrorException(
          `Failed to normalize permissions: ${safeErrorMessage(
            result.error,
            'unknown agent error',
            800,
          )}`,
        );
      }
      const response = {
        steps: result.data?.steps || [],
        modxCorePath: result.data?.modxCorePath,
      };
      await this.operations.succeed(operation.id, {
        siteDomainId: domainId,
        stepCount: response.steps.length,
      });
      return response;
    } catch (error) {
      await this.operations.fail(operation.id, error).catch(() => undefined);
      throw error;
    }
  }

  async createLoginHandoff(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
  ): Promise<{ token: string; expiresInSeconds: number }> {
    const ctx = await this.context(siteId, domainId, userId, role);
    assertModx(ctx);
    if (role !== 'ADMIN') {
      throw new ForbiddenException('Admin role required');
    }
    if (!ctx.domain.cmsAdminUser || !ctx.domain.cmsAdminPasswordEnc) {
      throw new ConflictException('MODX administrator credentials are not configured');
    }

    this.pruneLoginHandoffs();
    const token = randomBytes(32).toString('base64url');
    this.loginHandoffs.set(token, {
      siteId,
      domainId,
      expiresAt: Date.now() + LOGIN_HANDOFF_TTL_MS,
    });
    return { token, expiresInSeconds: LOGIN_HANDOFF_TTL_MS / 1000 };
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
  }
}
