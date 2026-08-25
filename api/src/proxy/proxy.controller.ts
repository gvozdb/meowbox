import {
  Controller,
  All,
  Get,
  Headers,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  Req,
  Res,
  NotFoundException,
  ForbiddenException,
  GoneException,
  Logger,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response as ExpressResponse } from 'express';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { isLegacyStaticV0Action } from '../common/guards/proxy-auth.guard';
import { dashboardOverviewMetricSamples } from '../common/dashboard-observability';
import { ProxyService } from './proxy.service';
import { ProxyAuditService } from './proxy-audit.service';
import {
  FederationDispatchError,
  FederationDispatcherService,
  FederationRouteTarget,
} from '../federation/federation-dispatcher.service';
import {
  AddServerDto,
  UpdateServerDto,
  UpdateBulkDto,
} from './proxy.dto';
import { getOrCreateNetworkContext } from '../common/http/network-context';
import { FederatedFleetUpdateService } from './federated-fleet-update.service';

interface AuthCtx {
  id: string;
  role: 'ADMIN' | 'MANAGER' | 'VIEWER';
}

const DASHBOARD_PROXY_READ_PATHS = new Set([
  '/dashboard/overview',
  '/dashboard/summary',
  '/system/metrics',
  '/sites',
]);

export function shouldAuditProxyRequest(method: string, path: string): boolean {
  const normalizedMethod = method.toUpperCase();
  const isRead = normalizedMethod === 'GET' || normalizedMethod === 'HEAD';
  return !isRead || !DASHBOARD_PROXY_READ_PATHS.has(path);
}

@Controller()
@Roles('ADMIN')
export class ProxyController {
  private readonly logger = new Logger('ProxyController');

  constructor(
    private readonly proxyService: ProxyService,
    private readonly audit: ProxyAuditService,
    private readonly federationDispatcher: FederationDispatcherService,
    private readonly fleetUpdates: FederatedFleetUpdateService,
  ) {}

  /** List all configured servers with online status */
  @Get('servers')
  async listServers() {
    const servers = await this.proxyService.getServersWithStatus();
    return { success: true, data: servers };
  }

  /** Force refresh statuses (manual healthcheck trigger) */
  @Post('servers/refresh')
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  async refreshServers() {
    const servers = await this.proxyService.refreshStatuses();
    return { success: true, data: servers };
  }

  /** Add a new server */
  @Post('servers')
  async addServer(@Body() body: AddServerDto) {
    const server = await this.proxyService.addServer(body);
    const ping = await this.proxyService.pingServer(server);
    return {
      success: true,
      data: { ...server, token: '***', ...ping },
    };
  }

  /** Update an existing server */
  @Put('servers/:id')
  async updateServer(
    @Param('id') id: string,
    @Body() body: UpdateServerDto,
  ) {
    const server = await this.proxyService.updateServer(id, body);
    return { success: true, data: { ...server, token: '***' } };
  }

  /** Delete a server */
  @Delete('servers/:id')
  async deleteServer(@Param('id') id: string) {
    await this.proxyService.removeServer(id);
    return { success: true };
  }

  /** Provision a new server via SSH */
  @Post('servers/provision')
  // Провижнинг запускает apt-install + ssh: дорогая и тяжёлая операция.
  // Ограничиваем 2 запроса / 5 минут, чтобы оператор случайно не запустил
  // десяток параллельных установок и не положил сеть.
  @Throttle({ default: { limit: 2, ttl: 300_000 } })
  provisionServer() {
    throw new GoneException(
      'Legacy static-token provisioning is disabled; use /servers/enrollments',
    );
  }

  /**
   * Массовое обновление выбранных серверов до целевой версии.
   * Версия должна быть СТРОГО ВЫШЕ максимальной текущей среди выбранных
   * (downgrade запрещён, может сломать БД-миграции slave-сервера).
   *
   * Шлёт POST /api/admin/update на каждый slave с body { version }.
   * Slave запускает tools/update.sh в фоне (см. PanelUpdateService).
   */
  @Post('servers/update-bulk')
  @Throttle({ default: { limit: 1, ttl: 300_000 } })
  async updateBulk(
    @Body() body: UpdateBulkDto,
    @CurrentUser() user: AuthCtx,
    @Req() req: Request,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const network = getOrCreateNetworkContext(req);
    const data = await this.fleetUpdates.triggerBulk(
      body.serverIds,
      body.version,
      {
        id: user.id,
        role: user.role,
        browserIp: network.browserIp,
        peerIp: network.peerIp,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      },
      idempotencyKey,
    );
    return { success: true, data };
  }

  @Get('servers/:id/update-status')
  async federatedUpdateStatus(
    @Param('id') id: string,
    @CurrentUser() user: AuthCtx,
    @Req() req: Request,
  ) {
    const network = getOrCreateNetworkContext(req);
    const data = await this.fleetUpdates.federatedStatus(id, {
      id: user.id,
      role: user.role,
      browserIp: network.browserIp,
      peerIp: network.peerIp,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });
    return { success: true, data };
  }

  /** Audit-лог проксирующих запросов (для UI на /servers, вкладка "журнал"). */
  @Get('servers/audit')
  async getAudit(
    @Query('serverId') serverId?: string,
    @Query('direction') direction?: 'OUT' | 'IN',
    @Query('limit') limitStr?: string,
  ) {
    const limit = limitStr ? Math.min(Math.max(parseInt(limitStr, 10) || 100, 1), 500) : 100;
    const data = await this.audit.listRecent({
      serverId,
      direction: direction === 'OUT' || direction === 'IN' ? direction : undefined,
      limit,
    });
    return { success: true, data };
  }

  /**
   * Universal proxy роутер. Pass-through: сохраняет Content-Type, тело,
   * стримит ответ. Работает для:
   *   - JSON CRUD (как раньше)
   *   - multipart/form-data (загрузка файлов в /files, /backups/restore)
   *   - бинарных скачиваний (бэкап-экспорты, дампы БД)
   *   - произвольных text/html/octet-stream ответов
   *
   * Rate-limit: 120 запросов / минуту на пользователя — достаточно для UI
   * (страница может делать ~10 параллельных запросов), но защищает slave
   * от DDOS через master.
   *
   * IMPORTANT: для этого роута в main.ts подключён express.raw({type:'star/star'}),
   * который складывает входящее тело в req.body как Buffer, минуя обычный
   * JSON-парсер. Без этого multipart/бинарь рушились бы на global JSON pipe.
   */
  @All('proxy/:serverId/*')
  @Roles('ADMIN', 'MANAGER', 'VIEWER')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async proxyRequest(
    @Param('serverId') serverId: string,
    @Req() req: Request,
    @Res() res: ExpressResponse,
    @CurrentUser() user: AuthCtx,
  ) {
    const routeTarget = await this.federationDispatcher.resolveRouteTarget(serverId);
    if (routeTarget.kind === 'V1') {
      await this.dispatchFederationRequest(routeTarget, req, res, user);
      return;
    }

    const server = this.proxyService.getServer(serverId);
    if (!server) {
      throw new NotFoundException(`Server "${serverId}" not found in config`);
    }

    // req.path не содержит querystring — берём из originalUrl, чтобы пробросить ?param=
    const prefix = `/api/proxy/${serverId}`;
    const fullUrl = req.originalUrl || req.url;
    const targetPathWithQuery = fullUrl.startsWith(prefix)
      ? fullUrl.slice(prefix.length) || '/'
      : fullUrl;
    const targetPath = targetPathWithQuery.split('?')[0] || '/';
    const shouldAudit = shouldAuditProxyRequest(req.method, targetPath);

    if (user.role !== 'ADMIN') {
      throw new ForbiddenException('Legacy remote access is ADMIN-only');
    }
    if (!isLegacyStaticV0Action(req.method, `/api${targetPathWithQuery}`)) {
      res.status(426).json({
        success: false,
        error: {
          code: 'LEGACY_UPGRADE_REQUIRED',
          message: 'This target must be upgraded before the action is available',
        },
      });
      return;
    }

    const ip = (req.ip ?? 'unknown') as string;
    const ua = (req.headers['user-agent'] as string | undefined) ?? null;
    const t0 = Date.now();

    // Собираем заголовки запроса — только string-значения. Express может
    // вернуть string[] для повторяющихся (set-cookie и т.п.), для запроса
    // это нерелевантно — берём первый.
    const inHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) inHeaders[k] = v[0] ?? '';
      else if (typeof v === 'string') inHeaders[k] = v;
    }

    // Тело: req.body после express.raw() — это Buffer (или undefined для GET).
    // На случай, если что-то по пути ещё парснуло в JSON (security middleware)
    // — для GET/HEAD не передаём тело вообще.
    const bodyBuf =
      req.method !== 'GET' && req.method !== 'HEAD'
        ? Buffer.isBuffer(req.body)
          ? (req.body as Buffer)
          : (req.body !== undefined && req.body !== null)
            ? Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
            : undefined
        : undefined;

    let upstream: Response;
    try {
      upstream = await this.proxyService.proxyRaw(
        server,
        req.method,
        targetPathWithQuery,
        inHeaders,
        bodyBuf,
      );
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.error(`Proxy to ${server.name} failed: ${msg}`);
      if (targetPath === '/dashboard/overview') {
        this.logger.log(JSON.stringify({
          event: 'dashboard_overview_proxy_complete',
          durationMs: Date.now() - t0,
          role: user.role,
          statusCode: 502,
          metrics: dashboardOverviewMetricSamples({
            durationMs: Date.now() - t0,
            role: 'ADMIN',
            localOrProxy: 'proxy',
          }),
        }));
      }
      if (shouldAudit) {
        await this.audit.logOut({
          userId: user.id,
          serverId: server.id,
          serverName: server.name,
          method: req.method,
          path: targetPath,
          statusCode: null,
          durationMs: Date.now() - t0,
          ipAddress: ip,
          userAgent: ua,
          errorMsg: msg,
        });
      }
      res.status(502).json({
        success: false,
        error: { code: 'PROXY_UPSTREAM_FAILED', message: `Failed to reach server "${server.name}": ${msg}` },
      });
      return;
    }

    // Пробрасываем response-заголовки (с фильтром hop-by-hop).
    upstream.headers.forEach((value, key) => {
      const lk = key.toLowerCase();
      if (
        lk === 'connection' ||
        lk === 'keep-alive' ||
        lk === 'transfer-encoding' ||
        lk === 'content-encoding' || // мы не запрашивали gzip — slave не должен слать, но на всякий
        lk === 'content-length' || // длина может поменяться при ретрансляции; пусть Express сам выставит
        lk === 'set-cookie' ||
        lk === 'location'
      ) {
        return;
      }
      res.setHeader(key, value);
    });
    res.status(upstream.status);

    if (targetPath === '/dashboard/overview') {
      const durationMs = Date.now() - t0;
      this.logger.log(JSON.stringify({
        event: 'dashboard_overview_proxy_complete',
        durationMs,
        role: user.role,
        statusCode: upstream.status,
        metrics: dashboardOverviewMetricSamples({
          durationMs,
          role: 'ADMIN',
          localOrProxy: 'proxy',
        }),
      }));
    }

    if (shouldAudit) {
      await this.audit.logOut({
        userId: user.id,
        serverId: server.id,
        serverName: server.name,
        method: req.method,
        path: targetPath,
        statusCode: upstream.status,
        durationMs: Date.now() - t0,
        ipAddress: ip,
        userAgent: ua,
      });
    }

    if (!upstream.body) {
      res.end();
      return;
    }

    // Стримим тело ответа через node:stream/Readable.fromWeb — без буферизации
    // в памяти. Критично для бэкап-экспортов: 50GB не влезут в RAM мастера.
    // TODO(3b): см. proxy.service.ts::proxyRaw — переезд на signed URLs
    // позволит обходить мастера для тяжёлых скачиваний полностью.
    try {
      const nodeStream = Readable.fromWeb(upstream.body as never);
      nodeStream.on('error', (err) => {
        this.logger.error(`Proxy stream error from ${server.name}: ${err.message}`);
        if (!res.headersSent) {
          res.status(502).json({ success: false, error: { code: 'PROXY_STREAM_ERROR', message: err.message } });
        } else {
          res.end();
        }
      });
      // Если клиент закрыл соединение — обрываем upstream.
      res.on('close', () => {
        nodeStream.destroy();
      });
      nodeStream.pipe(res);
    } catch (err) {
      this.logger.error(`Proxy stream setup failed: ${(err as Error).message}`);
      if (!res.headersSent) {
        res.status(502).json({ success: false, error: { code: 'PROXY_STREAM_SETUP', message: (err as Error).message } });
      } else {
        res.end();
      }
    }
  }

  private async dispatchFederationRequest(
    routeTarget: Extract<FederationRouteTarget, { kind: 'V1' }>,
    req: Request,
    res: ExpressResponse,
    user: AuthCtx,
  ): Promise<void> {
    const ip = (req.ip ?? 'unknown') as string;
    const userAgent = (req.headers['user-agent'] as string | undefined) ?? null;
    const startedAt = Date.now();
    const abortController = new AbortController();
    const body = req.method === 'GET' || req.method === 'HEAD'
      ? Buffer.alloc(0)
      : Buffer.isBuffer(req.body)
        ? req.body
        : req.body === undefined || req.body === null
          ? Buffer.alloc(0)
          : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    const targetPath = (req.originalUrl || req.url)
      .slice(`/api/proxy/${routeTarget.targetInstallationId}`.length)
      .split('?', 1)[0] || '/';
    const auditRequest = shouldAuditProxyRequest(req.method, targetPath);

    try {
      const upstream = await this.federationDispatcher.dispatch({
        targetInstallationId: routeTarget.targetInstallationId,
        inboundTarget: req.originalUrl || req.url,
        method: req.method,
        rawHeaders: req.rawHeaders,
        body,
        actor: {
          id: user.id,
          role: user.role as 'ADMIN' | 'MANAGER' | 'VIEWER',
        },
        browserIp: ip,
        signal: abortController.signal,
      });
      for (const [name, value] of Object.entries(upstream.headers)) {
        res.setHeader(name, Array.isArray(value) ? [...value] : value);
      }
      res.setHeader('X-Request-Id', upstream.requestId);
      res.status(upstream.statusCode);

      if (targetPath === '/dashboard/overview') {
        const durationMs = Date.now() - startedAt;
        this.logger.log(JSON.stringify({
          event: 'dashboard_overview_proxy_complete',
          durationMs,
          role: user.role,
          statusCode: upstream.statusCode,
          protocol: 1,
          metrics: dashboardOverviewMetricSamples({
            durationMs,
            role: user.role === 'MANAGER' ? 'MANAGER' : 'ADMIN',
            localOrProxy: 'proxy',
          }),
        }));
      }
      if (auditRequest) {
        await this.audit.logOut({
          userId: user.id,
          serverId: routeTarget.serverId,
          serverName: routeTarget.displayName,
          method: req.method,
          path: targetPath,
          statusCode: upstream.statusCode,
          durationMs: Date.now() - startedAt,
          ipAddress: ip,
          userAgent,
          requestId: upstream.requestId,
          actionId: upstream.actionId,
          issuerInstallationId: upstream.issuerInstallationId,
          targetInstallationId: upstream.targetInstallationId,
          actorKind: 'OPERATOR',
          keyId: upstream.keyId,
          peerIp: ip,
          browserIp: ip,
        });
      }

      upstream.body.on('error', (error: Error) => {
        this.logger.warn(`Federation response stream failed (${upstream.requestId}): ${error.message}`);
        if (!res.headersSent) {
          res.status(502).json({
            success: false,
            error: { code: 'REMOTE_IDLE_TIMEOUT', message: 'Remote response stream failed' },
          });
        } else {
          res.destroy(error);
        }
      });
      res.on('close', () => {
        if (!res.writableEnded) abortController.abort();
        upstream.body.destroy();
      });
      upstream.body.pipe(res);
    } catch (error) {
      abortController.abort();
      const dispatchError = error instanceof FederationDispatchError ? error : null;
      const contract = dispatchError?.contract ?? {
        code: 'REMOTE_OFFLINE',
        message: 'Remote transport failed',
        requestId: randomUUID(),
        targetInstallationId: routeTarget.targetInstallationId,
        actionId: null,
        retryable: false,
        retryAfterSeconds: null,
        targetStatus: null,
      };
      this.logger.warn(`Federation dispatch failed (${contract.requestId}, ${contract.code})`);
      if (auditRequest) {
        await this.audit.logOut({
          userId: user.id,
          serverId: routeTarget.serverId,
          serverName: routeTarget.displayName,
          method: req.method,
          path: targetPath,
          statusCode: dispatchError?.httpStatus ?? 502,
          durationMs: Date.now() - startedAt,
          ipAddress: ip,
          userAgent,
          errorMsg: contract.code,
          requestId: contract.requestId,
          actionId: contract.actionId,
          targetInstallationId: contract.targetInstallationId,
          actorKind: 'OPERATOR',
          peerIp: ip,
          browserIp: ip,
        });
      }
      res.status(dispatchError?.httpStatus ?? 502).json({ success: false, error: contract });
    }
  }
}
