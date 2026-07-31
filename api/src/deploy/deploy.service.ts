import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { DeployStatus, SiteStatus } from '../common/enums';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { NotificationDispatcherService } from '../notifications/notification-dispatcher.service';
import { DomainContextService } from '../sites/domain-context.service';
import { redactSensitiveText, safeErrorMessage } from '@meowbox/shared';
import { OperationsService } from '../operations/operations.service';

const MAX_DEPLOY_OUTPUT_LENGTH = 1_000_000;

interface DeployLogListOptions {
  siteId: string;
  domainId: string;
  userId: string;
  role: string;
  page?: number;
  perPage?: number;
}

@Injectable()
export class DeployService {
  private readonly logger = new Logger('DeployService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
    private readonly notifier: NotificationDispatcherService,
    private readonly domainContext: DomainContextService,
    private readonly operations: OperationsService,
  ) {}

  async triggerDeploy(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
    branch?: string,
    idempotencyKey?: string,
  ) {
    let context =
      await this.domainContext.requireOwnedSiteDomain(
        siteId,
        domainId,
        userId,
        role,
      );
    const requestedBranch =
      branch || context.domain.deployBranch || 'main';
    const operation = await this.operations.begin({
      idempotencyKey,
      type: 'DOMAIN_DEPLOY',
      siteId,
      siteDomainId: domainId,
      lockSite: false,
      userId,
      request: { branch: requestedBranch },
    });
    if (operation.replayed) {
      const deployLog = await this.prisma.deployLog.findUnique({
        where: { operationId: operation.id },
      });
      if (!deployLog) {
        throw new BadRequestException(
          'Deploy operation exists without a deploy log; retry with a new idempotency key',
        );
      }
      return { deployLog, site: context.site };
    }
    await this.operations.start(operation.id, 'validate');

    try {
      context = await this.domainContext.requireOwnedSiteDomain(
        siteId,
        domainId,
        userId,
        role,
      );
      const { site, domain, envVars } = context;
      if (!domain.gitRepository) {
        throw new BadRequestException(
          'Domain application has no git repository configured',
        );
      }
      if (domain.appStatus !== 'RUNNING' && domain.appStatus !== 'ERROR') {
        throw new BadRequestException(
          `Domain application is busy (${domain.appStatus})`,
        );
      }

      const activeDeploy = await this.prisma.deployLog.findFirst({
        where: {
          siteDomainId: domainId,
          status: { in: [DeployStatus.PENDING, DeployStatus.IN_PROGRESS] },
        },
        select: { id: true },
      });
      if (activeDeploy) {
        throw new BadRequestException(
          'A deploy is already in progress for this domain',
        );
      }

      const deployLog = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.siteDomain.updateMany({
          where: {
            id: domainId,
            siteId,
            appStatus: { in: ['RUNNING', 'ERROR'] },
          },
          data: { appStatus: 'DEPLOYING', appErrorMessage: null },
        });
        if (claimed.count !== 1) {
          throw new BadRequestException('Domain application is busy');
        }
        return tx.deployLog.create({
          data: {
            siteId,
            siteDomainId: domainId,
            operationId: operation.id,
            branch: requestedBranch,
            status: DeployStatus.PENDING,
            triggeredBy: userId,
          },
        });
      });

      this.agentRelay.emitToAgentAsync('deploy:execute', {
        deployId: deployLog.id,
        operationId: operation.id,
        siteDomainId: domainId,
        preset: domain.preset,
        rootPath: site.rootPath,
        filesRelPath: domain.filesRelPath,
        gitRepository: domain.gitRepository,
        branch: requestedBranch,
        phpVersion: domain.phpVersion,
        appPort: domain.appPort,
        domain: domain.domain,
        runtimeKey: domain.runtimeKey,
        envVars,
      });
      await this.operations.step(operation.id, 'await-agent', 10);
      this.logger.log(
        `Deploy triggered for site "${site.name}" (branch: ${requestedBranch})`,
      );
      return { deployLog, site };
    } catch (error) {
      const message = safeErrorMessage(error, 'Deploy trigger failed');
      await this.prisma.deployLog
        .updateMany({
          where: { operationId: operation.id },
          data: {
            status: DeployStatus.FAILED,
            output: `Deploy trigger failed: ${message}`,
            completedAt: new Date(),
          },
        })
        .catch(() => undefined);
      await this.prisma.siteDomain
        .updateMany({
          where: { id: domainId, appStatus: 'DEPLOYING' },
          data: { appStatus: 'ERROR', appErrorMessage: message },
        })
        .catch(() => undefined);
      await this.operations.fail(operation.id, error).catch(() => undefined);
      throw error;
    }
  }

  async rollbackDeploy(
    siteId: string,
    domainId: string,
    deployId: string,
    userId: string,
    role: string,
    idempotencyKey?: string,
  ) {
    let context =
      await this.domainContext.requireOwnedSiteDomain(
        siteId,
        domainId,
        userId,
        role,
      );
    const deploy = await this.prisma.deployLog.findUnique({
      where: { id: deployId },
      select: {
        id: true,
        siteId: true,
        siteDomainId: true,
        branch: true,
        commitSha: true,
      },
    });

    if (!deploy) throw new NotFoundException('Deploy not found');
    if (deploy.siteId !== siteId || deploy.siteDomainId !== domainId) {
      throw new NotFoundException('Deploy not found');
    }
    if (!deploy.commitSha) {
      throw new BadRequestException('Deploy has no commit SHA to rollback to');
    }
    const rollbackCommitSha = deploy.commitSha;
    const operation = await this.operations.begin({
      idempotencyKey,
      type: 'DOMAIN_DEPLOY_ROLLBACK',
      siteId,
      siteDomainId: domainId,
      lockSite: false,
      userId,
      request: { deployId, commitSha: rollbackCommitSha },
    });
    if (operation.replayed) {
      const replay = await this.prisma.deployLog.findUnique({
        where: { operationId: operation.id },
      });
      if (!replay) {
        throw new BadRequestException(
          'Rollback operation exists without a deploy log; retry with a new idempotency key',
        );
      }
      return replay;
    }
    await this.operations.start(operation.id, 'validate');

    try {
      context = await this.domainContext.requireOwnedSiteDomain(
        siteId,
        domainId,
        userId,
        role,
      );
      const { site, domain, envVars } = context;
      if (domain.appStatus !== 'RUNNING' && domain.appStatus !== 'ERROR') {
        throw new BadRequestException(
          `Domain application is busy (${domain.appStatus})`,
        );
      }
      const rollbackLog = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.siteDomain.updateMany({
          where: {
            id: domainId,
            siteId,
            appStatus: { in: ['RUNNING', 'ERROR'] },
          },
          data: { appStatus: 'DEPLOYING', appErrorMessage: null },
        });
        if (claimed.count !== 1) {
          throw new BadRequestException('Domain application is busy');
        }
        return tx.deployLog.create({
          data: {
            siteId: deploy.siteId,
            siteDomainId: deploy.siteDomainId,
            operationId: operation.id,
            branch: deploy.branch,
            status: DeployStatus.PENDING,
            triggeredBy: userId,
            output: `[rollback] Rolling back to deploy ${deployId.slice(0, 8)} (commit ${rollbackCommitSha.slice(0, 8)})\n`,
          },
        });
      });

      this.agentRelay.emitToAgentAsync('deploy:rollback', {
        deployId: rollbackLog.id,
        operationId: operation.id,
        siteDomainId: domain.id,
        rootPath: site.rootPath,
        filesRelPath: domain.filesRelPath,
        commitSha: rollbackCommitSha,
        preset: domain.preset,
        domain: domain.domain,
        phpVersion: domain.phpVersion,
        runtimeKey: domain.runtimeKey,
        appPort: domain.appPort,
        envVars,
      });
      await this.operations.step(operation.id, 'await-agent', 10);
      this.logger.log(
        `Rollback triggered for "${site.name}" to commit ${rollbackCommitSha.slice(0, 8)}`,
      );
      return rollbackLog;
    } catch (error) {
      const message = safeErrorMessage(error, 'Rollback trigger failed');
      await this.prisma.deployLog
        .updateMany({
          where: { operationId: operation.id },
          data: {
            status: DeployStatus.FAILED,
            output: `Rollback trigger failed: ${message}`,
            completedAt: new Date(),
          },
        })
        .catch(() => undefined);
      await this.prisma.siteDomain
        .updateMany({
          where: { id: domainId, appStatus: 'DEPLOYING' },
          data: { appStatus: 'ERROR', appErrorMessage: message },
        })
        .catch(() => undefined);
      await this.operations.fail(operation.id, error).catch(() => undefined);
      throw error;
    }
  }

  async appendOutput(deployId: string, output: string) {
    const current = await this.prisma.deployLog.findUnique({
      where: { id: deployId },
      select: { output: true },
    });
    if (!current) return;
    const safeOutput = redactSensitiveText(output, MAX_DEPLOY_OUTPUT_LENGTH);
    const nextOutput = `${current.output}${safeOutput}`.slice(
      -MAX_DEPLOY_OUTPUT_LENGTH,
    );

    await this.prisma.deployLog.update({
      where: { id: deployId },
      data: {
        output: nextOutput,
        status: DeployStatus.IN_PROGRESS,
      },
    });
  }

  async completeDeploy(
    deployId: string,
    success: boolean,
    commitSha?: string,
    commitMessage?: string,
  ) {
    const now = new Date();
    const completed = await this.prisma.$transaction(async (tx) => {
      const deployLog = await tx.deployLog.findUnique({
        where: { id: deployId },
        select: {
          siteId: true,
          siteDomainId: true,
          operationId: true,
          startedAt: true,
        },
      });
      if (!deployLog) return null;
      const durationMs = now.getTime() - deployLog.startedAt.getTime();
      if (deployLog.operationId) {
        const operation = await tx.operation.updateMany({
          where: {
            id: deployLog.operationId,
            status: { in: ['PENDING', 'RUNNING'] },
          },
          data: {
            status: success ? 'SUCCEEDED' : 'FAILED',
            currentStep: null,
            progress: success ? 100 : undefined,
            result: success
              ? JSON.stringify({ deployId, commitSha: commitSha || null })
              : null,
            errorMessage: success
              ? null
              : safeErrorMessage(commitMessage, 'Deploy failed'),
            completedAt: now,
          },
        });
        if (operation.count !== 1) {
          return null;
        }
        await tx.operationLock.deleteMany({
          where: { operationId: deployLog.operationId },
        });
      }
      await tx.deployLog.update({
        where: { id: deployId },
        data: {
          status: success ? DeployStatus.SUCCESS : DeployStatus.FAILED,
          commitSha,
          commitMessage,
          completedAt: now,
          durationMs,
        },
      });
      await tx.siteDomain.update({
        where: { id: deployLog.siteDomainId },
        data: {
          appStatus: success ? 'RUNNING' : 'ERROR',
          appErrorMessage: success
            ? null
            : safeErrorMessage(commitMessage, 'Deploy failed'),
        },
      });
      return {
        siteId: deployLog.siteId,
        durationMs,
      };
    });
    if (!completed) return;

    // Dispatch notification
    const site = await this.prisma.site.findUnique({
      where: { id: completed.siteId },
      select: { name: true },
    });
    this.notifier.dispatch({
      event: success ? 'DEPLOY_SUCCESS' : 'DEPLOY_FAILED',
      title: success ? 'Deploy Succeeded' : 'Deploy Failed',
      message: success
        ? `Deploy completed in ${Math.round(completed.durationMs / 1000)}s${commitSha ? ` (${commitSha.slice(0, 8)})` : ''}`
        : `Deploy failed${commitMessage ? `: ${commitMessage}` : ''}`,
      siteName: site?.name,
      timestamp: now,
    }).catch((err) =>
      this.logger.error(`Notification failed: ${safeErrorMessage(err)}`),
    );
  }

  async findStuckDeploys() {
    return this.prisma.deployLog.findMany({
      where: {
        status: { in: [DeployStatus.PENDING, DeployStatus.IN_PROGRESS] },
      },
      select: {
        id: true,
        branch: true,
        site: { select: { rootPath: true } },
      },
    });
  }

  async findBySite(options: DeployLogListOptions) {
    const { siteId, domainId, userId, role, page = 1, perPage = 20 } = options;
    const take = Math.min(perPage, 50);
    const skip = (page - 1) * take;

    await this.domainContext.requireOwnedSiteDomain(
      siteId,
      domainId,
      userId,
      role,
    );

    const [logs, total] = await Promise.all([
      this.prisma.deployLog.findMany({
        where: { siteDomainId: domainId },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        select: {
          id: true,
          status: true,
          branch: true,
          commitSha: true,
          commitMessage: true,
          durationMs: true,
          startedAt: true,
          completedAt: true,
        },
      }),
      this.prisma.deployLog.count({ where: { siteDomainId: domainId } }),
    ]);

    return {
      logs,
      meta: { page, perPage: take, total, totalPages: Math.ceil(total / take) },
    };
  }

  async findById(
    siteId: string,
    domainId: string,
    id: string,
    userId: string,
    role: string,
  ) {
    const log = await this.prisma.deployLog.findUnique({
      where: { id },
      include: {
        site: { select: { userId: true, name: true } },
        siteDomain: { select: { id: true, domain: true } },
      },
    });

    if (!log) throw new NotFoundException('Deploy log not found');
    if (log.siteId !== siteId || log.siteDomainId !== domainId) {
      throw new NotFoundException('Deploy log not found');
    }
    if (role !== 'ADMIN' && log.site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    return log;
  }

  async findSiteByDomain(domain: string) {
    return this.prisma.siteDomain.findUnique({
      where: { domain },
      select: {
        id: true,
        domain: true,
        preset: true,
        appStatus: true,
        gitRepository: true,
        deployBranch: true,
        appPort: true,
        phpVersion: true,
        envVars: true,
        runtimeKey: true,
        site: {
          select: { id: true, name: true, rootPath: true, userId: true },
        },
      },
    });
  }

  async findSiteByRepo(repoUrl: string) {
    const normalized = repoUrl
      .replace(/\.git$/, '')
      .replace(/^https?:\/\//, '')
      .replace(/^git@([^:]+):/, '$1/');

    const sites = await this.prisma.siteDomain.findMany({
      where: { gitRepository: { not: null } },
      select: {
        id: true,
        domain: true,
        preset: true,
        appStatus: true,
        gitRepository: true,
        deployBranch: true,
        filesRelPath: true,
        appPort: true,
        phpVersion: true,
        envVars: true,
        runtimeKey: true,
        site: {
          select: { id: true, name: true, rootPath: true, userId: true },
        },
      },
    });

    return sites.find((s) => {
      if (!s.gitRepository) return false;
      const siteNormalized = s.gitRepository
        .replace(/\.git$/, '')
        .replace(/^https?:\/\//, '')
        .replace(/^git@([^:]+):/, '$1/');
      return siteNormalized === normalized;
    });
  }
}
