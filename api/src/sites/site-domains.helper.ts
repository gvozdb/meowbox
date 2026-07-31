/**
 * Хелперы для мульти-доменной модели (`SiteDomain`).
 *
 * Один Site = N основных доменов (`SiteDomain`). Ровно один помечен
 * `isPrimary=true` (главный, position=0). Приложение и runtime принадлежат
 * непосредственно SiteDomain.
 *
 * Здесь сосредоточены:
 *  - `nginxZoneName` — имя rate-limit zone (одно на SiteDomain);
 *  - `buildMultiDomainNginxPayload` — payload для socket-события
 *    `nginx:create-config` (регенерирует весь сайт со всеми доменами);
 *  - `serializeSiteDomain` — нормализация SiteDomain в shared-форму для REST;
 *  - `resolveDomainFilesRelPath` — валидация обязательного web-root домена.
 */

import {
  siteNginxOverrides,
  nginxZoneName,
  type SiteNginxOverrides,
} from '@meowbox/shared';
import {
  parseJsonObject,
  parseSiteAliases,
  parseStringArray,
  type SiteAliasParsed,
} from '../common/json-array';
import { SslStatus } from '../common/enums';

// Имя rate-limit зоны домена — единая реализация в @meowbox/shared
// (используется агентом при рендере и миграцией nginx-multi-domain-rebuild).
export { nginxZoneName };

/** Возвращает обязательный явный web-root домена. */
export function resolveDomainFilesRelPath(
  domainFilesRelPath: string | null | undefined,
  _siteFilesRelPath?: string | null,
): string {
  const own = domainFilesRelPath?.trim();
  if (own) return own;
  throw new Error('SiteDomain.filesRelPath is required');
}

// ---------------------------------------------------------------------------
// Сырые типы Prisma-выборок (без strict-привязки к модели).
// ---------------------------------------------------------------------------

export interface RawSslCertificate {
  status: string;
  certPath: string | null;
  keyPath: string | null;
}

export function isNginxUsableSsl(ssl: RawSslCertificate | null | undefined): boolean {
  return !!(
    ssl &&
    (ssl.status === SslStatus.ACTIVE ||
      ssl.status === SslStatus.EXPIRING_SOON ||
      ssl.status === SslStatus.EXPIRED) &&
    ssl.certPath &&
    ssl.keyPath
  );
}

export interface RawSiteDomain {
  id: string;
  domain: string;
  isPrimary: boolean;
  position: number;
  aliases: string;
  preset: string;
  appStatus: string;
  appErrorMessage?: string | null;
  filesRelPath: string;
  phpVersion: string | null;
  phpPoolCustom?: string | null;
  runtimeKey: string;
  gitRepository?: string | null;
  deployBranch?: string | null;
  envVars?: string;
  cmsAdminUser?: string | null;
  cmsAdminPasswordEnc?: string | null;
  managerPath?: string | null;
  connectorsPath?: string | null;
  cmsTablePrefix?: string | null;
  modxVersion?: string | null;
  appPort: number | null;
  httpsRedirect: boolean;
  nginxClientMaxBodySize?: string | null;
  nginxFastcgiReadTimeout?: number | null;
  nginxFastcgiSendTimeout?: number | null;
  nginxFastcgiConnectTimeout?: number | null;
  nginxFastcgiBufferSizeKb?: number | null;
  nginxFastcgiBufferCount?: number | null;
  nginxHttp2?: boolean | null;
  nginxHsts?: boolean | null;
  nginxGzip?: boolean | null;
  nginxRateLimitEnabled?: boolean | null;
  nginxRateLimitRps?: number | null;
  nginxRateLimitBurst?: number | null;
  nginxCustomConfig?: string | null;
  sslCertificate?: RawSslCertificate | null;
}

export interface RawSiteForNginx {
  name: string;
  rootPath: string;
  systemUser: string | null;
  domains: RawSiteDomain[];
}

/**
 * Один элемент массива `domains` в payload `nginx:create-config`.
 */
export interface NginxDomainEntry {
  domainId: string;
  domain: string;
  isPrimary: boolean;
  aliases: SiteAliasParsed[];
  filesRelPath: string;
  preset: string;
  phpVersion: string | null;
  runtimeKey: string;
  appPort: number | null;
  sslEnabled: boolean;
  certPath: string | null;
  keyPath: string | null;
  httpsRedirect: boolean;
  zoneName: string;
  settings: SiteNginxOverrides;
  customConfig: string | null;
  forceWriteCustom?: boolean;
}

/**
 * Собирает payload для `nginx:create-config` (регенерация всего сайта со
 * всеми основными доменами). Агент перезаписывает server-блоки идемпотентно.
 *
 * `forceWriteCustom` — если true, агент перезапишет 95-custom.conf даже если
 * он уже есть на диске (нужно для bulk-rebuild / первой установки).
 */
export function buildMultiDomainNginxPayload(
  site: RawSiteForNginx,
  opts: { forceWriteCustom?: boolean } = {},
): Record<string, unknown> {
  const domains: NginxDomainEntry[] = site.domains
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((d) => {
      const ssl = d.sslCertificate;
      const sslActive = isNginxUsableSsl(ssl);
      return {
        domainId: d.id,
        domain: d.domain,
        isPrimary: d.isPrimary,
        aliases: parseSiteAliases(d.aliases),
        filesRelPath: resolveDomainFilesRelPath(d.filesRelPath),
        preset: d.preset,
        phpVersion: d.phpVersion,
        runtimeKey: d.runtimeKey,
        appPort: d.appPort ?? null,
        sslEnabled: sslActive,
        certPath: sslActive ? ssl!.certPath : null,
        keyPath: sslActive ? ssl!.keyPath : null,
        httpsRedirect: d.httpsRedirect,
        zoneName: nginxZoneName(d.id),
        settings: siteNginxOverrides(d),
        customConfig: d.nginxCustomConfig ?? null,
        ...(opts.forceWriteCustom ? { forceWriteCustom: true } : {}),
      };
    });

  return {
    siteName: site.name,
    rootPath: site.rootPath,
    systemUser: site.systemUser ?? undefined,
    domains,
  };
}

/**
 * Нормализует запись `SiteDomain` (Prisma) в shared-форму `SiteDomain`
 * для REST-ответов. Алиасы парсятся из JSON-строки; sslCertificate
 * сериализуется отдельно (через serializeSslCertificate).
 */
export function serializeSiteDomain(
  d: RawSiteDomain & {
    siteId?: string;
    createdAt?: Date | string;
    updatedAt?: Date | string;
  },
): Record<string, unknown> {
  return {
    id: d.id,
    siteId: (d as { siteId?: string }).siteId,
    domain: d.domain,
    isPrimary: d.isPrimary,
    position: d.position,
    aliases: parseSiteAliases(d.aliases),
    preset: d.preset,
    appStatus: d.appStatus,
    appErrorMessage: d.appErrorMessage ?? null,
    filesRelPath: d.filesRelPath,
    phpVersion: d.phpVersion,
    runtimeKey: d.runtimeKey,
    gitRepository: d.gitRepository ?? null,
    deployBranch: d.deployBranch ?? null,
    envVars: parseJsonObject(d.envVars, {}),
    cmsAdminUser: d.cmsAdminUser ?? null,
    hasCmsAdminPassword: !!(
      d as RawSiteDomain & { cmsAdminPasswordEnc?: string | null }
    ).cmsAdminPasswordEnc,
    managerPath: d.managerPath ?? null,
    connectorsPath: d.connectorsPath ?? null,
    cmsTablePrefix: d.cmsTablePrefix ?? null,
    modxVersion: d.modxVersion ?? null,
    httpsRedirect: d.httpsRedirect,
    sslCertificate: d.sslCertificate
      ? serializeSslCertificate(d.sslCertificate)
      : null,
    createdAt: (d as { createdAt?: Date | string }).createdAt,
    updatedAt: (d as { updatedAt?: Date | string }).updatedAt,
  };
}

/** Нормализует SslCertificate (Prisma) — поле `domains` JSON → string[]. */
export function serializeSslCertificate(
  ssl: unknown,
): Record<string, unknown> | null {
  if (!ssl || typeof ssl !== 'object') return null;
  const s = ssl as Record<string, unknown>;
  return {
    ...s,
    domains: Array.isArray(s.domains)
      ? s.domains
      : parseStringArray(typeof s.domains === 'string' ? s.domains : undefined),
  };
}
