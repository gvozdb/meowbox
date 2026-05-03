import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { CronJobStatus } from '../common/enums';
import {
  CreateSystemCronJobDto,
  UpdateSystemCronJobDto,
} from './system-cron.dto';

/**
 * Управление задачами в crontab пользователя `root` — общесистемные
 * cron'ы, не привязанные к конкретному сайту.
 *
 * Использует тот же агентский handler `cron:add`/`cron:remove`, что и
 * per-site CronJob, передавая `user: 'root'`. Это безопасно — `cron.manager.ts`
 * валидирует имя пользователя через regex и пишет crontab атомарно через
 * tmp-файл, без shell-инъекций.
 *
 * Безопасность: SystemCron — root-уровень. Все команды бегут от root.
 * Доступ к этому модулю должен быть только у роли ADMIN.
 */
@Injectable()
export class SystemCronService {
  private readonly logger = new Logger('SystemCronService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
  ) {}

  // ─── Public API ────────────────────────────────────────────────────────

  async findAll() {
    return this.prisma.systemCronJob.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(dto: CreateSystemCronJobDto, role: string) {
    this.assertAdmin(role);

    const job = await this.prisma.systemCronJob.create({
      data: {
        name: dto.name,
        schedule: dto.schedule,
        command: dto.command,
        comment: dto.comment ?? null,
        status: CronJobStatus.ACTIVE,
        source: 'MANUAL',
      },
    });

    try {
      const result = await this.agentRelay.emitToAgent('cron:add', {
        id: job.id,
        schedule: dto.schedule,
        command: dto.command,
        enabled: true,
        user: 'root',
      });

      if (!result.success) {
        await this.prisma.systemCronJob.delete({ where: { id: job.id } });
        throw new InternalServerErrorException(
          `System cron add failed: ${result.error}`,
        );
      }

      this.logger.log(`System cron "${dto.name}" added (root)`);
    } catch (err) {
      if (err instanceof InternalServerErrorException) throw err;
      await this.prisma.systemCronJob.delete({ where: { id: job.id } });
      throw new InternalServerErrorException((err as Error).message);
    }

    return job;
  }

  async update(id: string, dto: UpdateSystemCronJobDto, role: string) {
    this.assertAdmin(role);
    const existing = await this.findById(id);

    const updated = await this.prisma.systemCronJob.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.schedule !== undefined && { schedule: dto.schedule }),
        ...(dto.command !== undefined && { command: dto.command }),
        ...(dto.comment !== undefined && { comment: dto.comment }),
        ...(dto.status !== undefined && { status: dto.status }),
      },
    });

    if (this.agentRelay.isAgentConnected()) {
      try {
        await this.agentRelay.emitToAgent('cron:add', {
          id: updated.id,
          schedule: updated.schedule,
          command: updated.command,
          enabled: updated.status === CronJobStatus.ACTIVE,
          user: 'root',
        });
      } catch (err) {
        this.logger.error(`System cron update failed: ${(err as Error).message}`);
      }
    } else {
      this.logger.warn(
        `System cron ${id} updated in DB, but agent offline — crontab not synced`,
      );
    }

    return updated;
  }

  async delete(id: string, role: string) {
    this.assertAdmin(role);
    await this.findById(id); // 404 if missing

    if (this.agentRelay.isAgentConnected()) {
      try {
        await this.agentRelay.emitToAgent('cron:remove', { id, user: 'root' });
        this.logger.log(`System cron ${id} removed from root crontab`);
      } catch (err) {
        this.logger.error(`System cron removal failed: ${(err as Error).message}`);
      }
    }

    await this.prisma.systemCronJob.delete({ where: { id } });
  }

  async toggleStatus(id: string, role: string) {
    this.assertAdmin(role);
    const existing = await this.findById(id);

    const newStatus =
      existing.status === CronJobStatus.ACTIVE
        ? CronJobStatus.DISABLED
        : CronJobStatus.ACTIVE;

    const updated = await this.prisma.systemCronJob.update({
      where: { id },
      data: { status: newStatus },
    });

    if (this.agentRelay.isAgentConnected()) {
      try {
        await this.agentRelay.emitToAgent('cron:add', {
          id: updated.id,
          schedule: updated.schedule,
          command: updated.command,
          enabled: newStatus === CronJobStatus.ACTIVE,
          user: 'root',
        });
      } catch (err) {
        this.logger.error(`System cron toggle failed: ${(err as Error).message}`);
      }
    }

    return updated;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private async findById(id: string) {
    const job = await this.prisma.systemCronJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('System cron job not found');
    return job;
  }

  private assertAdmin(role: string) {
    if (role !== 'ADMIN') {
      throw new ForbiddenException('Only admins can manage system cron jobs');
    }
  }
}
