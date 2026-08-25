import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
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
import { QUICK_COMMAND_OUTPUT_MAX_BYTES, SiteType } from '@meowbox/shared';
import { QuickCommandInputDto } from './site-node.dto';
import { DomainContextService } from '../sites/domain-context.service';
import { OperationAdmissionService } from '../operations/operation-admission.service';
import {
  OperationsWorkerService,
  type OperationExecutionContext,
} from '../operations/operations-worker.service';
import { OperationNeedsAttentionError } from '../operations/operation-errors';

const PROC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const QUICK_COMMAND_TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,99}$/;
const SITE_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const QUICK_COMMAND_OPERATION_ACTION = 'site.node.quick_command';
const QUICK_COMMAND_AGENT_ACTION = 'agent.node.quick_command';
type ProcessAction = 'stop' | 'restart' | 'reload' | 'delete';

interface QuickCommandOperationRequest {
  siteId: string;
  domainId: string;
  commandId: string;
  systemUser: string;
  source: 'npm' | 'make';
  target: string;
  cwd: string;
}

function validateQuickCommandRequest(request: unknown): QuickCommandOperationRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new BadRequestException('Quick command operation request is invalid');
  }
  const value = request as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !==
      'commandId,cwd,domainId,siteId,source,systemUser,target' ||
    typeof value.siteId !== 'string' ||
    !UUID_RE.test(value.siteId) ||
    typeof value.domainId !== 'string' ||
    !UUID_RE.test(value.domainId) ||
    typeof value.commandId !== 'string' ||
    !UUID_RE.test(value.commandId) ||
    typeof value.systemUser !== 'string' ||
    !SITE_USER_RE.test(value.systemUser) ||
    (value.source !== 'npm' && value.source !== 'make') ||
    typeof value.target !== 'string' ||
    !QUICK_COMMAND_TARGET_RE.test(value.target) ||
    typeof value.cwd !== 'string' ||
    value.cwd.length < 1 ||
    value.cwd.length > 512 ||
    !/^\/[^\0]*$/.test(value.cwd)
  ) {
    throw new BadRequestException('Quick command operation request is invalid');
  }
  return value as unknown as QuickCommandOperationRequest;
}

function validateQuickCommandResult(result: unknown): QuickCommandRunResult {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new OperationNeedsAttentionError('Quick command returned an invalid result');
  }
  const value = result as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !== 'durationMs,exitCode,output,truncated' ||
    typeof value.exitCode !== 'number' ||
    !Number.isInteger(value.exitCode) ||
    value.exitCode < 0 ||
    value.exitCode > 255 ||
    typeof value.output !== 'string' ||
    Buffer.byteLength(value.output, 'utf8') > QUICK_COMMAND_OUTPUT_MAX_BYTES ||
    typeof value.durationMs !== 'number' ||
    !Number.isInteger(value.durationMs) ||
    value.durationMs < 0 ||
    value.durationMs > 60 * 60_000 ||
    typeof value.truncated !== 'boolean'
  ) {
    throw new OperationNeedsAttentionError('Quick command returned an invalid result');
  }
  return value as unknown as QuickCommandRunResult;
}

/**
 * Управление Node.js-приложениями сайта.
 *
 * PM2-процессы: источник правды — ecosystem-файлы в репозитории сайта;
 * сервис лишь проксирует операции на агент (агент работает от имени
 * системного юзера сайта). Быстрые команды хранятся в БД (SiteQuickCommand).
 */
@Injectable()
export class SiteNodeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('SiteNodeService');
  private unregisterOperationHandler: (() => void) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentRelayService,
    private readonly domainContext: DomainContextService,
    private readonly admission: OperationAdmissionService,
    private readonly worker: OperationsWorkerService,
  ) {}

  onModuleInit(): void {
    this.unregisterOperationHandler = this.worker.registerHandler(
      QUICK_COMMAND_OPERATION_ACTION,
      (request, context) => this.executeQueuedQuickCommand(request, context),
    );
  }

  onModuleDestroy(): void {
    this.unregisterOperationHandler?.();
    this.unregisterOperationHandler = null;
  }

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

  async enqueueQuickCommand(
    siteId: string,
    domainId: string,
    commandId: string,
    actor: { userId: string; role: string },
    idempotencyKey?: string,
  ) {
    const ctx = await this.siteCtx(siteId, domainId);
    const cmd = await this.prisma.siteQuickCommand.findFirst({
      where: { id: commandId, siteId },
    });
    if (!cmd) throw new NotFoundException('Команда не найдена');

    const request = validateQuickCommandRequest({
      siteId,
      domainId,
      commandId,
      systemUser: ctx.systemUser,
      source: cmd.source,
      target: cmd.target,
      cwd: cmd.cwd,
    });
    return this.admission.admit({
      actionId: QUICK_COMMAND_OPERATION_ACTION,
      type: 'SITE_NODE_QUICK_COMMAND',
      idempotencyKey,
      actor,
      request,
      deadlineMs: 15 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      siteId,
      siteDomainId: domainId,
      lockSite: true,
    });
  }

  private async executeQueuedQuickCommand(
    request: unknown,
    context: OperationExecutionContext,
  ): Promise<QuickCommandRunResult> {
    const input = validateQuickCommandRequest(request);
    await context.heartbeat('execute', 5);
    const result = await this.agent.runAgentJob(
      {
        operationId: context.operationId,
        actionId: QUICK_COMMAND_AGENT_ACTION,
        step: 'execute',
        payload: {
          systemUser: input.systemUser,
          source: input.source,
          target: input.target,
          cwd: input.cwd,
        },
        deadlineAt: context.deadlineAt,
        cancelSafe: false,
      },
      () => context.isCancellationRequested(),
    );
    const validated = validateQuickCommandResult(result);
    this.logger.log(
      `Site ${input.siteId}: quick command completed ${input.source}:${input.target}`,
    );
    return validated;
  }
}
