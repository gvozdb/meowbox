/**
 * Извлечение client IP с учётом доверенных прокси.
 *
 * Раньше мы слепо читали первый элемент X-Forwarded-For — это позволяло
 * подделывать IP при brute-force/лимитах. Теперь:
 *
 *   1) Если `TRUSTED_PROXY_IPS` env пуст — игнорируем XFF полностью
 *      и возвращаем прямой remoteAddress. Это безопасный default, когда
 *      API выставляется напрямую без reverse-proxy или с localhost-only
 *      bind.
 *   2) Если TRUSTED_PROXY_IPS задан (comma-separated, IP литералы) —
 *      доверяем XFF только когда запрос пришёл с этого IP. В XFF берём
 *      ПОСЛЕДНИЙ untrusted IP, чтобы клиент не мог подделать, дописав
 *      свой собственный первым в списке.
 */

import type { Request } from 'express';

interface RequestLike {
  headers: Request['headers'];
  ip?: string;
  socket?: { remoteAddress?: string };
}

const FALLBACK = '0.0.0.0';

function getTrustedProxies(): Set<string> {
  const raw = process.env.TRUSTED_PROXY_IPS || '';
  const set = new Set<string>();
  for (const part of raw.split(',')) {
    const p = part.trim();
    if (p) set.add(p);
  }
  return set;
}

function normalize(ip: string | undefined | null): string {
  if (!ip) return FALLBACK;
  // Node кладёт IPv4 как `::ffff:1.2.3.4` когда socket дуальный — срезаем префикс.
  const mapped = ip.match(/^::ffff:([0-9.]+)$/);
  if (mapped) return mapped[1];
  return ip;
}

export function extractClientIp(req: RequestLike): string {
  const direct = normalize(req.ip || req.socket?.remoteAddress);
  const trusted = getTrustedProxies();

  if (trusted.size === 0) {
    return direct;
  }

  // Считаем доверенным только прямое соединение с одного из TRUSTED_PROXY_IPS.
  if (!trusted.has(direct)) {
    return direct;
  }

  const raw = req.headers['x-forwarded-for'];
  if (!raw) return direct;

  // Express может отдавать как string, так и string[].
  const header = Array.isArray(raw) ? raw.join(',') : raw;
  const parts = header
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalize);

  // Идём с конца XFF и берём первый НЕ-доверенный IP. Это реальный клиент.
  for (let i = parts.length - 1; i >= 0; i--) {
    const ip = parts[i];
    if (!trusted.has(ip)) {
      return ip;
    }
  }

  return direct;
}
