import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { CronJobStatus } from '../common/enums';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { CreateCronJobDto, UpdateCronJobDto } from './cron.dto';

@Injectable()
export class CronService implements OnModuleInit {
  private readonly logger = new Logger('CronService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
  ) {}

  /**
   * Миграция: при старте переносим meowbox cron-entries из ROOT crontab в
   * crontab'ы соответствующих site-юзеров (per-site isolation). Идемпотентно —
   * повторный запуск ничего не делает, т.к. в root'овом crontab'е marker'ы
   * уже удалены.
   *
   * SECURITY: до этой миграции cron-задачи пользователей выполнялись с правами
   * root (агент = root). Это дыра уровня catastrophic. Теперь каждая задача
   * крутится в crontab'е своего Linux-юзера (systemUser сайта).
   */
  async onModuleInit() {
    // Ждём подключения агента (он может стартануть позже).
    setTimeout(() => {
      this.migrateRootCronToPerUser().catch((e) =>
        this.logger.error(`Cron migration failed: ${(e as Error).message}`),
      );
    }, 8_000);
  }

  private async migrateRootCronToPerUser(): Promise<void> {
    if (!this.agentRelay.isAgentConnected()) {
      this.logger.warn('Agent offline, skipping cron migration');
      return;
    }

    // Собираем mapping cronJobId → site.systemUser.
    const jobs = await this.prisma.cronJob.findMany({
      include: { site: { select: { systemUser: true, name: true } } },
    });
    if (jobs.length === 0) return;

    const mapping: Record<string, string> = {};
    for (const j of jobs) {
      const user = j.site.systemUser || j.site.name;
      if (user) mapping[j.id] = user;
    }

    const result = await this.agentRelay.emitToAgent(
      'cron:migrate-from-root',
      { mapping },
    );
    if (result.success && result.data) {
      const d = result.data as { moved: number; orphans: string[]; errors: string[] };
      if (d.moved > 0) {
        this.logger.log(
          `Cron migrated ${d.moved} jobs to per-user crontabs (orphans=${d.orphans.length})`,
        );
      }
      if (d.errors.length > 0) {
        this.logger.warn(`Cron migration errors: ${d.errors.join('; ')}`);
      }
    }
  }

  async findBySite(siteId: string, userId: string, role: string) {
    await this.assertSiteAccess(siteId, userId, role);

    return this.prisma.cronJob.findMany({
      where: { siteId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(dto: CreateCronJobDto, userId: string, role: string) {
    await this.assertSiteAccess(dto.siteId, userId, role);

    const site = await this.prisma.site.findUnique({
      where: { id: dto.siteId },
      select: { systemUser: true, name: true },
    });
    if (!site) throw new NotFoundException('Site not found');
    const systemUser = site.systemUser || site.name;
    if (!systemUser) {
      throw new InternalServerErrorException(
        'Site has no systemUser — cannot create cron job safely',
      );
    }

    const cronJob = await this.prisma.cronJob.create({
      data: {
        siteId: dto.siteId,
        name: dto.name,
        schedule: dto.schedule,
        command: dto.command,
        status: CronJobStatus.ACTIVE,
      },
    });

    // Agent: add crontab entry per-user.
    try {
      const result = await this.agentRelay.emitToAgent('cron:add', {
        id: cronJob.id,
        schedule: dto.schedule,
        command: dto.command,
        enabled: true,
        user: systemUser,
      });

      if (!result.success) {
        await this.prisma.cronJob.delete({ where: { id: cronJob.id } });
        throw new InternalServerErrorException(`Cron add failed: ${result.error}`);
      }

      this.logger.log(`Cron job "${dto.name}" added as ${systemUser}`);
    } catch (err) {
      if (err instanceof InternalServerErrorException) throw err;
      await this.prisma.cronJob.delete({ where: { id: cronJob.id } });
      throw new InternalServerErrorException((err as Error).message);
    }

    return cronJob;
  }

  async update(id: string, dto: UpdateCronJobDto, userId: string, role: string) {
    const cronJob = await this.findByIdWithAccess(id, userId, role);

    const updated = await this.prisma.cronJob.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.schedule !== undefined && { schedule: dto.schedule }),
        ...(dto.command !== undefined && { command: dto.command }),
        ...(dto.status !== undefined && { status: dto.status as CronJobStatus }),
      },
    });

    // Agent: update crontab entry
    const systemUser = await this.getSystemUser(cronJob.siteId);
    if (this.agentRelay.isAgentConnected() && systemUser) {
      try {
        await this.agentRelay.emitToAgent('cron:add', {
          id: updated.id,
          schedule: updated.schedule,
          command: updated.command,
          enabled: updated.status === CronJobStatus.ACTIVE,
          user: systemUser,
        });
      } catch (err) {
        this.logger.error(`Cron update failed: ${(err as Error).message}`);
      }
    }

    return updated;
  }

  async delete(id: string, userId: string, role: string) {
    const cronJob = await this.findByIdWithAccess(id, userId, role);

    const systemUser = await this.getSystemUser(cronJob.siteId);
    if (this.agentRelay.isAgentConnected() && systemUser) {
      try {
        await this.agentRelay.emitToAgent('cron:remove', { id, user: systemUser });
        this.logger.log(`Cron job ${id} removed from ${systemUser} crontab`);
      } catch (err) {
        this.logger.error(`Cron removal failed: ${(err as Error).message}`);
      }
    }

    await this.prisma.cronJob.delete({ where: { id } });
  }

  async toggleStatus(id: string, userId: string, role: string) {
    const cronJob = await this.findByIdWithAccess(id, userId, role);

    const newStatus =
      cronJob.status === CronJobStatus.ACTIVE
        ? CronJobStatus.DISABLED
        : CronJobStatus.ACTIVE;

    const updated = await this.prisma.cronJob.update({
      where: { id },
      data: { status: newStatus },
    });

    const systemUser = await this.getSystemUser(cronJob.siteId);
    if (this.agentRelay.isAgentConnected() && systemUser) {
      try {
        await this.agentRelay.emitToAgent('cron:add', {
          id: updated.id,
          schedule: updated.schedule,
          command: updated.command,
          enabled: newStatus === CronJobStatus.ACTIVE,
          user: systemUser,
        });
      } catch (err) {
        this.logger.error(`Cron toggle failed: ${(err as Error).message}`);
      }
    }

    return updated;
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private async getSystemUser(siteId: string): Promise<string | null> {
    const s = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { systemUser: true, name: true },
    });
    return (s?.systemUser || s?.name) ?? null;
  }

  private async findByIdWithAccess(id: string, userId: string, role: string) {
    const cronJob = await this.prisma.cronJob.findUnique({
      where: { id },
      include: { site: { select: { userId: true } } },
    });

    if (!cronJob) throw new NotFoundException('Cron job not found');
    if (role !== 'ADMIN' && cronJob.site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    return cronJob;
  }

  private async assertSiteAccess(siteId: string, userId: string, role: string) {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { userId: true },
    });

    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
  }
}
