/**
 * Сервис мульти-доменной модели сайта (`SiteDomain`).
 *
 * Один Site = N основных доменов. Ровно один `isPrimary=true` (position=0).
 *
 * После ЛЮБОГО изменения доменов:
 *  - обновление Site-level PHP CLI shim по primary domain;
 *  - регенерация nginx всего сайта (`regenerateNginx`);
 *  - регенерация глобальных rate-limit zones при create/delete.
 */

import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import { initialCustomConfigFor } from '@meowbox/shared';

import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { hashPassword } from '../common/crypto/argon2.helper';
import {
  decryptDbPassword,
  encryptDbPassword,
} from '../common/crypto/database-cipher';
import {
  decryptCmsPassword,
  encryptCmsPassword,
} from '../common/crypto/cms-cipher';
import {
  stringifySiteAliases,
  parseSiteAliases,
} from '../common/json-array';
import { DatabaseType, SiteStatus, SslStatus } from '../common/enums';
import {
  buildMultiDomainNginxPayload,
  serializeSiteDomain,
  nginxZoneName,
  type RawSiteForNginx,
} from './site-domains.helper';
import {
  CreateSiteDomainDto,
  UpdateSiteDomainDto,
  UpdateSiteDomainAliasesDto,
  DeleteSiteDomainDto,
} from './site-domains.dto';
import {
  canonicalizeHostname,
  normalizeFilesRelPath,
  runtimeKeyForDomain,
  validateEnvVars,
} from './domain-validation';
import { OperationsService } from '../operations/operations.service';
import { safeErrorMessage } from '@meowbox/shared';
import {
  createHostnameClaims,
  HOSTNAME_REGISTRY_LOCK,
  replaceHostnameClaims,
  rethrowHostnameClaimConflict,
} from './hostname-registry';

/** include-фрагмент: домены сайта с их SSL-сертификатами, отсортированные. */
const DOMAINS_WITH_SSL = {
  domains: {
    orderBy: { position: 'asc' as const },
    include: {
      sslCertificate: true,
      databases: true,
    },
  },
} satisfies Prisma.SiteInclude;

/** Application plus the Site roots needed to detect an intentional shared root. */
const APPLICATION_WITH_ROOT_SHARERS = {
  site: {
    include: {
      domains: {
        select: {
          id: true,
          filesRelPath: true,
          appStatus: true,
        },
      },
    },
  },
  sslCertificate: true,
  databases: true,
} satisfies Prisma.SiteDomainInclude;

@Injectable()
export class SiteDomainsService {
  private readonly logger = new Logger('SiteDomainsService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
    private readonly operations: OperationsService,
  ) {}

  // ===========================================================================
  // Чтение
  // ===========================================================================

  /** Загружает сайт с доменами + проверяет доступ. */
  private async requireSiteWithDomains(siteId: string, userId: string, role: string) {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      include: DOMAINS_WITH_SSL,
    });
    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    return site;
  }

  async listDomains(siteId: string, userId: string, role: string) {
    const site = await this.requireSiteWithDomains(siteId, userId, role);
    return site.domains.map((d) =>
      serializeSiteDomain({ ...d, siteId: site.id }),
    );
  }

  // ===========================================================================
  // Создание неглавного домена
  // ===========================================================================

  async createDomain(
    siteId: string,
    dto: CreateSiteDomainDto,
    userId: string,
    role: string,
    idempotencyKey?: string,
  ) {
    if (dto.skipInstall === true) {
      throw new ForbiddenException(
        'skipInstall is unavailable for public domain creation',
      );
    }
    const site = await this.requireSiteWithDomains(siteId, userId, role);
    const domain = this.canonicalHostname(dto.domain);
    const normalizedAliases = this.normalizeAliases(dto.aliases || []);
    const aliases = normalizedAliases.map((alias) => alias.domain);
    const filesRelPath = this.applicationPath(dto.filesRelPath);
    const preset = dto.preset;
    const isModx = preset === 'MODX_REVO' || preset === 'MODX_3';
    const phpVersion = isModx ? dto.phpVersion || '8.2' : dto.phpVersion || null;
    const reusesExistingRoot = this.hasRunningSharedApplicationRoot(
      site.domains,
      filesRelPath,
    );
    this.assertSharedRootPreset(preset, reusesExistingRoot);

    if (isModx && dto.dbType === 'POSTGRESQL') {
      throw new BadRequestException('MODX requires MariaDB or MySQL');
    }
    this.assertEnvVars(dto.envVars);

    const operation = await this.operations.begin({
      idempotencyKey,
      type: 'DOMAIN_CREATE',
      siteId,
      globalLockKey: HOSTNAME_REGISTRY_LOCK,
      userId,
      request: {
        ...dto,
        domain,
        aliases,
        filesRelPath,
      },
    });
    if (operation.replayed) {
      return {
        operationId: operation.id,
        operationStatus: operation.status,
        result: operation.result,
      };
    }
    await this.operations.start(operation.id, 'reserve');

    try {
      await this.assertDomainFree(domain, null);
      for (const alias of aliases) {
        await this.assertDomainFree(alias, null, domain);
      }
      await this.ensureDomainFreeInNginx([domain, ...aliases]);

      const maxPosition = site.domains.reduce((m, d) => Math.max(m, d.position), 0);
      const id = randomUUID();
      const runtimeKey = runtimeKeyForDomain(id);

      const storedAliases = stringifySiteAliases(normalizedAliases);
      await this.prisma
        .$transaction(async (tx) => {
          await tx.siteDomain.create({
            data: {
              id,
              siteId: site.id,
              domain,
              isPrimary: false,
              position: maxPosition + 1,
              aliases: storedAliases,
              preset,
              appStatus: 'PROVISIONING',
              appErrorMessage: null,
              filesRelPath,
              phpVersion,
              phpPoolCustom: dto.phpPoolCustom?.trim() || null,
              runtimeKey,
              gitRepository: dto.gitRepository?.trim() || null,
              deployBranch: dto.deployBranch?.trim() || 'main',
              envVars: JSON.stringify(dto.envVars || {}),
              appPort: null,
              httpsRedirect: dto.httpsRedirect !== false,
              nginxCustomConfig: initialCustomConfigFor(preset),
              cmsAdminUser: isModx
                ? dto.cmsAdminUser?.trim() || site.systemUser
                : null,
              managerPath: isModx
                ? dto.managerPath?.trim() || 'manager'
                : null,
              connectorsPath: isModx
                ? dto.connectorsPath?.trim() || 'connectors'
                : null,
              cmsTablePrefix: isModx
                ? dto.cmsTablePrefix || `${this.randomLowercase(7)}_`
                : null,
              modxVersion: isModx ? dto.modxVersion || null : null,
            },
          });
          await createHostnameClaims(tx, {
            siteDomainId: id,
            domain,
            aliases: storedAliases,
          });
          await tx.sslCertificate.create({
            data: {
              siteId: site.id,
              domainId: id,
              domains: JSON.stringify([domain, ...aliases]),
              status: SslStatus.NONE,
              issuer: '',
            },
          });
        })
        .catch(rethrowHostnameClaimConflict);
      await this.operations.attachScope(operation.id, {
        siteId,
        siteDomainId: id,
      });
      await this.operations.step(operation.id, 'configure-routing', 15);

      try {
        await this.syncPrimaryPhpCliShim(site.id);
        await this.regenerateGlobalZones();
        await this.regenerateNginx(site.id);
      } catch (error) {
        const message = safeErrorMessage(error);
        await this.prisma.siteDomain.update({
          where: { id },
          data: {
            appStatus: 'ERROR',
            appErrorMessage: message,
          },
        });
        throw error;
      }

      this.provisionDomainApplication(
        site.id,
        id,
        dto,
        operation.id,
      )
        .then(() =>
          this.operations.succeed(operation.id, { siteDomainId: id }),
        )
        .catch(async (error) => {
          const message = safeErrorMessage(
            error,
            'Unknown provisioning error',
          );
          this.logger.error(`Domain application ${id} provisioning failed: ${message}`);
          await this.prisma.siteDomain
            .update({
              where: { id },
              data: {
                appStatus: 'ERROR',
                appErrorMessage: message,
              },
            })
            .catch(() => undefined);
          await this.operations.fail(operation.id, error);
        });

      this.logger.log(`Domain "${domain}" added to site "${site.name}"`);
      return {
        operationId: operation.id,
        operationStatus: 'RUNNING',
        domains: await this.listDomains(site.id, userId, role),
      };
    } catch (error) {
      const message = safeErrorMessage(error);
      await this.operations.fail(operation.id, error);
      throw error;
    }
  }

  // ===========================================================================
  // Обновление домена
  // ===========================================================================

  async updateDomain(
    siteId: string,
    domainId: string,
    dto: UpdateSiteDomainDto,
    userId: string,
    role: string,
    idempotencyKey?: string,
  ) {
    const site = await this.requireSiteWithDomains(siteId, userId, role);
    const target = site.domains.find((d) => d.id === domainId);
    if (!target) throw new NotFoundException('Domain not found');
    if (['PROVISIONING', 'DEPLOYING', 'UPDATING'].includes(target.appStatus)) {
      throw new ConflictException(
        `Application is busy (${target.appStatus}); retry after it finishes`,
      );
    }
    this.assertEnvVars(dto.envVars);

    const data: Prisma.SiteDomainUpdateInput = {};
    let domainChanged = false;
    let newDomain = target.domain;
    const oldPhpVersion = target.phpVersion;

    if (dto.domain !== undefined) {
      newDomain = this.canonicalHostname(dto.domain);
      if (newDomain !== target.domain) {
        data.domain = newDomain;
        domainChanged = true;
      }
    }

    if (dto.httpsRedirect !== undefined) {
      data.httpsRedirect = !!dto.httpsRedirect;
    }

    if (dto.filesRelPath !== undefined) {
      data.filesRelPath = this.applicationPath(dto.filesRelPath);
    }
    if (dto.phpVersion !== undefined) {
      if (
        dto.phpVersion === null &&
        (target.preset === 'MODX_REVO' || target.preset === 'MODX_3')
      ) {
        throw new BadRequestException('PHP cannot be disabled for MODX');
      }
      data.phpVersion = dto.phpVersion;
    }
    if (dto.gitRepository !== undefined) {
      data.gitRepository = dto.gitRepository?.trim() || null;
    }
    if (dto.deployBranch !== undefined) {
      data.deployBranch = dto.deployBranch?.trim() || 'main';
    }
    if (dto.envVars !== undefined) {
      data.envVars = JSON.stringify(dto.envVars);
    }

    const nextPhpVersion =
      dto.phpVersion !== undefined ? dto.phpVersion : target.phpVersion;
    const nextFilesRelPath =
      dto.filesRelPath !== undefined
        ? this.applicationPath(dto.filesRelPath)
        : target.filesRelPath;
    const phpConfigChanged =
      dto.phpVersion !== undefined || dto.filesRelPath !== undefined;
    if (!this.agentRelay.isAgentConnected()) {
      throw new ConflictException('Agent is offline; domain update is unavailable');
    }
    const operation = await this.operations.begin({
      idempotencyKey,
      type: 'DOMAIN_UPDATE',
      siteId,
      siteDomainId: domainId,
      globalLockKey: domainChanged ? HOSTNAME_REGISTRY_LOCK : null,
      userId,
      request: {
        ...dto,
        domain: newDomain,
        filesRelPath: nextFilesRelPath,
        phpVersion: nextPhpVersion,
      },
    });
    if (operation.replayed) {
      return {
        operationId: operation.id,
        operationStatus: operation.status,
        result: operation.result,
      };
    }
    await this.operations.start(
      operation.id,
      domainChanged ? 'validate-hostname' : 'apply-runtime',
    );

    const sslWasEnabled =
      target.sslCertificate?.status === SslStatus.ACTIVE ||
      target.sslCertificate?.status === SslStatus.EXPIRING_SOON;
    const previousData: Prisma.SiteDomainUpdateInput = {
      domain: target.domain,
      filesRelPath: target.filesRelPath,
      phpVersion: target.phpVersion,
      gitRepository: target.gitRepository,
      deployBranch: target.deployBranch,
      envVars: target.envVars,
      httpsRedirect: target.httpsRedirect,
    };
    const previousCertificate = target.sslCertificate
      ? {
          domains: target.sslCertificate.domains,
          status: target.sslCertificate.status,
          issuer: target.sslCertificate.issuer,
          isWildcard: target.sslCertificate.isWildcard,
          issuedAt: target.sslCertificate.issuedAt,
          expiresAt: target.sslCertificate.expiresAt,
          daysRemaining: target.sslCertificate.daysRemaining,
          certPath: target.sslCertificate.certPath,
          keyPath: target.sslCertificate.keyPath,
        }
      : null;
    let newPoolApplied = false;
    let metadataApplied = false;
    let certificateReset = false;

    try {
      if (domainChanged) {
        await this.assertDomainFree(newDomain, domainId);
        await this.ensureDomainFreeInNginx(
          [newDomain],
          target.domain,
          site.name,
        );
        await this.operations.step(operation.id, 'apply-runtime', 10);
      }
      if (phpConfigChanged && nextPhpVersion) {
        const recreated = await this.agentRelay.emitToAgent(
          'php:create-pool',
          {
            siteDomainId: domainId,
            runtimeKey: target.runtimeKey,
            siteName: site.name,
            domain: newDomain,
            phpVersion: nextPhpVersion,
            user: site.systemUser,
            rootPath: site.rootPath,
            filesRelPath: nextFilesRelPath,
            sslEnabled: sslWasEnabled,
            customConfig: target.phpPoolCustom,
          },
        );
        if (!recreated.success) {
          throw new InternalServerErrorException(
            `Failed to create PHP pool: ${safeErrorMessage(
              recreated.error,
              'unknown agent error',
              800,
            )}`,
          );
        }
        newPoolApplied = true;
      }

      await this.prisma
        .$transaction(async (tx) => {
          await tx.siteDomain.update({ where: { id: domainId }, data });
          if (domainChanged) {
            await replaceHostnameClaims(tx, {
              siteDomainId: domainId,
              domain: newDomain,
              aliases: target.aliases,
            });
            await tx.sslCertificate.updateMany({
              where: { domainId, status: { not: SslStatus.NONE } },
              data: {
                domains: JSON.stringify([
                  newDomain,
                  ...parseSiteAliases(target.aliases).map(
                    (alias) => alias.domain,
                  ),
                ]),
                status: SslStatus.NONE,
                certPath: null,
                keyPath: null,
                issuedAt: null,
                expiresAt: null,
                daysRemaining: null,
                issuer: '',
              },
            });
          }
        })
        .catch(rethrowHostnameClaimConflict);
      metadataApplied = true;
      certificateReset = domainChanged && previousCertificate !== null;
      if (certificateReset) {
        this.logger.log(`SSL reset for domain ${domainId} after domain change`);
      }

      await this.syncPrimaryPhpCliShim(site.id);
      // На случай, если global-zones файл не содержит зону этого домена (например,
      // createDomain в прошлом упал, до ввода правильного порядка) — гарантируем
      // её наличие ДО регенерации сайт-чанков. Дешёвая идемпотентная операция.
      await this.regenerateGlobalZones();
      await this.regenerateNginx(site.id);
    } catch (error) {
      const rollbackErrors: string[] = [];
      if (metadataApplied) {
        await this.prisma
          .$transaction(async (tx) => {
            await tx.siteDomain.update({
              where: { id: domainId },
              data: previousData,
            });
            if (domainChanged) {
              await replaceHostnameClaims(tx, {
                siteDomainId: domainId,
                domain: target.domain,
                aliases: target.aliases,
              });
            }
            if (certificateReset && previousCertificate) {
              await tx.sslCertificate.updateMany({
                where: { domainId },
                data: previousCertificate,
              });
            }
          })
          .catch((rollbackError) => {
            rollbackErrors.push(
              `metadata: ${safeErrorMessage(rollbackError, 'restore failed')}`,
            );
          });
      }
      if (newPoolApplied) {
        if (oldPhpVersion) {
          const restoredPool = await this.agentRelay
            .emitToAgent('php:create-pool', {
              siteDomainId: domainId,
              runtimeKey: target.runtimeKey,
              siteName: site.name,
              domain: target.domain,
              phpVersion: oldPhpVersion,
              user: site.systemUser,
              rootPath: site.rootPath,
              filesRelPath: target.filesRelPath,
              sslEnabled: sslWasEnabled,
              customConfig: target.phpPoolCustom,
            })
            .catch((rollbackError) => ({
              success: false,
              error: safeErrorMessage(rollbackError, 'restore failed'),
            }));
          if (!restoredPool.success) {
            rollbackErrors.push(
              `PHP pool: ${safeErrorMessage(
                restoredPool.error,
                'restore failed',
              )}`,
            );
          }
        }
        if (nextPhpVersion && nextPhpVersion !== oldPhpVersion) {
          const removedPool = await this.agentRelay
            .emitToAgent('php:remove-pool', {
              siteDomainId: domainId,
              runtimeKey: target.runtimeKey,
              phpVersion: nextPhpVersion,
            })
            .catch((rollbackError) => ({
              success: false,
              error: safeErrorMessage(rollbackError, 'cleanup failed'),
            }));
          if (!removedPool.success) {
            rollbackErrors.push(
              `new PHP pool cleanup: ${safeErrorMessage(
                removedPool.error,
                'cleanup failed',
              )}`,
            );
          }
        }
      }
      if (metadataApplied) {
        await this.regenerateGlobalZones().catch((rollbackError) => {
          rollbackErrors.push(
            `Nginx zones: ${safeErrorMessage(rollbackError, 'restore failed')}`,
          );
        });
        await this.regenerateNginx(site.id).catch((rollbackError) => {
          rollbackErrors.push(
            `Nginx: ${safeErrorMessage(rollbackError, 'restore failed')}`,
          );
        });
      }
      if (rollbackErrors.length > 0) {
        const failure = new InternalServerErrorException(
          `${safeErrorMessage(error, 'Domain update failed')}; rollback failed: ${rollbackErrors.join('; ')}`,
        );
        await this.operations.fail(operation.id, failure).catch(() => undefined);
        throw failure;
      }
      await this.operations.fail(operation.id, error).catch(() => undefined);
      throw error;
    }

    if (
      dto.phpVersion !== undefined &&
      dto.phpVersion !== oldPhpVersion &&
      oldPhpVersion &&
      this.agentRelay.isAgentConnected()
    ) {
      const removed = await this.agentRelay
        .emitToAgent('php:remove-pool', {
          siteDomainId: domainId,
          runtimeKey: target.runtimeKey,
          phpVersion: oldPhpVersion,
        })
        .catch((error) => ({
          success: false,
          error: safeErrorMessage(error, 'unknown agent error'),
        }));
      if (!removed.success) {
        this.logger.warn(
          `Old PHP pool cleanup failed for ${target.runtimeKey}: ${safeErrorMessage(
            removed.error,
            'unknown agent error',
            800,
          )}`,
        );
      }
    }

    await this.operations.succeed(operation.id, { siteDomainId: domainId });
    return {
      operationId: operation.id,
      operationStatus: 'SUCCEEDED',
      domains: await this.listDomains(site.id, userId, role),
    };
  }

  // ===========================================================================
  // Удаление домена
  // ===========================================================================

  async deleteDomain(
    siteId: string,
    domainId: string,
    dto: DeleteSiteDomainDto,
    userId: string,
    role: string,
    idempotencyKey?: string,
  ) {
    const site = await this.requireSiteWithDomains(siteId, userId, role);
    const target = site.domains.find((d) => d.id === domainId);
    if (!target) throw new NotFoundException('Domain not found');

    if (site.domains.length <= 1) {
      throw new ConflictException(
        'Нельзя удалить единственный домен сайта. Сначала добавьте другой домен.',
      );
    }
    if (target.isPrimary) {
      throw new ConflictException(
        'Нельзя удалить главный домен. Сначала назначьте главным другой домен (make-primary).',
      );
    }
    if (this.canonicalHostname(dto.confirmDomain) !== target.domain) {
      throw new BadRequestException('Domain confirmation does not match');
    }
    if (['PROVISIONING', 'DEPLOYING', 'UPDATING'].includes(target.appStatus)) {
      throw new ConflictException(
        `Application is busy (${target.appStatus}); it cannot be deleted`,
      );
    }
    const activeBackup = await this.prisma.backup.findFirst({
      where: {
        siteId,
        status: { in: ['PENDING', 'IN_PROGRESS'] },
      },
      select: { id: true },
    });
    if (activeBackup) {
      throw new ConflictException(
        'Application cannot be deleted while a Site backup is active',
      );
    }
    if (!this.agentRelay.isAgentConnected()) {
      throw new ConflictException(
        'Agent is offline; application deletion is unavailable',
      );
    }

    if (dto.deleteApplicationFiles) {
      const sharedPath = site.domains.some(
        (domain) =>
          domain.id !== target.id &&
          this.applicationPath(domain.filesRelPath) ===
            this.applicationPath(target.filesRelPath),
      );
      if (sharedPath) {
        throw new ConflictException(
          'Application files are shared with another domain and cannot be deleted',
        );
      }
    }
    if (
      dto.deleteOwnedDatabases &&
      target.databases.some((database) => !database.dbPasswordEnc)
    ) {
      throw new ConflictException(
        'Owned databases cannot be deleted safely until every database password is reset',
      );
    }

    const operation = await this.operations.begin({
      idempotencyKey,
      type: 'DOMAIN_APPLICATION_DELETE',
      siteId,
      siteDomainId: domainId,
      globalLockKey: HOSTNAME_REGISTRY_LOCK,
      userId,
      request: {
        confirmDomain: target.domain,
        deleteApplicationFiles: dto.deleteApplicationFiles === true,
        deleteOwnedDatabases: dto.deleteOwnedDatabases === true,
      },
    });
    if (operation.replayed) {
      return {
        operationId: operation.id,
        operationStatus: operation.status,
        result: operation.result,
      };
    }
    await this.operations.start(operation.id, 'quiesce-routing');
    const previousStatus = target.appStatus;
    await this.prisma.siteDomain.update({
      where: { id: target.id },
      data: { appStatus: 'UPDATING', appErrorMessage: null },
    });

    let routeRemoved = false;
    let poolRemoved = false;
    let filesTrashed = false;
    let metadataCommitted = false;
    let applicationSnapshotPath: string | null = null;
    const droppedDatabaseIds = new Set<string>();
    const databaseSnapshots = new Map<string, string>();
    try {
      // First stop serving the selected application. Other Site domains stay
      // online; the old route is rebuilt from persisted metadata on rollback.
      await this.regenerateNginx(site.id, {
        excludeSiteDomainId: target.id,
      });
      routeRemoved = true;
      await this.regenerateGlobalZones(target.id);

      await this.operations.step(operation.id, 'snapshot', 20);
      if (dto.deleteApplicationFiles) {
        const snapshot = await this.agentRelay.emitToAgent<{
          snapshotPath?: string;
        }>(
          'application:snapshot',
          {
            operationId: operation.id,
            siteName: site.name,
            siteDomainId: target.id,
            runtimeKey: target.runtimeKey,
            rootPath: site.rootPath,
            filesRelPath: target.filesRelPath,
            databases: target.databases.map((database) => ({
              name: database.name,
              type: database.type,
            })),
          },
          900_000,
        );
        if (!snapshot.success || !snapshot.data?.snapshotPath) {
          throw new InternalServerErrorException(
            `Application snapshot failed: ${snapshot.error || 'no snapshot produced'}`,
          );
        }
        applicationSnapshotPath = snapshot.data.snapshotPath;
      } else if (dto.deleteOwnedDatabases) {
        for (const database of target.databases) {
          const snapshot = await this.agentRelay.emitToAgent<{
            filePath?: string;
          }>('db:export', {
            operationId: operation.id,
            name: database.name,
            type: database.type,
          });
          if (!snapshot.success || !snapshot.data?.filePath) {
            throw new InternalServerErrorException(
              `Database snapshot failed for ${database.name}: ${
                snapshot.error || 'no dump produced'
              }`,
            );
          }
          databaseSnapshots.set(database.id, snapshot.data.filePath);
        }
      }

      await this.operations.step(operation.id, 'remove-runtime', 45);
      if (target.phpVersion) {
        const pool = await this.agentRelay.emitToAgent('php:remove-pool', {
          operationId: operation.id,
          siteDomainId: domainId,
          runtimeKey: target.runtimeKey,
          phpVersion: target.phpVersion,
        });
        if (!pool.success) {
          throw new InternalServerErrorException(
            `PHP pool removal failed: ${pool.error}`,
          );
        }
        poolRemoved = true;
      }

      if (dto.deleteOwnedDatabases) {
        for (const database of target.databases) {
          const dropped = await this.agentRelay.emitToAgent('db:drop', {
            operationId: operation.id,
            name: database.name,
            type: database.type,
            dbUser: database.dbUser,
          });
          if (!dropped.success) {
            throw new InternalServerErrorException(
              `Database deletion failed for ${database.name}: ${dropped.error}`,
            );
          }
          droppedDatabaseIds.add(database.id);
        }
      }

      if (dto.deleteApplicationFiles) {
        const removed = await this.agentRelay.emitToAgent(
          'application:delete-files',
          {
            operationId: operation.id,
            siteDomainId: target.id,
            runtimeKey: target.runtimeKey,
            rootPath: site.rootPath,
            filesRelPath: target.filesRelPath,
          },
        );
        if (!removed.success) {
          throw new InternalServerErrorException(
            `Application file deletion failed: ${removed.error}`,
          );
        }
        filesTrashed = true;
      }

      await this.operations.step(operation.id, 'commit-metadata', 80);
      const preservedDatabaseTarget = site.domains.find(
        (domain) => domain.isPrimary,
      );
      if (!preservedDatabaseTarget) {
        throw new ConflictException('Site has no primary domain');
      }
      const result = {
        deletedDomainId: target.id,
        domain: target.domain,
        preservedDatabaseCount: dto.deleteOwnedDatabases
          ? 0
          : target.databases.length,
        preservedDatabaseTargetId: dto.deleteOwnedDatabases
          ? null
          : preservedDatabaseTarget.id,
      };
      await this.commitDomainDeletionMetadata(
        site.id,
        target.id,
        preservedDatabaseTarget.id,
        dto.deleteOwnedDatabases === true,
        operation.id,
        result,
      );
      metadataCommitted = true;

      // Certificate relation is already gone. Physical ACME cleanup is
      // best-effort after the commit boundary: revocation is irreversible and
      // must never make a successfully deleted domain appear rolled back.
      if (
        target.sslCertificate &&
        target.sslCertificate.status !== SslStatus.NONE
      ) {
        const revoked = await this.agentRelay
          .emitToAgent(
            'ssl:revoke',
            {
              operationId: operation.id,
              domain: target.domain,
            },
            90_000,
          )
          .catch((error) => ({
            success: false,
            error: safeErrorMessage(error, 'SSL cleanup failed'),
          }));
        if (!revoked.success) {
          this.logger.warn(
            `Post-delete SSL cleanup failed for ${target.domain}: ${safeErrorMessage(
              revoked.error,
              'unknown agent error',
              800,
            )}`,
          );
        }
      }
      this.logger.log(`Domain "${target.domain}" removed from site "${site.name}"`);
      return {
        operationId: operation.id,
        operationStatus: 'SUCCEEDED',
        domains: await this.listDomains(site.id, userId, role),
      };
    } catch (error) {
      const message = safeErrorMessage(
        error,
        'Domain deletion failed',
        2_000,
      );
      if (metadataCommitted) {
        // The metadata transaction also marks the operation SUCCEEDED. This is
        // a forward-only boundary; never recreate a deleted domain implicitly.
        this.logger.error(
          `Post-commit domain cleanup failed for ${target.domain}: ${message}`,
        );
        throw error;
      }

      const rollbackErrors: string[] = [];
      for (const database of target.databases) {
        if (!droppedDatabaseIds.has(database.id)) continue;
        let password: string;
        try {
          password = decryptDbPassword(database.dbPasswordEnc!);
        } catch (rollbackError) {
          rollbackErrors.push(
            `database ${database.name} credentials: ${safeErrorMessage(
              rollbackError,
              'decrypt failed',
            )}`,
          );
          continue;
        }
        const recreated = await this.agentRelay
          .emitToAgent('db:create', {
            operationId: operation.id,
            siteDomainId: target.id,
            name: database.name,
            type: database.type,
            dbUser: database.dbUser,
            password,
          })
          .catch((rollbackError) => ({
            success: false,
            error: safeErrorMessage(rollbackError, 'create failed'),
          }));
        if (!recreated.success) {
          rollbackErrors.push(
            `database ${database.name} create: ${safeErrorMessage(
              recreated.error,
              'restore failed',
            )}`,
          );
        }
      }

      if (
        applicationSnapshotPath &&
        (filesTrashed || droppedDatabaseIds.size > 0)
      ) {
        const restored = await this.agentRelay
          .emitToAgent(
            'application:restore-snapshot',
            {
              operationId: operation.id,
              siteDomainId: target.id,
              snapshotPath: applicationSnapshotPath,
            },
            900_000,
          )
          .catch((rollbackError) => ({
            success: false,
            error: safeErrorMessage(rollbackError, 'restore failed'),
          }));
        if (!restored.success) {
          rollbackErrors.push(
            `application snapshot: ${safeErrorMessage(
              restored.error,
              'restore failed',
            )}`,
          );
        }
      } else {
        for (const database of target.databases) {
          if (!droppedDatabaseIds.has(database.id)) continue;
          const filePath = databaseSnapshots.get(database.id);
          if (!filePath) {
            rollbackErrors.push(
              `database ${database.name}: rollback dump is missing`,
            );
            continue;
          }
          const restored = await this.agentRelay
            .emitToAgent('db:import', {
              operationId: operation.id,
              siteDomainId: target.id,
              name: database.name,
              type: database.type,
              filePath,
            })
            .catch((rollbackError) => ({
              success: false,
              error: safeErrorMessage(rollbackError, 'import failed'),
            }));
          if (!restored.success) {
            rollbackErrors.push(
              `database ${database.name} import: ${safeErrorMessage(
                restored.error,
                'restore failed',
              )}`,
            );
          }
        }
      }

      if (poolRemoved && target.phpVersion) {
        const restoredPool = await this.agentRelay
          .emitToAgent('php:create-pool', {
            operationId: operation.id,
            siteDomainId: target.id,
            runtimeKey: target.runtimeKey,
            siteName: site.name,
            domain: target.domain,
            phpVersion: target.phpVersion,
            user: site.systemUser,
            rootPath: site.rootPath,
            filesRelPath: target.filesRelPath,
            sslEnabled:
              target.sslCertificate?.status === SslStatus.ACTIVE ||
              target.sslCertificate?.status === SslStatus.EXPIRING_SOON,
            customConfig: target.phpPoolCustom,
          })
          .catch((rollbackError) => ({
            success: false,
            error: safeErrorMessage(rollbackError, 'restore failed'),
          }));
        if (!restoredPool.success) {
          rollbackErrors.push(
            `PHP pool: ${safeErrorMessage(
              restoredPool.error,
              'restore failed',
            )}`,
          );
        }
      }

      await this.prisma.siteDomain
        .updateMany({
          where: { id: target.id },
          data: {
            appStatus: previousStatus,
            appErrorMessage: target.appErrorMessage,
          },
        })
        .catch((rollbackError) => {
          rollbackErrors.push(
            `metadata status: ${safeErrorMessage(
              rollbackError,
              'restore failed',
            )}`,
          );
        });
      if (routeRemoved) {
        await this.regenerateGlobalZones().catch((rollbackError) => {
          rollbackErrors.push(
            `Nginx zones: ${safeErrorMessage(rollbackError, 'restore failed')}`,
          );
        });
        await this.regenerateNginx(site.id).catch((rollbackError) => {
          rollbackErrors.push(
            `Nginx route: ${safeErrorMessage(rollbackError, 'restore failed')}`,
          );
        });
      }

      if (rollbackErrors.length > 0) {
        const failure = new InternalServerErrorException(
          `${message}; rollback failed: ${rollbackErrors.join('; ')}`,
        );
        await this.operations.fail(operation.id, failure).catch(() => undefined);
        await this.prisma.siteDomain
          .updateMany({
            where: { id: target.id },
            data: {
              appStatus: 'ERROR',
              appErrorMessage: safeErrorMessage(failure, message, 2_000),
            },
          })
          .catch(() => undefined);
        throw failure;
      }
      await this.operations.fail(operation.id, error).catch(() => undefined);
      throw error;
    }
  }

  // ===========================================================================
  // Назначить главным
  // ===========================================================================

  async makePrimary(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    idempotencyKey?: string,
  ) {
    const site = await this.requireSiteWithDomains(siteId, userId, role);
    const target = site.domains.find((d) => d.id === domainId);
    if (!target) throw new NotFoundException('Domain not found');

    if (target.isPrimary) {
      // Уже главный — ничего не делаем, отдаём текущий список.
      return this.listDomains(site.id, userId, role);
    }
    if (!this.agentRelay.isAgentConnected()) {
      throw new ConflictException(
        'Agent is offline; primary domain update is unavailable',
      );
    }

    // Новый порядок: target → position 0, остальные по текущему порядку.
    const rest = site.domains
      .filter((d) => d.id !== domainId)
      .sort((a, b) => a.position - b.position);
    const previousOrdering = site.domains.map((domain) => ({
      id: domain.id,
      isPrimary: domain.isPrimary,
      position: domain.position,
    }));
    const nextOrdering = [target, ...rest].map((domain, position) => ({
      id: domain.id,
      isPrimary: position === 0,
      position,
    }));
    const operation = await this.operations.begin({
      idempotencyKey,
      type: 'DOMAIN_MAKE_PRIMARY',
      siteId,
      siteDomainId: domainId,
      userId,
      request: { domainId },
    });
    if (operation.replayed) {
      return {
        operationId: operation.id,
        operationStatus: operation.status,
        result: operation.result,
      };
    }
    await this.operations.start(operation.id, 'commit-metadata');

    let metadataApplied = false;
    try {
      await this.setDomainOrdering(nextOrdering);
      metadataApplied = true;
      await this.operations.step(operation.id, 'regenerate-runtime', 65);
      await this.syncPrimaryPhpCliShim(site.id);
      await this.regenerateGlobalZones();
      await this.regenerateNginx(site.id);
      await this.operations.succeed(operation.id, {
        primarySiteDomainId: target.id,
      });
      this.logger.log(
        `Primary domain of site "${site.name}" → "${target.domain}"`,
      );
      return {
        operationId: operation.id,
        operationStatus: 'SUCCEEDED',
        domains: await this.listDomains(site.id, userId, role),
      };
    } catch (error) {
      const rollbackErrors: string[] = [];
      if (metadataApplied) {
        await this.setDomainOrdering(previousOrdering).catch((rollbackError) => {
          rollbackErrors.push(
            `metadata: ${safeErrorMessage(rollbackError, 'restore failed')}`,
          );
        });
        await this.syncPrimaryPhpCliShim(site.id).catch((rollbackError) => {
          rollbackErrors.push(
            `PHP CLI: ${safeErrorMessage(rollbackError, 'restore failed')}`,
          );
        });
        await this.regenerateGlobalZones().catch((rollbackError) => {
          rollbackErrors.push(
            `Nginx zones: ${safeErrorMessage(rollbackError, 'restore failed')}`,
          );
        });
        await this.regenerateNginx(site.id).catch((rollbackError) => {
          rollbackErrors.push(
            `Nginx: ${safeErrorMessage(rollbackError, 'restore failed')}`,
          );
        });
      }
      if (rollbackErrors.length > 0) {
        const failure = new InternalServerErrorException(
          `${safeErrorMessage(error, 'Primary domain update failed')}; rollback failed: ${rollbackErrors.join('; ')}`,
        );
        await this.operations.fail(operation.id, failure).catch(() => undefined);
        throw failure;
      }
      await this.operations.fail(operation.id, error).catch(() => undefined);
      throw error;
    }
  }

  // ===========================================================================
  // Алиасы домена
  // ===========================================================================

  async updateAliases(
    siteId: string,
    domainId: string,
    dto: UpdateSiteDomainAliasesDto,
    userId: string,
    role: string,
    idempotencyKey?: string,
  ) {
    const site = await this.requireSiteWithDomains(siteId, userId, role);
    const target = site.domains.find((d) => d.id === domainId);
    if (!target) throw new NotFoundException('Domain not found');
    if (!this.agentRelay.isAgentConnected()) {
      throw new ConflictException(
        'Agent is offline; domain alias update is unavailable',
      );
    }

    const normalizedAliases = this.normalizeAliases(dto.aliases);
    const requested = normalizedAliases.map((alias) => alias.domain);
    const operation = await this.operations.begin({
      idempotencyKey,
      type: 'DOMAIN_ALIASES_UPDATE',
      siteId,
      siteDomainId: domainId,
      globalLockKey: HOSTNAME_REGISTRY_LOCK,
      userId,
      request: { aliases: normalizedAliases },
    });
    if (operation.replayed) {
      return {
        operationId: operation.id,
        operationStatus: operation.status,
        result: operation.result,
      };
    }
    await this.operations.start(operation.id, 'validate-hostnames');

    let metadataApplied = false;
    try {
      // Конфликт каждого алиаса с любым другим основным доменом / алиасом.
      for (const ad of requested) {
        await this.assertDomainFree(ad, domainId, target.domain);
      }
      // nginx-level — только реально новые алиасы.
      const oldAliases = new Set(
        parseSiteAliases(target.aliases).map((alias) =>
          alias.domain.toLowerCase(),
        ),
      );
      const newAliasDomains = requested.filter((domain) => !oldAliases.has(domain));
      if (newAliasDomains.length > 0) {
        await this.ensureDomainFreeInNginx(
          newAliasDomains,
          target.domain,
          site.name,
        );
      }

      await this.operations.step(operation.id, 'commit-metadata', 45);
      const storedAliases = stringifySiteAliases(normalizedAliases);
      await this.prisma
        .$transaction(async (tx) => {
          await tx.siteDomain.update({
            where: { id: domainId },
            data: { aliases: storedAliases },
          });
          await replaceHostnameClaims(tx, {
            siteDomainId: domainId,
            domain: target.domain,
            aliases: storedAliases,
          });
        })
        .catch(rethrowHostnameClaimConflict);
      metadataApplied = true;

      await this.operations.step(operation.id, 'regenerate-runtime', 70);
      await this.syncPrimaryPhpCliShim(site.id);
      await this.regenerateGlobalZones();
      await this.regenerateNginx(site.id);
      await this.operations.succeed(operation.id, { siteDomainId: domainId });
      return {
        operationId: operation.id,
        operationStatus: 'SUCCEEDED',
        domains: await this.listDomains(site.id, userId, role),
      };
    } catch (error) {
      const rollbackErrors: string[] = [];
      if (metadataApplied) {
        await this.prisma
          .$transaction(async (tx) => {
            await tx.siteDomain.update({
              where: { id: domainId },
              data: { aliases: target.aliases },
            });
            await replaceHostnameClaims(tx, {
              siteDomainId: domainId,
              domain: target.domain,
              aliases: target.aliases,
            });
          })
          .catch((rollbackError) => {
            rollbackErrors.push(
              `metadata: ${safeErrorMessage(rollbackError, 'restore failed')}`,
            );
          });
        await this.regenerateGlobalZones().catch((rollbackError) => {
          rollbackErrors.push(
            `Nginx zones: ${safeErrorMessage(rollbackError, 'restore failed')}`,
          );
        });
        await this.regenerateNginx(site.id).catch((rollbackError) => {
          rollbackErrors.push(
            `Nginx: ${safeErrorMessage(rollbackError, 'restore failed')}`,
          );
        });
      }
      if (rollbackErrors.length > 0) {
        const failure = new InternalServerErrorException(
          `${safeErrorMessage(error, 'Alias update failed')}; rollback failed: ${rollbackErrors.join('; ')}`,
        );
        await this.operations.fail(operation.id, failure).catch(() => undefined);
        throw failure;
      }
      await this.operations.fail(operation.id, error).catch(() => undefined);
      throw error;
    }
  }

  // ===========================================================================
  // Внутренние операции
  // ===========================================================================

  private async commitDomainDeletionMetadata(
    siteId: string,
    domainId: string,
    preservedDatabaseTargetId: string,
    deleteOwnedDatabases: boolean,
    operationId: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (deleteOwnedDatabases) {
        await tx.database.deleteMany({ where: { siteDomainId: domainId } });
      } else {
        await tx.database.updateMany({
          where: { siteDomainId: domainId },
          data: {
            siteDomainId: preservedDatabaseTargetId,
            purpose: 'AUXILIARY',
          },
        });
      }
      await tx.siteDomain.delete({ where: { id: domainId } });

      const remaining = await tx.siteDomain.findMany({
        where: { siteId },
        orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }],
        select: { id: true, isPrimary: true },
      });
      for (const [index, domain] of remaining.entries()) {
        await tx.siteDomain.update({
          where: { id: domain.id },
          data: { position: -(remaining.length + index + 1) },
        });
      }
      for (const [position, domain] of remaining.entries()) {
        await tx.siteDomain.update({
          where: { id: domain.id },
          data: { position },
        });
      }

      const completed = await tx.operation.updateMany({
        where: { id: operationId, status: 'RUNNING' },
        data: {
          status: 'SUCCEEDED',
          currentStep: null,
          progress: 100,
          result: JSON.stringify(result),
          errorMessage: null,
          completedAt: new Date(),
        },
      });
      if (completed.count !== 1) {
        throw new ConflictException('Deletion operation is not running');
      }
      await tx.operationLock.deleteMany({
        where: { operationId },
      });
    });
  }

  private async setDomainOrdering(
    ordering: Array<{ id: string; isPrimary: boolean; position: number }>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (const [index, domain] of ordering.entries()) {
        await tx.siteDomain.update({
          where: { id: domain.id },
          data: {
            isPrimary: false,
            position: -(ordering.length + index + 1),
          },
        });
      }
      for (const domain of ordering) {
        await tx.siteDomain.update({
          where: { id: domain.id },
          data: {
            isPrimary: domain.isPrimary,
            position: domain.position,
          },
        });
      }
    });
  }

  /** Синхронизирует только Site-level CLI runtime с текущим primary domain. */
  async syncPrimaryPhpCliShim(siteId: string): Promise<void> {
    const primary = await this.prisma.siteDomain.findFirst({
      where: { siteId, isPrimary: true },
      include: {
        site: {
          select: {
            systemUser: true,
            rootPath: true,
          },
        },
      },
    });
    if (!primary) {
      this.logger.error(`Site ${siteId} has no primary domain`);
      return;
    }
    if (
      !primary.site.systemUser ||
      !this.agentRelay.isAgentConnected()
    ) {
      return;
    }
    const result = await this.agentRelay.emitToAgent(
      'user:setup-php-shim',
      {
        username: primary.site.systemUser,
        homeDir: primary.site.rootPath,
        phpVersion: primary.phpVersion,
      },
      20_000,
    );
    if (!result.success) {
      this.logger.warn(
        `Primary PHP CLI shim update failed for site ${siteId}: ${result.error}`,
      );
    }
  }

  /** Перенумеровывает position доменов сайта (главный=0, остальные по порядку). */
  private async renumberPositions(siteId: string): Promise<void> {
    const domains = await this.prisma.siteDomain.findMany({
      where: { siteId },
      orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }],
    });
    await this.prisma.$transaction(async (tx) => {
      for (const [index, domain] of domains.entries()) {
        await tx.siteDomain.update({
          where: { id: domain.id },
          data: { position: -(index + 1) },
        });
      }
      for (const [index, domain] of domains.entries()) {
        await tx.siteDomain.update({
          where: { id: domain.id },
          data: { position: index },
        });
      }
    });
  }

  /**
   * Регенерирует nginx-конфиг всего сайта (все домены) через
   * `nginx:create-config` с мульти-доменным payload.
   */
  async regenerateNginx(
    siteId: string,
    options: {
      forceWriteCustom?: boolean;
      excludeSiteDomainId?: string;
    } = {},
  ): Promise<void> {
    if (!this.agentRelay.isAgentConnected()) {
      throw new InternalServerErrorException('Agent is not connected');
    }
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      include: DOMAINS_WITH_SSL,
    });
    if (!site) return;
    try {
      const event = site.status === SiteStatus.STOPPED
        ? 'nginx:create-stopped-config'
        : 'nginx:create-config';
      const payloadSite = options.excludeSiteDomainId
        ? {
            ...site,
            domains: site.domains.filter(
              (domain) => domain.id !== options.excludeSiteDomainId,
            ),
          }
        : site;
      const res = await this.agentRelay.emitToAgent<{ success?: boolean; error?: string }>(
        event,
        buildMultiDomainNginxPayload(
          payloadSite as unknown as RawSiteForNginx,
          options,
        ),
      );
      // Раньше success:false тихо игнорировался → агент откатывал backup, домен
      // не появлялся в nginx, а оператор узнавал об этом только когда «всё не
      // работает». Логируем ошибку явно.
      const ack = res as unknown as { success?: boolean; error?: string };
      if (ack && ack.success === false) {
        throw new Error(
          `${event} rejected by agent: ${ack.error || 'unknown'}`,
        );
      }
    } catch (err) {
      const message = safeErrorMessage(err, 'unknown Nginx error', 800);
      this.logger.error(
        `Nginx config regeneration failed for site ${siteId}: ${message}`,
      );
      throw new InternalServerErrorException(
        `Nginx configuration failed: ${message}`,
      );
    }
  }

  /**
   * Rebuilds every derived runtime artifact from persisted SiteDomain state.
   * Used after restore/import; sockets and generated configs never come from
   * an archive.
   */
  async regenerateRuntime(siteId: string): Promise<void> {
    if (!this.agentRelay.isAgentConnected()) {
      throw new InternalServerErrorException('Agent is not connected');
    }
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      include: DOMAINS_WITH_SSL,
    });
    if (!site) throw new NotFoundException('Site not found');

    for (const domain of site.domains) {
      if (!domain.phpVersion) continue;
      const result = await this.agentRelay.emitToAgent('php:create-pool', {
        siteDomainId: domain.id,
        runtimeKey: domain.runtimeKey,
        siteName: site.name,
        domain: domain.domain,
        phpVersion: domain.phpVersion,
        user: site.systemUser || site.name,
        rootPath: site.rootPath,
        filesRelPath: domain.filesRelPath,
        sslEnabled:
          domain.sslCertificate?.status === SslStatus.ACTIVE ||
          domain.sslCertificate?.status === SslStatus.EXPIRING_SOON,
        customConfig: domain.phpPoolCustom,
      });
      if (!result.success) {
        throw new InternalServerErrorException(
          `PHP pool regeneration failed for "${domain.domain}": ${
            result.error || 'unknown agent error'
          }`,
        );
      }
    }

    await this.syncPrimaryPhpCliShim(siteId);
    await this.regenerateGlobalZones();
    await this.regenerateNginx(siteId, { forceWriteCustom: true });
  }

  /**
   * Перегенерирует глобальный zones-файл: один `limit_req_zone` на каждый
   * `SiteDomain` среди ВСЕХ сайтов.
   */
  async regenerateGlobalZones(excludeSiteDomainId?: string): Promise<void> {
    if (!this.agentRelay.isAgentConnected()) {
      throw new InternalServerErrorException('Agent is not connected');
    }
    try {
      const domains = await this.prisma.siteDomain.findMany({
        where: excludeSiteDomainId
          ? { id: { not: excludeSiteDomainId } }
          : undefined,
        select: {
          id: true,
          nginxRateLimitEnabled: true,
          nginxRateLimitRps: true,
        },
      });
      const zones = domains.map((d) => ({
        zoneName: nginxZoneName(d.id),
        rps: d.nginxRateLimitRps && d.nginxRateLimitRps > 0 ? d.nginxRateLimitRps : 30,
        enabled: d.nginxRateLimitEnabled !== false,
      }));
      const res = await this.agentRelay.emitToAgent<{ success?: boolean; error?: string }>(
        'nginx:write-global-zones',
        { zones },
      );
      const ack = res as unknown as { success?: boolean; error?: string };
      if (ack && ack.success === false) {
        throw new Error(
          `nginx:write-global-zones rejected by agent: ${ack.error || 'unknown'}`,
        );
      }
    } catch (err) {
      const message = safeErrorMessage(err, 'unknown Nginx error', 800);
      this.logger.error(`regenerateGlobalZones: ${message}`);
      throw new InternalServerErrorException(
        `Global Nginx zones update failed: ${message}`,
      );
    }
  }

  /**
   * Проверяет, что `domain` не занят никаким другим основным доменом или
   * алиасом во ВСЕЙ БД. `ignoreDomainId` — исключить текущий домен из проверки.
   * `ownDomain` — собственный домен записи (его алиасы не считаем конфликтом).
   */
  async assertDomainFree(
    domain: string,
    ignoreDomainId: string | null,
    ownDomain?: string,
  ): Promise<void> {
    if (ownDomain && domain === ownDomain.toLowerCase()) {
      throw new ConflictException(
        `Hostname "${domain}" cannot be an alias of itself`,
      );
    }

    const claim = await this.prisma.hostnameClaim.findFirst({
      where: {
        hostname: domain,
        ...(ignoreDomainId
          ? { siteDomainId: { not: ignoreDomainId } }
          : {}),
      },
      include: {
        siteDomain: {
          include: { site: { select: { name: true } } },
        },
      },
    });
    if (claim) {
      throw new ConflictException(
        `Домен "${domain}" уже используется сайтом "${claim.siteDomain.site.name}"`,
      );
    }

    // Fail closed if an old/manual write predates registry synchronization.
    const asPrimary = await this.prisma.siteDomain.findFirst({
      where: {
        domain,
        ...(ignoreDomainId ? { id: { not: ignoreDomainId } } : {}),
      },
      include: { site: { select: { name: true } } },
    });
    if (asPrimary) {
      throw new ConflictException(
        `Домен "${domain}" уже используется сайтом "${asPrimary.site.name}"`,
      );
    }

    // Конфликт с алиасом другого домена (substring-поиск в JSON).
    const asAlias = await this.prisma.siteDomain.findFirst({
      where: {
        aliases: { contains: `"${domain}"` },
        ...(ignoreDomainId ? { id: { not: ignoreDomainId } } : {}),
      },
      include: { site: { select: { name: true } } },
    });
    if (asAlias) {
      throw new ConflictException(
        `Домен "${domain}" уже используется как алиас сайта "${asAlias.site.name}"`,
      );
    }
  }

  /**
   * nginx-level проверка: домен не обслуживается чужим конфигом вне meowbox.
   */
  async ensureDomainFreeInNginx(
    domains: string[],
    ignoreOwnDomain?: string,
    ignoreSiteName?: string,
  ): Promise<void> {
    if (!this.agentRelay.isAgentConnected()) {
      throw new ConflictException(
        'Agent is offline; Nginx hostname validation is unavailable',
      );
    }
    const ignoreFiles = new Set<string>();
    if (ignoreOwnDomain) {
      ignoreFiles.add(`${ignoreOwnDomain}.conf`);
      ignoreFiles.add(ignoreOwnDomain);
    }
    if (ignoreSiteName) {
      ignoreFiles.add(`${ignoreSiteName}.conf`);
      ignoreFiles.add(ignoreSiteName);
    }
    for (const d of domains) {
      let resp;
      try {
        resp = await this.agentRelay.emitToAgent<{
          hits: Array<{ file: string; line: string }>;
        }>('nginx:find-domain-usage', { domain: d }, 15_000);
      } catch (error) {
        throw new InternalServerErrorException(
          `Nginx hostname validation failed: ${safeErrorMessage(
            error,
            'agent request failed',
            800,
          )}`,
        );
      }
      if (!resp.success || !Array.isArray(resp.data?.hits)) {
        throw new InternalServerErrorException(
          `Nginx hostname validation failed: ${safeErrorMessage(
            resp.error,
            'invalid agent response',
            800,
          )}`,
        );
      }
      const hits = resp.data.hits;
      const external = hits.filter((h) => !ignoreFiles.has(h.file));
      if (external.length > 0) {
        const files = external.map((h) => h.file).join(', ');
        throw new ConflictException(
          `Домен "${d}" уже обслуживается nginx-конфигом: ${files}. ` +
            `Удали/перенастрой этот конфиг вручную перед добавлением домена в meowbox.`,
        );
      }
    }
  }

  async retryDomainApplication(
    siteId: string,
    domainId: string,
    operationId: string,
  ): Promise<void> {
    const claimed = await this.prisma.siteDomain.updateMany({
      where: { id: domainId, siteId, appStatus: 'ERROR' },
      data: { appStatus: 'PROVISIONING', appErrorMessage: null },
    });
    if (claimed.count !== 1) {
      throw new ConflictException('Only failed applications can be retried');
    }

    try {
      await this.provisionDomainApplication(
        siteId,
        domainId,
        undefined,
        operationId,
      );
    } catch (error) {
      const message = safeErrorMessage(error);
      await this.prisma.siteDomain.update({
        where: { id: domainId },
        data: {
          appStatus: 'ERROR',
          appErrorMessage: message,
        },
      });
      throw error;
    }
  }

  async provisionDomainApplication(
    siteId: string,
    domainId: string,
    requested?: CreateSiteDomainDto,
    operationId?: string,
  ): Promise<void> {
    if (!this.agentRelay.isAgentConnected()) {
      throw new InternalServerErrorException('Agent is not connected');
    }

    let application = await this.prisma.siteDomain.findFirst({
      where: { id: domainId, siteId },
      include: APPLICATION_WITH_ROOT_SHARERS,
    });
    if (!application) throw new NotFoundException('Domain application not found');

    const reusesExistingRoot = this.hasRunningSharedApplicationRoot(
      application.site.domains,
      application.filesRelPath,
      domainId,
    );
    this.assertSharedRootPreset(application.preset, reusesExistingRoot);

    const isModx =
      application.preset === 'MODX_REVO' || application.preset === 'MODX_3';
    const sslEnabled = requested?.sslEnabled === true;
    const shouldInstall = requested?.skipInstall !== true;
    const step = async (name: string, progress: number) => {
      if (operationId) {
        await this.operations.step(operationId, name, progress);
      }
    };

    let database = application.databases.find(
      (entry) => entry.purpose === 'APP_PRIMARY',
    );
    let databasePassword: string | undefined;
    let createdDatabaseId: string | null = null;
    let databaseMutationStarted = false;
    let rootMutationStarted = false;
    let poolMutationStarted = false;

    try {
      if (shouldInstall) {
        await step('preflight-root', 5);
        const preflight = await this.agentRelay.emitToAgent(
          'application:preflight-create-root',
          {
            operationId,
            siteDomainId: domainId,
            rootPath: application.site.rootPath,
            filesRelPath: application.filesRelPath,
            allowExistingRoot: reusesExistingRoot,
          },
        );
        if (!preflight.success) {
          throw new ConflictException(
            `Application root preflight failed: ${
              preflight.error || 'unknown agent error'
            }`,
          );
        }
      }

      const wantsDatabase =
        shouldInstall &&
        (isModx ||
          requested?.dbType !== undefined ||
          requested?.dbName !== undefined);
      await step('database', 15);

      if (wantsDatabase && !database) {
        const detected = await this.agentRelay.emitToAgent<{
          available: string[];
          preferred: string | null;
        }>('db:detect', { operationId, siteDomainId: domainId });
        if (!detected.success) {
          throw new Error(
            `Database engine detection failed: ${detected.error}`,
          );
        }
        const available = detected.data?.available || [];
        const selectedType =
          requested?.dbType ||
          (isModx
            ? available.find(
                (type) => type === 'MARIADB' || type === 'MYSQL',
              )
            : detected.data?.preferred);
        if (!selectedType) {
          throw new Error('No compatible database engine is available');
        }
        if (
          isModx &&
          selectedType !== 'MARIADB' &&
          selectedType !== 'MYSQL'
        ) {
          throw new Error('MODX requires MariaDB or MySQL');
        }

        const suffix = application.runtimeKey.slice(-8);
        const baseName = application.site.name.replace(/-/g, '_');
        const databaseName = (
          requested?.dbName || `${baseName}_${suffix}`
        ).slice(0, 64);
        const databaseUser = (
          requested?.dbUser || `${baseName}_${suffix}`
        ).slice(0, 32);
        databasePassword =
          requested?.dbPassword || randomBytes(16).toString('base64url');
        const prismaType = selectedType as DatabaseType;

        const existing = await this.prisma.database.findUnique({
          where: {
            name_type: {
              name: databaseName,
              type: prismaType,
            },
          },
        });
        if (existing) {
          throw new ConflictException(
            `Database ${databaseName} (${selectedType}) already exists`,
          );
        }

        database = await this.prisma.database.create({
          data: {
            name: databaseName,
            type: prismaType,
            dbUser: databaseUser,
            dbPasswordHash: await hashPassword(databasePassword),
            dbPasswordEnc: encryptDbPassword(databasePassword),
            siteId,
            siteDomainId: domainId,
            purpose: 'APP_PRIMARY',
          },
        });
        createdDatabaseId = database.id;
      } else if (database?.dbPasswordEnc) {
        databasePassword = decryptDbPassword(database.dbPasswordEnc);
      }

      if (database && databasePassword && createdDatabaseId) {
        databaseMutationStarted = true;
        const physicalDatabase = await this.agentRelay.emitToAgent(
          'db:create',
          {
            operationId,
            siteDomainId: domainId,
            name: database.name,
            type: database.type,
            dbUser: database.dbUser,
            password: databasePassword,
          },
        );
        if (!physicalDatabase.success) {
          throw new Error(
            `Database creation failed for ${database.name}: ${
              physicalDatabase.error || 'unknown agent error'
            }`,
          );
        }
      }

      // Migration import reserves metadata and the Site container first. Files,
      // databases and runtime artifacts are restored and activated atomically by
      // MigrationService afterwards; serving an empty root here would expose a
      // half-imported application.
      if (!shouldInstall) {
        await step('reserved-for-import', 80);
        return;
      }

      let adminPassword: string | undefined;
      if (isModx) {
        adminPassword =
          requested?.cmsAdminPassword ||
          (application.cmsAdminPasswordEnc
            ? decryptCmsPassword(application.cmsAdminPasswordEnc)
            : randomBytes(16).toString('base64url'));
        await this.prisma.siteDomain.update({
          where: { id: domainId },
          data: {
            cmsAdminUser:
              requested?.cmsAdminUser ||
              application.cmsAdminUser ||
              application.site.systemUser,
            cmsAdminPasswordEnc: encryptCmsPassword(adminPassword),
            managerPath:
              requested?.managerPath || application.managerPath || 'manager',
            connectorsPath:
              requested?.connectorsPath ||
              application.connectorsPath ||
              'connectors',
            cmsTablePrefix:
              requested?.cmsTablePrefix ||
              application.cmsTablePrefix ||
              `${this.randomLowercase(7)}_`,
          },
        });
        application = await this.prisma.siteDomain.findFirstOrThrow({
          where: { id: domainId },
          include: APPLICATION_WITH_ROOT_SHARERS,
        });
      }

      if (shouldInstall) {
        await step('install', 35);
        const install = await this.agentRelay.emitToAgent<{
          version?: string;
          mutationStarted?: boolean;
        }>(
          'site:install',
          {
            operationId,
            siteId,
            siteDomainId: domainId,
            runtimeKey: application.runtimeKey,
            preset: application.preset,
            rootPath: application.site.rootPath,
            filesRelPath: application.filesRelPath,
            reuseExistingRoot: reusesExistingRoot,
            domain: application.domain,
            phpVersion: application.phpVersion || undefined,
            modxVersion:
              requested?.modxVersion ||
              application.modxVersion ||
              undefined,
            appPort: application.appPort || undefined,
            dbName: database?.name,
            dbUser: database?.dbUser,
            dbPassword: databasePassword,
            dbType: database?.type,
            adminUser: application.cmsAdminUser || undefined,
            adminPassword,
            adminEmail: `admin@${application.domain}`,
            systemUser: application.site.systemUser,
            managerPath: application.managerPath || undefined,
            connectorsPath: application.connectorsPath || undefined,
            tablePrefix: application.cmsTablePrefix || undefined,
          },
          1_200_000,
        );
        rootMutationStarted = install.data?.mutationStarted === true;
        if (!install.success) {
          throw new Error(
            `Application installation failed: ${
              install.error || 'unknown error'
            }`,
          );
        }
        if (install.data?.version) {
          await this.prisma.siteDomain.update({
            where: { id: domainId },
            data: { modxVersion: install.data.version },
          });
        }
      }

      if (application.phpVersion) {
        await step('php-pool', 55);
        poolMutationStarted = true;
        const pool = await this.agentRelay.emitToAgent('php:create-pool', {
          operationId,
          siteDomainId: domainId,
          runtimeKey: application.runtimeKey,
          siteName: application.site.name,
          domain: application.domain,
          phpVersion: application.phpVersion,
          user: application.site.systemUser,
          rootPath: application.site.rootPath,
          filesRelPath: application.filesRelPath,
          sslEnabled:
            application.sslCertificate?.status === SslStatus.ACTIVE ||
            application.sslCertificate?.status === SslStatus.EXPIRING_SOON,
          customConfig: application.phpPoolCustom,
        });
        if (!pool.success) {
          throw new Error(
            `PHP pool creation failed: ${pool.error || 'unknown agent error'}`,
          );
        }
      }

      await step('nginx', 70);
      await this.regenerateNginx(siteId);

      await step('health-check', 80);
      const health = await this.agentRelay.emitToAgent<{
        reachable: boolean;
        statusCode: number | null;
      }>(
        'site:health-check',
        { domain: application.domain, port: null },
        15_000,
      );
      const statusCode = health.data?.statusCode ?? 0;
      if (
        !health.success ||
        health.data?.reachable !== true ||
        statusCode < 1 ||
        statusCode >= 500
      ) {
        throw new Error(
          `Application health check failed${
            statusCode ? ` (HTTP ${statusCode})` : ''
          }`,
        );
      }

      if (sslEnabled) {
        await step('ssl', 90);
        const aliases = parseSiteAliases(application.aliases).map(
          (alias) => alias.domain,
        );
        const domains = Array.from(
          new Set([application.domain, ...aliases]),
        );
        const certificate = await this.prisma.sslCertificate.upsert({
          where: { domainId },
          create: {
            siteId,
            domainId,
            domains: JSON.stringify(domains),
            status: SslStatus.PENDING,
            issuer: '',
          },
          update: {
            domains: JSON.stringify(domains),
            status: SslStatus.PENDING,
          },
        });

        try {
          const raw = await this.agentRelay.emitToAgent<{
            certPath?: string;
            keyPath?: string;
            expiresAt?: string;
            domains?: string[];
          }>(
            'ssl:issue',
            {
              operationId,
              siteDomainId: domainId,
              domain: application.domain,
              domains,
              rootPath: application.site.rootPath,
              filesRelPath: application.filesRelPath,
              email: `admin@${application.domain}`,
            },
            180_000,
          );
          const ack = raw as unknown as {
            success?: boolean;
            certPath?: string;
            keyPath?: string;
            expiresAt?: string;
            domains?: string[];
            error?: string;
          };
          if (!ack.success || !ack.certPath || !ack.keyPath) {
            throw new Error(
              ack.error || raw.error || 'Certificate files were not returned',
            );
          }
          const expiresAt = ack.expiresAt ? new Date(ack.expiresAt) : null;
          if (expiresAt && Number.isNaN(expiresAt.getTime())) {
            throw new Error('Certificate expiration date is invalid');
          }
          await this.prisma.sslCertificate.update({
            where: { id: certificate.id },
            data: {
              domains: JSON.stringify(
                ack.domains?.length ? ack.domains : domains,
              ),
              status: SslStatus.ACTIVE,
              certPath: ack.certPath,
              keyPath: ack.keyPath,
              issuer: "Let's Encrypt",
              issuedAt: new Date(),
              expiresAt,
              daysRemaining: expiresAt
                ? Math.floor(
                    (expiresAt.getTime() - Date.now()) /
                      (1000 * 60 * 60 * 24),
                  )
                : null,
            },
          });
          await this.regenerateNginx(siteId);
        } catch (error) {
          await this.prisma.sslCertificate.update({
            where: { id: certificate.id },
            data: { status: SslStatus.NONE },
          });
          this.logger.warn(
            `SSL issue failed for ${application.domain}: ${safeErrorMessage(
              error,
              'unknown SSL error',
              800,
            )}`,
          );
        }
      }

      await this.prisma.siteDomain.update({
        where: { id: domainId },
        data: { appStatus: 'RUNNING', appErrorMessage: null },
      });
    } catch (error) {
      await step('compensate', 95).catch(() => undefined);

      if (poolMutationStarted && application.phpVersion) {
        await this.agentRelay
          .emitToAgent('php:remove-pool', {
            operationId,
            siteDomainId: domainId,
            runtimeKey: application.runtimeKey,
            phpVersion: application.phpVersion,
          })
          .catch(() => undefined);
      }

      if (rootMutationStarted && operationId && !reusesExistingRoot) {
        await this.agentRelay
          .emitToAgent('application:delete-files', {
            operationId,
            siteDomainId: domainId,
            runtimeKey: application.runtimeKey,
            rootPath: application.site.rootPath,
            filesRelPath: application.filesRelPath,
          })
          .catch(() => undefined);
      }

      if (
        databaseMutationStarted &&
        createdDatabaseId &&
        database
      ) {
        const dropped = await this.agentRelay
          .emitToAgent('db:drop', {
            operationId,
            siteDomainId: domainId,
            name: database.name,
            type: database.type,
            dbUser: database.dbUser,
          })
          .catch(() => ({ success: false }));
        if (dropped.success) {
          await this.prisma.database
            .delete({ where: { id: createdDatabaseId } })
            .catch(() => undefined);
        }
      } else if (createdDatabaseId) {
        await this.prisma.database
          .delete({ where: { id: createdDatabaseId } })
          .catch(() => undefined);
      }

      await this.regenerateNginx(siteId).catch(() => undefined);
      throw error;
    }
  }

  private canonicalHostname(value: string): string {
    try {
      return canonicalizeHostname(value);
    } catch {
      throw new BadRequestException('Invalid domain name');
    }
  }

  private normalizeAliases(
    aliases: Array<string | { domain: string; redirect?: boolean }>,
  ): Array<{ domain: string; redirect: boolean }> {
    if (aliases.length > 64) {
      throw new BadRequestException('Максимум 64 алиаса на домен');
    }
    const normalized = aliases.map((alias) => ({
      domain: this.canonicalHostname(
        typeof alias === 'string' ? alias : alias.domain,
      ),
      redirect: typeof alias === 'string' ? false : alias.redirect === true,
    }));
    const domains = normalized.map((alias) => alias.domain);
    if (new Set(domains).size !== domains.length) {
      throw new BadRequestException('Duplicate aliases are not allowed');
    }
    return normalized;
  }

  private applicationPath(value: string): string {
    try {
      return normalizeFilesRelPath(value);
    } catch {
      throw new BadRequestException('Invalid application files path');
    }
  }

  private hasRunningSharedApplicationRoot(
    domains: Array<{
      id: string;
      filesRelPath: string;
      appStatus: string;
    }>,
    filesRelPath: string,
    excludeDomainId?: string,
  ): boolean {
    const targetPath = this.applicationPath(filesRelPath);
    return domains.some(
      (domain) =>
        domain.id !== excludeDomainId &&
        domain.appStatus === 'RUNNING' &&
        this.applicationPath(domain.filesRelPath) === targetPath,
    );
  }

  private assertSharedRootPreset(
    preset: string,
    reusesExistingRoot: boolean,
  ): void {
    if (reusesExistingRoot && preset !== 'CUSTOM') {
      throw new ConflictException(
        'MODX applications require a dedicated empty application root',
      );
    }
  }

  private assertEnvVars(envVars: Record<string, string> | undefined): void {
    try {
      validateEnvVars(envVars);
    } catch {
      throw new BadRequestException('Invalid or oversized environment variables');
    }
  }

  private randomLowercase(length: number): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz';
    const bytes = randomBytes(length);
    return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
  }

  // ===========================================================================
  // Bulk rebuild — все домены всех сайтов
  // ===========================================================================

  async rebuildAll(role: string): Promise<{
    total: number;
    ok: number;
    failed: number;
    details: Array<{ siteName: string; status: 'ok' | 'failed'; error?: string }>;
  }> {
    if (role !== 'ADMIN') {
      throw new ForbiddenException('Only ADMIN can rebuild all nginx configs');
    }
    if (!this.agentRelay.isAgentConnected()) {
      throw new InternalServerErrorException('Агент не подключён');
    }
    const sites = await this.prisma.site.findMany({ include: DOMAINS_WITH_SSL });
    const details: Array<{ siteName: string; status: 'ok' | 'failed'; error?: string }> = [];
    let ok = 0;
    let failed = 0;
    for (const site of sites) {
      try {
        const event = site.status === SiteStatus.STOPPED
          ? 'nginx:create-stopped-config'
          : 'nginx:create-config';
        const r = await this.agentRelay.emitToAgent(
          event,
          buildMultiDomainNginxPayload(site as unknown as RawSiteForNginx, {
            forceWriteCustom: site.domains.some((d) => !!d.nginxCustomConfig),
          }),
        );
        if (r.success) {
          ok++;
          details.push({ siteName: site.name, status: 'ok' });
        } else {
          failed++;
          details.push({ siteName: site.name, status: 'failed', error: r.error || 'unknown' });
        }
      } catch (e) {
        failed++;
        details.push({ siteName: site.name, status: 'failed', error: (e as Error).message });
      }
    }
    // Глобальные zones — на основе всех доменов.
    await this.regenerateGlobalZones();
    this.logger.log(`Bulk nginx rebuild: total=${sites.length}, ok=${ok}, failed=${failed}`);
    return { total: sites.length, ok, failed, details };
  }
}
