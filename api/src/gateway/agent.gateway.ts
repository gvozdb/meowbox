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
import { timingSafeEqual, randomBytes } from 'crypto';
import { AgentRelayService } from './agent-relay.service';
import { DeployService } from '../deploy/deploy.service';
import { BackupsService } from '../backups/backups.service';
import { BackupExportsService } from '../backups/backup-exports.service';
import { SslService } from '../ssl/ssl.service';
import { SitesService } from '../sites/sites.service';
import { MonitoringService } from '../monitoring/monitoring.service';
import { LogsService } from '../logs/logs.service';
import { AiService, AiEvent } from '../ai/ai.service';

interface AuthenticatedSocket extends Socket {
  data: {
    type: 'agent' | 'client';
    userId?: string;
    role?: string;
  };
}

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
    private readonly backupExportsService: BackupExportsService,
    private readonly sslService: SslService,
    @Inject(forwardRef(() => SitesService))
    private readonly sitesService: SitesService,
    private readonly monitoringService: MonitoringService,
    private readonly logsService: LogsService,
    private readonly aiService: AiService,
  ) {}

  async handleConnection(client: AuthenticatedSocket) {
    const auth = client.handshake.auth;

    // --- Agent authentication (AGENT_SECRET) ---
    if (auth.secret) {
      const expected = this.config.getOrThrow<string>('AGENT_SECRET');
      const provided = String(auth.secret);

      if (!this.constantTimeCompare(provided, expected)) {
        this.logger.warn('Agent auth failed: invalid secret');
        client.disconnect(true);
        return;
      }

      client.data = { type: 'agent' };
      this.relay.setAgentSocket(client);
      this.registerAgentListeners(client);
      this.logger.log(`Agent connected: ${client.id}`);
      this.reconcileOnConnect(client);
      return;
    }

    // --- Browser client authentication (JWT) ---
    if (auth.token) {
      try {
        const payload = this.jwtService.verify<{
          sub: string;
          role: string;
        }>(auth.token);

        client.data = {
          type: 'client',
          userId: payload.sub,
          role: payload.role,
        };

        // Join user-specific room for targeted events
        client.join(`user:${payload.sub}`);
        this.registerClientListeners(client);
        this.logger.log(`Client connected: ${client.id} (user: ${payload.sub})`);
        return;
      } catch {
        this.logger.warn('Client auth failed: invalid JWT');
        client.disconnect(true);
        return;
      }
    }

    // No valid auth
    this.logger.warn(`Unauthenticated connection rejected: ${client.id}`);
    client.disconnect(true);
  }

  handleDisconnect(client: AuthenticatedSocket) {
    if (client.data?.type === 'agent') {
      this.relay.setAgentSocket(null);
      this.logger.log('Agent disconnected');
    } else if (client.data?.type === 'client') {
      // Clean up any terminal sessions owned by this client
      const sessions = this.clientTerminalSessions.get(client.id);
      if (sessions) {
        for (const sessionId of sessions) {
          this.relay.emitToAgentAsync('terminal:close', { sessionId });
          // terminalSessionOwner мог не очиститься через `terminal:close`-listener
          // если клиент отвалился внезапно (kill -9 браузера, обрыв сети) →
          // запись в Map жила до перезапуска API. Сносим явно при disconnect.
          this.terminalSessionOwner.delete(sessionId);
        }
        this.clientTerminalSessions.delete(client.id);
      }
      // Clean up any tail sessions owned by this client
      const tailSessions = this.clientTailSessions.get(client.id);
      if (tailSessions && this.relay.isAgentConnected()) {
        for (const tailId of tailSessions) {
          this.relay.emitToAgentAsync('logs:tail:stop', { tailId });
        }
      }
      this.clientTailSessions.delete(client.id);
      this.logger.log(`Client disconnected: ${client.id}`);
    }
  }

  /**
   * Register listeners for events browser clients send TO the API.
   */
  private registerClientListeners(client: AuthenticatedSocket) {
    // Log tail: available to ADMIN and MANAGER
    if (client.data.role === 'ADMIN' || client.data.role === 'MANAGER') {
      this.registerLogTailListeners(client);
    }

    // Terminal: ADMIN only
    if (client.data.role !== 'ADMIN') return;

    // --- Terminal: open ---
    client.on('terminal:open', async (optionsOrCb: { user?: string } | ((p: Record<string, unknown>) => void), maybeCb?: (p: Record<string, unknown>) => void) => {
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
        client.join(`terminal:${sessionId}`);

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
    client.on('terminal:input', (payload: { sessionId: string; data: string }) => {
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
    client.on('terminal:resize', (payload: { sessionId: string; cols: number; rows: number }) => {
      const sessions = this.clientTerminalSessions.get(client.id);
      if (!sessions?.has(payload.sessionId)) return;

      if (this.relay.isAgentConnected()) {
        this.relay.emitToAgentAsync('terminal:resize', payload);
      }
    });

    // --- Terminal: close ---
    client.on('terminal:close', (payload: { sessionId: string }) => {
      const sessions = this.clientTerminalSessions.get(client.id);
      if (!sessions?.has(payload.sessionId)) return;

      if (this.relay.isAgentConnected()) {
        this.relay.emitToAgentAsync('terminal:close', payload);
      }

      sessions.delete(payload.sessionId);
      this.terminalSessionOwner.delete(payload.sessionId);
      client.leave(`terminal:${payload.sessionId}`);
      this.logger.log(`Terminal session closed: ${payload.sessionId}`);
    });

    // --- AI Chat ---
    this.registerAiListeners(client);
  }

  /**
   * Register log tail listeners (ADMIN + MANAGER).
   */
  private registerLogTailListeners(client: AuthenticatedSocket) {
    // --- Log tail: start ---
    client.on('logs:tail:start', async (
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
        client.join(`logs:tail:${tailId}`);

        this.logger.log(`Log tail started: ${tailId} for client ${client.id}`);
        cb({ tailId });
      } catch (err) {
        cb({ error: (err as Error).message });
      }
    });

    // --- Log tail: stop ---
    client.on('logs:tail:stop', (payload: { tailId: string }) => {
      const tails = this.clientTailSessions.get(client.id);
      if (!tails?.has(payload.tailId)) return;

      if (this.relay.isAgentConnected()) {
        this.relay.emitToAgentAsync('logs:tail:stop', payload);
      }

      tails.delete(payload.tailId);
      client.leave(`logs:tail:${payload.tailId}`);
      this.logger.log(`Log tail stopped: ${payload.tailId}`);
    });
  }

  /**
   * Register listeners for events the Agent sends TO the API.
   */
  private registerAgentListeners(agent: AuthenticatedSocket) {
    // --- Deploy log streaming ---
    agent.on(
      'deploy:log',
      async (data: { deployId: string; line: string }) => {
        await this.deployService.appendOutput(data.deployId, data.line + '\n');
        // Forward to subscribed clients
        this.server.to(`deploy:${data.deployId}`).emit('site:deploy:log', {
          deployLogId: data.deployId,
          line: data.line,
          stream: 'stdout',
          timestamp: new Date().toISOString(),
        });
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
        this.server.to(`deploy:${data.deployId}`).emit('site:deploy:log', {
          deployLogId: data.deployId,
          line: data.success
            ? '✓ Deploy completed successfully'
            : '✗ Deploy failed',
          stream: data.success ? 'stdout' : 'stderr',
          timestamp: new Date().toISOString(),
        });
      },
    );

    // --- Backup progress ---
    agent.on(
      'backup:progress',
      async (data: { backupId: string; progress: number }) => {
        await this.backupsService.updateBackupProgress(
          data.backupId,
          data.progress,
        );
        agent.broadcast.emit('backup:progress', {
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
        agent.broadcast.emit('backup:progress', {
          backupId: data.backupId,
          progress: data.success ? 100 : 0,
          status: data.success ? 'COMPLETED' : 'FAILED',
          timestamp: new Date().toISOString(),
        });
      },
    );

    // --- Backup restore progress ---
    agent.on(
      'backup:restore:progress',
      async (data: { backupId: string; progress: number }) => {
        agent.broadcast.emit('backup:restore:progress', {
          backupId: data.backupId,
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
        success: boolean;
        error?: string;
      }) => {
        agent.broadcast.emit('backup:restore:progress', {
          backupId: data.backupId,
          progress: data.success ? 100 : 0,
          status: data.success ? 'RESTORED' : 'FAILED',
          error: data.error,
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
        this.server.emit('site:provision:log', {
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
      this.server.to(`terminal:${data.sessionId}`).emit('terminal:data', data);
    });

    // --- Log tail data streaming ---
    agent.on('logs:tail:data', (data: { tailId: string; line: string }) => {
      this.server.to(`logs:tail:${data.tailId}`).emit('logs:tail:data', data);
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
      agent.broadcast.emit('system:metrics', data);
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
    this.server.emit('site:status', {
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
    this.server.emit('site:provision:log', {
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
    this.server.emit('site:provision:done', {
      siteId,
      status,
      error,
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
    client.on('ai:start', async (payload: { prompt: string; cwd?: string; sessionId?: string }) => {
      if (!payload.prompt?.trim()) return;
      if (payload.prompt.length > aiPromptMax) {
        client.emit('ai:error', { type: 'error', message: `Промпт слишком длинный (>${aiPromptMax} символов)` });
        return;
      }

      try {
        await this.aiService.startSession(
          userId,
          payload.prompt,
          (event: AiEvent) => {
            client.emit(`ai:${event.type}`, event);
          },
          { cwd: payload.cwd, resumeSessionId: payload.sessionId },
        );
      } catch (err) {
        client.emit('ai:error', { type: 'error', message: (err as Error).message });
      }
    });

    // Send message to existing session (resume with new prompt)
    client.on('ai:message', async (payload: { sessionId: string; message: string }) => {
      if (!payload.message?.trim() || !payload.sessionId) return;
      if (payload.message.length > aiPromptMax) {
        client.emit('ai:error', { type: 'error', message: `Сообщение слишком длинное (>${aiPromptMax} символов)` });
        return;
      }

      try {
        await this.aiService.startSession(
          userId,
          payload.message,
          (event: AiEvent) => {
            client.emit(`ai:${event.type}`, event);
          },
          { resumeSessionId: payload.sessionId },
        );
      } catch (err) {
        client.emit('ai:error', { type: 'error', message: (err as Error).message });
      }
    });

    // Stop active session
    client.on('ai:stop', () => {
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
