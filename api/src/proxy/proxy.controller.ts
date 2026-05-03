import {
  Controller,
  All,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  Req,
  Res,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response as ExpressResponse } from 'express';
import { Readable } from 'stream';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ProxyService } from './proxy.service';
import { ProvisionService } from './provision.service';
import { ProxyAuditService } from './proxy-audit.service';
import {
  AddServerDto,
  UpdateServerDto,
  ProvisionServerDto,
  UpdateBulkDto,
} from './proxy.dto';

interface AuthCtx {
  id: string;
  role: string;
}

/**
 * Сравнение semver-тегов вида "v0.4.0", "0.4.1", "v1.2.3-beta.4".
 * Возвращает: -1 (a<b), 0 (a==b), 1 (a>b).
 */
function compareSemver(a: string, b: string): number {
  const norm = (v: string) => v.replace(/^v/i, '').split(/[.-]/);
  const aa = norm(a);
  const bb = norm(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const ai = aa[i] ?? '0';
    const bi = bb[i] ?? '0';
    const an = Number(ai);
    const bn = Number(bi);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) {
      if (an !== bn) return an < bn ? -1 : 1;
    } else {
      if (ai !== bi) return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

@Controller()
@Roles('ADMIN')
export class ProxyController {
  private readonly logger = new Logger('ProxyController');

  constructor(
    private readonly proxyService: ProxyService,
    private readonly provisionService: ProvisionService,
    private readonly audit: ProxyAuditService,
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
  async provisionServer(@Body() body: ProvisionServerDto) {
    const result = await this.provisionService.provision(body);
    return { success: true, data: result };
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
  ) {
    const allServers = this.proxyService.getServers();
    const selected = body.serverIds
      .map((id) => allServers.find((s) => s.id === id))
      .filter((s): s is NonNullable<typeof s> => !!s);

    if (selected.length === 0) {
      throw new BadRequestException('Не найден ни один сервер из выбранных');
    }

    // Получаем актуальные версии всех выбранных серверов через свежий пинг
    // (нельзя доверять кешу — может быть stale).
    const versions = await Promise.all(
      selected.map(async (s) => {
        const ping = await this.proxyService.pingServer(s);
        return { server: s, current: ping.version ?? null, online: ping.online };
      }),
    );

    const offline = versions.filter((v) => !v.online);
    if (offline.length > 0) {
      throw new BadRequestException(
        `Сервера офлайн: ${offline.map((o) => o.server.name).join(', ')}. Обновление невозможно.`,
      );
    }

    // Самая высокая версия среди выбранных. Целевая должна быть строго выше.
    const knownVersions = versions
      .map((v) => v.current)
      .filter((v): v is string => !!v && v !== 'unknown');
    if (knownVersions.length > 0) {
      const maxCurrent = knownVersions.reduce((a, b) => (compareSemver(a, b) >= 0 ? a : b));
      if (compareSemver(body.version, maxCurrent) <= 0) {
        throw new BadRequestException(
          `Целевая версия ${body.version} не выше максимальной текущей (${maxCurrent}). Downgrade запрещён.`,
        );
      }
    }

    const ip = (req.ip ?? 'unknown') as string;
    const ua = (req.headers['user-agent'] as string | undefined) ?? null;

    const results: Array<{ id: string; name: string; success: boolean; error?: string }> = [];

    for (const { server } of versions) {
      const t0 = Date.now();
      try {
        const { status, data } = await this.proxyService.proxyRequest(
          server,
          'POST',
          '/admin/update',
          { version: body.version },
        );
        const ok = status >= 200 && status < 300;
        results.push({
          id: server.id,
          name: server.name,
          success: ok,
          error: !ok ? `HTTP ${status}: ${JSON.stringify(data)}` : undefined,
        });
        await this.audit.logOut({
          userId: user.id,
          serverId: server.id,
          serverName: server.name,
          method: 'POST',
          path: '/admin/update',
          statusCode: status,
          durationMs: Date.now() - t0,
          ipAddress: ip,
          userAgent: ua,
          errorMsg: !ok ? `HTTP ${status}` : null,
        });
      } catch (err) {
        const msg = (err as Error).message;
        results.push({ id: server.id, name: server.name, success: false, error: msg });
        await this.audit.logOut({
          userId: user.id,
          serverId: server.id,
          serverName: server.name,
          method: 'POST',
          path: '/admin/update',
          statusCode: null,
          durationMs: Date.now() - t0,
          ipAddress: ip,
          userAgent: ua,
          errorMsg: msg,
        });
      }
    }

    return { success: true, data: { version: body.version, results } };
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
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async proxyRequest(
    @Param('serverId') serverId: string,
    @Req() req: Request,
    @Res() res: ExpressResponse,
    @CurrentUser() user: AuthCtx,
  ) {
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
        lk === 'content-length' // длина может поменяться при ретрансляции; пусть Express сам выставит
      ) {
        return;
      }
      res.setHeader(key, value);
    });
    res.status(upstream.status);

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
}
