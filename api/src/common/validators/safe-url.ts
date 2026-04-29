/**
 * Защита от SSRF для fetch-запросов по URL, контролируемых пользователем.
 *
 * Проверяем:
 *   1) Протокол обязан быть http / https.
 *   2) Hostname обязан резолвиться и не попадать в private/loopback/link-local
 *      диапазоны (IPv4/IPv6).
 *   3) Порт — если разрешён только 80/443 через `onlyStandardPorts`, прочие
 *      отбрасываем.
 *
 * Использование:
 *   await assertPublicHttpUrl(sourceUrl);
 *
 * Предупреждение: между DNS-резолвом и собственно fetch существует TOCTOU-окно
 * (DNS rebinding). Для задач со "средней" степенью чувствительности этого
 * достаточно; для строгих — нужен кастомный Agent с lookup-хуком.
 */

import { BadRequestException } from '@nestjs/common';
import * as dns from 'dns/promises';
import * as net from 'net';

export interface SafeUrlOptions {
  /** Разрешённые протоколы. Default: ['http:', 'https:']. */
  protocols?: string[];
  /** Разрешить только порты 80/443. Default: false. */
  onlyStandardPorts?: boolean;
  /** Максимальная длина URL. Default: 2048. */
  maxLength?: number;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true; // treat malformed as unsafe
  }
  const [a, b] = parts;
  // 0.0.0.0/8
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 127.0.0.0/8
  if (a === 127) return true;
  // 169.254.0.0/16 (link-local + AWS IMDS)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 (IETF protocol assignments)
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 — CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 224.0.0.0/4 (multicast) + 240.0.0.0/4 (reserved)
  if (a >= 224) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  // ULA fc00::/7 (fc.., fd..)
  if (/^fc[0-9a-f]{2}:/.test(lower) || /^fd[0-9a-f]{2}:/.test(lower)) return true;
  // link-local fe80::/10
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  // multicast ff00::/8
  if (lower.startsWith('ff')) return true;
  // IPv4-mapped (::ffff:x.x.x.x)
  const mapped = lower.match(/^::ffff:([0-9.]+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

export function isPrivateHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
  if (lower.endsWith('.local')) return true;
  if (lower.endsWith('.internal') || lower.endsWith('.intranet')) return true;

  const ipv = net.isIP(lower);
  if (ipv === 4) return isPrivateIPv4(lower);
  if (ipv === 6) return isPrivateIPv6(lower);
  return false;
}

export async function assertPublicHttpUrl(
  input: string | undefined | null,
  opts: SafeUrlOptions = {},
): Promise<URL> {
  const protocols = opts.protocols ?? ['http:', 'https:'];
  const maxLength = opts.maxLength ?? 2048;

  if (!input || typeof input !== 'string') {
    throw new BadRequestException('URL is required');
  }
  if (input.length > maxLength) {
    throw new BadRequestException('URL too long');
  }
  if (/[\s\0\r\n]/.test(input)) {
    throw new BadRequestException('URL contains whitespace or control characters');
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new BadRequestException('Invalid URL');
  }

  if (!protocols.includes(url.protocol)) {
    throw new BadRequestException(
      `URL protocol must be one of: ${protocols.join(', ')}`,
    );
  }

  if (opts.onlyStandardPorts) {
    const defaultPorts: Record<string, string> = { 'http:': '80', 'https:': '443' };
    const port = url.port || defaultPorts[url.protocol] || '';
    if (!['80', '443', ''].includes(port)) {
      throw new BadRequestException('Non-standard ports are not allowed');
    }
  }

  const hostname = url.hostname;
  if (!hostname) {
    throw new BadRequestException('URL must have a hostname');
  }

  // Быстрая проверка: сам hostname — уже private literal.
  if (isPrivateHost(hostname)) {
    throw new BadRequestException('URL points to a private or loopback address');
  }

  // DNS-резолв: если одно из значений приватное — блок.
  // Берём все A/AAAA и проверяем каждое. Это не защищает от DNS rebinding
  // (второй резолв при fetch может вернуть другое значение), но отсекает
  // большинство атак на "публичные" имена с приватными A-записями.
  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    for (const r of records) {
      if (isPrivateHost(r.address)) {
        throw new BadRequestException(
          'URL host resolves to a private or loopback address',
        );
      }
    }
  } catch (err) {
    if (err instanceof BadRequestException) throw err;
    throw new BadRequestException('Unable to resolve URL hostname');
  }

  return url;
}
