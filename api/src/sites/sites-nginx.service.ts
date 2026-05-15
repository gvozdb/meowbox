/**
 * Per-domain nginx settings + 95-custom.conf редактор.
 *
 * 13 `nginx*` колонок и `nginxCustomConfig` теперь живут на `SiteDomain`
 * (каждый основной домен — собственный server-блок). UI вкладка «Nginx»
 * страницы домена дёргает:
 *  GET  /sites/:id/domains/:domainId/nginx/settings
 *  PUT  /sites/:id/domains/:domainId/nginx/settings
 *  GET  /sites/:id/domains/:domainId/nginx/custom
 *  PUT  /sites/:id/domains/:domainId/nginx/custom
 *  POST /sites/:id/nginx/test     — site-level
 *  POST /sites/:id/nginx/reload   — site-level
 *  POST /sites/nginx/rebuild-all  — все домены всех сайтов
 *
 * Регенерация конфигов идёт через `SiteDomainsService.regenerateNginx`
 * (мульти-доменный `nginx:create-config`).
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
import { SiteDomainsService } from './site-domains.service';

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
    private readonly siteDomains: SiteDomainsService,
  ) {}

  // ---------------------------------------------------------------------------
  // SETTINGS (per-domain)
  // ---------------------------------------------------------------------------

  async getSettings(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
  ): Promise<NginxSettingsResponse> {
    const domain = await this.requireDomain(siteId, domainId, userId, role);
    const overrides = siteNginxOverrides(domain);
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
    domainId: string,
    dto: UpdateSiteNginxSettingsDto,
    userId: string,
    role: string,
  ): Promise<NginxSettingsResponse> {
    await this.requireDomain(siteId, domainId, userId, role);

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
    if (dto.rateLimitEnabled !== undefined) data.nginxRateLimitEnabled = !!dto.rateLimitEnabled;
    if (dto.rateLimitRps !== undefined) {
      data.nginxRateLimitRps = this.intOrNull(dto.rateLimitRps, 1, 100000, 'rateLimitRps');
    }
    if (dto.rateLimitBurst !== undefined) {
      data.nginxRateLimitBurst = this.intOrNull(dto.rateLimitBurst, 1, 10000, 'rateLimitBurst');
    }

    if (Object.keys(data).length === 0) {
      return this.getSettings(siteId, domainId, userId, role);
    }

    await this.prisma.siteDomain.update({ where: { id: domainId }, data });

    // Изменились rate-limit поля → обновляем глобальный zones-файл
    // (limit_req_zone на каждый SiteDomain).
    const rateLimitChanged =
      dto.rateLimitEnabled !== undefined ||
      dto.rateLimitRps !== undefined ||
      dto.rateLimitBurst !== undefined;
    if (rateLimitChanged) {
      await this.siteDomains.regenerateGlobalZones();
    }

    await this.siteDomains.regenerateNginx(siteId);

    return this.getSettings(siteId, domainId, userId, role);
  }

  // ---------------------------------------------------------------------------
  // GLOBAL ZONES (limit_req_zone) — делегирование
  // ---------------------------------------------------------------------------

  async regenerateGlobalZones(): Promise<void> {
    await this.siteDomains.regenerateGlobalZones();
  }

  // ---------------------------------------------------------------------------
  // CUSTOM CONFIG (per-domain)
  // ---------------------------------------------------------------------------

  async getCustomConfig(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
  ): Promise<{ content: string; updatedAt: Date }> {
    const domain = await this.requireDomain(siteId, domainId, userId, role);
    return {
      content: domain.nginxCustomConfig ?? '',
      updatedAt: domain.updatedAt,
    };
  }

  /** PUT — сохраняем в БД + force-write на диск через агент (после nginx -t). */
  async updateCustomConfig(
    siteId: string,
    domainId: string,
    dto: UpdateSiteNginxCustomDto,
    userId: string,
    role: string,
  ): Promise<{ content: string; testResult: { success: boolean; error?: string } }> {
    const domain = await this.requireDomain(siteId, domainId, userId, role);
    const content = (dto.content ?? '').slice(0, 256 * 1024);

    if (!this.agentRelay.isAgentConnected()) {
      throw new InternalServerErrorException('Агент не подключён — невозможно применить кастомный конфиг.');
    }

    // Валидируем через агент (nginx:set-custom → nginx -t). domainId — агент
    // знает, какой именно server-блок переписать.
    const result = await this.agentRelay.emitToAgent<unknown>('nginx:set-custom', {
      siteName: domain.site.name,
      domainId,
      content,
    });
    if (!result.success) {
      throw new BadRequestException(result.error || 'nginx -t failed (custom config invalid)');
    }

    await this.prisma.siteDomain.update({
      where: { id: domainId },
      data: { nginxCustomConfig: content },
    });

    return { content, testResult: { success: true } };
  }

  // ---------------------------------------------------------------------------
  // TEST / RELOAD (site-level)
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
  // BULK REGENERATE (admin) — все домены всех сайтов
  // ---------------------------------------------------------------------------

  async regenerateAll(role: string): Promise<{
    total: number;
    ok: number;
    failed: number;
    details: Array<{ siteName: string; status: 'ok' | 'failed'; error?: string }>;
  }> {
    return this.siteDomains.rebuildAll(role);
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
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    return site;
  }

  private async requireDomain(siteId: string, domainId: string, userId: string, role: string) {
    const domain = await this.prisma.siteDomain.findUnique({
      where: { id: domainId },
      include: { site: { select: { id: true, name: true, userId: true } } },
    });
    if (!domain || domain.siteId !== siteId) {
      throw new NotFoundException('Domain not found');
    }
    if (role !== 'ADMIN' && domain.site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    return domain;
  }
}
