import * as net from 'net';
import * as dns from 'dns/promises';
import type { LookupAddress } from 'dns';

/**
 * Защита от SSRF при обращениях к admin-controlled URL'ам (например, поле
 * `apiBaseUrl` у DNS-провайдера VK Cloud, или endpoint из Keystone catalog).
 *
 * Запрещённые цели:
 *  - не https-схема (file://, http:// для прода, gopher:// и т.п.);
 *  - loopback (127.0.0.0/8, ::1);
 *  - link-local (169.254.0.0/16, fe80::/10) — особенно опасно: AWS/Yandex/VK
 *    cloud-instance metadata висит на 169.254.169.254;
 *  - private RFC1918 (10/8, 172.16/12, 192.168/16);
 *  - CGNAT 100.64.0.0/10;
 *  - 0.0.0.0/8.
 *
 * Резолв hostname → IP делается через node:dns, чтобы атакующий не мог обойти
 * проверку через DNS-rebinding на момент валидации (мы проверяем тот же IP,
 * что fetch будет использовать чуть позже — короткое окно, но допустимое).
 */

export class UrlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlGuardError';
  }
}

const ALLOWED_PROTOCOLS = new Set(['https:']);

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true; // некорректный → блок
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (METADATA!)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark 198.18/15
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  // ::ffff:V4 IPv4-mapped
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice(7);
    if (net.isIPv4(v4)) return isPrivateIPv4(v4);
  }
  // 2002::/16 6to4 → проверим встроенный IPv4
  if (lower.startsWith('2002:')) {
    const parts = lower.split(':');
    if (parts.length >= 3) {
      const hexA = parts[1].padStart(4, '0');
      const hexB = parts[2].padStart(4, '0');
      const v4 = `${parseInt(hexA.slice(0, 2), 16)}.${parseInt(hexA.slice(2, 4), 16)}.${parseInt(hexB.slice(0, 2), 16)}.${parseInt(hexB.slice(2, 4), 16)}`;
      if (isPrivateIPv4(v4)) return true;
    }
  }
  // 64:ff9b::/96 NAT64
  if (lower.startsWith('64:ff9b:')) return false; // публичные
  // fc00::/7 unique-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // fe80::/10 link-local — первые 10 бит = 1111 1110 10 → fe80–febf
  const firstHex = parseInt(lower.split(':')[0] || '0', 16);
  if ((firstHex & 0xffc0) === 0xfe80) return true;
  return false;
}

/**
 * Бросает UrlGuardError если URL ведёт на запрещённую цель.
 * Резолвит hostname → IP через DNS и проверяет каждый адрес.
 */
export async function assertSafeExternalUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UrlGuardError('Некорректный URL');
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new UrlGuardError(`Разрешён только https; получено ${url.protocol}`);
  }
  const host = url.hostname;
  if (!host) throw new UrlGuardError('URL без хоста');

  // Если host — уже IP, проверяем напрямую без DNS-резолва.
  if (net.isIP(host)) {
    if (net.isIPv4(host) && isPrivateIPv4(host)) {
      throw new UrlGuardError(`Запрещённый IP: ${host}`);
    }
    if (net.isIPv6(host) && isPrivateIPv6(host)) {
      throw new UrlGuardError(`Запрещённый IPv6: ${host}`);
    }
    return;
  }

  // Резолвим всё семейство адресов и проверяем каждый.
  let resolved: LookupAddress[];
  try {
    resolved = await dns.lookup(host, { all: true });
  } catch (err) {
    throw new UrlGuardError(`DNS lookup failed: ${(err as Error).message}`);
  }
  for (const a of resolved) {
    if (a.family === 4 && isPrivateIPv4(a.address)) {
      throw new UrlGuardError(`Хост ${host} резолвится в приватный IP ${a.address}`);
    }
    if (a.family === 6 && isPrivateIPv6(a.address)) {
      throw new UrlGuardError(`Хост ${host} резолвится в приватный IPv6 ${a.address}`);
    }
  }
}
