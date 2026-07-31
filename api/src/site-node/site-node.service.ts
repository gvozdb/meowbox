import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { PrismaService } from '../common/prisma.service';
import type {
  NodeProcessesResult,
  NodeDomainRef,
  DiscoveredCommandGroup,
  QuickCommand,
  QuickCommandRunResult,
} from '@meowbox/shared';
import { SiteType } from '@meowbox/shared';
import { QuickCommandInputDto } from './site-node.dto';
import { DomainContextService } from '../sites/domain-context.service';

const PROC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
type ProcessAction = 'stop' | 'restart' | 'reload' | 'delete';

/**
 * Управление Node.js-приложениями сайта.
 *
 * PM2-процессы: источник правды — ecosystem-файлы в репозитории сайта;
 * сервис лишь проксирует операции на агент (агент работает от имени
 * системного юзера сайта). Быстрые команды хранятся в БД (SiteQuickCommand).
 */
@Injectable()
export class SiteNodeService {
  private readonly logger = new Logger('SiteNodeService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentRelayService,
    private readonly domainContext: DomainContextService,
  ) {}

  private async siteCtx(
    siteId: string,
    domainId: string,
  ): Promise<{ systemUser: string; filesRelPath: string; domainRoots: NodeDomainRef[] }> {
    const { site, domain } =
      await this.domainContext.requireOwnedSiteDomain(
        siteId,
        domainId,
        '',
        'ADMIN',
      );
    if (domain.preset !== 'CUSTOM') {
      throw new BadRequestException('Node.js is available only for CUSTOM applications');
    }

    return {
      systemUser: site.systemUser || site.name,
      filesRelPath: domain.filesRelPath,
      domainRoots: [
        {
          domainId: domain.id,
          domain: domain.domain,
          preset: SiteType.CUSTOM,
          filesRelPath: domain.filesRelPath,
          isPrimary: domain.isPrimary,
          position: domain.position,
        },
      ],
    };
  }

  private unwrap<T>(
    result: { success: boolean; data?: T; error?: string },
    fallback: string,
  ): T {
    if (!result.success) {
      throw new InternalServerErrorException(result.error || fallback);
    }
    return result.data as T;
  }

  private assertProcName(name: string): void {
    if (!PROC_NAME_RE.test(name)) {
      throw new BadRequestException('Некорректное имя процесса');
    }
  }

  // ----------------------------------------------------------------
  // PM2-процессы
  // ----------------------------------------------------------------

  async getProcesses(siteId: string, domainId: string): Promise<NodeProcessesResult> {
    const ctx = await this.siteCtx(siteId, domainId);
    const result = await this.agent.emitToAgent<NodeProcessesResult>(
      'node:processes',
      ctx,
    );
    return this.unwrap(result, 'Не удалось получить список процессов');
  }

  async startEcosystem(
    siteId: string,
    domainId: string,
    file: string,
    only?: string,
  ): Promise<void> {
    const ctx = await this.siteCtx(siteId, domainId);
    const result = await this.agent.emitToAgent('node:ecosystem-start', {
      ...ctx,
      file,
      only,
    });
    this.unwrap(result, 'Не удалось запустить приложение');
    this.logger.log(`Site ${siteId}: ecosystem start ${file}${only ? ` (${only})` : ''}`);
  }

  async controlProcess(
    siteId: string,
    domainId: string,
    action: ProcessAction,
    name: string,
  ): Promise<void> {
    this.assertProcName(name);
    const ctx = await this.siteCtx(siteId, domainId);
    const result = await this.agent.emitToAgent('node:process-control', {
      ...ctx,
      action,
      name,
    });
    this.unwrap(result, 'Не удалось выполнить операцию с процессом');
    this.logger.log(`Site ${siteId}: pm2 ${action} ${name}`);
  }

  async getProcessLogs(
    siteId: string,
    domainId: string,
    name: string,
    lines: number,
  ): Promise<string> {
    this.assertProcName(name);
    const ctx = await this.siteCtx(siteId, domainId);
    const result = await this.agent.emitToAgent<string>('node:process-logs', {
      ...ctx,
      name,
      lines,
    });
    return this.unwrap(result, 'Не удалось получить логи процесса');
  }

  // ----------------------------------------------------------------
  // Автозагрузка
  // ----------------------------------------------------------------

  async getAutostart(siteId: string, domainId: string): Promise<{ enabled: boolean }> {
    const ctx = await this.siteCtx(siteId, domainId);
    const result = await this.agent.emitToAgent<{ enabled: boolean }>(
      'node:autostart-get',
      { systemUser: ctx.systemUser },
    );
    return this.unwrap(result, 'Не удалось получить статус автозагрузки');
  }

  async setAutostart(siteId: string, domainId: string, enable: boolean): Promise<void> {
    const ctx = await this.siteCtx(siteId, domainId);
    const result = await this.agent.emitToAgent('node:autostart-set', {
      systemUser: ctx.systemUser,
      enable,
    });
    this.unwrap(result, 'Не удалось изменить автозагрузку');
    this.logger.log(`Site ${siteId}: autostart ${enable ? 'enabled' : 'disabled'}`);
  }

  // ----------------------------------------------------------------
  // Быстрые команды
  // ----------------------------------------------------------------

  async discoverCommands(
    siteId: string,
    domainId: string,
  ): Promise<DiscoveredCommandGroup[]> {
    const ctx = await this.siteCtx(siteId, domainId);
    const result = await this.agent.emitToAgent<DiscoveredCommandGroup[]>(
      'node:commands-discover',
      ctx,
    );
    return this.unwrap(result, 'Не удалось просканировать команды');
  }

  async listQuickCommands(siteId: string, domainId: string): Promise<QuickCommand[]> {
    await this.siteCtx(siteId, domainId);
    const rows = await this.prisma.siteQuickCommand.findMany({
      where: { siteId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      source: r.source as 'npm' | 'make',
      target: r.target,
      cwd: r.cwd,
      sortOrder: r.sortOrder,
    }));
  }

  /** Полная замена набора быстрых команд сайта (сохранение из модалки «Настроить»). */
  async replaceQuickCommands(
    siteId: string,
    domainId: string,
    commands: QuickCommandInputDto[],
  ): Promise<QuickCommand[]> {
    await this.siteCtx(siteId, domainId);
    await this.prisma.$transaction([
      this.prisma.siteQuickCommand.deleteMany({ where: { siteId } }),
      this.prisma.siteQuickCommand.createMany({
        data: commands.map((c, idx) => ({
          siteId,
          label: c.label,
          source: c.source,
          target: c.target,
          cwd: c.cwd,
          sortOrder: typeof c.sortOrder === 'number' ? c.sortOrder : idx,
        })),
      }),
    ]);
    return this.listQuickCommands(siteId, domainId);
  }

  async runQuickCommand(
    siteId: string,
    domainId: string,
    commandId: string,
  ): Promise<QuickCommandRunResult> {
    const ctx = await this.siteCtx(siteId, domainId);
    const cmd = await this.prisma.siteQuickCommand.findFirst({
      where: { id: commandId, siteId },
    });
    if (!cmd) throw new NotFoundException('Команда не найдена');

    // Таймаут больше, чем handler-timeout агента (630s) — иначе API отвалится
    // по таймауту раньше, чем агент успеет вернуть результат.
    const result = await this.agent.emitToAgent<QuickCommandRunResult>(
      'node:command-run',
      {
        systemUser: ctx.systemUser,
        source: cmd.source,
        target: cmd.target,
        cwd: cmd.cwd,
      },
      660_000,
    );
    this.logger.log(`Site ${siteId}: quick command run ${cmd.source}:${cmd.target}`);
    return this.unwrap(result, 'Не удалось выполнить команду');
  }
}
