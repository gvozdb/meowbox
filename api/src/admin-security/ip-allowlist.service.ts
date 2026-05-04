/**
 * IP allowlist для админки. Если включен — все запросы к API,
 * кроме explicit-bypass (loopback и slave-proxy), отбиваются 403,
 * пока IP клиента не входит в один из CIDR-ов списка.
 *
 * Хранилище — `PanelSetting.key='admin-ip-allowlist'`. Формат:
 *   { enabled: boolean, entries: [{ cidr: string, label: string }] }
 *
 * Чтобы каждый запрос не дёргал БД, держим in-memory `net.BlockList`
 * и инвалидируем его при PUT (через `reload()` после `save()`).
 */
import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as net from 'node:net';

import { PrismaService } from '../common/prisma.service';

export interface IpAllowlistEntry {
  cidr: string;
  label: string;
}

export interface IpAllowlistConfig {
  enabled: boolean;
  entries: IpAllowlistEntry[];
}

const SETTING_KEY = 'admin-ip-allowlist';

@Injectable()
export class IpAllowlistService implements OnModuleInit {
  private readonly logger = new Logger('IpAllowlistService');
  private cached: IpAllowlistConfig = { enabled: false, entries: [] };
  private blockList: net.BlockList = new net.BlockList();
  private loaded = false;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  /** Текущий конфиг + пересборка in-memory BlockList. */
  async reload(): Promise<IpAllowlistConfig> {
    const row = await this.prisma.panelSetting.findUnique({ where: { key: SETTING_KEY } });
    let cfg: IpAllowlistConfig = { enabled: false, entries: [] };
    if (row) {
      try {
        const raw = JSON.parse(row.value) as Partial<IpAllowlistConfig>;
        const entries = Array.isArray(raw.entries) ? raw.entries : [];
        cfg = {
          enabled: !!raw.enabled,
          entries: entries
            .filter((e) => e && typeof e.cidr === 'string')
            .map((e) => ({
              cidr: String(e.cidr).trim(),
              label: typeof e.label === 'string' ? e.label.trim() : '',
            })),
        };
      } catch (e) {
        this.logger.warn(`Cannot parse ${SETTING_KEY}: ${(e as Error).message} — using defaults`);
      }
    }
    this.cached = cfg;
    this.blockList = this.buildBlockList(cfg.entries);
    this.loaded = true;
    return cfg;
  }

  /** Текущий конфиг (read-only). */
  getConfig(): IpAllowlistConfig {
    return { enabled: this.cached.enabled, entries: this.cached.entries.slice() };
  }

  /**
   * Главная проверка для Guard'а. Возвращает `true` если запрос разрешён.
   * Вызывается из `IpAllowlistGuard` на каждый запрос (быстрая, без I/O).
   */
  isAllowed(clientIp: string): boolean {
    if (!this.loaded) return true; // ещё не успели подгрузить — fail-open до reload
    if (!this.cached.enabled) return true;
    if (!clientIp) return false;
    if (this.isLoopback(clientIp)) return true;
    return this.checkBlockList(clientIp);
  }

  /** Сохранить новый конфиг. Вызывать ТОЛЬКО после валидации (см. validate). */
  async save(cfg: IpAllowlistConfig): Promise<IpAllowlistConfig> {
    const sanitized = this.validate(cfg);
    await this.prisma.panelSetting.upsert({
      where: { key: SETTING_KEY },
      create: { key: SETTING_KEY, value: JSON.stringify(sanitized) },
      update: { value: JSON.stringify(sanitized) },
    });
    return await this.reload();
  }

  /**
   * Проверка валидности конфига + санитайз. Бросает `BadRequestException`
   * если CIDR битый. Дубликаты схлопываем по ключу cidr.
   */
  validate(cfg: Partial<IpAllowlistConfig>): IpAllowlistConfig {
    const enabled = !!cfg.enabled;
    const entries = Array.isArray(cfg.entries) ? cfg.entries : [];
    const seen = new Set<string>();
    const sanitized: IpAllowlistEntry[] = [];
    for (const e of entries) {
      const cidr = typeof e?.cidr === 'string' ? e.cidr.trim() : '';
      const label = typeof e?.label === 'string' ? e.label.trim().slice(0, 64) : '';
      if (!cidr) throw new BadRequestException('Пустой CIDR в списке');
      if (cidr.length > 64) throw new BadRequestException(`CIDR слишком длинный: ${cidr}`);
      if (!this.isValidCidrOrIp(cidr)) {
        throw new BadRequestException(`Невалидный CIDR/IP: ${cidr}`);
      }
      const key = this.normalizeCidr(cidr);
      if (seen.has(key)) continue;
      seen.add(key);
      sanitized.push({ cidr: key, label });
    }
    return { enabled, entries: sanitized };
  }

  /**
   * Сухой прогон: разрешён бы был IP при таком конфиге? Используется для
   * защиты от самобана при сохранении нового списка — см. controller.
   * Не трогает закешированный BlockList.
   */
  simulateAllowed(cfg: IpAllowlistConfig, clientIp: string): boolean {
    if (!cfg.enabled) return true;
    if (!clientIp) return false;
    if (this.isLoopback(clientIp)) return true;
    const bl = this.buildBlockList(cfg.entries);
    const norm = this.normalizeIp(clientIp);
    const type = net.isIPv6(norm) ? 'ipv6' : 'ipv4';
    try {
      return bl.check(norm, type);
    } catch {
      return false;
    }
  }

  /** Нормализация: одиночный IP → IP/32 (или /128 для IPv6). */
  normalizeCidr(input: string): string {
    if (input.includes('/')) return input;
    const v6 = net.isIPv6(input);
    return `${input}/${v6 ? 128 : 32}`;
  }

  // ── Private ────────────────────────────────────────────────────────────

  private buildBlockList(entries: IpAllowlistEntry[]): net.BlockList {
    const bl = new net.BlockList();
    for (const e of entries) {
      const norm = this.normalizeCidr(e.cidr);
      const [addr, prefixStr] = norm.split('/');
      const prefix = parseInt(prefixStr, 10);
      const type = net.isIPv6(addr) ? 'ipv6' : 'ipv4';
      try {
        bl.addSubnet(addr, prefix, type);
      } catch (err) {
        this.logger.warn(`Skipping bad CIDR "${e.cidr}": ${(err as Error).message}`);
      }
    }
    return bl;
  }

  private checkBlockList(ip: string): boolean {
    // net.BlockList.check возвращает true если ip входит в любой добавленный диапазон.
    // Для IPv4-mapped IPv6 (`::ffff:1.2.3.4`) приводим к чистому IPv4.
    const normalized = this.normalizeIp(ip);
    const type = net.isIPv6(normalized) ? 'ipv6' : 'ipv4';
    try {
      return this.blockList.check(normalized, type);
    } catch {
      return false;
    }
  }

  private isLoopback(ip: string): boolean {
    if (!ip) return false;
    if (ip === '::1') return true;
    const norm = this.normalizeIp(ip);
    if (norm === '127.0.0.1') return true;
    return norm.startsWith('127.');
  }

  private normalizeIp(ip: string): string {
    if (!ip) return ip;
    if (ip.startsWith('::ffff:')) return ip.slice(7);
    return ip;
  }

  private isValidCidrOrIp(input: string): boolean {
    if (input.includes('/')) {
      const [addr, prefixStr] = input.split('/');
      const prefix = parseInt(prefixStr, 10);
      if (!Number.isFinite(prefix)) return false;
      if (net.isIPv4(addr) && prefix >= 0 && prefix <= 32) return true;
      if (net.isIPv6(addr) && prefix >= 0 && prefix <= 128) return true;
      return false;
    }
    return net.isIPv4(input) || net.isIPv6(input);
  }
}
