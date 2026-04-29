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

interface DeployLogListOptions {
  siteId: string;
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
  ) {}

  async triggerDeploy(
    siteId: string,
    userId: string,
    role: string,
    branch?: string,
  ) {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: {
        id: true,
        name: true,
        domain: true,
        type: true,
        status: true,
        gitRepository: true,
        deployBranch: true,
        rootPath: true,
        appPort: true,
        phpVersion: true,
        envVars: true,
        userId: true,
      },
    });

    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    if (!site.gitRepository) {
      throw new BadRequestException('Site has no git repository configured');
    }

    // Prevent concurrent deploys
    const activeDeploy = await this.prisma.deployLog.findFirst({
      where: {
        siteId,
        status: { in: [DeployStatus.PENDING, DeployStatus.IN_PROGRESS] },
      },
      select: { id: true },
    });

    if (activeDeploy) {
      throw new BadRequestException('A deploy is already in progress for this site');
    }

    const deployBranch = branch || site.deployBranch || 'main';

    const deployLog = await this.prisma.deployLog.create({
      data: {
        siteId,
        branch: deployBranch,
        status: DeployStatus.PENDING,
        triggeredBy: userId,
      },
    });

    // Set site status to PLAYING
    await this.prisma.site.update({
      where: { id: siteId },
      data: { status: SiteStatus.DEPLOYING },
    });

    // =========================================================================
    // Agent: dispatch deploy execution (async — streams results back)
    // =========================================================================
    try {
      this.agentRelay.emitToAgentAsync('deploy:execute', {
        deployId: deployLog.id,
        siteType: site.type,
        rootPath: site.rootPath,
        gitRepository: site.gitRepository,
        branch: deployBranch,
        phpVersion: site.phpVersion,
        appPort: site.appPort,
        domain: site.domain,
        envVars: site.envVars || {},
      });

      this.logger.log(`Deploy triggered for site "${site.name}" (branch: ${deployBranch})`);
    } catch (err) {
      this.logger.error(`Failed to dispatch deploy: ${(err as Error).message}`);
      // Mark as failed if agent is unavailable
      await this.prisma.deployLog.update({
        where: { id: deployLog.id },
        data: {
          status: DeployStatus.FAILED,
          output: `Agent unavailable: ${(err as Error).message}`,
          completedAt: new Date(),
        },
      });
      await this.prisma.site.update({
        where: { id: siteId },
        data: { status: SiteStatus.ERROR },
      });
    }

    return { deployLog, site };
  }

  async rollbackDeploy(deployId: string, userId: string, role: string) {
    const deploy = await this.prisma.deployLog.findUnique({
      where: { id: deployId },
      include: {
        site: {
          select: {
            id: true, name: true, domain: true, type: true,
            rootPath: true, phpVersion: true, userId: true,
          },
        },
      },
    });

    if (!deploy) throw new NotFoundException('Deploy not found');
    if (role !== 'ADMIN' && deploy.site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    if (!deploy.commitSha) {
      throw new BadRequestException('Deploy has no commit SHA to rollback to');
    }

    // Create a new deploy log for the rollback
    const rollbackLog = await this.prisma.deployLog.create({
      data: {
        siteId: deploy.siteId,
        branch: deploy.branch,
        status: DeployStatus.PENDING,
        triggeredBy: userId,
        output: `[rollback] Rolling back to deploy ${deployId.slice(0, 8)} (commit ${deploy.commitSha.slice(0, 8)})\n`,
      },
    });

    await this.prisma.site.update({
      where: { id: deploy.siteId },
      data: { status: SiteStatus.DEPLOYING },
    });

    try {
      this.agentRelay.emitToAgentAsync('deploy:rollback', {
        deployId: rollbackLog.id,
        rootPath: deploy.site.rootPath,
        commitSha: deploy.commitSha,
        siteType: deploy.site.type,
        domain: deploy.site.domain,
        phpVersion: deploy.site.phpVersion,
      });

      this.logger.log(`Rollback triggered for "${deploy.site.name}" to commit ${deploy.commitSha.slice(0, 8)}`);
    } catch (err) {
      await this.prisma.deployLog.update({
        where: { id: rollbackLog.id },
        data: {
          status: DeployStatus.FAILED,
          output: `Agent unavailable: ${(err as Error).message}`,
          completedAt: new Date(),
        },
      });
      await this.prisma.site.update({
        where: { id: deploy.siteId },
        data: { status: SiteStatus.ERROR },
      });
    }

    return rollbackLog;
  }

  async appendOutput(deployId: string, output: string) {
    const current = await this.prisma.deployLog.findUnique({
      where: { id: deployId },
      select: { output: true },
    });
    if (!current) return;

    await this.prisma.deployLog.update({
      where: { id: deployId },
      data: {
        output: current.output + output,
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
    const deployLog = await this.prisma.deployLog.findUnique({
      where: { id: deployId },
      select: { siteId: true, startedAt: true },
    });

    if (!deployLog) return;

    const now = new Date();
    const durationMs = now.getTime() - deployLog.startedAt.getTime();

    await this.prisma.deployLog.update({
      where: { id: deployId },
      data: {
        status: success ? DeployStatus.SUCCESS : DeployStatus.FAILED,
        commitSha,
        commitMessage,
        completedAt: now,
        durationMs,
      },
    });

    await this.prisma.site.update({
      where: { id: deployLog.siteId },
      data: {
        status: success ? SiteStatus.RUNNING : SiteStatus.ERROR,
      },
    });

    // Dispatch notification
    const site = await this.prisma.site.findUnique({
      where: { id: deployLog.siteId },
      select: { name: true },
    });
    this.notifier.dispatch({
      event: success ? 'DEPLOY_SUCCESS' : 'DEPLOY_FAILED',
      title: success ? 'Deploy Succeeded' : 'Deploy Failed',
      message: success
        ? `Deploy completed in ${Math.round(durationMs / 1000)}s${commitSha ? ` (${commitSha.slice(0, 8)})` : ''}`
        : `Deploy failed${commitMessage ? `: ${commitMessage}` : ''}`,
      siteName: site?.name,
      timestamp: now,
    }).catch((err) => this.logger.error(`Notification failed: ${(err as Error).message}`));
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
    const { siteId, userId, role, page = 1, perPage = 20 } = options;
    const take = Math.min(perPage, 50);
    const skip = (page - 1) * take;

    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { userId: true },
    });

    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    const [logs, total] = await Promise.all([
      this.prisma.deployLog.findMany({
        where: { siteId },
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
      this.prisma.deployLog.count({ where: { siteId } }),
    ]);

    return {
      logs,
      meta: { page, perPage: take, total, totalPages: Math.ceil(total / take) },
    };
  }

  async findById(id: string, userId: string, role: string) {
    const log = await this.prisma.deployLog.findUnique({
      where: { id },
      include: {
        site: { select: { userId: true, name: true, domain: true } },
      },
    });

    if (!log) throw new NotFoundException('Deploy log not found');
    if (role !== 'ADMIN' && log.site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    return log;
  }

  async findSiteByDomain(domain: string) {
    return this.prisma.site.findUnique({
      where: { domain },
      select: {
        id: true,
        name: true,
        domain: true,
        type: true,
        status: true,
        gitRepository: true,
        deployBranch: true,
        rootPath: true,
        appPort: true,
        phpVersion: true,
        envVars: true,
        userId: true,
      },
    });
  }

  async findSiteByRepo(repoUrl: string) {
    const normalized = repoUrl
      .replace(/\.git$/, '')
      .replace(/^https?:\/\//, '')
      .replace(/^git@([^:]+):/, '$1/');

    const sites = await this.prisma.site.findMany({
      where: { gitRepository: { not: null } },
      select: {
        id: true,
        name: true,
        domain: true,
        type: true,
        status: true,
        gitRepository: true,
        deployBranch: true,
        rootPath: true,
        appPort: true,
        phpVersion: true,
        envVars: true,
        userId: true,
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
