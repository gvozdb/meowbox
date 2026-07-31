import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'crypto';

import { AgentRelayService } from '../gateway/agent-relay.service';
import { PrismaService } from '../common/prisma.service';
import {
  DatabaseType,
  SiteStatus,
  SslStatus,
} from '../common/enums';
import { hashPassword } from '../common/crypto/argon2.helper';
import { encryptDbPassword } from '../common/crypto/database-cipher';
import { encryptSshPassword } from '../common/crypto/ssh-cipher';
import { jsonArrayContains } from '../common/sqlite-mappers';
import { stringifyStringArray } from '../common/json-array';
import { isReservedSiteName } from '../common/validators/site-names';
import { OperationsService } from '../operations/operations.service';
import { safeErrorMessage } from '@meowbox/shared';
import {
  canonicalizeHostname,
  normalizeFilesRelPath,
} from './domain-validation';
import { SiteDomainsService } from './site-domains.service';
import { DuplicateSiteDto } from './sites.dto';
import {
  createHostnameClaims,
  HOSTNAME_REGISTRY_LOCK,
  rethrowHostnameClaimConflict,
} from './hostname-registry';

interface TargetDatabase {
  sourceId: string;
  sourceName: string;
  name: string;
  type: DatabaseType;
  dbUser: string;
  purpose: string;
  password: string;
}

interface DuplicateRuntimeContext {
  operationId: string;
  siteId: string;
  domainId: string;
  rootPath: string;
  siteName: string;
  systemUser: string;
  sshPassword: string;
  sourceRootPath: string;
  sourceFilesRelPath: string;
  targetFilesRelPath: string;
  domain: string;
  preset: string;
  phpVersion: string | null;
  phpPoolCustom: string | null;
  runtimeKey: string;
  managerPath: string | null;
  connectorsPath: string | null;
  cmsTablePrefix: string | null;
  databases: TargetDatabase[];
}

@Injectable()
export class SiteDuplicateService {
  private readonly logger = new Logger(SiteDuplicateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
    private readonly siteDomains: SiteDomainsService,
    private readonly operations: OperationsService,
  ) {}

  async duplicate(
    sourceSiteId: string,
    dto: DuplicateSiteDto,
    userId: string,
    role: string,
    idempotencyKey: string | undefined,
    targetRootPath: string,
  ): Promise<{
    siteId: string | null;
    operationId: string;
    operationStatus: string;
  }> {
    const source = await this.prisma.siteDomain.findFirst({
      where: {
        id: dto.siteDomainId,
        siteId: sourceSiteId,
        ...(role === 'ADMIN' ? {} : { site: { userId } }),
      },
      include: {
        site: true,
        databases: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!source) {
      const siteExists = await this.prisma.site.count({
        where: { id: sourceSiteId },
      });
      if (siteExists > 0 && role !== 'ADMIN') {
        throw new ForbiddenException('Access denied');
      }
      throw new NotFoundException('Source domain application not found');
    }
    if (source.appStatus !== 'RUNNING') {
      throw new ConflictException(
        `Source application must be RUNNING, got ${source.appStatus}`,
      );
    }
    if (!this.agentRelay.isAgentConnected()) {
      throw new ConflictException('Agent is not connected');
    }
    const isModx =
      source.preset === 'MODX_REVO' || source.preset === 'MODX_3';
    const primaryDatabases = source.databases.filter(
      (database) => database.purpose === 'APP_PRIMARY',
    );
    if (isModx && primaryDatabases.length !== 1) {
      throw new ConflictException(
        'MODX application must own exactly one APP_PRIMARY database',
      );
    }
    if (isReservedSiteName(dto.name)) {
      throw new ConflictException(`Name "${dto.name}" is reserved`);
    }

    let domain: string;
    let filesRelPath: string;
    try {
      domain = canonicalizeHostname(dto.domain);
      filesRelPath = normalizeFilesRelPath(dto.filesRelPath);
    } catch (error) {
      throw new ConflictException((error as Error).message);
    }

    const operation = await this.operations.begin({
      idempotencyKey,
      type: 'DOMAIN_APPLICATION_DUPLICATE',
      siteId: sourceSiteId,
      siteDomainId: source.id,
      globalLockKey: HOSTNAME_REGISTRY_LOCK,
      userId,
      request: {
        sourceSiteId,
        sourceSiteDomainId: source.id,
        ...dto,
        domain,
        filesRelPath,
      },
    });
    if (operation.replayed) {
      return {
        siteId: operation.siteId,
        operationId: operation.id,
        operationStatus: operation.status,
      };
    }
    await this.operations.start(operation.id, 'preflight');

    try {
      const existingName = await this.prisma.site.findUnique({
        where: { name: dto.name },
        select: { id: true },
      });
      if (existingName) {
        throw new ConflictException(`Site name "${dto.name}" is already taken`);
      }
      await this.siteDomains.assertDomainFree(domain, null);
      await this.siteDomains.ensureDomainFreeInNginx([domain]);

      const targetDatabases = await this.mapDatabases(source.databases, dto);
      await this.assertTargetDatabasesFree(targetDatabases);

      const domainId = randomUUID();
      const systemUser = dto.name;
      const sshPassword = randomBytes(16).toString('base64url');
      const preparedDatabases = await Promise.all(
        targetDatabases.map(async (database) => ({
          ...database,
          passwordHash: await hashPassword(database.password),
          passwordEnc: encryptDbPassword(database.password),
        })),
      );

      const site = await this.prisma.$transaction(async (tx) => {
        const created = await tx.site.create({
          data: {
            name: dto.name,
            displayName: dto.displayName?.trim() || null,
            status: SiteStatus.DEPLOYING,
            errorMessage: null,
            rootPath: targetRootPath,
            nginxConfigPath: `/etc/nginx/sites-available/${dto.name}.conf`,
            systemUser,
            sshPasswordEnc: encryptSshPassword(sshPassword),
            metadata: JSON.stringify({
              duplicatedFrom: {
                siteId: source.siteId,
                siteDomainId: source.id,
              },
            }),
            userId,
          },
        });
        await tx.siteDomain.create({
          data: {
            id: domainId,
            siteId: created.id,
            domain,
            aliases: '[]',
            isPrimary: true,
            position: 0,
            filesRelPath,
            preset: source.preset,
            appStatus: 'PROVISIONING',
            appErrorMessage: null,
            phpVersion: source.phpVersion,
            phpPoolCustom: source.phpPoolCustom,
            runtimeKey: dto.name,
            gitRepository: source.gitRepository,
            deployBranch: source.deployBranch,
            envVars: source.envVars,
            cmsAdminUser: source.cmsAdminUser,
            cmsAdminPasswordEnc: source.cmsAdminPasswordEnc,
            managerPath: source.managerPath,
            connectorsPath: source.connectorsPath,
            cmsTablePrefix: source.cmsTablePrefix,
            modxVersion: source.modxVersion,
            // A running reverse-proxy process cannot share the source port.
            // A later deploy allocates/configures its own process.
            appPort: null,
            httpsRedirect: source.httpsRedirect,
            nginxClientMaxBodySize: source.nginxClientMaxBodySize,
            nginxFastcgiReadTimeout: source.nginxFastcgiReadTimeout,
            nginxFastcgiSendTimeout: source.nginxFastcgiSendTimeout,
            nginxFastcgiConnectTimeout: source.nginxFastcgiConnectTimeout,
            nginxFastcgiBufferSizeKb: source.nginxFastcgiBufferSizeKb,
            nginxFastcgiBufferCount: source.nginxFastcgiBufferCount,
            nginxHttp2: source.nginxHttp2,
            nginxHsts: source.nginxHsts,
            nginxGzip: source.nginxGzip,
            nginxRateLimitEnabled: source.nginxRateLimitEnabled,
            nginxRateLimitRps: source.nginxRateLimitRps,
            nginxRateLimitBurst: source.nginxRateLimitBurst,
            nginxCustomConfig: source.nginxCustomConfig,
          },
        });
        await createHostnameClaims(tx, {
          siteDomainId: domainId,
          domain,
          aliases: '[]',
        });
        await tx.sslCertificate.create({
          data: {
            siteId: created.id,
            domainId,
            domains: stringifyStringArray([domain]),
            status: SslStatus.NONE,
            issuer: '',
          },
        });
        for (const database of preparedDatabases) {
          await tx.database.create({
            data: {
              name: database.name,
              type: database.type,
              dbUser: database.dbUser,
              dbPasswordHash: database.passwordHash,
              dbPasswordEnc: database.passwordEnc,
              siteId: created.id,
              siteDomainId: domainId,
              purpose: database.purpose,
            },
          });
        }
        await this.operations.attachCreatedSiteScope(tx, operation.id, {
          siteId: created.id,
          siteDomainId: domainId,
        });
        return created;
      }).catch(rethrowHostnameClaimConflict);
      this.runDuplicate({
        operationId: operation.id,
        siteId: site.id,
        domainId,
        rootPath: targetRootPath,
        siteName: dto.name,
        systemUser,
        sshPassword,
        sourceRootPath: source.site.rootPath,
        sourceFilesRelPath: source.filesRelPath,
        targetFilesRelPath: filesRelPath,
        domain,
        preset: source.preset,
        phpVersion: source.phpVersion,
        phpPoolCustom: source.phpPoolCustom,
        runtimeKey: dto.name,
        managerPath: source.managerPath,
        connectorsPath: source.connectorsPath,
        cmsTablePrefix: source.cmsTablePrefix,
        databases: targetDatabases,
      }).catch(async (error) => {
        this.logger.error(
          `Unhandled duplicate operation ${operation.id}: ${safeErrorMessage(
            error,
          )}`,
        );
        await this.operations.fail(operation.id, error).catch(() => undefined);
      });

      return {
        siteId: site.id,
        operationId: operation.id,
        operationStatus: 'RUNNING',
      };
    } catch (error) {
      await this.operations.fail(operation.id, error);
      throw error;
    }
  }

  private async runDuplicate(context: DuplicateRuntimeContext): Promise<void> {
    const physicalDatabases: TargetDatabase[] = [];
    let userCreated = false;
    let poolCreated = false;
    let nginxCreated = false;

    try {
      await this.operations.step(context.operationId, 'create-container', 10);
      const user = await this.agentRelay.emitToAgent('user:create', {
        operationId: context.operationId,
        username: context.systemUser,
        homeDir: context.rootPath,
        password: context.sshPassword,
        filesRelPath: context.targetFilesRelPath,
      });
      if (!user.success) {
        throw new Error(`System user creation failed: ${user.error}`);
      }
      userCreated = true;

      const root = await this.agentRelay.emitToAgent(
        'application:preflight-create-root',
        {
          operationId: context.operationId,
          siteDomainId: context.domainId,
          rootPath: context.rootPath,
          filesRelPath: context.targetFilesRelPath,
        },
      );
      if (!root.success) {
        throw new Error(`Target root preflight failed: ${root.error}`);
      }

      await this.operations.step(context.operationId, 'copy-files', 25);
      const files = await this.agentRelay.emitToAgent(
        'site:copy-files',
        {
          operationId: context.operationId,
          srcRoot: context.sourceRootPath,
          srcRelPath: context.sourceFilesRelPath,
          dstRoot: context.rootPath,
          dstRelPath: context.targetFilesRelPath,
          dstUser: context.systemUser,
        },
        900_000,
      );
      if (!files.success) {
        throw new Error(`Application file copy failed: ${files.error}`);
      }

      for (const [index, database] of context.databases.entries()) {
        await this.operations.step(
          context.operationId,
          `copy-database:${index + 1}`,
          35 + Math.floor((25 * index) / Math.max(1, context.databases.length)),
        );
        const created = await this.agentRelay.emitToAgent('db:create', {
          operationId: context.operationId,
          siteDomainId: context.domainId,
          name: database.name,
          type: database.type,
          dbUser: database.dbUser,
          password: database.password,
        });
        if (!created.success) {
          throw new Error(
            `Database creation failed for ${database.name}: ${created.error}`,
          );
        }
        physicalDatabases.push(database);

        const copied = await this.agentRelay.emitToAgent(
          'db:copy',
          {
            operationId: context.operationId,
            srcName: database.sourceName,
            dstName: database.name,
            type: database.type,
          },
          900_000,
        );
        if (!copied.success) {
          throw new Error(
            `Database copy failed for ${database.name}: ${copied.error}`,
          );
        }
      }

      const primaryDatabase = context.databases.find(
        (database) => database.purpose === 'APP_PRIMARY',
      );
      if (
        (context.preset === 'MODX_REVO' || context.preset === 'MODX_3')
        && primaryDatabase
      ) {
        await this.operations.step(
          context.operationId,
          'rewrite-modx-config',
          65,
        );
        if (
          primaryDatabase.type !== DatabaseType.MARIADB
          && primaryDatabase.type !== DatabaseType.MYSQL
        ) {
          throw new Error('MODX duplicate requires MariaDB or MySQL');
        }
        if (!context.cmsTablePrefix) {
          throw new Error('MODX table prefix is missing');
        }
        const rewritten = await this.agentRelay.emitToAgent(
          'modx:rewrite-database-config',
          {
            operationId: context.operationId,
            siteDomainId: context.domainId,
            rootPath: context.rootPath,
            filesRelPath: context.targetFilesRelPath,
            dbName: primaryDatabase.name,
            dbUser: primaryDatabase.dbUser,
            dbPassword: primaryDatabase.password,
            dbType: primaryDatabase.type,
            tablePrefix: context.cmsTablePrefix,
            managerPath: context.managerPath || undefined,
            connectorsPath: context.connectorsPath || undefined,
          },
          30_000,
        );
        if (!rewritten.success) {
          throw new Error(`MODX config rewrite failed: ${rewritten.error}`);
        }
      }

      if (context.phpVersion) {
        await this.operations.step(context.operationId, 'php-pool', 72);
        const pool = await this.agentRelay.emitToAgent('php:create-pool', {
          operationId: context.operationId,
          siteDomainId: context.domainId,
          runtimeKey: context.runtimeKey,
          siteName: context.siteName,
          domain: context.domain,
          phpVersion: context.phpVersion,
          user: context.systemUser,
          rootPath: context.rootPath,
          filesRelPath: context.targetFilesRelPath,
          sslEnabled: false,
          customConfig: context.phpPoolCustom,
        });
        if (!pool.success) {
          throw new Error(`PHP pool creation failed: ${pool.error}`);
        }
        poolCreated = true;
        const shim = await this.agentRelay.emitToAgent('user:setup-php-shim', {
          username: context.systemUser,
          homeDir: context.rootPath,
          phpVersion: context.phpVersion,
        });
        if (!shim.success) {
          throw new Error(`PHP CLI shim setup failed: ${shim.error}`);
        }
      }

      await this.operations.step(context.operationId, 'nginx', 82);
      await this.siteDomains.regenerateGlobalZones();
      nginxCreated = true;
      await this.siteDomains.regenerateNginx(context.siteId);

      await this.operations.step(context.operationId, 'health-check', 92);
      const health = await this.agentRelay.emitToAgent<{
        reachable: boolean;
        statusCode: number | null;
      }>(
        'site:health-check',
        { domain: context.domain, port: null },
        15_000,
      );
      const statusCode = health.data?.statusCode ?? 0;
      if (
        !health.success
        || health.data?.reachable !== true
        || statusCode < 1
        || statusCode >= 500
      ) {
        throw new Error(
          `Duplicate health check failed${
            statusCode ? ` (HTTP ${statusCode})` : ''
          }`,
        );
      }

      await this.prisma.$transaction([
        this.prisma.siteDomain.update({
          where: { id: context.domainId },
          data: { appStatus: 'RUNNING', appErrorMessage: null },
        }),
        this.prisma.site.update({
          where: { id: context.siteId },
          data: { status: SiteStatus.RUNNING, errorMessage: null },
        }),
      ]);
      await this.operations.succeed(context.operationId, {
        siteId: context.siteId,
        siteDomainId: context.domainId,
      });
    } catch (error) {
      const message = safeErrorMessage(error, 'Duplicate failed');
      await this.compensate(
        context,
        physicalDatabases,
        userCreated,
        poolCreated,
        nginxCreated,
      );
      await this.prisma.siteDomain
        .updateMany({
          where: { id: context.domainId },
          data: {
            appStatus: 'ERROR',
            appErrorMessage: message,
          },
        })
        .catch(() => undefined);
      await this.prisma.site
        .updateMany({
          where: { id: context.siteId },
          data: {
            status: SiteStatus.ERROR,
            errorMessage: message,
          },
        })
        .catch(() => undefined);
      await this.operations.fail(context.operationId, error);
      throw error;
    }
  }

  private async compensate(
    context: DuplicateRuntimeContext,
    databases: TargetDatabase[],
    userCreated: boolean,
    poolCreated: boolean,
    nginxCreated: boolean,
  ): Promise<void> {
    if (nginxCreated) {
      await this.agentRelay
        .emitToAgent('nginx:remove-config', { siteName: context.siteName })
        .catch(() => undefined);
    }
    if (poolCreated && context.phpVersion) {
      await this.agentRelay
        .emitToAgent('php:remove-pool', {
          siteDomainId: context.domainId,
          runtimeKey: context.runtimeKey,
          phpVersion: context.phpVersion,
        })
        .catch(() => undefined);
    }
    for (const database of [...databases].reverse()) {
      await this.agentRelay
        .emitToAgent('db:drop', {
          name: database.name,
          type: database.type,
          dbUser: database.dbUser,
        })
        .catch(() => undefined);
    }
    if (userCreated) {
      await this.agentRelay
        .emitToAgent('site:remove-files', {
          operationId: context.operationId,
          rootPath: context.rootPath,
        })
        .catch(() => undefined);
      await this.agentRelay
        .emitToAgent('user:delete', { username: context.systemUser })
        .catch(() => undefined);
    }
  }

  private async mapDatabases(
    sourceDatabases: Array<{
      id: string;
      name: string;
      type: string;
      purpose: string;
    }>,
    dto: DuplicateSiteDto,
  ): Promise<TargetDatabase[]> {
    if (sourceDatabases.length === 0) return [];

    const explicit = dto.databaseMappings || [];
    if (explicit.length === 0) {
      if (sourceDatabases.length !== 1 || !dto.dbName || !dto.dbUser) {
        throw new ConflictException(
          'Explicit target mapping is required for every source database',
        );
      }
      const source = sourceDatabases[0];
      return [
        {
          sourceId: source.id,
          sourceName: source.name,
          name: dto.dbName,
          type: source.type as DatabaseType,
          dbUser: dto.dbUser,
          purpose: source.purpose,
          password: randomBytes(16).toString('base64url'),
        },
      ];
    }

    const mappings = new Map(
      explicit.map((mapping) => [mapping.sourceDatabaseId, mapping]),
    );
    if (
      mappings.size !== explicit.length
      || mappings.size !== sourceDatabases.length
      || sourceDatabases.some((database) => !mappings.has(database.id))
    ) {
      throw new ConflictException(
        'Database mappings must cover every owned database exactly once',
      );
    }
    return sourceDatabases.map((source) => {
      const target = mappings.get(source.id)!;
      return {
        sourceId: source.id,
        sourceName: source.name,
        name: target.name,
        type: source.type as DatabaseType,
        dbUser: target.dbUser,
        purpose: source.purpose,
        password: randomBytes(16).toString('base64url'),
      };
    });
  }

  private async assertTargetDatabasesFree(
    databases: TargetDatabase[],
  ): Promise<void> {
    const targets = new Set<string>();
    for (const database of databases) {
      const key = `${database.type}:${database.name}`;
      if (targets.has(key)) {
        throw new ConflictException(
          `Target database is duplicated in request: ${database.name}`,
        );
      }
      targets.add(key);
    }
    if (databases.length === 0) return;

    const conflict = await this.prisma.database.findFirst({
      where: {
        OR: databases.map((database) => ({
          name: database.name,
          type: database.type,
        })),
      },
      select: { name: true, type: true },
    });
    if (conflict) {
      throw new ConflictException(
        `Database "${conflict.name}" (${conflict.type}) already exists`,
      );
    }
  }
}
