import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'crypto';
import {
  VpnProtocol,
  VpnServiceStatus,
  VpnServiceConfig,
  VpnUserCreds,
  VpnUserCredsView,
  DEFAULT_AMNEZIA_NETWORK,
  DEFAULT_AMNEZIA_DNS,
  DEFAULT_AMNEZIA_MTU,
  isVpnPortReserved,
  SniValidationResult,
} from '@meowbox/shared';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import {
  encryptVpnJson,
  decryptVpnJson,
  assertVpnSecretConfigured,
} from '../common/crypto/vpn-cipher';
import { VpnRegistry } from './vpn.registry';
import { NotificationDispatcherService } from '../notifications/notification-dispatcher.service';
import { CreateServiceDto, CreateUserDto, UpdateUserDto } from './vpn.dto';
import { XrayRealityProvider } from './providers/xray-reality.provider';
import {
  AmneziaWgProvider,
  allocateNextIp,
  buildWgQuickConfig,
} from './providers/amnezia-wg.provider';
import {
  buildVlessUrl,
} from './providers/xray-reality.provider';
import { OperationAdmissionService } from '../operations/operation-admission.service';
import {
  OperationsWorkerService,
  type OperationExecutionContext,
} from '../operations/operations-worker.service';
import { OperationNeedsAttentionError } from '../operations/operation-errors';

const VPN_RUNTIME_OPERATION_ACTIONS = {
  INSTALL: 'vpn.runtime.install',
  UNINSTALL: 'vpn.runtime.uninstall',
  SNI_HEALTH_CHECK: 'vpn.sni_health_check',
} as const;

const VPN_RUNTIME_AGENT_ACTIONS = {
  INSTALL_XRAY: 'agent.vpn.runtime.install_xray',
  INSTALL_AMNEZIA: 'agent.vpn.runtime.install_amnezia',
  UNINSTALL_XRAY: 'agent.vpn.runtime.uninstall_xray',
  UNINSTALL_AMNEZIA: 'agent.vpn.runtime.uninstall_amnezia',
} as const;

interface VpnRuntimeOperationRequest {
  protocol: VpnProtocol;
}

function validateVpnRuntimeRequest(request: unknown): VpnRuntimeOperationRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new OperationNeedsAttentionError('VPN runtime request is invalid');
  }
  const value = request as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !== 'protocol' ||
    (value.protocol !== VpnProtocol.VLESS_REALITY &&
      value.protocol !== VpnProtocol.AMNEZIA_WG)
  ) {
    throw new OperationNeedsAttentionError('VPN runtime request is invalid');
  }
  return value as unknown as VpnRuntimeOperationRequest;
}

function validateVpnRuntimeInstallResult(result: unknown): {
  installed: true;
  version: string | null;
} {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new OperationNeedsAttentionError('VPN runtime install result is invalid');
  }
  const value = result as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !['installed', 'version', 'details'].includes(key)) ||
    value.installed !== true ||
    (value.version !== null &&
      (typeof value.version !== 'string' || value.version.length > 128)) ||
    (value.details !== undefined &&
      (typeof value.details !== 'string' || value.details.length > 1_024))
  ) {
    throw new OperationNeedsAttentionError('VPN runtime install result is invalid');
  }
  return { installed: true, version: value.version as string | null };
}

function validateVpnRuntimeUninstallResult(result: unknown): {
  uninstalled: true;
} {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new OperationNeedsAttentionError('VPN runtime uninstall result is invalid');
  }
  const value = result as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'uninstalled' || value.uninstalled !== true) {
    throw new OperationNeedsAttentionError('VPN runtime uninstall was not confirmed');
  }
  return { uninstalled: true };
}

interface PublicHostInfo {
  publicIp: string | null;
}

interface SubscriptionEntry {
  fingerprint: string;
  content: string;
}

interface SubscriptionUser {
  id: string;
  name: string;
  enabled: boolean;
  updatedAt: Date;
  creds: Array<{
    id: string;
    serviceId: string;
    credsBlob: string;
    updatedAt: Date;
    service: {
      id: string;
      label: string | null;
      protocol: string;
      port: number;
      status: string;
      configBlob: string;
      updatedAt: Date;
    };
  }>;
}

export interface FederatedVpnSubscriptionSourceSnapshot {
  sourceId: string;
  epoch: string;
  entries: readonly SubscriptionEntry[];
}

@Injectable()
export class VpnService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('VpnService');
  /** Кеш определённого через агент публичного IP. Сбрасывается раз в час. */
  private hostInfoCache: { publicIp: string | null; cachedAt: number } | null = null;
  private static readonly HOST_INFO_TTL_MS = 60 * 60 * 1000;
  private unregisterOperationHandlers: Array<() => void> = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly relay: AgentRelayService,
    private readonly registry: VpnRegistry,
    private readonly xrayReality: XrayRealityProvider,
    private readonly amneziaWg: AmneziaWgProvider,
    private readonly notifications: NotificationDispatcherService,
    private readonly admission: OperationAdmissionService,
    private readonly worker: OperationsWorkerService,
  ) {}

  // =========================================================================
  // Установка runtime'ов (Xray / AmneziaWG)
  // =========================================================================

  async getInstallStatus(): Promise<{
    xray: { installed: boolean; version: string | null; details?: string };
    amnezia: { installed: boolean; version: string | null; details?: string };
  }> {
    if (!this.relay.isAgentConnected()) {
      return {
        xray: { installed: false, version: null, details: 'agent offline' },
        amnezia: { installed: false, version: null, details: 'agent offline' },
      };
    }
    const r = await this.relay.emitToAgent<{
      xray: { installed: boolean; version: string | null; details?: string };
      amnezia: { installed: boolean; version: string | null; details?: string };
    }>('vpn:installer:status', {});
    if (!r.success || !r.data) {
      return {
        xray: { installed: false, version: null },
        amnezia: { installed: false, version: null },
      };
    }
    return r.data;
  }

  async installRuntime(
    protocol: VpnProtocol,
    userId: string,
    role: string,
    idempotencyKey?: string,
  ) {
    if (!this.relay.isAgentConnected()) {
      throw new BadRequestException('Агент не подключён');
    }
    return this.admission.admit({
      actionId: VPN_RUNTIME_OPERATION_ACTIONS.INSTALL,
      type: 'VPN_RUNTIME_INSTALL',
      idempotencyKey,
      actor: { userId, role },
      request: { protocol },
      deadlineMs: 11 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      globalLockKey: `vpn-runtime:${protocol.toLowerCase().replaceAll('_', '-')}`,
    });
  }

  async uninstallRuntime(
    protocol: VpnProtocol,
    userId: string,
    role: string,
    idempotencyKey?: string,
  ) {
    if (!this.relay.isAgentConnected()) {
      throw new BadRequestException('Агент не подключён');
    }
    // Защита: нельзя удалять runtime если есть активные сервисы этого протокола.
    const count = await this.prisma.vpnService.count({ where: { protocol } });
    if (count > 0) {
      throw new BadRequestException(
        `Нельзя удалить runtime: на сервере ${count} активных сервисов этого типа. Удали их сначала.`,
      );
    }
    return this.admission.admit({
      actionId: VPN_RUNTIME_OPERATION_ACTIONS.UNINSTALL,
      type: 'VPN_RUNTIME_UNINSTALL',
      idempotencyKey,
      actor: { userId, role },
      request: { protocol },
      deadlineMs: 11 * 60_000,
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      globalLockKey: `vpn-runtime:${protocol.toLowerCase().replaceAll('_', '-')}`,
    });
  }

  async onModuleInit(): Promise<void> {
    this.unregisterOperationHandlers.push(
      this.worker.registerHandler(
        VPN_RUNTIME_OPERATION_ACTIONS.INSTALL,
        (request, context) => this.executeRuntimeInstall(request, context),
      ),
      this.worker.registerHandler(
        VPN_RUNTIME_OPERATION_ACTIONS.UNINSTALL,
        (request, context) => this.executeRuntimeUninstall(request, context),
      ),
      this.worker.registerHandler(
        VPN_RUNTIME_OPERATION_ACTIONS.SNI_HEALTH_CHECK,
        (request, context) => this.executeSniHealthCheck(request, context),
      ),
    );
    // Прогреваем мастер-ключ — авто-создаст файл если нужно.
    try {
      assertVpnSecretConfigured();
    } catch (err) {
      this.logger.error(
        `VPN secret key bootstrap failed: ${(err as Error).message}. ` +
          `VPN модуль не сможет шифровать конфиги. Проверь миграцию ` +
          `2026-05-09-001-vpn-secret-bootstrap или env VPN_SECRET_KEY.`,
      );
    }
  }

  onModuleDestroy(): void {
    for (const unregister of this.unregisterOperationHandlers.splice(0)) unregister();
  }

  private async executeRuntimeInstall(
    request: unknown,
    context: OperationExecutionContext,
  ) {
    const input = validateVpnRuntimeRequest(request);
    await context.heartbeat('install-runtime', 5);
    const actionId = input.protocol === VpnProtocol.VLESS_REALITY
      ? VPN_RUNTIME_AGENT_ACTIONS.INSTALL_XRAY
      : VPN_RUNTIME_AGENT_ACTIONS.INSTALL_AMNEZIA;
    const result = await this.relay.runAgentJob(
      {
        operationId: context.operationId,
        actionId,
        step: 'install-runtime',
        payload: {},
        deadlineAt: context.deadlineAt,
        cancelSafe: false,
      },
      () => context.isCancellationRequested(),
    );
    return validateVpnRuntimeInstallResult(result);
  }

  private async executeRuntimeUninstall(
    request: unknown,
    context: OperationExecutionContext,
  ) {
    const input = validateVpnRuntimeRequest(request);
    const count = await this.prisma.vpnService.count({
      where: { protocol: input.protocol },
    });
    if (count > 0) {
      throw new OperationNeedsAttentionError(
        `VPN runtime is still referenced by ${count} service(s)`,
      );
    }
    await context.heartbeat('uninstall-runtime', 5);
    const actionId = input.protocol === VpnProtocol.VLESS_REALITY
      ? VPN_RUNTIME_AGENT_ACTIONS.UNINSTALL_XRAY
      : VPN_RUNTIME_AGENT_ACTIONS.UNINSTALL_AMNEZIA;
    const result = await this.relay.runAgentJob(
      {
        operationId: context.operationId,
        actionId,
        step: 'uninstall-runtime',
        payload: {},
        deadlineAt: context.deadlineAt,
        cancelSafe: false,
      },
      () => context.isCancellationRequested(),
    );
    return validateVpnRuntimeUninstallResult(result);
  }

  // =========================================================================
  // Сервисы
  // =========================================================================

  async listServices() {
    const services = await this.prisma.vpnService.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { userCreds: true } } },
    });
    return services.map((s) => ({
      id: s.id,
      label: s.label,
      protocol: s.protocol,
      port: s.port,
      status: s.status,
      errorMessage: s.errorMessage,
      sniMask: s.sniMask,
      sniLastCheckOk: s.sniLastCheckOk,
      sniLastCheckedAt: s.sniLastCheckedAt,
      sniLastError: s.sniLastError,
      usersCount: s._count.userCreds,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
  }

  async getService(id: string) {
    const s = await this.prisma.vpnService.findUnique({
      where: { id },
      include: { _count: { select: { userCreds: true } } },
    });
    if (!s) throw new NotFoundException(`VPN service ${id} not found`);
    return {
      id: s.id,
      label: s.label,
      protocol: s.protocol,
      port: s.port,
      status: s.status,
      errorMessage: s.errorMessage,
      sniMask: s.sniMask,
      sniLastCheckOk: s.sniLastCheckOk,
      sniLastCheckedAt: s.sniLastCheckedAt,
      sniLastError: s.sniLastError,
      usersCount: s._count.userCreds,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  async createService(dto: CreateServiceDto) {
    this.assertPortIsAvailableForProtocol(dto.protocol, dto.port);

    if (!this.relay.isAgentConnected()) {
      throw new BadRequestException('Агент не подключён');
    }

    // Проверка что runtime установлен.
    const status = await this.getInstallStatus();
    if (dto.protocol === VpnProtocol.VLESS_REALITY && !status.xray.installed) {
      throw new BadRequestException(
        'Xray-core не установлен. Нажми «Установить Xray» в блоке runtime\'ов.',
      );
    }
    if (dto.protocol === VpnProtocol.AMNEZIA_WG && !status.amnezia.installed) {
      throw new BadRequestException(
        'AmneziaWG не установлен. Нажми «Установить AmneziaWG» в блоке runtime\'ов.',
      );
    }

    // Уникальность по протокол+порт.
    const conflicting = await this.prisma.vpnService.findUnique({
      where: { protocol_port: { protocol: dto.protocol, port: dto.port } },
    });
    if (conflicting) {
      throw new ConflictException(
        `Сервис ${dto.protocol} уже существует на порту ${dto.port}`,
      );
    }

    // Доп. валидация порта — не занят ли в системе.
    const busy = await this.relay.emitToAgent<{ busy: boolean }>('vpn:port-busy', {
      port: dto.port,
      proto: dto.protocol === VpnProtocol.AMNEZIA_WG ? 'udp' : 'tcp',
    });
    if (busy.success && busy.data?.busy) {
      throw new BadRequestException(
        `Порт ${dto.port} уже занят другим процессом на сервере`,
      );
    }

    const provider = this.registry.get(dto.protocol);
    const serviceId = randomUUID();

    // Создаём запись со статусом DEPLOYING.
    const initialBlob = encryptVpnJson({ pending: true });
    await this.prisma.vpnService.create({
      data: {
        id: serviceId,
        label: dto.label,
        protocol: dto.protocol,
        port: dto.port,
        status: VpnServiceStatus.DEPLOYING,
        configBlob: initialBlob,
        sniMask: dto.protocol === VpnProtocol.VLESS_REALITY ? dto.sniMask ?? null : null,
      },
    });

    try {
      const cfg = await provider.install(
        {
          protocol: dto.protocol,
          port: dto.port,
          sniMask: dto.sniMask,
          network: dto.network,
          dns: dto.dns,
          mtu: dto.mtu,
        },
        serviceId,
      );

      await this.prisma.vpnService.update({
        where: { id: serviceId },
        data: {
          status: VpnServiceStatus.RUNNING,
          configBlob: encryptVpnJson(cfg),
          errorMessage: null,
        },
      });
      this.logger.log(
        `Created VPN service ${dto.protocol} on :${dto.port} (id=${serviceId})`,
      );
      return this.getService(serviceId);
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.error(`Install failed for ${serviceId}: ${msg}`);
      await this.prisma.vpnService.update({
        where: { id: serviceId },
        data: { status: VpnServiceStatus.ERROR, errorMessage: msg },
      });
      throw new BadRequestException(`Развёртывание упало: ${msg}`);
    }
  }

  async deleteService(id: string): Promise<void> {
    const s = await this.prisma.vpnService.findUnique({ where: { id } });
    if (!s) throw new NotFoundException(`VPN service ${id} not found`);
    if (this.relay.isAgentConnected()) {
      try {
        const provider = this.registry.get(s.protocol);
        await provider.uninstall(s.id, s.port);
      } catch (err) {
        this.logger.warn(`Uninstall agent-side error: ${(err as Error).message}`);
        // продолжаем — БД почистим
      }
    }
    await this.prisma.vpnService.delete({ where: { id } });
  }

  async startService(id: string): Promise<void> {
    const s = await this.prisma.vpnService.findUnique({ where: { id } });
    if (!s) throw new NotFoundException();
    this.assertPortIsAvailableForProtocol(s.protocol as VpnProtocol, s.port);
    const provider = this.registry.get(s.protocol);
    await provider.start(s.id);
    await this.prisma.vpnService.update({
      where: { id },
      data: { status: VpnServiceStatus.RUNNING, errorMessage: null },
    });
  }

  async stopService(id: string): Promise<void> {
    const s = await this.prisma.vpnService.findUnique({ where: { id } });
    if (!s) throw new NotFoundException();
    const provider = this.registry.get(s.protocol);
    await provider.stop(s.id);
    await this.prisma.vpnService.update({
      where: { id },
      data: { status: VpnServiceStatus.STOPPED },
    });
  }

  private assertPortIsAvailableForProtocol(protocol: VpnProtocol, port: number): void {
    if (!isVpnPortReserved(protocol, port)) return;
    throw new BadRequestException(
      `TCP-порт ${port} зарезервирован для HTTP/HTTPS сайтов Meowbox. Выбери другой порт, например 8443.`,
    );
  }

  async validateSni(sniMask: string): Promise<SniValidationResult> {
    if (!this.relay.isAgentConnected()) {
      throw new BadRequestException('Агент не подключён');
    }
    return this.xrayReality.validateSni(sniMask);
  }

  async rotateSni(id: string, newSni: string): Promise<void> {
    const s = await this.prisma.vpnService.findUnique({ where: { id } });
    if (!s) throw new NotFoundException();
    if (s.protocol !== VpnProtocol.VLESS_REALITY) {
      throw new BadRequestException('rotate-sni доступно только для VLESS+Reality');
    }
    await this.xrayReality.rotateSni(s.id, newSni);
    // Обновим конфиг в БД (sniMask меняется).
    const cfg = decryptVpnJson<VpnServiceConfig>(s.configBlob);
    if (cfg.protocol === VpnProtocol.VLESS_REALITY) {
      cfg.sniMask = newSni;
      await this.prisma.vpnService.update({
        where: { id },
        data: {
          configBlob: encryptVpnJson(cfg),
          sniMask: newSni,
          sniLastCheckOk: true,
          sniLastCheckedAt: new Date(),
          sniLastError: null,
        },
      });
    }
  }

  async rotateKeys(id: string): Promise<void> {
    const s = await this.prisma.vpnService.findUnique({ where: { id } });
    if (!s) throw new NotFoundException();
    const cfg = decryptVpnJson<VpnServiceConfig>(s.configBlob);
    if (cfg.protocol === VpnProtocol.VLESS_REALITY) {
      const fresh = await this.xrayReality.rotateKeys(s.id);
      cfg.privKey = fresh.privKey;
      cfg.pubKey = fresh.pubKey;
      cfg.shortId = fresh.shortId;
      await this.prisma.vpnService.update({
        where: { id },
        data: { configBlob: encryptVpnJson(cfg) },
      });
    } else if (cfg.protocol === VpnProtocol.AMNEZIA_WG) {
      const fresh = await this.amneziaWg.rotateKeys(s.id);
      cfg.srvPriv = fresh.srvPriv;
      cfg.srvPub = fresh.srvPub;
      await this.prisma.vpnService.update({
        where: { id },
        data: { configBlob: encryptVpnJson(cfg) },
      });
    }
  }

  // =========================================================================
  // Юзеры
  // =========================================================================

  async listUsers() {
    const users = await this.prisma.vpnUser.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        creds: {
          select: {
            id: true,
            serviceId: true,
            createdAt: true,
            service: {
              select: { protocol: true, port: true, label: true, status: true },
            },
          },
        },
      },
    });
    return users.map((u) => ({
      id: u.id,
      name: u.name,
      enabled: u.enabled,
      notes: u.notes,
      subToken: u.subToken,
      services: u.creds.map((c) => ({
        credId: c.id,
        serviceId: c.serviceId,
        protocol: c.service.protocol,
        port: c.service.port,
        label: c.service.label,
        status: c.service.status,
        createdAt: c.createdAt,
      })),
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    }));
  }

  async createUser(dto: CreateUserDto) {
    const existing = await this.prisma.vpnUser.findUnique({ where: { name: dto.name } });
    if (existing) {
      throw new ConflictException(`Юзер с именем "${dto.name}" уже есть`);
    }
    const subToken = randomBytes(32).toString('hex');

    const user = await this.prisma.vpnUser.create({
      data: {
        name: dto.name,
        subToken,
        notes: dto.notes,
      },
    });

    if (dto.serviceIds && dto.serviceIds.length > 0) {
      for (const serviceId of dto.serviceIds) {
        try {
          await this.addUserToService(user.id, serviceId);
        } catch (err) {
          this.logger.warn(
            `Failed to add user ${user.id} to ${serviceId}: ${(err as Error).message}`,
          );
        }
      }
    }
    return this.getUser(user.id);
  }

  async getUser(id: string) {
    const u = await this.prisma.vpnUser.findUnique({
      where: { id },
      include: {
        creds: {
          select: {
            id: true,
            serviceId: true,
            createdAt: true,
            service: { select: { protocol: true, port: true, label: true, status: true } },
          },
        },
      },
    });
    if (!u) throw new NotFoundException(`VPN user ${id} not found`);
    return {
      id: u.id,
      name: u.name,
      enabled: u.enabled,
      notes: u.notes,
      subToken: u.subToken,
      services: u.creds.map((c) => ({
        credId: c.id,
        serviceId: c.serviceId,
        protocol: c.service.protocol,
        port: c.service.port,
        label: c.service.label,
        status: c.service.status,
        createdAt: c.createdAt,
      })),
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    };
  }

  async updateUser(id: string, dto: UpdateUserDto) {
    const u = await this.prisma.vpnUser.findUnique({ where: { id } });
    if (!u) throw new NotFoundException();
    if (dto.name && dto.name !== u.name) {
      const conflict = await this.prisma.vpnUser.findUnique({ where: { name: dto.name } });
      if (conflict) throw new ConflictException();
    }

    // Если меняется enabled — мутируем agent-side для всех связанных сервисов.
    if (dto.enabled !== undefined && dto.enabled !== u.enabled) {
      const allCreds = await this.prisma.vpnUserCreds.findMany({
        where: { userId: id },
        include: { service: true },
      });
      for (const c of allCreds) {
        const provider = this.registry.get(c.service.protocol);
        const cfg = decryptVpnJson<VpnServiceConfig>(c.service.configBlob);
        const creds = decryptVpnJson<VpnUserCreds>(c.credsBlob);
        try {
          if (dto.enabled) {
            await provider.applyAddUser(c.serviceId, cfg, creds, u.name);
          } else {
            await provider.applyRemoveUser(c.serviceId, cfg, creds);
          }
        } catch (err) {
          this.logger.warn(
            `enable/disable user ${id} on service ${c.serviceId}: ${(err as Error).message}`,
          );
        }
      }
    }

    await this.prisma.vpnUser.update({
      where: { id },
      data: {
        name: dto.name,
        enabled: dto.enabled,
        notes: dto.notes,
      },
    });
    return this.getUser(id);
  }

  async deleteUser(id: string): Promise<void> {
    const u = await this.prisma.vpnUser.findUnique({ where: { id } });
    if (!u) throw new NotFoundException();
    // Снимаем все creds с агентов.
    const allCreds = await this.prisma.vpnUserCreds.findMany({
      where: { userId: id },
      include: { service: true },
    });
    for (const c of allCreds) {
      try {
        const provider = this.registry.get(c.service.protocol);
        const cfg = decryptVpnJson<VpnServiceConfig>(c.service.configBlob);
        const creds = decryptVpnJson<VpnUserCreds>(c.credsBlob);
        await provider.applyRemoveUser(c.serviceId, cfg, creds);
      } catch (err) {
        this.logger.warn(
          `applyRemoveUser ${c.id}: ${(err as Error).message}`,
        );
      }
    }
    await this.prisma.vpnUser.delete({ where: { id } });
  }

  async regenerateSubToken(id: string): Promise<{ subToken: string }> {
    const u = await this.prisma.vpnUser.findUnique({ where: { id } });
    if (!u) throw new NotFoundException();
    const subToken = randomBytes(32).toString('hex');
    await this.prisma.vpnUser.update({ where: { id }, data: { subToken } });
    return { subToken };
  }

  async addUserToService(userId: string, serviceId: string) {
    const user = await this.prisma.vpnUser.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException(`User ${userId}`);
    const service = await this.prisma.vpnService.findUnique({ where: { id: serviceId } });
    if (!service) throw new NotFoundException(`Service ${serviceId}`);

    const existing = await this.prisma.vpnUserCreds.findUnique({
      where: { userId_serviceId: { userId, serviceId } },
    });
    if (existing) {
      throw new ConflictException('Юзер уже добавлен в этот сервис');
    }

    const cfg = decryptVpnJson<VpnServiceConfig>(service.configBlob);
    const provider = this.registry.get(service.protocol);

    // Для AmneziaWG нужно выделить IP.
    let allocatedIp: string | undefined;
    if (cfg.protocol === VpnProtocol.AMNEZIA_WG) {
      const taken = await this.collectTakenIps(serviceId);
      allocatedIp = allocateNextIp(cfg.network, taken);
    }

    const creds = await provider.generateUserCreds(cfg, allocatedIp);

    await this.prisma.vpnUserCreds.create({
      data: {
        userId,
        serviceId,
        credsBlob: encryptVpnJson(creds),
      },
    });

    if (user.enabled && service.status === VpnServiceStatus.RUNNING) {
      try {
        await provider.applyAddUser(serviceId, cfg, creds, user.name);
      } catch (err) {
        // Откатим запись если применить не получилось.
        await this.prisma.vpnUserCreds.delete({
          where: { userId_serviceId: { userId, serviceId } },
        });
        throw new BadRequestException(
          `Не удалось применить юзера на агенте: ${(err as Error).message}`,
        );
      }
    }
    return this.getUserCredsView(userId, serviceId);
  }

  async removeUserFromService(userId: string, serviceId: string): Promise<void> {
    const cred = await this.prisma.vpnUserCreds.findUnique({
      where: { userId_serviceId: { userId, serviceId } },
      include: { service: true, user: true },
    });
    if (!cred) throw new NotFoundException();

    try {
      const provider = this.registry.get(cred.service.protocol);
      const cfg = decryptVpnJson<VpnServiceConfig>(cred.service.configBlob);
      const creds = decryptVpnJson<VpnUserCreds>(cred.credsBlob);
      await provider.applyRemoveUser(serviceId, cfg, creds);
    } catch (err) {
      this.logger.warn(`applyRemoveUser: ${(err as Error).message}`);
    }
    await this.prisma.vpnUserCreds.delete({
      where: { userId_serviceId: { userId, serviceId } },
    });
  }

  async getUserCredsView(
    userId: string,
    serviceId: string,
  ): Promise<VpnUserCredsView> {
    const cred = await this.prisma.vpnUserCreds.findUnique({
      where: { userId_serviceId: { userId, serviceId } },
      include: { service: true, user: true },
    });
    if (!cred) throw new NotFoundException();
    const provider = this.registry.get(cred.service.protocol);
    const cfg = decryptVpnJson<VpnServiceConfig>(cred.service.configBlob);
    const creds = decryptVpnJson<VpnUserCreds>(cred.credsBlob);
    const host = await this.resolvePublicHost();
    return provider.renderUserView(cfg, creds, host, cred.service.port, cred.user.name);
  }

  // =========================================================================
  // Subscription
  // =========================================================================

  /**
   * Plain-text base64 subscription (формат v2rayN/Streisand).
   * Возвращает все vless:// и wg-quick конфиги юзера в одной base64-строке.
   */
  async buildSubscription(subToken: string): Promise<string> {
    const u = await this.prisma.vpnUser.findUnique({
      where: { subToken },
      include: { creds: { include: { service: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });
    if (!u) throw new NotFoundException();
    const entries = await this.renderSubscriptionEntries(u);
    return Buffer.from(entries.map((entry) => entry.content).join('\n'), 'utf8').toString('base64');
  }

  async buildFederatedSubscriptionSource(
    vpnUserId: string,
  ): Promise<FederatedVpnSubscriptionSourceSnapshot> {
    const user = await this.prisma.vpnUser.findUnique({
      where: { id: vpnUserId },
      include: { creds: { include: { service: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });
    if (!user) throw new NotFoundException();
    const entries = await this.renderSubscriptionEntries(user);
    const epoch = createHash('sha256').update(JSON.stringify({
      userId: user.id,
      userUpdatedAt: user.updatedAt.toISOString(),
      enabled: user.enabled,
      credentials: user.creds.map((credential) => ({
        id: credential.id,
        updatedAt: credential.updatedAt.toISOString(),
        serviceId: credential.serviceId,
        serviceUpdatedAt: credential.service.updatedAt.toISOString(),
        serviceStatus: credential.service.status,
      })),
      fingerprints: entries.map((entry) => entry.fingerprint),
    }), 'utf8').digest('hex');
    return { sourceId: user.id, epoch, entries };
  }

  private async renderSubscriptionEntries(user: SubscriptionUser): Promise<SubscriptionEntry[]> {
    if (!user.enabled) return [];
    const host = await this.resolvePublicHost();
    const entries: SubscriptionEntry[] = [];
    for (const c of user.creds) {
      if (c.service.status !== VpnServiceStatus.RUNNING) continue;
      const cfg = decryptVpnJson<VpnServiceConfig>(c.service.configBlob);
      const creds = decryptVpnJson<VpnUserCreds>(c.credsBlob);
      const label = c.service.label ? `${user.name} @ ${c.service.label}` : user.name;
      let content: string;
      if (cfg.protocol === VpnProtocol.VLESS_REALITY && creds.protocol === VpnProtocol.VLESS_REALITY) {
        content = buildVlessUrl({
          uuid: creds.uuid,
          host,
          port: c.service.port,
          sniMask: cfg.sniMask,
          pubKey: cfg.pubKey,
          shortId: cfg.shortId,
          fingerprint: cfg.fingerprint,
          flow: creds.flow,
          label,
        });
      } else if (cfg.protocol === VpnProtocol.AMNEZIA_WG && creds.protocol === VpnProtocol.AMNEZIA_WG) {
        content = [
          '# AmneziaWG config (импортируй вручную в Amnezia клиент):',
          ...buildWgQuickConfig({
          cfg,
          creds,
          publicHost: host,
          port: c.service.port,
          label,
          }).split('\n').map((line) => `# ${line}`),
        ].join('\n');
      } else continue;
      entries.push({
        fingerprint: createHash('sha256').update(content, 'utf8').digest('hex'),
        content,
      });
    }
    return entries;
  }

  // =========================================================================
  // SNI auto-check
  // =========================================================================

  async enqueueSniHealthCheck(
    userId: string,
    role: string,
    idempotencyKey?: string,
  ) {
    if (role !== 'ADMIN') {
      throw new ForbiddenException('Only ADMIN can run VPN SNI health checks');
    }
    if (!this.relay.isAgentConnected()) {
      throw new ConflictException('Agent is offline; VPN SNI health check is unavailable');
    }
    return this.admission.admit({
      actionId: VPN_RUNTIME_OPERATION_ACTIONS.SNI_HEALTH_CHECK,
      type: 'VPN_SNI_HEALTH_CHECK',
      idempotencyKey,
      actor: { userId, role },
      request: {},
      deadlineMs: 2 * 60 * 60_000,
      recoveryPolicy: 'RETRY_SAFE',
      retryable: true,
      maxAttempts: 3,
      globalLockKey: 'vpn:sni-health-check',
    });
  }

  private async executeSniHealthCheck(
    request: unknown,
    context: OperationExecutionContext,
  ): Promise<{ checked: number; failed: number }> {
    if (
      !request ||
      typeof request !== 'object' ||
      Array.isArray(request) ||
      Object.keys(request as Record<string, unknown>).length !== 0
    ) {
      throw new OperationNeedsAttentionError('VPN SNI health request is invalid');
    }
    if (context.actor.role !== 'ADMIN') {
      throw new OperationNeedsAttentionError('VPN SNI health actor is not ADMIN');
    }
    if (!this.relay.isAgentConnected()) {
      throw new Error('Agent disconnected before VPN SNI health check');
    }
    await context.throwIfCancellationRequested();
    return this.runSniHealthCheck(async (checked, total) => {
      await context.throwIfCancellationRequested();
      const progress = total === 0 ? 95 : 5 + Math.floor((checked / total) * 90);
      await context.heartbeat('validate-sni', progress);
    });
  }

  /**
   * Прогоняет проверку SNI для всех VLESS+Reality сервисов. Вызывается из cron.
   *
   * Шлёт нотификацию VPN_SNI_FAILED только при **переходе** ok→fail
   * (или при первой неудачной проверке, если предыдущего значения не было).
   * Это исключает дубль-уведомления каждые 6 часов на одну и ту же проблему.
   */
  async runSniHealthCheck(
    onProgress?: (checked: number, total: number) => Promise<void>,
  ): Promise<{ checked: number; failed: number }> {
    if (!this.relay.isAgentConnected()) return { checked: 0, failed: 0 };
    const services = await this.prisma.vpnService.findMany({
      where: {
        protocol: VpnProtocol.VLESS_REALITY,
        sniMask: { not: null },
      },
    });
    let checked = 0;
    let failed = 0;
    await onProgress?.(0, services.length);
    for (const s of services) {
      if (!s.sniMask) continue;
      const result = await this.xrayReality.validateSni(s.sniMask);
      checked++;
      const wasOk = s.sniLastCheckOk; // null | true | false
      if (!result.ok) failed++;
      await this.prisma.vpnService.update({
        where: { id: s.id },
        data: {
          sniLastCheckOk: result.ok,
          sniLastCheckedAt: new Date(),
          sniLastError: result.ok ? null : result.reason ?? 'unknown',
        },
      });

      // Notify только при переходе ok/null → fail.
      if (!result.ok && wasOk !== false) {
        try {
          await this.notifications.dispatch({
            event: 'VPN_SNI_FAILED',
            title: `VPN: SNI ${s.sniMask} недоступна`,
            message:
              `Сервис ${s.label || `${s.protocol}:${s.port}`} перестал получать ` +
              `TLS 1.3 + X25519 от маски ${s.sniMask}. Причина: ${result.reason ?? 'unknown'}. ` +
              `Зайди в /vpn и переключи SNI на другой домен из списка.`,
            timestamp: new Date(),
          });
        } catch (err) {
          this.logger.warn(`notify VPN_SNI_FAILED failed: ${(err as Error).message}`);
        }
      }
      await onProgress?.(checked, services.length);
    }
    return { checked, failed };
  }

  // =========================================================================
  // helpers
  // =========================================================================

  private async collectTakenIps(serviceId: string): Promise<string[]> {
    const allCreds = await this.prisma.vpnUserCreds.findMany({
      where: { serviceId },
      select: { credsBlob: true },
    });
    const ips: string[] = [];
    for (const c of allCreds) {
      try {
        const decoded = decryptVpnJson<VpnUserCreds>(c.credsBlob);
        if (decoded.protocol === VpnProtocol.AMNEZIA_WG) {
          ips.push(decoded.peerIp);
        }
      } catch {
        /* битые creds — пропускаем */
      }
    }
    return ips;
  }

  private async resolvePublicHost(): Promise<string> {
    const cached = this.hostInfoCache;
    if (cached && Date.now() - cached.cachedAt < VpnService.HOST_INFO_TTL_MS && cached.publicIp) {
      return cached.publicIp;
    }
    if (this.relay.isAgentConnected()) {
      try {
        const r = await this.relay.emitToAgent<PublicHostInfo>('vpn:host-info', {});
        if (r.success && r.data?.publicIp) {
          this.hostInfoCache = { publicIp: r.data.publicIp, cachedAt: Date.now() };
          return r.data.publicIp;
        }
      } catch {
        /* fall through */
      }
    }
    // Fallback — env var (PANEL_DOMAIN) или 127.0.0.1.
    return process.env.PANEL_DOMAIN || '127.0.0.1';
  }
}
