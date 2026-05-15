/**
 * Сервис мульти-доменной модели сайта (`SiteDomain`).
 *
 * Один Site = N основных доменов. Ровно один `isPrimary=true` (position=0).
 * Site.domain / Site.aliases / Site.appPort всегда зеркалят главный домен.
 *
 * После ЛЮБОГО изменения доменов:
 *  - re-sync зеркала Site (`syncPrimaryMirror`);
 *  - регенерация nginx всего сайта (`regenerateNginx`);
 *  - регенерация глобальных rate-limit zones при create/delete.
 */

import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import {
  stringifySiteAliases,
  parseSiteAliases,
  aliasDomains,
} from '../common/json-array';
import { SslStatus } from '../common/enums';
import {
  buildMultiDomainNginxPayload,
  serializeSiteDomain,
  nginxZoneName,
  type RawSiteForNginx,
} from './site-domains.helper';
import {
  CreateSiteDomainDto,
  UpdateSiteDomainDto,
  UpdateSiteDomainAliasesDto,
} from './site-domains.dto';

/** include-фрагмент: домены сайта с их SSL-сертификатами, отсортированные. */
const DOMAINS_WITH_SSL = {
  domains: {
    orderBy: { position: 'asc' as const },
    include: { sslCertificate: true },
  },
} satisfies Prisma.SiteInclude;

@Injectable()
export class SiteDomainsService {
  private readonly logger = new Logger('SiteDomainsService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
  ) {}

  // ===========================================================================
  // Чтение
  // ===========================================================================

  /** Загружает сайт с доменами + проверяет доступ. */
  private async requireSiteWithDomains(siteId: string, userId: string, role: string) {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      include: DOMAINS_WITH_SSL,
    });
    if (!site) throw new NotFoundException('Site not found');
    if (role !== 'ADMIN' && site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    return site;
  }

  async listDomains(siteId: string, userId: string, role: string) {
    const site = await this.requireSiteWithDomains(siteId, userId, role);
    return site.domains.map((d) =>
      serializeSiteDomain({ ...d, siteId: site.id }),
    );
  }

  // ===========================================================================
  // Создание неглавного домена
  // ===========================================================================

  async createDomain(
    siteId: string,
    dto: CreateSiteDomainDto,
    userId: string,
    role: string,
  ) {
    const site = await this.requireSiteWithDomains(siteId, userId, role);
    const domain = dto.domain.trim().toLowerCase();

    await this.assertDomainFree(domain, null);
    await this.ensureDomainFreeInNginx([domain]);

    const maxPosition = site.domains.reduce((m, d) => Math.max(m, d.position), 0);

    await this.prisma.siteDomain.create({
      data: {
        siteId: site.id,
        domain,
        isPrimary: false,
        position: maxPosition + 1,
        aliases: '[]',
        httpsRedirect: true,
      },
    });

    await this.syncPrimaryMirror(site.id);
    await this.regenerateNginx(site.id);
    await this.regenerateGlobalZones();

    this.logger.log(`Domain "${domain}" added to site "${site.name}"`);
    return this.listDomains(site.id, userId, role);
  }

  // ===========================================================================
  // Обновление домена
  // ===========================================================================

  async updateDomain(
    siteId: string,
    domainId: string,
    dto: UpdateSiteDomainDto,
    userId: string,
    role: string,
  ) {
    const site = await this.requireSiteWithDomains(siteId, userId, role);
    const target = site.domains.find((d) => d.id === domainId);
    if (!target) throw new NotFoundException('Domain not found');

    const data: Prisma.SiteDomainUpdateInput = {};
    let domainChanged = false;
    let newDomain = target.domain;

    if (dto.domain !== undefined) {
      newDomain = dto.domain.trim().toLowerCase();
      if (newDomain !== target.domain) {
        await this.assertDomainFree(newDomain, domainId);
        await this.ensureDomainFreeInNginx([newDomain], target.domain);
        data.domain = newDomain;
        domainChanged = true;
      }
    }

    if (dto.appPort !== undefined) {
      data.appPort = dto.appPort ?? null;
    }
    if (dto.httpsRedirect !== undefined) {
      data.httpsRedirect = !!dto.httpsRedirect;
    }

    // filesRelPath: для ГЛАВНОГО домена пишем в Site.filesRelPath (общий
    // дефолт сайта), сам SiteDomain.filesRelPath держим null. Для неглавного —
    // пишем в собственный SiteDomain.filesRelPath.
    if (dto.filesRelPath !== undefined) {
      const rel = dto.filesRelPath === null ? null : dto.filesRelPath.trim() || null;
      if (target.isPrimary) {
        await this.prisma.site.update({
          where: { id: site.id },
          data: { filesRelPath: rel || 'www' },
        });
        data.filesRelPath = null;
      } else {
        data.filesRelPath = rel;
      }
    }

    await this.prisma.siteDomain.update({ where: { id: domainId }, data });

    // Смена домена → сброс его SSL-серта (выпущен на старый CN). Файлы серта
    // на диске не трогаем (как и при смене главного домена сайта раньше).
    if (domainChanged) {
      await this.prisma.sslCertificate.updateMany({
        where: { domainId, status: { not: SslStatus.NONE } },
        data: {
          status: SslStatus.NONE,
          certPath: null,
          keyPath: null,
          issuedAt: null,
          expiresAt: null,
          daysRemaining: null,
          issuer: '',
        },
      });
      this.logger.log(`SSL reset for domain ${domainId} after domain change`);
    }

    await this.syncPrimaryMirror(site.id);
    await this.regenerateNginx(site.id);

    return this.listDomains(site.id, userId, role);
  }

  // ===========================================================================
  // Удаление домена
  // ===========================================================================

  async deleteDomain(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
  ) {
    const site = await this.requireSiteWithDomains(siteId, userId, role);
    const target = site.domains.find((d) => d.id === domainId);
    if (!target) throw new NotFoundException('Domain not found');

    if (site.domains.length <= 1) {
      throw new ConflictException(
        'Нельзя удалить единственный домен сайта. Сначала добавьте другой домен.',
      );
    }
    if (target.isPrimary) {
      throw new ConflictException(
        'Нельзя удалить главный домен. Сначала назначьте главным другой домен (make-primary).',
      );
    }

    // Best-effort revoke SSL домена на агенте.
    if (
      target.sslCertificate &&
      target.sslCertificate.status !== SslStatus.NONE &&
      this.agentRelay.isAgentConnected()
    ) {
      await this.agentRelay
        .emitToAgent('ssl:revoke', { domain: target.domain }, 90_000)
        .catch((err) =>
          this.logger.warn(
            `ssl:revoke failed for ${target.domain}: ${(err as Error).message}`,
          ),
        );
    }

    // SslCertificate каскадно удалится по FK domainId → SiteDomain.
    await this.prisma.siteDomain.delete({ where: { id: domainId } });

    // Перенумеровываем позиции оставшихся доменов.
    await this.renumberPositions(site.id);
    await this.syncPrimaryMirror(site.id);
    await this.regenerateNginx(site.id);
    await this.regenerateGlobalZones();

    this.logger.log(`Domain "${target.domain}" removed from site "${site.name}"`);
    return this.listDomains(site.id, userId, role);
  }

  // ===========================================================================
  // Назначить главным
  // ===========================================================================

  async makePrimary(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
  ) {
    const site = await this.requireSiteWithDomains(siteId, userId, role);
    const target = site.domains.find((d) => d.id === domainId);
    if (!target) throw new NotFoundException('Domain not found');

    if (target.isPrimary) {
      // Уже главный — ничего не делаем, отдаём текущий список.
      return this.listDomains(site.id, userId, role);
    }

    // Новый порядок: target → position 0, остальные по текущему порядку.
    const rest = site.domains
      .filter((d) => d.id !== domainId)
      .sort((a, b) => a.position - b.position);

    await this.prisma.$transaction([
      this.prisma.siteDomain.update({
        where: { id: domainId },
        data: { isPrimary: true, position: 0 },
      }),
      ...rest.map((d, idx) =>
        this.prisma.siteDomain.update({
          where: { id: d.id },
          data: { isPrimary: false, position: idx + 1 },
        }),
      ),
    ]);

    await this.syncPrimaryMirror(site.id);
    await this.regenerateNginx(site.id);

    this.logger.log(`Primary domain of site "${site.name}" → "${target.domain}"`);
    return this.listDomains(site.id, userId, role);
  }

  // ===========================================================================
  // Алиасы домена
  // ===========================================================================

  async updateAliases(
    siteId: string,
    domainId: string,
    dto: UpdateSiteDomainAliasesDto,
    userId: string,
    role: string,
  ) {
    const site = await this.requireSiteWithDomains(siteId, userId, role);
    const target = site.domains.find((d) => d.id === domainId);
    if (!target) throw new NotFoundException('Domain not found');

    const requested = aliasDomains(dto.aliases).map((d) => d.toLowerCase());
    if (requested.length > 64) {
      throw new BadRequestException('Максимум 64 алиаса на домен');
    }

    // Конфликт каждого алиаса с любым другим основным доменом / алиасом.
    for (const ad of requested) {
      await this.assertDomainFree(ad, domainId, target.domain);
    }
    // nginx-level — только реально новые алиасы.
    const oldAliases = new Set(parseSiteAliases(target.aliases).map((a) => a.domain.toLowerCase()));
    const newAliasDomains = requested.filter((d) => !oldAliases.has(d));
    if (newAliasDomains.length > 0) {
      await this.ensureDomainFreeInNginx(newAliasDomains, target.domain);
    }

    await this.prisma.siteDomain.update({
      where: { id: domainId },
      data: { aliases: stringifySiteAliases(dto.aliases) },
    });

    await this.syncPrimaryMirror(site.id);
    await this.regenerateNginx(site.id);

    return this.listDomains(site.id, userId, role);
  }

  // ===========================================================================
  // Внутренние операции
  // ===========================================================================

  /**
   * Re-sync зеркала Site (`domain`, `aliases`, `appPort`) из главного домена.
   * Вызывается после ЛЮБОГО изменения доменов.
   */
  async syncPrimaryMirror(siteId: string): Promise<void> {
    const primary = await this.prisma.siteDomain.findFirst({
      where: { siteId, isPrimary: true },
    });
    if (!primary) {
      this.logger.error(`Site ${siteId} has no primary domain — mirror not synced`);
      return;
    }
    await this.prisma.site.update({
      where: { id: siteId },
      data: {
        domain: primary.domain,
        aliases: primary.aliases,
        appPort: primary.appPort,
      },
    });
  }

  /** Перенумеровывает position доменов сайта (главный=0, остальные по порядку). */
  private async renumberPositions(siteId: string): Promise<void> {
    const domains = await this.prisma.siteDomain.findMany({
      where: { siteId },
      orderBy: [{ isPrimary: 'desc' }, { position: 'asc' }],
    });
    await this.prisma.$transaction(
      domains.map((d, idx) =>
        this.prisma.siteDomain.update({
          where: { id: d.id },
          data: { position: idx },
        }),
      ),
    );
  }

  /**
   * Регенерирует nginx-конфиг всего сайта (все домены) через
   * `nginx:create-config` с мульти-доменным payload.
   */
  async regenerateNginx(siteId: string): Promise<void> {
    if (!this.agentRelay.isAgentConnected()) {
      this.logger.warn(`Agent offline — nginx not regenerated for site ${siteId}`);
      return;
    }
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      include: DOMAINS_WITH_SSL,
    });
    if (!site) return;
    try {
      await this.agentRelay.emitToAgent(
        'nginx:create-config',
        buildMultiDomainNginxPayload(site as unknown as RawSiteForNginx),
      );
    } catch (err) {
      this.logger.warn(
        `nginx:create-config failed for site ${siteId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Перегенерирует глобальный zones-файл: один `limit_req_zone` на каждый
   * `SiteDomain` среди ВСЕХ сайтов.
   */
  async regenerateGlobalZones(): Promise<void> {
    if (!this.agentRelay.isAgentConnected()) return;
    try {
      const domains = await this.prisma.siteDomain.findMany({
        select: {
          id: true,
          nginxRateLimitEnabled: true,
          nginxRateLimitRps: true,
        },
      });
      const zones = domains.map((d) => ({
        zoneName: nginxZoneName(d.id),
        rps: d.nginxRateLimitRps && d.nginxRateLimitRps > 0 ? d.nginxRateLimitRps : 30,
        enabled: d.nginxRateLimitEnabled !== false,
      }));
      await this.agentRelay.emitToAgent('nginx:write-global-zones', { zones });
    } catch (err) {
      this.logger.warn(`regenerateGlobalZones: ${(err as Error).message}`);
    }
  }

  /**
   * Проверяет, что `domain` не занят никаким другим основным доменом или
   * алиасом во ВСЕЙ БД. `ignoreDomainId` — исключить текущий домен из проверки.
   * `ownDomain` — собственный домен записи (его алиасы не считаем конфликтом).
   */
  private async assertDomainFree(
    domain: string,
    ignoreDomainId: string | null,
    ownDomain?: string,
  ): Promise<void> {
    if (ownDomain && domain === ownDomain.toLowerCase()) return;

    // Конфликт с основным доменом.
    const asPrimary = await this.prisma.siteDomain.findFirst({
      where: {
        domain,
        ...(ignoreDomainId ? { id: { not: ignoreDomainId } } : {}),
      },
      include: { site: { select: { name: true } } },
    });
    if (asPrimary) {
      throw new ConflictException(
        `Домен "${domain}" уже используется сайтом "${asPrimary.site.name}"`,
      );
    }

    // Конфликт с алиасом другого домена (substring-поиск в JSON).
    const asAlias = await this.prisma.siteDomain.findFirst({
      where: {
        aliases: { contains: `"domain":"${domain}"` },
        ...(ignoreDomainId ? { id: { not: ignoreDomainId } } : {}),
      },
      include: { site: { select: { name: true } } },
    });
    if (asAlias) {
      throw new ConflictException(
        `Домен "${domain}" уже используется как алиас сайта "${asAlias.site.name}"`,
      );
    }
  }

  /**
   * nginx-level проверка: домен не обслуживается чужим конфигом вне meowbox.
   */
  private async ensureDomainFreeInNginx(
    domains: string[],
    ignoreOwnDomain?: string,
  ): Promise<void> {
    if (!this.agentRelay.isAgentConnected()) return;
    const ignoreFiles = new Set<string>();
    if (ignoreOwnDomain) {
      ignoreFiles.add(`${ignoreOwnDomain}.conf`);
      ignoreFiles.add(ignoreOwnDomain);
    }
    for (const d of domains) {
      ignoreFiles.add(`${d}.conf`);
      ignoreFiles.add(d);
      let resp;
      try {
        resp = await this.agentRelay.emitToAgent<{
          hits: Array<{ file: string; line: string }>;
        }>('nginx:find-domain-usage', { domain: d }, 15_000);
      } catch {
        continue;
      }
      const hits = resp.data?.hits || [];
      const external = hits.filter((h) => !ignoreFiles.has(h.file));
      if (external.length > 0) {
        const files = external.map((h) => h.file).join(', ');
        throw new ConflictException(
          `Домен "${d}" уже обслуживается nginx-конфигом: ${files}. ` +
            `Удали/перенастрой этот конфиг вручную перед добавлением домена в meowbox.`,
        );
      }
    }
  }

  // ===========================================================================
  // Bulk rebuild — все домены всех сайтов
  // ===========================================================================

  async rebuildAll(role: string): Promise<{
    total: number;
    ok: number;
    failed: number;
    details: Array<{ siteName: string; status: 'ok' | 'failed'; error?: string }>;
  }> {
    if (role !== 'ADMIN') {
      throw new ForbiddenException('Only ADMIN can rebuild all nginx configs');
    }
    if (!this.agentRelay.isAgentConnected()) {
      throw new InternalServerErrorException('Агент не подключён');
    }
    const sites = await this.prisma.site.findMany({ include: DOMAINS_WITH_SSL });
    const details: Array<{ siteName: string; status: 'ok' | 'failed'; error?: string }> = [];
    let ok = 0;
    let failed = 0;
    for (const site of sites) {
      try {
        const r = await this.agentRelay.emitToAgent(
          'nginx:create-config',
          buildMultiDomainNginxPayload(site as unknown as RawSiteForNginx, {
            forceWriteCustom: site.domains.some((d) => !!d.nginxCustomConfig),
          }),
        );
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
    // Глобальные zones — на основе всех доменов.
    await this.regenerateGlobalZones();
    this.logger.log(`Bulk nginx rebuild: total=${sites.length}, ok=${ok}, failed=${failed}`);
    return { total: sites.length, ok, failed, details };
  }
}
