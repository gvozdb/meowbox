import {
  BadGatewayException, BadRequestException, Injectable, Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import {
  assertCredentialKeyConfigured, decryptJson, encryptJson,
} from '../common/crypto/credentials-cipher';
import {
  ApplyTemplateDto, CreateProviderDto, CreateRecordDto, UpdateRecordDto,
} from './dns.dto';
import { getProvider } from './providers/provider-factory';
import { evictYandexTokenCache, evictYandexUrlGuardCache } from './providers/yandex-cloud.provider';
import { evictVkTokenCache } from './providers/vk-cloud.provider';
import { evictAllCloudflareZoneCache } from './providers/cloudflare.provider';
import {
  evictYandex360UrlGuardCache, exchangeAuthCodeY360, Y360Credentials,
} from './providers/yandex-360.provider';
import {
  DnsProviderContext, DnsProviderType,
} from './providers/dns-provider.interface';
import {
  getMailTemplate, MailTemplate, MailTemplateExtras,
} from './templates/mail-templates';

export interface MaskedProviderView {
  id: string;
  type: string;
  label: string;
  scopeId: string | null;
  apiBaseUrl: string | null;
  status: string;
  lastError: string | null;
  lastSyncAt: Date | null;
  zonesCount: number;
  createdAt: Date;
  updatedAt: Date;
  credentialsHint: Record<string, string>;
}

export interface ZoneView {
  id: string;
  accountId: string;
  accountLabel: string;
  accountType: string;
  externalId: string;
  domain: string;
  status: string;
  recordsCount: number;
  recordsCachedAt: Date | null;
  /**
   * Все сайты, чей domain или один из aliases попадает под зону:
   *   - host === zone.domain (apex match)
   *   - host endsWith `.${zone.domain}` (subdomain match)
   * Один host может матчить несколько зон (например, blog.example.com матчит и зону
   * example.com, и зону blog.example.com если обе есть). Матчинг динамический —
   * вычисляется при каждом запросе, чтобы не зависеть от ручного "linkedSite".
   */
  matchedSites: Array<{ id: string; name: string; domain: string }>;
  nameservers: string[] | null;
  updatedAt: Date;
}

const RECORD_TYPES = new Set(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA']);

/**
 * Маскирует возможные секрет-substring в произвольной строке (например, в
 * upstream error message, который не должен пройти "сырым" в БД lastError /
 * audit-log / UI). Срабатывает на known patterns:
 *   - PEM-блоки (-----BEGIN ... -----END ...)
 *   - Bearer/Token: <…>
 *   - "secret":"…" / "private_key":"…" в JSON-эхо
 *   - длинные base64-строки (>40 chars)
 */
function redactSecrets(s: string): string {
  if (!s) return s;
  return s
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[REDACTED:PEM]')
    .replace(/(Bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(/("?(?:secret|private_key|password|token|apiToken|api_token|appCredentialSecret)"?\s*[:=]\s*"?)([^"\s,}]{6,})/gi, '$1[REDACTED]')
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '[REDACTED:long-base64]')
    .slice(0, 500); // hard cap, чтобы не раздуть БД на mega-stack-traces
}

@Injectable()
export class DnsService {
  private readonly logger = new Logger(DnsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Providers
  // -------------------------------------------------------------------------

  async listProviders(): Promise<MaskedProviderView[]> {
    const rows = await this.prisma.dnsProviderAccount.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.toProviderView(r));
  }

  async createProvider(dto: CreateProviderDto): Promise<MaskedProviderView> {
    assertCredentialKeyConfigured();
    this.validateProviderInputs(dto);

    // Y360: при создании юзер передаёт {clientId, clientSecret, code}.
    // Меняем code на пару (access_token, refresh_token) ДО валидации/сохранения.
    let credentials: Record<string, unknown> = dto.credentials;
    if (dto.type === 'YANDEX_360') {
      const c = dto.credentials || {};
      const clientId = typeof c.clientId === 'string' ? c.clientId : '';
      const clientSecret = typeof c.clientSecret === 'string' ? c.clientSecret : '';
      const code = typeof c.code === 'string' ? c.code : '';
      try {
        const tokens: Y360Credentials = await exchangeAuthCodeY360(clientId, clientSecret, code);
        credentials = { ...tokens };
      } catch (err) {
        throw new BadRequestException(`Yandex 360: не удалось обменять authorization code на токены: ${(err as Error).message}`);
      }
    }

    const provider = getProvider(dto.type);
    const ctx: DnsProviderContext = {
      credentials,
      scopeId: dto.scopeId,
      apiBaseUrl: dto.apiBaseUrl,
    };
    const valid = await provider.validateCredentials(ctx);
    if (!valid.ok) {
      throw new BadRequestException(`Не удалось подтвердить креды провайдера: ${valid.error || 'unknown error'}`);
    }

    const credentialsEnc = encryptJson(credentials);
    const account = await this.prisma.dnsProviderAccount.create({
      data: {
        type: dto.type,
        label: dto.label.trim(),
        credentialsEnc,
        scopeId: dto.scopeId || null,
        apiBaseUrl: dto.apiBaseUrl || null,
        status: 'ACTIVE',
      },
    });

    // Сразу делаем ПОЛНЫЙ sync (зоны + записи во всех зонах). await — чтобы
    // пользователь сразу увидел всё содержимое после "Подключить".
    try {
      await this.syncProviderFull(account.id);
    } catch (err) {
      this.logger.warn(`Initial sync for new provider ${account.id} failed: ${(err as Error).message}`);
    }

    const fresh = await this.prisma.dnsProviderAccount.findUnique({ where: { id: account.id } });
    return this.toProviderView(fresh!);
  }

  /**
   * Полный sync провайдера: zones + records для всех зон. Используется при
   * первом подключении провайдера и в периодическом cron-задании.
   * Нечувствителен к ошибке refresh отдельной зоны — логирует и идёт дальше.
   */
  async syncProviderFull(accountId: string): Promise<{
    zonesAdded: number; zonesRemoved: number; zonesTotal: number;
    recordsRefreshed: number; recordsFailed: number;
  }> {
    const z = await this.syncZones(accountId);
    const allZones = await this.prisma.dnsZone.findMany({
      where: { accountId },
      select: { id: true, domain: true },
    });
    let recordsRefreshed = 0;
    let recordsFailed = 0;
    for (const zone of allZones) {
      try {
        await this.refreshRecords(zone.id);
        recordsRefreshed++;
      } catch (err) {
        recordsFailed++;
        this.logger.warn(
          `refreshRecords for zone ${zone.id} (${zone.domain}) failed: ${(err as Error).message}`,
        );
      }
    }
    return {
      zonesAdded: z.added, zonesRemoved: z.removed, zonesTotal: z.total,
      recordsRefreshed, recordsFailed,
    };
  }

  /**
   * Cron-task: полный sync ВСЕХ активных провайдеров. Вызывается из SchedulerService.
   * Ошибки одного провайдера не блокируют остальных — все результаты в массиве.
   */
  async syncAllProvidersCron(): Promise<{ accountId: string; ok: boolean; error?: string }[]> {
    const accs = await this.prisma.dnsProviderAccount.findMany({
      where: { status: { in: ['ACTIVE', 'ERROR'] } }, // UNAUTHORIZED — не пробуем, нет смысла
      select: { id: true },
    });
    const out: { accountId: string; ok: boolean; error?: string }[] = [];
    for (const a of accs) {
      try {
        await this.syncProviderFull(a.id);
        out.push({ accountId: a.id, ok: true });
      } catch (err) {
        out.push({ accountId: a.id, ok: false, error: (err as Error).message });
      }
    }
    return out;
  }

  async deleteProvider(id: string): Promise<void> {
    const acc = await this.prisma.dnsProviderAccount.findUnique({ where: { id } });
    if (!acc) throw new NotFoundException('DNS provider not found');
    // Перед удалением чистим in-memory token cache, чтобы атакующий, имеющий
    // доступ к процессу, не получил валидный кэшированный токен после revoke.
    try {
      const creds = decryptJson(acc.credentialsEnc);
      if (acc.type === 'YANDEX_CLOUD') {
        evictYandexTokenCache(creds);
        evictYandexUrlGuardCache(acc.apiBaseUrl);
      } else if (acc.type === 'VK_CLOUD') {
        evictVkTokenCache(creds);
      } else if (acc.type === 'CLOUDFLARE') {
        evictAllCloudflareZoneCache();
      } else if (acc.type === 'YANDEX_360') {
        evictYandex360UrlGuardCache(acc.apiBaseUrl);
      }
    } catch (err) {
      this.logger.warn(`Token cache eviction failed for ${id}: ${(err as Error).message}`);
    }
    // Cascade удалит зоны и записи (CASCADE на FK).
    await this.prisma.dnsProviderAccount.delete({ where: { id } });
  }

  async testProvider(id: string): Promise<{ ok: boolean; error?: string }> {
    const ctx = await this.providerContext(id);
    const provider = getProvider(ctx.type);
    const res = await provider.validateCredentials(ctx.ctx);
    // Обновим статус в БД чтобы UI видел актуальное
    await this.prisma.dnsProviderAccount.update({
      where: { id },
      data: {
        status: res.ok ? 'ACTIVE' : 'UNAUTHORIZED',
        lastError: res.ok ? null : redactSecrets(res.error || 'unknown error'),
      },
    });
    return res;
  }

  async syncZones(accountId: string): Promise<{ added: number; removed: number; total: number }> {
    const ctx = await this.providerContext(accountId);
    const provider = getProvider(ctx.type);
    let zones;
    try {
      zones = await provider.listZones(ctx.ctx);
    } catch (err) {
      const msg = redactSecrets((err as Error).message);
      await this.prisma.dnsProviderAccount.update({
        where: { id: accountId },
        data: { status: 'ERROR', lastError: msg },
      });
      throw new BadGatewayException(`Не удалось получить список зон: ${msg}`);
    }

    const existing = await this.prisma.dnsZone.findMany({
      where: { accountId },
      select: { id: true, externalId: true },
    });
    const existingIds = new Set(existing.map((z) => z.externalId));
    const remoteIds = new Set(zones.map((z) => z.externalId));

    let added = 0;
    for (const z of zones) {
      // Нормализуем domain к lowercase — поле сравнивается в фильтрах и хочется
      // консистентности. Провайдеры обычно отдают lowercase, но не всегда (VK).
      const normalizedDomain = z.domain.trim().toLowerCase();
      const data = {
        accountId,
        externalId: z.externalId,
        domain: normalizedDomain,
        status: z.status || 'ACTIVE',
        nameservers: z.nameservers ? JSON.stringify(z.nameservers) : null,
      };
      const found = await this.prisma.dnsZone.findUnique({
        where: { accountId_externalId: { accountId, externalId: z.externalId } },
      });
      if (!found) {
        await this.prisma.dnsZone.create({ data });
        added++;
      } else {
        await this.prisma.dnsZone.update({
          where: { id: found.id },
          data: {
            domain: normalizedDomain,
            status: z.status || found.status,
            nameservers: z.nameservers ? JSON.stringify(z.nameservers) : found.nameservers,
          },
        });
      }
    }

    // Удаляем зоны, которые исчезли у провайдера. linkedSiteId — записи в site
    // не трогаются (CASCADE цепляет только записи зоны).
    let removed = 0;
    const toRemove = existing.filter((z) => !remoteIds.has(z.externalId));
    if (toRemove.length) {
      const r = await this.prisma.dnsZone.deleteMany({
        where: { id: { in: toRemove.map((z) => z.id) } },
      });
      removed = r.count;
    }

    const total = await this.prisma.dnsZone.count({ where: { accountId } });
    await this.prisma.dnsProviderAccount.update({
      where: { id: accountId },
      data: {
        status: 'ACTIVE',
        lastError: null,
        lastSyncAt: new Date(),
        zonesCount: total,
      },
    });

    // Auto-link новых/переcинканных зон к сайтам по совпадению apex-домена.
    // Не трогаем уже привязанные вручную (linkedSiteId NOT NULL).
    try {
      await this.autoLinkZonesToSites(accountId);
    } catch (err) {
      this.logger.warn(`autoLinkZonesToSites failed for account=${accountId}: ${(err as Error).message}`);
    }

    return { added, removed, total };
  }

  /**
   * @deprecated Связь зона→сайт(ы) теперь вычисляется динамически в
   * `findMatchedSites` по apex+aliases. Метод оставлен no-op чтобы существующие
   * вызовы (createProvider, /relink) не падали. Удалить в следующем релизе.
   */
  async autoLinkZonesToSites(_accountId?: string): Promise<{ linked: number }> {
    return { linked: 0 };
  }

  /**
   * View для вкладки "DNS" на странице сайта.
   *
   * Алгоритм:
   *   1. Берём site.domain + распарсенный site.aliases — это набор host'ов сайта.
   *   2. Перебираем ВСЕ зоны во ВСЕХ провайдерах. Для каждой записи строим FQDN
   *      ("@" → zone.domain, иначе record.name + "." + zone.domain).
   *   3. Если FQDN.toLowerCase() ∈ site_hosts → добавляем запись в группу по host'у.
   *   4. На каждой группе (host) — список { provider, zone, record }, чтобы юзер
   *      видел дубли в разных провайдерах (конфликт делегирования).
   */
  async getSiteDnsView(siteId: string): Promise<{
    site: { id: string; domain: string; aliases: string[] };
    groups: Array<{
      host: string;
      isAlias: boolean;
      entries: Array<{
        provider: { accountId: string; accountLabel: string; accountType: string };
        zone: { id: string; externalId: string; domain: string };
        record: {
          id: string; externalId: string; type: string; name: string;
          content: string; ttl: number; priority: number | null;
          proxied: boolean | null; comment: string | null; updatedAt: Date;
        };
      }>;
    }>;
    zones: Array<{
      provider: { accountId: string; accountLabel: string; accountType: string };
      zone: { id: string; externalId: string; domain: string; recordsCount: number };
      isLinked: boolean;
    }>;
  }> {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { id: true, domain: true, aliases: true },
    });
    if (!site) throw new NotFoundException('Site not found');

    let aliasArr: string[] = [];
    try {
      const parsed = JSON.parse(site.aliases || '[]');
      if (Array.isArray(parsed)) aliasArr = parsed.filter((s) => typeof s === 'string');
    } catch {
      aliasArr = [];
    }

    const apex = site.domain.trim().toLowerCase();
    const aliasSet = new Set(aliasArr.map((a) => a.trim().toLowerCase()).filter(Boolean));
    const allHosts = new Set<string>([apex, ...aliasSet]);

    // Pre-filter: вытаскиваем ТОЛЬКО те зоны, чей apex покрывает один из host'ов
    // сайта. Для site=blog.example.com подходит зона example.com (host endsWith
    // ".example.com"). Также подходят зоны с доменом ровно равным host'у.
    // Это превращает O(всё) в O(зон-сайта × записей-в-них).
    //
    // Почему OR-список вместо `WHERE domain IN (...)`: site=app.dev.example.com
    // должен матчить и dev.example.com и example.com, и obscure-зону app.dev.example.com.
    // Вычисляем все возможные apex-кандидаты для каждого host'а и берём union.
    const candidateApexes = new Set<string>();
    for (const host of allHosts) {
      const parts = host.split('.');
      for (let i = 0; i < parts.length - 1; i++) {
        candidateApexes.add(parts.slice(i).join('.'));
      }
    }

    // domain в БД хранится lowercase (нормализация в syncZones), поэтому
    // strict `WHERE domain IN (...)` отрабатывает по индексу и не тащит лишнее.
    const zones = await this.prisma.dnsZone.findMany({
      where: { domain: { in: Array.from(candidateApexes) } },
      include: {
        account: { select: { id: true, label: true, type: true } },
        records: { orderBy: [{ type: 'asc' }, { name: 'asc' }] },
      },
      orderBy: [{ domain: 'asc' }],
    });

    const groupsMap = new Map<string, {
      host: string; isAlias: boolean;
      entries: Array<{
        provider: { accountId: string; accountLabel: string; accountType: string };
        zone: { id: string; externalId: string; domain: string };
        record: {
          id: string; externalId: string; type: string; name: string;
          content: string; ttl: number; priority: number | null;
          proxied: boolean | null; comment: string | null; updatedAt: Date;
        };
      }>;
    }>();

    // Подзоны: если хост сайта попадает под зону по суффиксу, то это «зона сайта»
    // (даже если apex-имена не совпадают: site=blog.example.com, zone=example.com).
    const matchedZoneIds = new Set<string>();

    for (const z of zones) {
      const zoneDomain = z.domain.trim().toLowerCase();
      // Эта зона может покрывать любой host сайта, заканчивающийся на zoneDomain
      const zoneCovers = [...allHosts].some(
        (h) => h === zoneDomain || h.endsWith(`.${zoneDomain}`),
      );
      if (zoneCovers) matchedZoneIds.add(z.id);

      for (const r of z.records) {
        const recName = r.name.trim();
        // Apex или пустая = host = zoneDomain. Иначе = recName + "." + zoneDomain.
        // zoneDomain уже lowercase (нормализуется в syncZones), recName приводим тут.
        const fqdn =
          recName === '@' || recName === ''
            ? zoneDomain
            : `${recName.toLowerCase()}.${zoneDomain}`;
        if (!allHosts.has(fqdn)) continue;
        const groupKey = fqdn;
        if (!groupsMap.has(groupKey)) {
          groupsMap.set(groupKey, {
            host: fqdn,
            isAlias: fqdn !== apex,
            entries: [],
          });
        }
        groupsMap.get(groupKey)!.entries.push({
          provider: {
            accountId: z.account.id,
            accountLabel: z.account.label,
            accountType: z.account.type,
          },
          zone: { id: z.id, externalId: z.externalId, domain: z.domain },
          record: {
            id: r.id,
            externalId: r.externalId,
            type: r.type,
            name: r.name,
            content: r.content,
            ttl: r.ttl,
            priority: r.priority,
            proxied: r.proxied,
            comment: r.comment,
            updatedAt: r.updatedAt,
          },
        });
      }
    }

    // Список зон, относящихся к сайту (apex или родительских — для UI «зоны сайта»).
    const siteZones = zones
      .filter((z) => matchedZoneIds.has(z.id))
      .map((z) => ({
        provider: {
          accountId: z.account.id,
          accountLabel: z.account.label,
          accountType: z.account.type,
        },
        zone: {
          id: z.id,
          externalId: z.externalId,
          domain: z.domain,
          recordsCount: z.recordsCount,
        },
        // isLinked теперь = "зона действительно покрывает один из host'ов сайта".
        // Раньше тут была проверка ручной single-link (linkedSiteId === siteId),
        // теперь связь динамическая через matchedZoneIds (см. zoneCovers выше).
        isLinked: matchedZoneIds.has(z.id),
      }));

    // Стабильный порядок групп: apex → aliases (по алфавиту).
    const ordered = Array.from(groupsMap.values()).sort((a, b) => {
      if (a.host === apex) return -1;
      if (b.host === apex) return 1;
      return a.host.localeCompare(b.host);
    });

    return {
      site: { id: site.id, domain: site.domain, aliases: aliasArr },
      groups: ordered,
      zones: siteZones,
    };
  }

  // -------------------------------------------------------------------------
  // Zones / Records
  // -------------------------------------------------------------------------

  async listAllZones(filter: { accountId?: string; domain?: string } = {}): Promise<ZoneView[]> {
    const where: { accountId?: string; domain?: { contains: string } } = {};
    if (filter.accountId) where.accountId = filter.accountId;
    if (filter.domain) where.domain = { contains: filter.domain };
    const [rows, allSites] = await Promise.all([
      this.prisma.dnsZone.findMany({
        where,
        include: { account: { select: { id: true, label: true, type: true } } },
        orderBy: { domain: 'asc' },
      }),
      this.prisma.site.findMany({
        select: { id: true, name: true, domain: true, aliases: true },
      }),
    ]);
    return rows.map((z) => ({
      id: z.id,
      accountId: z.accountId,
      accountLabel: z.account.label,
      accountType: z.account.type,
      externalId: z.externalId,
      domain: z.domain,
      status: z.status,
      recordsCount: z.recordsCount,
      recordsCachedAt: z.recordsCachedAt,
      matchedSites: this.findMatchedSites(z.domain, allSites),
      nameservers: z.nameservers ? this.safeParseJsonArray(z.nameservers) : null,
      updatedAt: z.updatedAt,
    }));
  }

  /**
   * Находит все сайты, чей domain или alias попадает под зону.
   * Match: host === zoneDomain ИЛИ host endsWith `.${zoneDomain}`.
   * Сравнение case-insensitive. Aliases парсятся из JSON-строки.
   */
  private findMatchedSites(
    zoneDomain: string,
    sites: Array<{ id: string; name: string; domain: string; aliases: string }>,
  ): Array<{ id: string; name: string; domain: string }> {
    const apex = zoneDomain.trim().toLowerCase();
    if (!apex) return [];
    const out: Array<{ id: string; name: string; domain: string }> = [];
    for (const s of sites) {
      const hosts = new Set<string>();
      const main = s.domain.trim().toLowerCase();
      if (main) hosts.add(main);
      try {
        const arr = JSON.parse(s.aliases || '[]');
        if (Array.isArray(arr)) {
          for (const a of arr) {
            if (typeof a === 'string' && a.trim()) hosts.add(a.trim().toLowerCase());
          }
        }
      } catch { /* ignore broken aliases JSON */ }
      const matched = [...hosts].some((h) => h === apex || h.endsWith(`.${apex}`));
      if (matched) out.push({ id: s.id, name: s.name, domain: s.domain });
    }
    return out;
  }

  async getZone(zoneId: string): Promise<ZoneView & { records: Array<{
    id: string; externalId: string; type: string; name: string; content: string;
    ttl: number; priority: number | null; proxied: boolean | null; comment: string | null;
    updatedAt: Date;
  }> }> {
    const [z, allSites] = await Promise.all([
      this.prisma.dnsZone.findUnique({
        where: { id: zoneId },
        include: {
          account: { select: { id: true, label: true, type: true } },
          records: { orderBy: [{ type: 'asc' }, { name: 'asc' }] },
        },
      }),
      this.prisma.site.findMany({ select: { id: true, name: true, domain: true, aliases: true } }),
    ]);
    if (!z) throw new NotFoundException('DNS zone not found');
    return {
      id: z.id,
      accountId: z.accountId,
      accountLabel: z.account.label,
      accountType: z.account.type,
      externalId: z.externalId,
      domain: z.domain,
      status: z.status,
      recordsCount: z.recordsCount,
      recordsCachedAt: z.recordsCachedAt,
      matchedSites: this.findMatchedSites(z.domain, allSites),
      nameservers: z.nameservers ? this.safeParseJsonArray(z.nameservers) : null,
      updatedAt: z.updatedAt,
      records: z.records.map((r) => ({
        id: r.id,
        externalId: r.externalId,
        type: r.type,
        name: r.name,
        content: r.content,
        ttl: r.ttl,
        priority: r.priority,
        proxied: r.proxied,
        comment: r.comment,
        updatedAt: r.updatedAt,
      })),
    };
  }

  async refreshRecords(zoneId: string): Promise<void> {
    const zone = await this.prisma.dnsZone.findUnique({
      where: { id: zoneId },
      include: { account: true },
    });
    if (!zone) throw new NotFoundException('DNS zone not found');
    const ctx = this.contextFromAccount(zone.account);
    const provider = getProvider(zone.account.type);

    let records;
    try {
      records = await provider.listRecords(ctx, zone.externalId);
    } catch (err) {
      throw new BadGatewayException(`Не удалось получить записи: ${redactSecrets((err as Error).message)}`);
    }

    const existing = await this.prisma.dnsRecord.findMany({
      where: { zoneId },
      select: { id: true, externalId: true },
    });
    const remoteIds = new Set(records.map((r) => r.externalId));

    for (const r of records) {
      const found = await this.prisma.dnsRecord.findUnique({
        where: { zoneId_externalId: { zoneId, externalId: r.externalId } },
      });
      const data = {
        zoneId,
        externalId: r.externalId,
        type: r.type,
        name: r.name,
        content: r.content,
        ttl: r.ttl,
        priority: r.priority ?? null,
        proxied: r.proxied ?? null,
        comment: r.comment ?? null,
      };
      if (found) {
        await this.prisma.dnsRecord.update({ where: { id: found.id }, data });
      } else {
        await this.prisma.dnsRecord.create({ data });
      }
    }

    const toRemove = existing.filter((r) => !remoteIds.has(r.externalId));
    if (toRemove.length) {
      await this.prisma.dnsRecord.deleteMany({ where: { id: { in: toRemove.map((r) => r.id) } } });
    }

    const total = await this.prisma.dnsRecord.count({ where: { zoneId } });
    await this.prisma.dnsZone.update({
      where: { id: zoneId },
      data: { recordsCount: total, recordsCachedAt: new Date() },
    });
  }

  async createRecord(zoneId: string, dto: CreateRecordDto): Promise<{ id: string; externalId: string }> {
    this.validateRecordDto(dto);
    const zone = await this.prisma.dnsZone.findUnique({
      where: { id: zoneId },
      include: { account: true },
    });
    if (!zone) throw new NotFoundException('DNS zone not found');
    const ctx = this.contextFromAccount(zone.account);
    const provider = getProvider(zone.account.type);

    let remote;
    try {
      remote = await provider.createRecord(ctx, zone.externalId, dto);
    } catch (err) {
      throw new BadGatewayException(`Не удалось создать запись: ${redactSecrets((err as Error).message)}`);
    }

    const existing = await this.prisma.dnsRecord.findUnique({
      where: { zoneId_externalId: { zoneId, externalId: remote.externalId } },
    });
    let created;
    if (existing) {
      created = await this.prisma.dnsRecord.update({
        where: { id: existing.id },
        data: {
          type: remote.type,
          name: remote.name,
          content: remote.content,
          ttl: remote.ttl,
          priority: remote.priority ?? null,
          proxied: remote.proxied ?? null,
          comment: remote.comment ?? null,
        },
      });
      // recordsCount не меняем — запись уже существовала
    } else {
      created = await this.prisma.dnsRecord.create({
        data: {
          zoneId,
          externalId: remote.externalId,
          type: remote.type,
          name: remote.name,
          content: remote.content,
          ttl: remote.ttl,
          priority: remote.priority ?? null,
          proxied: remote.proxied ?? null,
          comment: remote.comment ?? null,
        },
      });
      await this.prisma.dnsZone.update({
        where: { id: zoneId },
        data: { recordsCount: { increment: 1 } },
      });
    }
    return { id: created.id, externalId: created.externalId };
  }

  async updateRecord(zoneId: string, recordId: string, dto: UpdateRecordDto): Promise<void> {
    this.validateRecordDto(dto);
    const zone = await this.prisma.dnsZone.findUnique({
      where: { id: zoneId },
      include: { account: true },
    });
    if (!zone) throw new NotFoundException('DNS zone not found');
    const rec = await this.prisma.dnsRecord.findUnique({ where: { id: recordId } });
    if (!rec || rec.zoneId !== zoneId) throw new NotFoundException('DNS record not found');

    const ctx = this.contextFromAccount(zone.account);
    const provider = getProvider(zone.account.type);
    let remote;
    try {
      remote = await provider.updateRecord(ctx, zone.externalId, rec.externalId, dto);
    } catch (err) {
      throw new BadGatewayException(`Не удалось обновить запись: ${redactSecrets((err as Error).message)}`);
    }

    await this.prisma.dnsRecord.update({
      where: { id: recordId },
      data: {
        externalId: remote.externalId,
        type: remote.type,
        name: remote.name,
        content: remote.content,
        ttl: remote.ttl,
        priority: remote.priority ?? null,
        proxied: remote.proxied ?? null,
        comment: remote.comment ?? null,
      },
    });
  }

  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    const zone = await this.prisma.dnsZone.findUnique({
      where: { id: zoneId },
      include: { account: true },
    });
    if (!zone) throw new NotFoundException('DNS zone not found');
    const rec = await this.prisma.dnsRecord.findUnique({ where: { id: recordId } });
    if (!rec || rec.zoneId !== zoneId) throw new NotFoundException('DNS record not found');

    const ctx = this.contextFromAccount(zone.account);
    const provider = getProvider(zone.account.type);
    try {
      // Передаём hint из локального кэша — Yandex использует это для построения
      // deletion (ttl + data), не делая лишний раунд-трип. Для CF/VK ignored.
      await provider.deleteRecord(ctx, zone.externalId, rec.externalId, {
        ttl: rec.ttl,
        content: rec.content,
      });
    } catch (err) {
      throw new BadGatewayException(`Не удалось удалить запись: ${redactSecrets((err as Error).message)}`);
    }
    await this.prisma.dnsRecord.delete({ where: { id: recordId } });
    await this.prisma.dnsZone.update({
      where: { id: zoneId },
      data: { recordsCount: { decrement: 1 } },
    });
  }

  /**
   * @deprecated Multi-site связь теперь вычисляется динамически через
   * `findMatchedSites` (по domain + aliases). Метод оставлен только чтобы
   * существующие fronted-вызовы не падали 404 — но он ничего не делает.
   * Со следующим релизом фронта удалить вместе с эндпоинтом.
   */
  async linkSite(_zoneId: string, _siteId: string | null): Promise<void> {
    // no-op: deprecated single-site link.
  }

  async applyMailTemplate(zoneId: string, dto: ApplyTemplateDto): Promise<{
    created: Array<{ type: string; name: string }>;
    skipped: Array<{ type: string; name: string; reason: string }>;
  }> {
    const zone = await this.prisma.dnsZone.findUnique({
      where: { id: zoneId },
      include: { account: true },
    });
    if (!zone) throw new NotFoundException('DNS zone not found');

    const records = getMailTemplate(dto.template as MailTemplate, (dto.extras || {}) as MailTemplateExtras);
    const ctx = this.contextFromAccount(zone.account);
    const provider = getProvider(zone.account.type);

    // Подтянем актуальный список — чтобы скипать дубликаты по type+name.
    let existing;
    try {
      existing = await provider.listRecords(ctx, zone.externalId);
    } catch (err) {
      throw new BadGatewayException(`Не удалось получить текущие записи: ${redactSecrets((err as Error).message)}`);
    }
    const normalizeName = (n: string) => n.toLowerCase().replace(/\.$/, '');
    const existingKey = (t: string, n: string) => `${t.toUpperCase()}|${normalizeName(n)}`;
    const existingSet = new Set(existing.map((r) => existingKey(r.type, r.name)));

    const created: Array<{ type: string; name: string }> = [];
    const skipped: Array<{ type: string; name: string; reason: string }> = [];

    for (const rec of records) {
      if (existingSet.has(existingKey(rec.type, rec.name))) {
        skipped.push({ type: rec.type, name: rec.name, reason: 'already exists' });
        continue;
      }
      try {
        const remote = await provider.createRecord(ctx, zone.externalId, rec);
        await this.prisma.dnsRecord.upsert({
          where: { zoneId_externalId: { zoneId, externalId: remote.externalId } },
          create: {
            zoneId, externalId: remote.externalId, type: remote.type, name: remote.name,
            content: remote.content, ttl: remote.ttl,
            priority: remote.priority ?? null, proxied: remote.proxied ?? null,
            comment: remote.comment ?? null,
          },
          update: {
            type: remote.type, name: remote.name, content: remote.content, ttl: remote.ttl,
            priority: remote.priority ?? null, proxied: remote.proxied ?? null,
            comment: remote.comment ?? null,
          },
        });
        created.push({ type: rec.type, name: rec.name });
      } catch (err) {
        skipped.push({ type: rec.type, name: rec.name, reason: redactSecrets((err as Error).message) });
      }
    }

    // recordsCount обновим грубо — через refresh (не критично).
    try { await this.refreshRecords(zoneId); } catch { /* ignore */ }
    return { created, skipped };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async providerContext(accountId: string): Promise<{ type: DnsProviderType; ctx: DnsProviderContext }> {
    const acc = await this.prisma.dnsProviderAccount.findUnique({ where: { id: accountId } });
    if (!acc) throw new NotFoundException('DNS provider not found');
    const ctx = this.contextFromAccount(acc);
    return { type: acc.type as DnsProviderType, ctx };
  }

  private contextFromAccount(acc: {
    id: string; type: string; credentialsEnc: string;
    scopeId: string | null; apiBaseUrl: string | null;
  }): DnsProviderContext {
    let credentials: unknown;
    try {
      credentials = decryptJson(acc.credentialsEnc);
    } catch (err) {
      throw new BadRequestException(
        `Не удалось расшифровать креды провайдера. Проверь DNS_CREDENTIAL_KEY: ${(err as Error).message}`,
      );
    }
    return {
      credentials,
      scopeId: acc.scopeId || undefined,
      apiBaseUrl: acc.apiBaseUrl || undefined,
      // Для Y360 (Authorization Code flow) — провайдер вызовет это при auto-refresh
      // access_token. Перезаписываем credentialsEnc в БД, чтобы следующий запрос
      // увидел свежий токен.
      onCredentialsUpdate: async (newCreds) => {
        try {
          const enc = encryptJson(newCreds);
          await this.prisma.dnsProviderAccount.update({
            where: { id: acc.id },
            data: { credentialsEnc: enc },
          });
        } catch (err) {
          this.logger.warn(`onCredentialsUpdate failed for ${acc.id}: ${(err as Error).message}`);
        }
      },
    };
  }

  private toProviderView(r: {
    id: string; type: string; label: string; credentialsEnc: string;
    scopeId: string | null; apiBaseUrl: string | null; status: string;
    lastError: string | null; lastSyncAt: Date | null; zonesCount: number;
    createdAt: Date; updatedAt: Date;
  }): MaskedProviderView {
    let hint: Record<string, string> = {};
    try {
      const creds = decryptJson<Record<string, unknown>>(r.credentialsEnc);
      hint = this.buildCredentialsHint(r.type, creds);
    } catch {
      hint = { _error: 'cannot decrypt' };
    }
    return {
      id: r.id,
      type: r.type,
      label: r.label,
      scopeId: r.scopeId,
      apiBaseUrl: r.apiBaseUrl,
      status: r.status,
      lastError: r.lastError,
      lastSyncAt: r.lastSyncAt,
      zonesCount: r.zonesCount,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      credentialsHint: hint,
    };
  }

  private buildCredentialsHint(type: string, creds: Record<string, unknown>): Record<string, string> {
    // Возвращаем только "что задано" + последние 4 символа (если есть).
    const out: Record<string, string> = {};
    const mask = (val: unknown): string => {
      if (typeof val !== 'string' || !val) return '***';
      if (val.length <= 4) return '***';
      return `***${val.slice(-4)}`;
    };
    if (type === 'CLOUDFLARE') {
      if (creds.apiToken) out.apiToken = mask(creds.apiToken);
    } else if (type === 'YANDEX_CLOUD') {
      const sak = creds.serviceAccountKey as Record<string, unknown> | undefined;
      if (sak) {
        if (sak.id) out.keyId = mask(sak.id);
        if (sak.service_account_id) out.serviceAccountId = mask(sak.service_account_id);
        if (sak.private_key) out.privateKey = '***PEM***';
      }
    } else if (type === 'VK_CLOUD') {
      if (creds.appCredentialId) out.appCredentialId = mask(creds.appCredentialId);
      if (creds.appCredentialSecret) out.appCredentialSecret = '***';
    } else if (type === 'YANDEX_360') {
      if (creds.clientId) out.clientId = mask(creds.clientId);
      if (creds.clientSecret) out.clientSecret = '***';
      if (creds.accessToken) out.accessToken = mask(creds.accessToken);
      if (creds.refreshToken) out.refreshToken = '***';
      if (typeof creds.expiresAt === 'number') {
        const left = Math.max(0, Math.floor((creds.expiresAt - Date.now()) / 1000 / 86400));
        out.tokenExpires = `${left}d`;
      }
    }
    return out;
  }

  private validateProviderInputs(dto: CreateProviderDto): void {
    const c = dto.credentials || {};
    if (dto.type === 'CLOUDFLARE') {
      if (typeof c.apiToken !== 'string' || !c.apiToken) {
        throw new BadRequestException('Cloudflare requires credentials.apiToken');
      }
      if (dto.apiBaseUrl) {
        throw new BadRequestException('Cloudflare не поддерживает кастомный apiBaseUrl');
      }
    } else if (dto.type === 'YANDEX_CLOUD') {
      const sak = c.serviceAccountKey as Record<string, unknown> | undefined;
      if (!sak || typeof sak !== 'object') {
        throw new BadRequestException('Yandex Cloud requires credentials.serviceAccountKey (JSON object)');
      }
      if (typeof sak.id !== 'string' || typeof sak.service_account_id !== 'string' || typeof sak.private_key !== 'string') {
        throw new BadRequestException('serviceAccountKey must include {id, service_account_id, private_key}');
      }
      if (!dto.scopeId) {
        throw new BadRequestException('Yandex Cloud requires scopeId (folderId)');
      }
    } else if (dto.type === 'VK_CLOUD') {
      if (typeof c.appCredentialId !== 'string' || typeof c.appCredentialSecret !== 'string') {
        throw new BadRequestException('VK Cloud requires credentials.appCredentialId and appCredentialSecret');
      }
    } else if (dto.type === 'YANDEX_360') {
      // На момент создания провайдера юзер передаёт OAuth client + одноразовый code.
      // После обмена в createProvider creds превратятся в {clientId, clientSecret,
      // accessToken, refreshToken, expiresAt}. Здесь валидируем только входные поля.
      if (typeof c.clientId !== 'string' || !c.clientId.trim()) {
        throw new BadRequestException('Yandex 360 requires credentials.clientId');
      }
      if (typeof c.clientSecret !== 'string' || !c.clientSecret.trim()) {
        throw new BadRequestException('Yandex 360 requires credentials.clientSecret');
      }
      if (typeof c.code !== 'string' || !c.code.trim()) {
        throw new BadRequestException('Yandex 360 requires credentials.code (authorization code)');
      }
      // scopeId (orgId) для Y360 — ОПЦИОНАЛЬНЫЙ. Если пустой, listZones обходит
      // все доступные юзеру организации (через GET /directory/v1/org). Это нужно
      // когда у юзера несколько орг-ов в Я360.
    }
  }

  private validateRecordDto(dto: CreateRecordDto): void {
    if (!RECORD_TYPES.has(dto.type)) {
      throw new BadRequestException(`Unsupported record type: ${dto.type}`);
    }
    if (dto.ttl !== 1 && dto.ttl < 60) {
      throw new BadRequestException('TTL должен быть >= 60 секунд (или 1 для CF auto)');
    }
    const c = dto.content.trim();
    if (dto.type === 'A') {
      // IPv4
      if (!/^(\d{1,3})(\.\d{1,3}){3}$/.test(c)) {
        throw new BadRequestException('A record content must be IPv4 address');
      }
      const parts = c.split('.').map((n) => parseInt(n, 10));
      if (parts.some((p) => p < 0 || p > 255)) {
        throw new BadRequestException('A record octets must be 0..255');
      }
    } else if (dto.type === 'AAAA') {
      if (!/^[0-9a-fA-F:]+$/.test(c) || c.length < 2) {
        throw new BadRequestException('AAAA record content must be IPv6 address');
      }
    } else if (dto.type === 'CNAME' || dto.type === 'NS') {
      if (!/^[a-zA-Z0-9._-]+$/.test(c) || c.length > 253) {
        throw new BadRequestException(`${dto.type} content must be a hostname`);
      }
    } else if (dto.type === 'MX' || dto.type === 'SRV') {
      if (dto.priority === undefined || dto.priority === null) {
        throw new BadRequestException(`${dto.type} requires priority`);
      }
    }
  }

  private safeParseJsonArray(raw: string): string[] | null {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v;
    } catch { /* ignore */ }
    return null;
  }
}
