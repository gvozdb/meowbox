/**
 * Хелперы для мульти-доменной модели (`SiteDomain`).
 *
 * Один Site = N основных доменов (`SiteDomain`). Ровно один помечен
 * `isPrimary=true` (главный, position=0). Site.domain / Site.aliases /
 * Site.appPort — зеркало главного домена (обратная совместимость).
 *
 * Здесь сосредоточены:
 *  - `nginxZoneName` — имя rate-limit zone (одно на SiteDomain);
 *  - `buildMultiDomainNginxPayload` — payload для socket-события
 *    `nginx:create-config` (регенерирует весь сайт со всеми доменами);
 *  - `serializeSiteDomain` — нормализация SiteDomain в shared-форму для REST;
 *  - `resolveDomainFilesRelPath` — резолв web-root (domain || site default).
 */

import {
  siteNginxOverrides,
  nginxZoneName,
  type SiteNginxOverrides,
} from '@meowbox/shared';
import { parseSiteAliases, parseStringArray, type SiteAliasParsed } from '../common/json-array';
import { SslStatus } from '../common/enums';

// Имя rate-limit зоны домена — единая реализация в @meowbox/shared
// (используется агентом при рендере и миграцией nginx-multi-domain-rebuild).
export { nginxZoneName };

/** Резолвит web-root домена: собственный `filesRelPath` или дефолт сайта. */
export function resolveDomainFilesRelPath(
  domainFilesRelPath: string | null | undefined,
  siteFilesRelPath: string | null | undefined,
): string {
  const own = domainFilesRelPath?.trim();
  if (own) return own;
  return (siteFilesRelPath?.trim()) || 'www';
}

// ---------------------------------------------------------------------------
// Сырые типы Prisma-выборок (без strict-привязки к модели).
// ---------------------------------------------------------------------------

export interface RawSslCertificate {
  status: string;
  certPath: string | null;
  keyPath: string | null;
}

export interface RawSiteDomain {
  id: string;
  domain: string;
  isPrimary: boolean;
  position: number;
  aliases: string;
  filesRelPath: string | null;
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
  type: string;
  rootPath: string;
  filesRelPath: string | null;
  phpVersion: string | null;
  systemUser: string | null;
  domains: RawSiteDomain[];
}

/**
 * Один элемент массива `domains` в payload `nginx:create-config`.
 */
export interface NginxDomainEntry {
  domainId: string;
  domain: string;
  aliases: SiteAliasParsed[];
  filesRelPath: string;
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
  const phpEnabled = !!site.phpVersion;
  const domains: NginxDomainEntry[] = site.domains
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((d) => {
      const ssl = d.sslCertificate;
      const sslActive = !!(
        ssl &&
        ssl.status === SslStatus.ACTIVE &&
        ssl.certPath &&
        ssl.keyPath
      );
      return {
        domainId: d.id,
        domain: d.domain,
        aliases: parseSiteAliases(d.aliases),
        filesRelPath: resolveDomainFilesRelPath(d.filesRelPath, site.filesRelPath),
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
    phpEnabled,
    phpVersion: site.phpVersion ?? undefined,
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
    filesRelPath: d.filesRelPath,
    appPort: d.appPort ?? null,
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
