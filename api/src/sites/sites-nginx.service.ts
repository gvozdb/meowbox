/**
 * Per-site nginx settings + 95-custom.conf редактор.
 *
 * UI вкладка «Nginx» страницы сайта дёргает:
 *  GET  /sites/:id/nginx/settings   → все nginx*-поля + effective дефолты + custom
 *  PUT  /sites/:id/nginx/settings   → сохраняет поля в БД + регенерирует чанки 00..50 на агенте
 *  GET  /sites/:id/nginx/custom     → возвращает 95-custom.conf (БД, fallback на диск)
 *  PUT  /sites/:id/nginx/custom     → сохраняет 95-custom.conf в БД + на диск (force-write)
 *  POST /sites/:id/nginx/test       → nginx -t
 *  POST /sites/:id/nginx/reload     → reload nginx
 *
 * Регенерация чанков идёт через тот же agent-event `nginx:create-config` —
 * агент идемпотентно перезапишет 00..50 файлов, а 95-custom.conf не тронет
 * (если не передан `forceWriteCustom: true`).
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  NGINX_DEFAULTS,
  resolveNginxSettings,
  siteNginxOverrides,
  type ResolvedNginxSettings,
  type SiteNginxOverrides,
} from '@meowbox/shared';

import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { SslStatus } from '../common/enums';

import { UpdateSiteNginxSettingsDto, UpdateSiteNginxCustomDto } from './sites.dto';

export interface NginxSettingsResponse {
  /** raw values из БД (null = дефолт). */
  raw: SiteNginxOverrides;
  /** Resolved values (с подставленными дефолтами) — для отображения в UI. */
  effective: ResolvedNginxSettings;
  /** Дефолты — для подсказок в плейсхолдерах формы. */
  defaults: typeof NGINX_DEFAULTS;
  /** Размеры буферов: подсказка в UI. */
  meta: {
    fastcgiSubBufferKb: number;
  };
}

@Injectable()
export class SitesNginxService {
  private readonly logger = new Logger(SitesNginxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
  ) {}

  // ---------------------------------------------------------------------------
  // SETTINGS
  // ---------------------------------------------------------------------------

  async getSettings(siteId: string, userId: string, role: string): Promise<NginxSettingsResponse> {
    const site = await this.requireSite(siteId, userId, role);
    const overrides = siteNginxOverrides(site);
    const effective = resolveNginxSettings(overrides);
    return {
      raw: overrides,
      effective,
      defaults: NGINX_DEFAULTS,
      meta: {
        fastcgiSubBufferKb: Math.max(4, Math.floor(effective.fastcgiBufferSizeKb / 2)),
      },
    };
  }

  async updateSettings(
    siteId: string,
    dto: UpdateSiteNginxSettingsDto,
    userId: string,
    role: string,
  ): Promise<NginxSettingsResponse> {
    const site = await this.requireSite(siteId, userId, role);

    const data: Record<string, unknown> = {};
    if (dto.clientMaxBodySize !== undefined) {
      const v = dto.clientMaxBodySize?.trim();
      if (v && !/^\d+[kmgKMG]?$/.test(v)) {
        throw new BadRequestException('clientMaxBodySize: ожидается формат "32M", "100M", "1G"');
      }
      data.nginxClientMaxBodySize = v || null;
    }
    if (dto.fastcgiReadTimeout !== undefined) {
      data.nginxFastcgiReadTimeout = this.intOrNull(dto.fastcgiReadTimeout, 1, 86400, 'fastcgiReadTimeout');
    }
    if (dto.fastcgiSendTimeout !== undefined) {
      data.nginxFastcgiSendTimeout = this.intOrNull(dto.fastcgiSendTimeout, 1, 86400, 'fastcgiSendTimeout');
    }
    if (dto.fastcgiConnectTimeout !== undefined) {
      data.nginxFastcgiConnectTimeout = this.intOrNull(dto.fastcgiConnectTimeout, 1, 86400, 'fastcgiConnectTimeout');
    }
    if (dto.fastcgiBufferSizeKb !== undefined) {
      data.nginxFastcgiBufferSizeKb = this.intOrNull(dto.fastcgiBufferSizeKb, 4, 1024, 'fastcgiBufferSizeKb');
    }
    if (dto.fastcgiBufferCount !== undefined) {
      data.nginxFastcgiBufferCount = this.intOrNull(dto.fastcgiBufferCount, 2, 256, 'fastcgiBufferCount');
    }
    if (dto.http2 !== undefined) data.nginxHttp2 = !!dto.http2;
    if (dto.hsts !== undefined) data.nginxHsts = !!dto.hsts;
    if (dto.gzip !== undefined) data.nginxGzip = !!dto.gzip;

    if (Object.keys(data).length === 0) {
      // Ничего не меняем, просто отдаём текущие значения.
      return this.getSettings(siteId, userId, role);
    }

    const updated = await this.prisma.site.update({ where: { id: siteId }, data });

    // Регенерация чанков на агенте.
    await this.regenerateConfigOnAgent(updated.id);

    return this.getSettings(siteId, userId, role);
  }

  // ---------------------------------------------------------------------------
  // CUSTOM CONFIG
  // ---------------------------------------------------------------------------

  /** GET — отдаёт значение из БД (источник истины). На диске может быть синхронизировано позже. */
  async getCustomConfig(siteId: string, userId: string, role: string): Promise<{ content: string; updatedAt: Date }> {
    const site = await this.requireSite(siteId, userId, role);
    return {
      content: (site as { nginxCustomConfig?: string | null }).nginxCustomConfig ?? '',
      updatedAt: site.updatedAt,
    };
  }

  /** PUT — сохраняем в БД + force-write на диск через агент. */
  async updateCustomConfig(
    siteId: string,
    dto: UpdateSiteNginxCustomDto,
    userId: string,
    role: string,
  ): Promise<{ content: string; testResult: { success: boolean; error?: string } }> {
    const site = await this.requireSite(siteId, userId, role);
    const content = (dto.content ?? '').slice(0, 256 * 1024); // 256KB sanity-cap

    // Атомарность: сначала пишем на агент (валидируется nginx -t), потом — БД.
    // Если nginx -t упадёт — БД не обновляем, юзер увидит ошибку и сможет починить.
    if (!this.agentRelay.isAgentConnected()) {
      throw new InternalServerErrorException('Агент не подключён — невозможно применить кастомный конфиг.');
    }

    const result = await this.agentRelay.emitToAgent<unknown>('nginx:set-custom', {
      siteName: site.name,
      content,
    });
    if (!result.success) {
      throw new BadRequestException(result.error || 'nginx -t failed (custom config invalid)');
    }

    await this.prisma.site.update({
      where: { id: siteId },
      data: { nginxCustomConfig: content },
    });

    return { content, testResult: { success: true } };
  }

  // ---------------------------------------------------------------------------
  // TEST / RELOAD
  // ---------------------------------------------------------------------------

  async testConfig(siteId: string, userId: string, role: string): Promise<{ success: boolean; error?: string }> {
    await this.requireSite(siteId, userId, role);
    const r = await this.agentRelay.emitToAgent<unknown>('nginx:test', {});
    return { success: !!r.success, error: r.success ? undefined : (r.error ?? 'nginx -t failed') };
  }

  async reload(siteId: string, userId: string, role: string): Promise<{ success: boolean; error?: string }> {
    await this.requireSite(siteId, userId, role);
    const r = await this.agentRelay.emitToAgent<unknown>('nginx:reload', {});
    return { success: !!r.success, error: r.success ? undefined : (r.error ?? 'reload failed') };
  }

  // ---------------------------------------------------------------------------
  // BULK REGENERATE (admin)
  // ---------------------------------------------------------------------------

  /**
   * Перегенерирует layered-конфиги для ВСЕХ сайтов. Используется после миграции
   * с монолитного формата на layered, либо при смене глобальных шаблонов nginx.
   * Возвращает summary {ok, failed, skipped} + per-site детали.
   */
  async regenerateAll(role: string): Promise<{
    total: number;
    ok: number;
    failed: number;
    skipped: number;
    details: Array<{ siteName: string; status: 'ok' | 'failed' | 'skipped'; error?: string }>;
  }> {
    if (role !== 'ADMIN') {
      throw new ForbiddenException('Only ADMIN can regenerate all nginx configs');
    }
    if (!this.agentRelay.isAgentConnected()) {
      throw new InternalServerErrorException('Агент не подключён');
    }

    const sites = await this.prisma.site.findMany({
      include: { sslCertificate: true },
    });
    const details: Array<{ siteName: string; status: 'ok' | 'failed' | 'skipped'; error?: string }> = [];
    let ok = 0;
    let failed = 0;
    let skipped = 0;

    for (const site of sites) {
      try {
        const ssl = site.sslCertificate;
        const sslActive = !!(ssl && ssl.status === SslStatus.ACTIVE && ssl.certPath && ssl.keyPath);
        const aliases = (() => {
          try { return JSON.parse(site.aliases || '[]'); } catch { return []; }
        })();

        const r = await this.agentRelay.emitToAgent('nginx:create-config', {
          siteName: site.name,
          siteType: site.type,
          domain: site.domain,
          aliases,
          rootPath: site.rootPath,
          filesRelPath: site.filesRelPath,
          phpVersion: site.phpVersion ?? undefined,
          phpEnabled: !!site.phpVersion,
          appPort: site.appPort ?? undefined,
          systemUser: site.systemUser ?? undefined,
          sslEnabled: sslActive,
          certPath: sslActive ? ssl!.certPath ?? undefined : undefined,
          keyPath: sslActive ? ssl!.keyPath ?? undefined : undefined,
          httpsRedirect: site.httpsRedirect,
          settings: siteNginxOverrides(site),
          // Если nginxCustomConfig в БД есть — пишем его на диск (force-write)
          // чтобы синхронизировать. Это переедет старые сайты с монолита.
          customConfig: site.nginxCustomConfig ?? undefined,
          forceWriteCustom: !!site.nginxCustomConfig,
        });

        if (r.success) {
          ok++;
          details.push({ siteName: site.name, status: 'ok' });
        } else {
          failed++;
          details.push({ siteName: site.name, status: 'failed', error: r.error || 'unknown' });
        }
      } catch (e) {
        failed++;
        details.push({ siteName: site.name, status: 'failed', error: (e as Error).message });
      }
    }

    this.logger.log(`Bulk nginx regenerate: total=${sites.length}, ok=${ok}, failed=${failed}, skipped=${skipped}`);
    return { total: sites.length, ok, failed, skipped, details };
  }

  // ---------------------------------------------------------------------------
  // INTERNALS
  // ---------------------------------------------------------------------------

  private intOrNull(v: number | null | undefined, min: number, max: number, name: string): number | null {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new BadRequestException(`${name}: ожидается целое число`);
    }
    if (n === 0) return null; // 0 = дефолт
    if (n < min || n > max) {
      throw new BadRequestException(`${name}: должно быть в диапазоне [${min}, ${max}]`);
    }
    return n;
  }

  private async requireSite(siteId: string, userId: string, role: string) {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      include: { sslCertificate: true },
    });
    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    return site;
  }

  /**
   * Дёргает агент `nginx:create-config` со всеми текущими параметрами сайта —
   * чанки 00..50 будут перезаписаны. 95-custom.conf не трогается (агент пишет
   * его только если файла нет на диске).
   */
  private async regenerateConfigOnAgent(siteId: string): Promise<void> {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      include: { sslCertificate: true },
    });
    if (!site) return;
    if (!this.agentRelay.isAgentConnected()) {
      this.logger.warn(`Agent not connected — settings saved in DB but not applied to nginx (site ${siteId})`);
      return;
    }

    const ssl = site.sslCertificate;
    const sslActive = !!(ssl && ssl.status === SslStatus.ACTIVE && ssl.certPath && ssl.keyPath);
    const aliases = (() => {
      try { return JSON.parse(site.aliases || '[]'); } catch { return []; }
    })();

    await this.agentRelay.emitToAgent('nginx:create-config', {
      siteName: site.name,
      siteType: site.type,
      domain: site.domain,
      aliases,
      rootPath: site.rootPath,
      filesRelPath: site.filesRelPath,
      phpVersion: site.phpVersion ?? undefined,
      phpEnabled: !!site.phpVersion,
      appPort: site.appPort ?? undefined,
      systemUser: site.systemUser ?? undefined,
      sslEnabled: sslActive,
      certPath: sslActive ? ssl!.certPath ?? undefined : undefined,
      keyPath: sslActive ? ssl!.keyPath ?? undefined : undefined,
      httpsRedirect: site.httpsRedirect,
      settings: siteNginxOverrides(site),
      // customConfig не передаём → агент не тронет существующий 95-custom.conf.
    });
  }
}
