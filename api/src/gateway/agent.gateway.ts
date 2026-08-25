import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger, Inject, forwardRef } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { timingSafeEqual, randomBytes, randomUUID } from 'crypto';
import {
  FederatedWsAckPayload,
  FederatedWsEnvelope,
  FederatedWsStatePayload,
  validateFederatedWsEnvelope,
} from '@meowbox/shared';
import { AgentRelayService } from './agent-relay.service';
import { DeployService } from '../deploy/deploy.service';
import { BackupsService } from '../backups/backups.service';
import { ServerPathBackupService } from '../backups/server-path-backup.service';
import { PanelDataBackupService } from '../backups/panel-data-backup.service';
import { BackupExportsService } from '../backups/backup-exports.service';
import { SslService } from '../ssl/ssl.service';
import { SitesService } from '../sites/sites.service';
import { MonitoringService } from '../monitoring/monitoring.service';
import { LogsService } from '../logs/logs.service';
import { AiService, AiEvent } from '../ai/ai.service';
import { MigrationHostpanelService } from '../migration-hostpanel/migration-hostpanel.service';
import { FederatedSocketBridgeService } from './federated-socket-bridge.service';
import { FederationWsChannelVerifierService } from '../federation/federation-ws-channel-verifier.service';
import {
  FederatedSocketPolicyAction,
  FederatedSocketPolicyService,
} from '../federation/federated-socket-policy';
import { extractClientIp } from '../common/http/client-ip';

interface AuthenticatedSocket extends Socket {
  data: {
    type: 'agent' | 'client' | 'remote-client' | 'federated-client';
    userId?: string;
    role?: string;
    proxyServerId?: string;
    bootId?: string | null;
    channelId?: string;
    channelEpoch?: number;
    federationKeyId?: string;
  };
}

type FederatedClientHandler = (...args: unknown[]) => unknown;

interface FederatedTargetSession {
  socket: AuthenticatedSocket;
  channelId: string;
  epoch: number;
  role: 'ADMIN' | 'MANAGER';
  allowedActionIds: Set<string>;
  actionsById: Map<string, FederatedSocketPolicyAction>;
  handlers: Map<string, FederatedClientHandler>;
  rooms: Set<string>;
  incomingSequence: number;
  outgoingSequence: number;
  expiryTimer: NodeJS.Timeout;
  rateByAction: Map<string, { windowStartedAt: number; count: number }>;
}

const LOCAL_CLIENTS_ROOM = '__meowbox_local_clients';

// CORS origin для WebSocket: те же правила, что и для HTTP (см. main.ts).
// Агент подключается без browser-origin (там отдельная auth по AGENT_SECRET
// через handshake.auth.secret), поэтому ужесточать origin безопасно —
// браузерный клиент всё равно грузит страницу с того же PANEL_DOMAIN.
function resolveWsOrigins(): string[] | false {
  const panelDomain = process.env.PANEL_DOMAIN;
  const webPort = process.env.WEB_PORT;
  const origins: string[] = [];
  if (panelDomain) {
    origins.push(`https://${panelDomain}`, `http://${panelDomain}`);
    if (webPort) {
      origins.push(`https://${panelDomain}:${webPort}`, `http://${panelDomain}:${webPort}`);
    }
  }
  // Доп. origin'ы через env (comma-separated) — например, для dev-окружений.
  const extra = process.env.WS_EXTRA_ORIGINS;
  if (extra) {
    for (const o of extra.split(',').map((s) => s.trim()).filter(Boolean)) {
      origins.push(o);
    }
  }
  return origins.length > 0 ? origins : false;
}

// WS_MAX_BUFFER_BYTES — ограничение на размер одного сообщения (по умолчанию
// 256 KiB, хватит для терминального ввода/AI-промптов). Socket.io дефолт 1 MiB,
// но нам не нужно принимать мегабайты в `terminal:input` или `ai:start` —
// это идеальный вектор DoS: memory-bomb через огромные payload'ы.
const WS_MAX_BUFFER_BYTES = parseInt(
  process.env.WS_MAX_BUFFER_BYTES || String(256 * 1024), 10,
);

@WebSocketGateway({
  cors: {
    origin: resolveWsOrigins(),
    credentials: true,
  },
  transports: ['websocket'],
  maxHttpBufferSize: WS_MAX_BUFFER_BYTES,
})
export class AgentGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger('AgentGateway');
  /** Maps client socket ID → set of terminal session IDs they own */
  private clientTerminalSessions = new Map<string, Set<string>>();
  /** Maps terminal session ID → client socket ID (for routing data back) */
  private terminalSessionOwner = new Map<string, string>();
  /** Maps client socket ID → set of tail session IDs they own */
  private clientTailSessions = new Map<string, Set<string>>();
  private federatedTargetSessions = new Map<string, FederatedTargetSession>();

  /** Limits to prevent resource exhaustion via PTY/tail. */
  private static readonly MAX_TERMINALS_PER_CLIENT = parseInt(
    process.env.MAX_TERMINALS_PER_CLIENT || '5', 10,
  );
  private static readonly MAX_TAILS_PER_CLIENT = parseInt(
    process.env.MAX_TAILS_PER_CLIENT || '10', 10,
  );

  constructor(
    private readonly config: ConfigService,
    private readonly jwtService: JwtService,
    private readonly relay: AgentRelayService,
    private readonly deployService: DeployService,
    private readonly backupsService: BackupsService,
    private readonly serverPathBackupService: ServerPathBackupService,
    private readonly panelDataBackupService: PanelDataBackupService,
    private readonly backupExportsService: BackupExportsService,
    private readonly sslService: SslService,
    @Inject(forwardRef(() => SitesService))
    private readonly sitesService: SitesService,
    private readonly monitoringService: MonitoringService,
    private readonly logsService: LogsService,
    private readonly aiService: AiService,
    @Inject(forwardRef(() => MigrationHostpanelService))
    private readonly migrationHostpanelService: MigrationHostpanelService,
    private readonly socketBridge: FederatedSocketBridgeService,
    private readonly channelVerifier: FederationWsChannelVerifierService,
    private readonly socketPolicy: FederatedSocketPolicyService,
  ) {}

  async handleConnection(client: AuthenticatedSocket) {
    const auth = client.handshake.auth;

    if (auth.federationChannel) {
      if (auth.secret || auth.proxySecret || auth.token) {
        this.logger.warn('Ambiguous federation WebSocket authentication rejected');
        client.disconnect(true);
        return;
      }
      await this.startFederatedTargetMode(client, auth.federationChannel);
      return;
    }

    // --- Agent authentication (AGENT_SECRET) ---
    if (auth.secret) {
      const expected = this.config.getOrThrow<string>('AGENT_SECRET');
      const provided = String(auth.secret);

      if (!this.constantTimeCompare(provided, expected)) {
        this.logger.warn('Agent auth failed: invalid secret');
        client.disconnect(true);
        return;
      }

      const bootId = typeof auth.bootId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(auth.bootId)
        ? auth.bootId
        : null;
      client.data = { type: 'agent', bootId };
      this.relay.setAgentSocket(client, bootId);
      this.registerAgentListeners(client);
      this.logger.log(`Agent connected: ${client.id}`);
      this.reconcileOnConnect(client);
      return;
    }

    // Static-token WS never belongs to legacy-static-v0. Keep it fail-closed
    // until the typed signed channel is negotiated by FederationSocketBridge.
    if (auth.proxySecret) {
      this.logger.warn('Legacy static-token WS rejected');
      client.disconnect(true);
      return;
    }

    // --- Browser client authentication (JWT) ---
    if (auth.token) {
      let payload: { sub: string; role: string };
      try {
        payload = this.jwtService.verify<{
          sub: string;
          role: string;
        }>(auth.token);
      } catch {
        this.logger.warn('Client auth failed: invalid JWT');
        client.disconnect(true);
        return;
      }

      // --- Proxy-mode: подключение оператора к выбранному slave ---
      // Если фронт передал proxyServerId — мастер не обрабатывает события
      // локально, а ретранслирует их на slave (upstream socket).
      // Все ивенты, ack'и, rooms работают прозрачно для UI.
      const proxyServerId =
        typeof auth.proxyServerId === 'string' ? auth.proxyServerId.trim() : '';
      if (proxyServerId) {
        // Только ADMIN/MANAGER могут управлять серверами. Без проверки —
        // VIEWER мог бы открыть терминал на slave обходом HTTP RBAC.
        if (payload.role !== 'ADMIN' && payload.role !== 'MANAGER') {
          this.logger.warn(
            `Proxy WS rejected: insufficient role ${payload.role} (user=${payload.sub})`,
          );
          client.disconnect(true);
          return;
        }
        await this.startProxyMode(client, proxyServerId, payload);
        return;
      }

      client.data = {
        type: 'client',
        userId: payload.sub,
        role: payload.role,
      };

      // Join user-specific room for targeted events
      client.join(`user:${payload.sub}`);
      client.join(LOCAL_CLIENTS_ROOM);
      this.registerClientListeners(client);
      this.logger.log(`Client connected: ${client.id} (user: ${payload.sub})`);
      return;
    }

    // No valid auth
    this.logger.warn(`Unauthenticated connection rejected: ${client.id}`);
    client.disconnect(true);
  }

  private async startProxyMode(
    client: AuthenticatedSocket,
    serverId: string,
    operator: { sub: string; role: string },
  ): Promise<void> {
    client.data = {
      type: 'remote-client',
      userId: operator.sub,
      role: operator.role,
      proxyServerId: serverId,
    };
    await this.socketBridge.attach(
      client,
      serverId,
      { id: operator.sub, role: operator.role as 'ADMIN' | 'MANAGER' },
      extractClientIp(client.handshake),
    );
  }

  private async startFederatedTargetMode(
    client: AuthenticatedSocket,
    assertion: unknown,
  ): Promise<void> {
    try {
      const verified = await this.channelVerifier.verify(
        assertion as Parameters<FederationWsChannelVerifierService['verify']>[0],
      );
      if (verified.claims.role !== 'ADMIN' && verified.claims.role !== 'MANAGER') {
        throw new Error('Federated WebSocket role is invalid');
      }
      client.data = {
        type: 'federated-client',
        userId: verified.userId,
        role: verified.claims.role,
        channelId: verified.claims.channelId,
        channelEpoch: verified.claims.epoch,
        federationKeyId: verified.keyId,
      };
      const expiresInMs = Math.max(1, verified.claims.expiresAt * 1_000 - Date.now());
      const expiryTimer = setTimeout(() => client.disconnect(true), expiresInMs);
      expiryTimer.unref();
      const session: FederatedTargetSession = {
        socket: client,
        channelId: verified.claims.channelId,
        epoch: verified.claims.epoch,
        role: verified.claims.role,
        allowedActionIds: new Set(verified.claims.actionIds),
        actionsById: new Map(verified.actions.map((action) => [action.actionId, action])),
        handlers: new Map(),
        rooms: new Set(),
        incomingSequence: 0,
        outgoingSequence: 0,
        expiryTimer,
        rateByAction: new Map(),
      };
      this.federatedTargetSessions.set(client.id, session);
      this.registerClientListeners(client);
      const federationSocket = client;
      federationSocket.on('federation:event', (value: unknown) => {
        void this.handleFederatedTargetEvent(session, value);
      });
      this.emitFederatedState(session, {
        state: 'READY',
        reasonCode: 'READY',
        readyAt: new Date().toISOString(),
        retryAfterMs: null,
      });
      this.logger.log(`Federated client connected: ${client.id}`);
    } catch (error) {
      this.logger.warn(`Federated client auth failed: ${(error as Error).name}`);
      client.disconnect(true);
    }
  }

  private async handleFederatedTargetEvent(
    session: FederatedTargetSession,
    value: unknown,
  ): Promise<void> {
    let envelope: FederatedWsEnvelope;
    try {
      envelope = validateFederatedWsEnvelope(value);
    } catch {
      this.closeFederatedProtocol(session, 'REMOTE_SCHEMA_MISMATCH');
      return;
    }
    if (
      envelope.channelId !== session.channelId ||
      envelope.epoch !== session.epoch ||
      envelope.sequence !== session.incomingSequence + 1 ||
      envelope.kind !== 'EVENT'
    ) {
      this.closeFederatedProtocol(session, 'REMOTE_SEQUENCE_INVALID');
      return;
    }
    session.incomingSequence = envelope.sequence;
    const action = session.actionsById.get(envelope.actionId);
    const handler = session.handlers.get(envelope.event);
    if (
      !action ||
      !session.allowedActionIds.has(envelope.actionId) ||
      action.direction !== 'browser_to_api' ||
      action.event !== envelope.event ||
      !handler
    ) {
      this.closeFederatedProtocol(session, 'REMOTE_ACTION_MISMATCH');
      return;
    }
    try {
      this.socketPolicy.validatePayload(action, envelope.payload);
    } catch {
      this.closeFederatedProtocol(session, 'REMOTE_SCHEMA_MISMATCH');
      return;
    }
    const nowMs = Date.now();
    const rate = session.rateByAction.get(action.actionId);
    if (!rate || nowMs - rate.windowStartedAt >= 1_000) {
      session.rateByAction.set(action.actionId, { windowStartedAt: nowMs, count: 1 });
    } else if (rate.count >= 100) {
      this.emitFederatedAck(session, envelope, {
        acceptedSequence: envelope.sequence,
        outcome: 'REJECTED',
        code: 'REMOTE_RATE_LIMITED',
        message: 'Remote WebSocket action rate limit exceeded',
        result: null,
      });
      return;
    } else {
      rate.count += 1;
    }

    let responded = false;
    const acknowledge = (result: unknown): void => {
      if (responded) return;
      responded = true;
      this.emitFederatedAck(session, envelope, {
        acceptedSequence: envelope.sequence,
        outcome: result && typeof result === 'object' && 'error' in result
          ? 'REJECTED'
          : 'COMPLETED',
        code: result && typeof result === 'object' && 'error' in result
          ? 'REMOTE_ACTION_REJECTED'
          : null,
        message: result && typeof result === 'object' && 'error' in result
          ? String((result as { error: unknown }).error).slice(0, 1_024)
          : null,
        result: result ?? null,
      });
    };
    try {
      await Promise.resolve(handler(envelope.payload, acknowledge));
      if (!responded) acknowledge(null);
    } catch {
      if (responded) return;
      responded = true;
      this.emitFederatedAck(session, envelope, {
        acceptedSequence: envelope.sequence,
        outcome: 'REJECTED',
        code: 'REMOTE_APPLICATION_ERROR',
        message: 'Remote WebSocket action failed',
        result: null,
      });
    }
  }

  private emitFederatedAck(
    session: FederatedTargetSession,
    request: FederatedWsEnvelope,
    payload: FederatedWsAckPayload,
  ): void {
    this.emitFederatedEnvelope(session, {
      actionId: request.actionId,
      correlationId: request.correlationId,
      event: request.event,
      kind: payload.outcome === 'REJECTED' ? 'NACK' : 'ACK',
      payload,
    });
  }

  private emitFederatedState(
    session: FederatedTargetSession,
    payload: FederatedWsStatePayload,
  ): void {
    this.emitFederatedEnvelope(session, {
      actionId: 'federation.ws-state',
      correlationId: randomUUID(),
      event: 'federation:state',
      kind: 'STATE',
      payload,
    });
  }

  private emitFederatedEnvelope(
    session: FederatedTargetSession,
    message: Pick<FederatedWsEnvelope, 'actionId' | 'correlationId' | 'event' | 'kind' | 'payload'>,
  ): void {
    const envelope = validateFederatedWsEnvelope({
      channelId: session.channelId,
      epoch: session.epoch,
      sequence: ++session.outgoingSequence,
      ...message,
    });
    session.socket.emit('federation:message', envelope);
  }

  private closeFederatedProtocol(
    session: FederatedTargetSession,
    reasonCode: string,
  ): void {
    this.emitFederatedState(session, {
      state: 'CLOSED',
      reasonCode,
      readyAt: null,
      retryAfterMs: null,
    });
    session.socket.disconnect(true);
  }

  private removeFederatedTargetSession(clientId: string): void {
    const session = this.federatedTargetSessions.get(clientId);
    if (!session) return;
    clearTimeout(session.expiryTimer);
    this.federatedTargetSessions.delete(clientId);
  }

  private bindClientEvent<TArgs extends unknown[]>(
    client: AuthenticatedSocket,
    event: string,
    handler: (...args: TArgs) => unknown,
  ): void {
    const wrapped: FederatedClientHandler = (...args: unknown[]) =>
      handler(...args as TArgs);
    if (client.data.type === 'federated-client') {
      const session = this.federatedTargetSessions.get(client.id);
      const action = this.socketPolicy.commandForEvent(event, client.data.role ?? '');
      if (!session || !action || !session.allowedActionIds.has(action.actionId)) return;
      session.handlers.set(event, wrapped);
      return;
    }
    switch (event) {
      case 'ai:message': client.on('ai:message', wrapped); return;
      case 'ai:start': client.on('ai:start', wrapped); return;
      case 'ai:stop': client.on('ai:stop', wrapped); return;
      case 'logs:tail:start': client.on('logs:tail:start', wrapped); return;
      case 'logs:tail:stop': client.on('logs:tail:stop', wrapped); return;
      case 'migrate-hostpanel:subscribe': client.on('migrate-hostpanel:subscribe', wrapped); return;
      case 'migrate-hostpanel:unsubscribe': client.on('migrate-hostpanel:unsubscribe', wrapped); return;
      case 'php:ext-install:subscribe': client.on('php:ext-install:subscribe', wrapped); return;
      case 'php:ext-install:unsubscribe': client.on('php:ext-install:unsubscribe', wrapped); return;
      case 'php:install:subscribe': client.on('php:install:subscribe', wrapped); return;
      case 'php:install:unsubscribe': client.on('php:install:unsubscribe', wrapped); return;
      case 'terminal:close': client.on('terminal:close', wrapped); return;
      case 'terminal:input': client.on('terminal:input', wrapped); return;
      case 'terminal:open': client.on('terminal:open', wrapped); return;
      case 'terminal:resize': client.on('terminal:resize', wrapped); return;
      default: throw new Error(`Uncatalogued client command: ${event}`);
    }
  }

  private joinClientRoom(client: AuthenticatedSocket, room: string): void {
    const session = this.federatedTargetSessions.get(client.id);
    if (client.data.type === 'federated-client' && session) {
      session.rooms.add(room);
      return;
    }
    void client.join(room);
  }

  private leaveClientRoom(client: AuthenticatedSocket, room: string): void {
    const session = this.federatedTargetSessions.get(client.id);
    if (client.data.type === 'federated-client' && session) {
      session.rooms.delete(room);
      return;
    }
    void client.leave(room);
  }

  private emitToClient(client: AuthenticatedSocket, event: string, payload: unknown): void {
    const session = this.federatedTargetSessions.get(client.id);
    if (client.data.type === 'federated-client' && session) {
      this.emitFederatedNotification(session, event, payload);
      return;
    }
    switch (event) {
      case 'ai:error': client.emit('ai:error', payload); return;
      case 'ai:result': client.emit('ai:result', payload); return;
      case 'ai:system': client.emit('ai:system', payload); return;
      case 'ai:text': client.emit('ai:text', payload); return;
      case 'ai:thinking': client.emit('ai:thinking', payload); return;
      case 'ai:tool_result': client.emit('ai:tool_result', payload); return;
      case 'ai:tool_use_done': client.emit('ai:tool_use_done', payload); return;
      case 'ai:tool_use_input': client.emit('ai:tool_use_input', payload); return;
      case 'ai:tool_use_start': client.emit('ai:tool_use_start', payload); return;
      default: throw new Error(`Uncatalogued client event: ${event}`);
    }
  }

  private emitBrowserBroadcast(event: string, payload: unknown): void {
    switch (event) {
      case 'backup:progress': this.server.to(LOCAL_CLIENTS_ROOM).emit('backup:progress', payload); break;
      case 'backup:restore:progress': this.server.to(LOCAL_CLIENTS_ROOM).emit('backup:restore:progress', payload); break;
      case 'site:provision:done': this.server.to(LOCAL_CLIENTS_ROOM).emit('site:provision:done', payload); break;
      case 'site:provision:log': this.server.to(LOCAL_CLIENTS_ROOM).emit('site:provision:log', payload); break;
      case 'site:status': this.server.to(LOCAL_CLIENTS_ROOM).emit('site:status', payload); break;
      case 'system:metrics': this.server.to(LOCAL_CLIENTS_ROOM).emit('system:metrics', payload); break;
      default: throw new Error(`Uncatalogued broadcast event: ${event}`);
    }
    for (const session of this.federatedTargetSessions.values()) {
      this.emitFederatedNotification(session, event, payload);
    }
  }

  private emitBrowserRoom(
    room: string,
    event: string,
    payload: unknown,
    broadcastToFederated = false,
  ): void {
    switch (event) {
      case 'logs:tail:data': this.server.to(room).emit('logs:tail:data', payload); break;
      case 'php:ext-install:log': this.server.to(room).emit('php:ext-install:log', payload); break;
      case 'php:install:log': this.server.to(room).emit('php:install:log', payload); break;
      case 'site:deploy:log': this.server.to(room).emit('site:deploy:log', payload); break;
      case 'terminal:data': this.server.to(room).emit('terminal:data', payload); break;
      default: throw new Error(`Uncatalogued room event: ${event}`);
    }
    for (const session of this.federatedTargetSessions.values()) {
      if (broadcastToFederated || session.rooms.has(room)) {
        this.emitFederatedNotification(session, event, payload);
      }
    }
  }

  private emitFederatedBroadcast(event: string, payload: unknown): void {
    for (const session of this.federatedTargetSessions.values()) {
      this.emitFederatedNotification(session, event, payload);
    }
  }

  private emitFederatedNotification(
    session: FederatedTargetSession,
    event: string,
    payload: unknown,
  ): void {
    const action = this.socketPolicy.notificationForEvent(event, session.role);
    if (!action || !session.allowedActionIds.has(action.actionId)) return;
    try {
      this.socketPolicy.validatePayload(action, payload);
    } catch {
      this.closeFederatedProtocol(session, 'REMOTE_SCHEMA_MISMATCH');
      return;
    }
    this.emitFederatedEnvelope(session, {
      actionId: action.actionId,
      correlationId: randomUUID(),
      event,
      kind: 'EVENT',
      payload,
    });
  }

  handleDisconnect(client: AuthenticatedSocket) {
    if (client.data?.type === 'remote-client') {
      this.socketBridge.detach(client.id);
      return;
    }
    if (client.data?.type === 'federated-client') {
      this.cleanupClientResources(client);
      this.removeFederatedTargetSession(client.id);
      return;
    }

    if (client.data?.type === 'agent') {
      this.relay.clearAgentSocket(client);
      this.logger.log('Agent disconnected');
    } else if (client.data?.type === 'client') {
      this.cleanupClientResources(client);
      this.logger.log(`Client disconnected: ${client.id}`);
    }
  }

  private cleanupClientResources(client: AuthenticatedSocket): void {
    const sessions = this.clientTerminalSessions.get(client.id);
    if (sessions) {
      for (const sessionId of sessions) {
        this.relay.emitToAgentAsync('terminal:close', { sessionId });
        this.terminalSessionOwner.delete(sessionId);
      }
      this.clientTerminalSessions.delete(client.id);
    }
    const tailSessions = this.clientTailSessions.get(client.id);
    if (tailSessions && this.relay.isAgentConnected()) {
      for (const tailId of tailSessions) {
        this.relay.emitToAgentAsync('logs:tail:stop', { tailId });
      }
    }
    this.clientTailSessions.delete(client.id);
  }

  /**
   * Register listeners for events browser clients send TO the API.
   */
  private registerClientListeners(client: AuthenticatedSocket) {
    // Log tail: available to ADMIN and MANAGER
    if (client.data.role === 'ADMIN' || client.data.role === 'MANAGER') {
      this.registerLogTailListeners(client);
      this.registerAiListeners(client);
    }

    // ─── Migration hostpanel: подписка на комнату миграции ───
    // Любой залогиненный пользователь, имеющий доступ к /admin/migrate-hostpanel
    // (= ADMIN), может подписаться. Логи и прогресс сами форвардятся в комнату.
    if (client.data.role === 'ADMIN') {
      this.bindClientEvent(client, 'migrate-hostpanel:subscribe', (payload: { migrationId: string }) => {
        if (!payload?.migrationId || typeof payload.migrationId !== 'string') return;
        if (!/^[a-f0-9-]{8,}$/i.test(payload.migrationId)) return;
        this.joinClientRoom(client, `migrate-hostpanel:${payload.migrationId}`);
      });
      this.bindClientEvent(client, 'migrate-hostpanel:unsubscribe', (payload: { migrationId: string }) => {
        if (!payload?.migrationId) return;
        this.leaveClientRoom(client, `migrate-hostpanel:${payload.migrationId}`);
      });

      // ─── PHP install/extension live-log: подписка ───
      // Клиент шлёт subscribe → joinит комнату php:install:<ver> или
      // php:ext-install:<ver>:<name>, агент шлёт строки → форвардятся в комнату.
      this.bindClientEvent(client, 'php:install:subscribe', (payload: { version: string }) => {
        if (!payload?.version || !/^\d+\.\d+$/.test(payload.version)) return;
        this.joinClientRoom(client, `php:install:${payload.version}`);
      });
      this.bindClientEvent(client, 'php:install:unsubscribe', (payload: { version: string }) => {
        if (!payload?.version) return;
        this.leaveClientRoom(client, `php:install:${payload.version}`);
      });
      this.bindClientEvent(client, 'php:ext-install:subscribe', (payload: { version: string; name: string }) => {
        if (!payload?.version || !/^\d+\.\d+$/.test(payload.version)) return;
        if (!payload.name || !/^[a-z][a-z0-9_]{0,63}$/.test(payload.name)) return;
        this.joinClientRoom(client, `php:ext-install:${payload.version}:${payload.name}`);
      });
      this.bindClientEvent(client, 'php:ext-install:unsubscribe', (payload: { version: string; name: string }) => {
        if (!payload?.version || !payload.name) return;
        this.leaveClientRoom(client, `php:ext-install:${payload.version}:${payload.name}`);
      });
    }

    // Terminal: ADMIN only
    if (client.data.role !== 'ADMIN') return;

    // --- Terminal: open ---
    this.bindClientEvent(client, 'terminal:open', async (optionsOrCb: { user?: string } | ((p: Record<string, unknown>) => void), maybeCb?: (p: Record<string, unknown>) => void) => {
      const callback = (typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb!) as (payload: { sessionId: string } | { error: string }) => void;
      const user = typeof optionsOrCb === 'object' ? optionsOrCb.user : undefined;

      if (!this.relay.isAgentConnected()) {
        callback({ error: 'Agent is not connected' });
        return;
      }
      // Защита от DoS: лимит одновременных PTY-сессий на одного клиента.
      const existing = this.clientTerminalSessions.get(client.id);
      if (existing && existing.size >= AgentGateway.MAX_TERMINALS_PER_CLIENT) {
        callback({
          error: `Too many terminals (max ${AgentGateway.MAX_TERMINALS_PER_CLIENT}). Close existing sessions first.`,
        });
        return;
      }
      try {
        const result = await this.relay.emitToAgent<{ sessionId: string }>(
          'terminal:open',
          { cols: 80, rows: 24, user },
        );
        if (!result.success || !result.data) {
          callback({ error: result.error || 'Failed to open terminal' });
          return;
        }
        const { sessionId } = result.data;

        // Track ownership
        if (!this.clientTerminalSessions.has(client.id)) {
          this.clientTerminalSessions.set(client.id, new Set());
        }
        this.clientTerminalSessions.get(client.id)!.add(sessionId);
        this.terminalSessionOwner.set(sessionId, client.id);

        // Join a room for this terminal session
        this.joinClientRoom(client, `terminal:${sessionId}`);

        this.logger.log(`Terminal session opened: ${sessionId} for client ${client.id}`);
        callback({ sessionId });
      } catch (err) {
        callback({ error: (err as Error).message });
      }
    });

    // --- Terminal: input ---
    // Вход обрезаем: при paste многомегабайтной простыни в терминал агент будет
    // захлёбываться. 64 KiB более чем достаточно для любого разумного ввода;
    // реальный copy-paste больших файлов — через `files` API, не через PTY.
    const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;
    this.bindClientEvent(client, 'terminal:input', (payload: { sessionId: string; data: string }) => {
      // Verify ownership
      const sessions = this.clientTerminalSessions.get(client.id);
      if (!sessions?.has(payload.sessionId)) return;

      // Защита от abuse: слишком длинный data — отбросить, не ретранслируя.
      if (typeof payload?.data !== 'string') return;
      if (Buffer.byteLength(payload.data, 'utf8') > MAX_TERMINAL_INPUT_BYTES) {
        this.logger.warn(
          `Terminal input rejected (too large): client=${client.id} session=${payload.sessionId}`,
        );
        return;
      }

      if (this.relay.isAgentConnected()) {
        this.relay.emitToAgentAsync('terminal:input', payload);
      }
    });

    // --- Terminal: resize ---
    this.bindClientEvent(client, 'terminal:resize', (payload: { sessionId: string; cols: number; rows: number }) => {
      const sessions = this.clientTerminalSessions.get(client.id);
      if (!sessions?.has(payload.sessionId)) return;

      if (this.relay.isAgentConnected()) {
        this.relay.emitToAgentAsync('terminal:resize', payload);
      }
    });

    // --- Terminal: close ---
    this.bindClientEvent(client, 'terminal:close', (payload: { sessionId: string }) => {
      const sessions = this.clientTerminalSessions.get(client.id);
      if (!sessions?.has(payload.sessionId)) return;

      if (this.relay.isAgentConnected()) {
        this.relay.emitToAgentAsync('terminal:close', payload);
      }

      sessions.delete(payload.sessionId);
      this.terminalSessionOwner.delete(payload.sessionId);
      this.leaveClientRoom(client, `terminal:${payload.sessionId}`);
      this.logger.log(`Terminal session closed: ${payload.sessionId}`);
    });

  }

  /**
   * Register log tail listeners (ADMIN + MANAGER).
   */
  private registerLogTailListeners(client: AuthenticatedSocket) {
    // --- Log tail: start ---
    this.bindClientEvent(client, 'logs:tail:start', async (
      payload: { source: string; type: string },
      cb: (result: { tailId?: string; error?: string }) => void,
    ) => {
      if (!this.relay.isAgentConnected()) {
        cb({ error: 'Agent is not connected' });
        return;
      }
      // Лимит одновременных tail-сессий на клиента.
      const existingTails = this.clientTailSessions.get(client.id);
      if (existingTails && existingTails.size >= AgentGateway.MAX_TAILS_PER_CLIENT) {
        cb({
          error: `Too many log tails (max ${AgentGateway.MAX_TAILS_PER_CLIENT}). Stop existing tails first.`,
        });
        return;
      }
      try {
        const filePath = await this.logsService.resolveLogPath(
          payload.source,
          payload.type,
          client.data.userId!,
          client.data.role!,
        );

        // ID логовой сессии должен быть непредсказуемым: он же — комната
        // Socket.io ('logs:tail:${tailId}'), куда другой клиент мог бы подписаться
        // при знании ID. Math.random() даёт предсказуемые значения — используем CSPRNG.
        const tailId = `tail_${Date.now()}_${randomBytes(12).toString('hex')}`;

        const result = await this.relay.emitToAgent<{ success: boolean; error?: string }>(
          'logs:tail:start',
          { tailId, filePath },
        );

        if (!result.success) {
          cb({ error: result.error || 'Failed to start tail' });
          return;
        }

        // Track ownership
        if (!this.clientTailSessions.has(client.id)) {
          this.clientTailSessions.set(client.id, new Set());
        }
        this.clientTailSessions.get(client.id)!.add(tailId);
        this.joinClientRoom(client, `logs:tail:${tailId}`);

        this.logger.log(`Log tail started: ${tailId} for client ${client.id}`);
        cb({ tailId });
      } catch (err) {
        cb({ error: (err as Error).message });
      }
    });

    // --- Log tail: stop ---
    this.bindClientEvent(client, 'logs:tail:stop', (payload: { tailId: string }) => {
      const tails = this.clientTailSessions.get(client.id);
      if (!tails?.has(payload.tailId)) return;

      if (this.relay.isAgentConnected()) {
        this.relay.emitToAgentAsync('logs:tail:stop', payload);
      }

      tails.delete(payload.tailId);
      this.leaveClientRoom(client, `logs:tail:${payload.tailId}`);
      this.logger.log(`Log tail stopped: ${payload.tailId}`);
    });
  }

  /**
   * Register listeners for events the Agent sends TO the API.
   */
  private registerAgentListeners(agent: AuthenticatedSocket) {
    // --- PHP install live log streaming (форвард agent → room клиентов) ---
    agent.on(
      'php:install:log',
      (data: { version: string; line: string; stream?: 'stdout' | 'stderr' }) => {
        if (!data?.version || typeof data.line !== 'string') return;
        if (!/^\d+\.\d+$/.test(data.version)) return;
        this.emitBrowserRoom(`php:install:${data.version}`, 'php:install:log', {
          version: data.version,
          line: data.line,
          stream: data.stream || 'stdout',
          timestamp: new Date().toISOString(),
        });
      },
    );
    agent.on(
      'php:ext-install:log',
      (data: { version: string; name: string; line: string; stream?: 'stdout' | 'stderr' }) => {
        if (!data?.version || !data?.name || typeof data.line !== 'string') return;
        if (!/^\d+\.\d+$/.test(data.version)) return;
        if (!/^[a-z][a-z0-9_]{0,63}$/.test(data.name)) return;
        this.emitBrowserRoom(`php:ext-install:${data.version}:${data.name}`, 'php:ext-install:log', {
          version: data.version,
          name: data.name,
          line: data.line,
          stream: data.stream || 'stdout',
          timestamp: new Date().toISOString(),
        });
      },
    );

    // --- Deploy log streaming ---
    agent.on(
      'deploy:log',
      async (data: { deployId: string; line: string }) => {
        await this.deployService.appendOutput(data.deployId, data.line + '\n');
        // Forward to subscribed clients
        this.emitBrowserRoom(`deploy:${data.deployId}`, 'site:deploy:log', {
          deployLogId: data.deployId,
          line: data.line,
          stream: 'stdout',
          timestamp: new Date().toISOString(),
        }, true);
      },
    );

    // --- Deploy complete ---
    agent.on(
      'deploy:complete',
      async (data: {
        deployId: string;
        success: boolean;
        commitSha?: string;
        commitMessage?: string;
      }) => {
        await this.deployService.completeDeploy(
          data.deployId,
          data.success,
          data.commitSha,
          data.commitMessage,
        );
        this.emitBrowserRoom(`deploy:${data.deployId}`, 'site:deploy:log', {
          deployLogId: data.deployId,
          line: data.success
            ? '✓ Deploy completed successfully'
            : '✗ Deploy failed',
          stream: data.success ? 'stdout' : 'stderr',
          timestamp: new Date().toISOString(),
        }, true);
      },
    );

    // --- Backup progress ---
    agent.on(
      'backup:progress',
      async (data: { backupId: string; progress: number }) => {
        // Один и тот же event прилетает для SITE / SERVER_PATH / PANEL_DATA.
        // Каждый сервис делает updateMany по WHERE id=backupId — попадёт только
        // та таблица, где этот id реально есть.
        await Promise.all([
          this.backupsService.updateBackupProgress(data.backupId, data.progress).catch(() => {}),
          this.serverPathBackupService.updateProgress(data.backupId, data.progress).catch(() => {}),
          this.panelDataBackupService.updateProgress(data.backupId, data.progress).catch(() => {}),
        ]);
        this.emitBrowserBroadcast('backup:progress', {
          backupId: data.backupId,
          progress: data.progress,
          timestamp: new Date().toISOString(),
        });
      },
    );

    // --- Backup complete ---
    agent.on(
      'backup:complete',
      async (data: {
        backupId: string;
        success: boolean;
        filePath?: string;
        sizeBytes?: number;
        error?: string;
        snapshotId?: string; // для Restic
      }) => {
        await this.backupsService.completeBackup(
          data.backupId,
          data.success,
          data.filePath,
          data.sizeBytes,
          data.error,
          data.snapshotId,
        );
        this.emitBrowserBroadcast('backup:progress', {
          backupId: data.backupId,
          progress: data.success ? 100 : 0,
          status: data.success ? 'COMPLETED' : 'FAILED',
          timestamp: new Date().toISOString(),
        });
      },
    );

    // --- Server-path backup complete (scope=SERVER_PATH) ---
    agent.on(
      'server-path:complete',
      async (data: {
        backupId: string;
        success: boolean;
        filePath?: string;
        sizeBytes?: number;
        error?: string;
        snapshotId?: string;
      }) => {
        await this.serverPathBackupService.completeBackup(
          data.backupId,
          data.success,
          data.filePath,
          data.sizeBytes,
          data.error,
          data.snapshotId,
        );
        this.emitBrowserBroadcast('backup:progress', {
          backupId: data.backupId,
          progress: data.success ? 100 : 0,
          status: data.success ? 'COMPLETED' : 'FAILED',
          timestamp: new Date().toISOString(),
        });
      },
    );

    // --- Panel-data backup complete (scope=PANEL_DATA) ---
    agent.on(
      'panel-data:complete',
      async (data: {
        backupId: string;
        success: boolean;
        filePath?: string;
        sizeBytes?: number;
        error?: string;
        snapshotId?: string;
      }) => {
        await this.panelDataBackupService.completeBackup(
          data.backupId,
          data.success,
          data.filePath,
          data.sizeBytes,
          data.error,
          data.snapshotId,
        );
        this.emitBrowserBroadcast('backup:progress', {
          backupId: data.backupId,
          progress: data.success ? 100 : 0,
          status: data.success ? 'COMPLETED' : 'FAILED',
          timestamp: new Date().toISOString(),
        });
      },
    );

    // --- Hostpanel migration: discovery live-progress ---
    // Агент шлёт каждый шаг discover'а (SSH whoami → distro → sites → cron →
    // per-site парсинг). Мы просто пробрасываем в комнату миграции — UI
    // на /admin/migrate-hostpanel рендерит лог в реальном времени.
    agent.on(
      'migrate:hostpanel:discover-log',
      (data: {
        migrationId: string;
        line: string;
        step?: number;
        total?: number;
        ts?: string;
      }) => {
        this.server
          .to(`migrate-hostpanel:${data.migrationId}`)
          .emit('migrate-hostpanel:discover-log', {
            migrationId: data.migrationId,
            line: data.line,
            step: data.step,
            total: data.total,
            timestamp: data.ts || new Date().toISOString(),
          });
      },
    );

    // --- Hostpanel migration: per-item log/progress/status ---
    // ВНИМАНИЕ: db-dump-import шлёт сотни строк в секунду. appendItemLog
    // буферизует в памяти и флашит пакетом — ошибок кидать не должен, но
    // обворачиваем try на случай чего: unhandledRejection здесь раньше валил
    // весь API → migration item помечался orphan FAILED.
    agent.on(
      'migrate:hostpanel:item:log',
      (data: { migrationId: string; itemId: string; line: string }) => {
        try {
          this.migrationHostpanelService.appendItemLog(data.itemId, data.line);
        } catch (e) {
          this.logger.warn(
            `appendItemLog failed: ${(e as Error).message}`,
          );
        }
        // Forward to subscribed clients (room: migrate-hostpanel:<migrationId>)
        this.server
          .to(`migrate-hostpanel:${data.migrationId}`)
          .emit('migrate-hostpanel:item:log', {
            migrationId: data.migrationId,
            itemId: data.itemId,
            line: data.line,
            timestamp: new Date().toISOString(),
          });
      },
    );

    agent.on(
      'migrate:hostpanel:item:progress',
      async (data: { migrationId: string; itemId: string; stage: string; progress: number }) => {
        await this.migrationHostpanelService.updateItemStatus(data.itemId, {
          currentStage: data.stage,
          progressPercent: data.progress,
        });
        this.server
          .to(`migrate-hostpanel:${data.migrationId}`)
          .emit('migrate-hostpanel:item:progress', {
            migrationId: data.migrationId,
            itemId: data.itemId,
            stage: data.stage,
            progress: data.progress,
          });
      },
    );

    agent.on(
      'migrate:hostpanel:item:status',
      async (data: { migrationId: string; itemId: string; status: string; errorMsg?: string }) => {
        const patch: Parameters<typeof this.migrationHostpanelService.updateItemStatus>[1] = {
          status: data.status,
          errorMsg: data.errorMsg ?? null,
        };
        if (data.status === 'DONE' || data.status === 'FAILED') {
          patch.finishedAt = new Date();
          if (data.status === 'DONE') patch.progressPercent = 100;
        }
        await this.migrationHostpanelService.updateItemStatus(data.itemId, patch);
        this.server
          .to(`migrate-hostpanel:${data.migrationId}`)
          .emit('migrate-hostpanel:item:status', {
            migrationId: data.migrationId,
            itemId: data.itemId,
            status: data.status,
            errorMsg: data.errorMsg,
          });
      },
    );

    // --- Backup restore progress ---
    agent.on(
      'backup:restore:progress',
      async (data: {
        backupId: string;
        restoreId: string;
        progress: number;
      }) => {
        await this.backupsService.updateRestoreProgress(
          data.backupId,
          data.restoreId,
          data.progress,
        );
        this.emitBrowserBroadcast('backup:restore:progress', {
          backupId: data.backupId,
          restoreId: data.restoreId,
          progress: data.progress,
          timestamp: new Date().toISOString(),
        });
      },
    );

    // --- Backup-export (S3 dump) complete ---
    agent.on(
      'backup-export:complete',
      async (data: {
        exportId: string;
        success: boolean;
        sizeBytes?: number;
        error?: string;
      }) => {
        await this.backupExportsService.handleAgentExportComplete(data);
      },
    );

    // --- Backup-export progress (live in-memory only, не пишем в БД) ---
    agent.on(
      'backup-export:progress',
      (data: {
        exportId: string;
        bytesRead: number;
        bytesUploaded: number;
        elapsedMs: number;
      }) => {
        this.backupExportsService.recordExportProgress(data);
      },
    );

    // --- Backup restore complete ---
    agent.on(
      'backup:restore:complete',
      async (data: {
        backupId: string;
        restoreId: string;
        success: boolean;
        error?: string;
      }) => {
        const result = await this.backupsService.completeRestore(data);
        this.emitBrowserBroadcast('backup:restore:progress', {
          backupId: data.backupId,
          restoreId: data.restoreId,
          progress: result.success ? 100 : 0,
          status: result.success ? 'RESTORED' : 'FAILED',
          error: result.error,
          timestamp: new Date().toISOString(),
        });
      },
    );

    // --- Site installer raw log streaming ---
    // Агент шлёт сырые строки composer/cli-install/setup. Реле'им во фронт
    // как обычный provision:log — тот же канал, тот же siteId, тот же фильтр.
    agent.on(
      'site:install:log',
      (data: { siteId?: string; domain?: string; line: string }) => {
        if (!data.siteId) return; // без siteId фронт не поймёт, к какому сайту относится
        // Помечаем строку как stderr -> 'warn', если прилетело из stderr-префикса.
        const level: 'info' | 'warn' =
          /^\[(composer|setup|install)!\] /.test(data.line) ? 'warn' : 'info';
        this.emitBrowserBroadcast('site:provision:log', {
          siteId: data.siteId,
          level,
          line: data.line,
          timestamp: new Date().toISOString(),
        });
      },
    );

    // --- Terminal data streaming (PTY output) ---
    agent.on('terminal:data', (data: { sessionId: string; data: string }) => {
      // Route to the specific client that owns this session
      this.emitBrowserRoom(`terminal:${data.sessionId}`, 'terminal:data', data);
    });

    // --- Log tail data streaming ---
    agent.on('logs:tail:data', (data: { tailId: string; line: string }) => {
      this.emitBrowserRoom(`logs:tail:${data.tailId}`, 'logs:tail:data', data);
    });

    // --- Reconciliation result ---
    agent.on(
      'reconcile:result',
      async (data: {
        deploys: Array<{
          deployId: string;
          found: boolean;
          commitSha?: string;
          commitMessage?: string;
        }>;
        backups: Array<{
          backupId: string;
          found: boolean;
          filePath?: string;
          sizeBytes?: number;
        }>;
      }) => {
        for (const d of data.deploys) {
          if (d.found) {
            await this.deployService.completeDeploy(d.deployId, true, d.commitSha, d.commitMessage);
            this.logger.log(`Reconciled deploy ${d.deployId} as SUCCESS`);
          }
        }

        for (const b of data.backups) {
          if (b.found) {
            await this.backupsService.completeBackup(b.backupId, true, b.filePath, b.sizeBytes);
            this.logger.log(`Reconciled backup ${b.backupId} as COMPLETED`);
          }
        }
      },
    );

    // --- System metrics streaming ---
    // Forward to browser clients + feed to monitoring service for persistence
    agent.on('system:metrics', (data: unknown) => {
      this.emitBrowserBroadcast('system:metrics', data);
      this.monitoringService.updateLatest(data);
    });
  }

  /**
   * Broadcast site status change to all connected clients.
   */
  broadcastSiteStatus(
    siteId: string,
    status: string,
    previousStatus: string,
  ) {
    this.emitBrowserBroadcast('site:status', {
      siteId,
      status,
      previousStatus,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Stream a provisioning log line for a specific site (used by SitesService
   * during async site creation). Broadcast to all clients; фронт фильтрует
   * по siteId. Безопасно: провижининг-сообщения не содержат секретов.
   */
  emitSiteProvisionLog(
    siteId: string,
    level: 'info' | 'warn' | 'error',
    line: string,
  ) {
    this.emitBrowserBroadcast('site:provision:log', {
      siteId,
      level,
      line,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Signal that async site provisioning is complete (success or failure).
   */
  emitSiteProvisionDone(
    siteId: string,
    status: 'RUNNING' | 'ERROR',
    error?: string,
  ) {
    this.emitBrowserBroadcast('site:provision:done', {
      siteId,
      status,
      error,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Broadcast `migrate-hostpanel:complete` в комнату миграции.
   * spec §15.5: финальный сигнал UI о завершении всей миграции
   * (totalDone/totalFailed). Вызывается мастер-сервисом из
   * `recomputeMigrationFinalStatus` когда status переходит в
   * терминальный (DONE / FAILED / PARTIAL / CANCELLED).
   */
  broadcastMigrationComplete(
    migrationId: string,
    status: string,
    totalDone: number,
    totalFailed: number,
  ): void {
    this.server
      .to(`migrate-hostpanel:${migrationId}`)
      .emit('migrate-hostpanel:complete', {
        migrationId,
        status,
        totalDone,
        totalFailed,
        timestamp: new Date().toISOString(),
      });
  }

  private async reconcileOnConnect(agent: AuthenticatedSocket): Promise<void> {
    try {
      const [stuckDeploys, stuckBackups] = await Promise.all([
        this.deployService.findStuckDeploys(),
        this.backupsService.findStuckBackups(),
      ]);

      if (stuckDeploys.length === 0 && stuckBackups.length === 0) return;

      this.logger.log(
        `Reconciling: ${stuckDeploys.length} stuck deploy(s), ${stuckBackups.length} stuck backup(s)`,
      );

      agent.emit('reconcile:check', {
        deploys: stuckDeploys.map((d) => ({
          deployId: d.id,
          rootPath: d.site.rootPath,
          branch: d.branch,
        })),
        backups: stuckBackups.map((b) => ({
          backupId: b.id,
          filePath: b.filePath,
          storageType: b.storageType,
        })),
      });
    } catch (err) {
      this.logger.error(`Reconciliation failed: ${(err as Error).message}`);
    }
  }

  // =========================================================================
  // AI Chat
  // =========================================================================

  private registerAiListeners(client: AuthenticatedSocket) {
    const userId = client.data.userId!;

    // Лимит на размер пользовательского промпта — защита от случайного/умышленного
    // забивания контекста Claude огромным куском (cost + время). 50 KB символов
    // ~12k токенов в худшем случае. Конфигурируется через AI_PROMPT_MAX_CHARS.
    const aiPromptMax = parseInt(process.env.AI_PROMPT_MAX_CHARS || '', 10) || 50_000;

    // Start new or resume existing session
    this.bindClientEvent(client, 'ai:start', async (payload: { prompt: string; cwd?: string; sessionId?: string }) => {
      if (!payload.prompt?.trim()) return;
      if (payload.prompt.length > aiPromptMax) {
        this.emitToClient(client, 'ai:error', { type: 'error', message: `Промпт слишком длинный (>${aiPromptMax} символов)` });
        return;
      }

      try {
        await this.aiService.startSession(
          userId,
          payload.prompt,
          (event: AiEvent) => {
            this.emitToClient(client, `ai:${event.type}`, event);
          },
          { cwd: payload.cwd, resumeSessionId: payload.sessionId },
        );
      } catch (err) {
        this.emitToClient(client, 'ai:error', { type: 'error', message: (err as Error).message });
      }
    });

    // Send message to existing session (resume with new prompt)
    this.bindClientEvent(client, 'ai:message', async (payload: { sessionId: string; message: string }) => {
      if (!payload.message?.trim() || !payload.sessionId) return;
      if (payload.message.length > aiPromptMax) {
        this.emitToClient(client, 'ai:error', { type: 'error', message: `Сообщение слишком длинное (>${aiPromptMax} символов)` });
        return;
      }

      try {
        await this.aiService.startSession(
          userId,
          payload.message,
          (event: AiEvent) => {
            this.emitToClient(client, `ai:${event.type}`, event);
          },
          { resumeSessionId: payload.sessionId },
        );
      } catch (err) {
        this.emitToClient(client, 'ai:error', { type: 'error', message: (err as Error).message });
      }
    });

    // Stop active session
    this.bindClientEvent(client, 'ai:stop', () => {
      this.aiService.stopForUser(userId);
    });
  }

  private constantTimeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return timingSafeEqual(bufA, bufB);
  }
}
