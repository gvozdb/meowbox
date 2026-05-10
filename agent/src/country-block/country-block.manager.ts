import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as https from 'https';
import { CommandExecutor } from '../command-executor';
import { isValidCountryCode } from './country.list';

// =============================================================================
// CountryBlockManager — server-level GeoIP-блокировка стран через ipset+iptables.
//
// Архитектура:
//   - Для каждой страны заводится 2 ipset'а: meowbox_cb_<cc>_v4 (hash:net),
//     meowbox_cb_<cc>_v6 (hash:net family inet6) — заполняются CIDR-блоками.
//   - В iptables (filter table, INPUT chain) для каждой связки
//     (страна, ports?, protocol) добавляется правило DROP с match-set по
//     соответствующему ipset.
//   - При apply мы ВСЕГДА строим состояние с нуля: чистим старое и применяем
//     новые правила. Это упрощает идемпотентность и убирает state drift.
//   - База CIDR (zone-файлы) хранится в /var/lib/meowbox/geoip/
//     с TTL ~1 сутки. Перезагружается из сети при refresh().
//
// Источники CIDR:
//   - IPDENY:           https://www.ipdeny.com/ipblocks/data/aggregated/<cc>-aggregated.zone
//                       https://www.ipdeny.com/ipv6/ipaddresses/aggregated/<cc>-aggregated.zone
//   - GITHUB_HERRBISCH: https://raw.githubusercontent.com/herrbischoff/country-ip-blocks/master/ipv4/<cc>.cidr
//                       (ipv6 — по аналогичному пути в /ipv6/)
//
// При недоступности primary автоматически идём по fallback-источникам.
// =============================================================================

export type CountrySource = 'IPDENY' | 'GITHUB_HERRBISCH';

export interface CountryBlockRule {
  /** ISO 3166-1 alpha-2 (RU, CN, US...). */
  country: string;
  /** CSV портов или диапазон 8000:9000. null/'' = блок ВСЕХ портов. */
  ports?: string | null;
  /** TCP|UDP|BOTH. Игнорируется при ports=null. */
  protocol: 'TCP' | 'UDP' | 'BOTH';
  enabled: boolean;
}

export interface CountryBlockApplyResult {
  success: boolean;
  applied: number;
  errors: string[];
  /** Страны, для которых не удалось загрузить базу. */
  missingCountries: string[];
}

export interface CountryBlockRefreshResult {
  success: boolean;
  updated: string[];
  errors: Array<{ country: string; error: string }>;
}

const GEOIP_DIR = '/var/lib/meowbox/geoip';
const IPSET_BIN = process.env.IPSET_BIN || '/sbin/ipset';
const IPTABLES_BIN = process.env.IPTABLES_BIN || '/sbin/iptables';
const IP6TABLES_BIN = process.env.IP6TABLES_BIN || '/sbin/ip6tables';
// Префикс ipset/iptables-comment для всех правил, управляемых meowbox.
// Используется при cleanup — удаляем по comment, чтоб не задеть пользовательские.
const IPSET_PREFIX = 'meowbox_cb_';
const IPTABLES_COMMENT = 'meowbox-country-block';

const HTTP_TIMEOUT_MS = 30_000;

interface ZoneFile {
  cidrs: string[];
  family: 'v4' | 'v6';
}

export class CountryBlockManager {
  private readonly executor: CommandExecutor;

  constructor() {
    this.executor = new CommandExecutor();
  }

  // ---------------------------------------------------------------------------
  // PUBLIC API
  // ---------------------------------------------------------------------------

  /**
   * Полностью применяет переданный набор правил: чистит старые meowbox-правила
   * (ipset + iptables), создаёт ipset'ы по странам, добавляет iptables-правила.
   * Идемпотентно — можно вызывать сколько угодно раз.
   */
  async applyRules(
    rules: CountryBlockRule[],
    sources: CountrySource[],
  ): Promise<CountryBlockApplyResult> {
    const result: CountryBlockApplyResult = {
      success: true,
      applied: 0,
      errors: [],
      missingCountries: [],
    };

    try {
      await this.ensureGeoIpDir();
      // Нормализуем enabled-only и валидные коды, дедуп по (country/ports/proto)
      const enabledRules = rules.filter(
        (r) => r.enabled && isValidCountryCode(r.country.toUpperCase()),
      ).map((r) => ({
        country: r.country.toUpperCase(),
        ports: r.ports?.trim() || null,
        protocol: r.protocol === 'TCP' || r.protocol === 'UDP' ? r.protocol : 'BOTH' as const,
        enabled: true,
      }));

      // Уникальные страны для загрузки CIDR
      const countries = Array.from(new Set(enabledRules.map((r) => r.country)));

      // 1) Чистим всё старое meowbox-наследие (idempotent)
      await this.cleanupAllMeowboxRules();

      if (enabledRules.length === 0) {
        return result;
      }

      // 2) Для каждой страны убедимся, что zone-файлы есть (cache hit ok),
      //    создадим ipset'ы и наполним их.
      for (const cc of countries) {
        try {
          await this.ensureCountryDataset(cc, sources);
          await this.populateIpsets(cc);
        } catch (err) {
          result.missingCountries.push(cc);
          result.errors.push(`${cc}: ${(err as Error).message}`);
        }
      }

      // 3) iptables-правила
      for (const rule of enabledRules) {
        if (result.missingCountries.includes(rule.country)) continue;
        try {
          await this.addIptablesRule(rule);
          result.applied++;
        } catch (err) {
          result.errors.push(
            `iptables ${rule.country} ${rule.ports || 'all'}/${rule.protocol}: ${(err as Error).message}`,
          );
        }
      }

      // 4) Сохраняем правила, чтоб переживали reboot
      await this.persistIptables();

      result.success = result.errors.length === 0;
      return result;
    } catch (err) {
      result.success = false;
      result.errors.push((err as Error).message);
      return result;
    }
  }

  /**
   * Скачивает свежие CIDR-zone'ы для указанных стран (или для всех уже
   * закешированных, если countries не передан). Используется в daily cron.
   */
  async refreshDatabase(
    countries: string[],
    sources: CountrySource[],
  ): Promise<CountryBlockRefreshResult> {
    const result: CountryBlockRefreshResult = { success: true, updated: [], errors: [] };
    await this.ensureGeoIpDir();

    const list = countries.filter((c) => isValidCountryCode(c.toUpperCase())).map((c) => c.toUpperCase());
    for (const cc of list) {
      try {
        await this.downloadDataset(cc, sources, /* force */ true);
        result.updated.push(cc);
      } catch (err) {
        result.errors.push({ country: cc, error: (err as Error).message });
      }
    }
    result.success = result.errors.length === 0;
    return result;
  }

  /**
   * Полная очистка: убирает ВСЕ meowbox-управляемые ipset'ы и iptables-правила.
   * Используется при выключении мастер-свитча.
   */
  async clearAll(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.cleanupAllMeowboxRules();
      await this.persistIptables();
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Текущее состояние: список ipset'ов, кол-во CIDR в каждом, активные iptables-правила,
   * дата последнего обновления каждой страны.
   */
  async status(): Promise<{
    success: boolean;
    error?: string;
    ipsets?: Array<{ name: string; entries: number; family: 'v4' | 'v6' }>;
    countries?: Array<{ country: string; lastUpdate: string | null; v4Count: number; v6Count: number }>;
    iptablesActive?: boolean;
  }> {
    try {
      const sets = await this.listMeowboxIpsets();
      const ipsets: Array<{ name: string; entries: number; family: 'v4' | 'v6' }> = [];
      for (const s of sets) {
        const entries = await this.ipsetCount(s);
        ipsets.push({
          name: s,
          entries,
          family: s.endsWith('_v6') ? 'v6' : 'v4',
        });
      }

      // Группируем по странам
      const byCountry = new Map<string, { v4: number; v6: number }>();
      for (const s of ipsets) {
        const m = s.name.match(/^meowbox_cb_([A-Z]{2})_v[46]$/);
        if (!m) continue;
        const cc = m[1];
        const cur = byCountry.get(cc) || { v4: 0, v6: 0 };
        if (s.family === 'v4') cur.v4 = s.entries;
        else cur.v6 = s.entries;
        byCountry.set(cc, cur);
      }

      const countries: Array<{ country: string; lastUpdate: string | null; v4Count: number; v6Count: number }> = [];
      for (const [cc, val] of byCountry) {
        const lu = await this.getDatasetMtime(cc);
        countries.push({ country: cc, lastUpdate: lu, v4Count: val.v4, v6Count: val.v6 });
      }
      countries.sort((a, b) => a.country.localeCompare(b.country));

      // Активны ли наши iptables-правила (хоть одно)
      const r = await this.executor.execute(
        IPTABLES_BIN,
        ['-L', 'INPUT', '-n', '--line-numbers'],
        { allowFailure: true, timeout: 10_000 },
      );
      const iptablesActive = /meowbox-country-block/.test(r.stdout);

      return { success: true, ipsets, countries, iptablesActive };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ---------------------------------------------------------------------------
  // INTERNAL: dataset management
  // ---------------------------------------------------------------------------

  private async ensureGeoIpDir(): Promise<void> {
    await fsp.mkdir(GEOIP_DIR, { recursive: true, mode: 0o755 });
  }

  /** Скачивает zone-файл, если его нет на диске. Не форсирует обновление. */
  private async ensureCountryDataset(cc: string, sources: CountrySource[]): Promise<void> {
    const v4Path = this.zoneFilePath(cc, 'v4');
    const v6Path = this.zoneFilePath(cc, 'v6');
    const need = !fs.existsSync(v4Path) || !fs.existsSync(v6Path);
    if (need) {
      await this.downloadDataset(cc, sources, /* force */ false);
    }
  }

  private zoneFilePath(cc: string, family: 'v4' | 'v6'): string {
    return path.join(GEOIP_DIR, `${cc.toUpperCase()}.${family}.zone`);
  }

  private async downloadDataset(
    cc: string,
    sources: CountrySource[],
    force: boolean,
  ): Promise<void> {
    const v4Path = this.zoneFilePath(cc, 'v4');
    const v6Path = this.zoneFilePath(cc, 'v6');

    // Force: всегда качаем; иначе только если файла нет.
    const v4Need = force || !fs.existsSync(v4Path);
    const v6Need = force || !fs.existsSync(v6Path);
    if (!v4Need && !v6Need) return;

    const lcc = cc.toLowerCase();
    let v4Body: string | null = null;
    let v6Body: string | null = null;
    let lastError: string = '';

    for (const src of sources) {
      const urls = this.urlsFor(src, lcc);
      try {
        if (v4Need && v4Body === null) {
          const body = await this.httpGet(urls.v4);
          v4Body = this.parseZoneBody(body, 'v4');
        }
        if (v6Need && v6Body === null) {
          try {
            const body = await this.httpGet(urls.v6);
            v6Body = this.parseZoneBody(body, 'v6');
          } catch (e) {
            // IPv6 может отсутствовать у некоторых стран — это не fatal.
            v6Body = '';
            void e;
          }
        }
        if ((!v4Need || v4Body !== null) && (!v6Need || v6Body !== null)) break;
      } catch (err) {
        lastError = (err as Error).message;
        continue; // следующий source
      }
    }

    if (v4Need && v4Body === null) {
      throw new Error(`Не удалось загрузить IPv4 базу страны ${cc}: ${lastError}`);
    }
    if (v4Need) await fsp.writeFile(v4Path, v4Body || '', { mode: 0o644 });
    if (v6Need) await fsp.writeFile(v6Path, v6Body || '', { mode: 0o644 });
  }

  private urlsFor(src: CountrySource, lcc: string): { v4: string; v6: string } {
    if (src === 'IPDENY') {
      return {
        v4: `https://www.ipdeny.com/ipblocks/data/aggregated/${lcc}-aggregated.zone`,
        v6: `https://www.ipdeny.com/ipv6/ipaddresses/aggregated/${lcc}-aggregated.zone`,
      };
    }
    // GITHUB_HERRBISCH
    return {
      v4: `https://raw.githubusercontent.com/herrbischoff/country-ip-blocks/master/ipv4/${lcc}.cidr`,
      v6: `https://raw.githubusercontent.com/herrbischoff/country-ip-blocks/master/ipv6/${lcc}.cidr`,
    };
  }

  /**
   * Парсит zone-body: одна строка = один CIDR. Игнорируем пустые/комментарии.
   * Возвращает текст для записи на диск (один CIDR на строке).
   */
  private parseZoneBody(body: string, family: 'v4' | 'v6'): string {
    const lines = body.split(/\r?\n/);
    const out: string[] = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      // Лёгкая валидация — отсечь явный мусор.
      if (family === 'v4') {
        if (!/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(line)) continue;
      } else {
        if (!/^[0-9a-fA-F:]+(\/\d{1,3})?$/.test(line)) continue;
      }
      out.push(line);
    }
    return out.join('\n') + '\n';
  }

  private async getDatasetMtime(cc: string): Promise<string | null> {
    try {
      const st = await fsp.stat(this.zoneFilePath(cc, 'v4'));
      return st.mtime.toISOString();
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // INTERNAL: ipset / iptables
  // ---------------------------------------------------------------------------

  /**
   * Создаёт ipset'ы для страны (v4+v6) и заполняет их актуальными CIDR.
   * Использует `ipset restore` (атомарная замена через swap).
   */
  private async populateIpsets(cc: string): Promise<void> {
    for (const family of ['v4', 'v6'] as const) {
      const setName = `${IPSET_PREFIX}${cc}_${family}`;
      const tempName = `${setName}_tmp`;
      const zoneFile = this.zoneFilePath(cc, family);
      let cidrs: string[] = [];
      try {
        const body = await fsp.readFile(zoneFile, 'utf8');
        cidrs = body.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      } catch {
        // нет zone-файла — пропускаем (например IPv6 у CN не у всех стран есть)
        continue;
      }
      if (cidrs.length === 0) continue;

      // Создаём временный set, заполняем, затем swap (atomic).
      const familyOpt = family === 'v6' ? 'inet6' : 'inet';
      // Создание основного set (если не существует) — нужен для swap.
      await this.executor.execute(IPSET_BIN, [
        'create', setName, 'hash:net', 'family', familyOpt, '-exist',
      ], { allowFailure: true, timeout: 10_000 });

      // Создаём temp set с теми же параметрами
      await this.executor.execute(IPSET_BIN, ['destroy', tempName], { allowFailure: true, timeout: 5_000 });
      await this.executor.execute(IPSET_BIN, [
        'create', tempName, 'hash:net', 'family', familyOpt, 'maxelem', '262144',
      ], { allowFailure: true, timeout: 10_000 });

      // Заполняем через `ipset restore -file <tmpfile>`. Tmp-файл идёт в /tmp,
      // 0600, удаляется после операции. Батчинг не нужен — restore читает файл
      // последовательно, RAM-overhead мал.
      const restoreInput = cidrs.map((c) => `add ${tempName} ${c} -exist`).join('\n') + '\n';
      const tmpFile = path.join('/tmp', `meowbox-ipset-${cc}-${family}-${Date.now()}.restore`);
      try {
        await fsp.writeFile(tmpFile, restoreInput, { mode: 0o600 });
        const r = await this.executor.execute(
          IPSET_BIN,
          ['restore', '-file', tmpFile],
          { timeout: 60_000, allowFailure: true },
        );
        if (r.exitCode !== 0) {
          const errExcerpt = (r.stderr || r.stdout || '').slice(0, 200);
          throw new Error(`ipset restore (${cc}/${family}) exit=${r.exitCode}: ${errExcerpt}`);
        }
      } finally {
        await fsp.unlink(tmpFile).catch(() => {});
      }

      // Swap основного и temp, потом удаляем temp.
      const sw = await this.executor.execute(IPSET_BIN, ['swap', tempName, setName], {
        allowFailure: true,
        timeout: 5_000,
      });
      if (sw.exitCode !== 0) {
        throw new Error(`ipset swap (${cc}/${family}) exit=${sw.exitCode}: ${sw.stderr.slice(0, 200)}`);
      }
      await this.executor.execute(IPSET_BIN, ['destroy', tempName], { allowFailure: true, timeout: 5_000 });
    }
  }

  /**
   * Добавляет iptables-правило DROP для (страна, ports, protocol).
   * v4 и v6 правила создаются параллельно (если соответствующий ipset существует).
   */
  private async addIptablesRule(rule: CountryBlockRule): Promise<void> {
    const cc = rule.country;
    const setV4 = `${IPSET_PREFIX}${cc}_v4`;
    const setV6 = `${IPSET_PREFIX}${cc}_v6`;

    const buildArgs = (setName: string, proto: string | null): string[] => {
      const args = [
        '-I', 'INPUT', '1', // вставляем в начало INPUT (приоритет над пользовательскими ALLOW)
        '-m', 'set', '--match-set', setName, 'src',
      ];
      if (rule.ports && proto) {
        args.push('-p', proto, '-m', 'multiport', '--dports', rule.ports);
      }
      args.push('-m', 'comment', '--comment', `${IPTABLES_COMMENT}:${cc}`);
      args.push('-j', 'DROP');
      return args;
    };

    // Список (proto) для подмножества правил
    const protocols: (string | null)[] = [];
    if (!rule.ports) {
      protocols.push(null); // без -p / multiport — блокируем всё
    } else if (rule.protocol === 'BOTH') {
      protocols.push('tcp', 'udp');
    } else {
      protocols.push(rule.protocol.toLowerCase());
    }

    // v4
    const v4Exists = await this.ipsetExists(setV4);
    if (v4Exists) {
      for (const p of protocols) {
        const r = await this.executor.execute(IPTABLES_BIN, buildArgs(setV4, p), {
          allowFailure: true, timeout: 10_000,
        });
        if (r.exitCode !== 0) {
          throw new Error(`iptables -I INPUT (${cc}/v4): ${r.stderr.slice(0, 200)}`);
        }
      }
    }
    // v6
    const v6Exists = await this.ipsetExists(setV6);
    if (v6Exists) {
      for (const p of protocols) {
        const r = await this.executor.execute(IP6TABLES_BIN, buildArgs(setV6, p), {
          allowFailure: true, timeout: 10_000,
        });
        if (r.exitCode !== 0) {
          // ip6tables может отсутствовать в окружении без IPv6 — не fatal
          if (!/no such file|cannot find|unrecognized|disabled/i.test(r.stderr)) {
            throw new Error(`ip6tables -I INPUT (${cc}/v6): ${r.stderr.slice(0, 200)}`);
          }
        }
      }
    }
  }

  /**
   * Удаляет ВСЕ meowbox-управляемые правила/наборы (v4+v6, iptables+ip6tables+ipset).
   * Идемпотентно: безопасно вызывать на чистом сервере.
   */
  private async cleanupAllMeowboxRules(): Promise<void> {
    // 1. iptables: удалить все INPUT правила с нашим comment
    for (const bin of [IPTABLES_BIN, IP6TABLES_BIN]) {
      // Получаем номера правил через -L INPUT --line-numbers
      const r = await this.executor.execute(bin, ['-L', 'INPUT', '-n', '--line-numbers'], {
        allowFailure: true, timeout: 10_000,
      });
      if (r.exitCode !== 0) continue;
      // Парсим строки с нашим комментом, собираем номера правил.
      const ruleNums: number[] = [];
      for (const line of r.stdout.split('\n')) {
        if (!line.includes(IPTABLES_COMMENT)) continue;
        const m = line.match(/^(\d+)\s/);
        if (m) ruleNums.push(parseInt(m[1], 10));
      }
      // Удаляем в обратном порядке, иначе номера съедут
      ruleNums.sort((a, b) => b - a);
      for (const n of ruleNums) {
        await this.executor.execute(bin, ['-D', 'INPUT', String(n)], {
          allowFailure: true, timeout: 5_000,
        });
      }
    }

    // 2. ipset: удалить все meowbox_cb_* (после iptables, иначе ipset busy)
    const sets = await this.listMeowboxIpsets();
    for (const s of sets) {
      await this.executor.execute(IPSET_BIN, ['destroy', s], { allowFailure: true, timeout: 10_000 });
    }
  }

  private async listMeowboxIpsets(): Promise<string[]> {
    const r = await this.executor.execute(IPSET_BIN, ['list', '-n'], {
      allowFailure: true, timeout: 10_000,
    });
    if (r.exitCode !== 0) return [];
    return r.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.startsWith(IPSET_PREFIX));
  }

  private async ipsetExists(name: string): Promise<boolean> {
    const r = await this.executor.execute(IPSET_BIN, ['list', '-n', name], {
      allowFailure: true, timeout: 5_000,
    });
    return r.exitCode === 0;
  }

  private async ipsetCount(name: string): Promise<number> {
    const r = await this.executor.execute(IPSET_BIN, ['list', name], {
      allowFailure: true, timeout: 10_000,
    });
    if (r.exitCode !== 0) return 0;
    const m = r.stdout.match(/Number of entries:\s*(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  /**
   * Сохраняет iptables/ipset так, чтобы они переживали reboot.
   * Использует netfilter-persistent (ставит iptables-persistent), best-effort.
   */
  private async persistIptables(): Promise<void> {
    // ipset save в /etc/iptables/ipset.rules — netfilter-persistent потом подхватит
    try {
      const save = await this.executor.execute(IPSET_BIN, ['save'], { allowFailure: true, timeout: 30_000 });
      if (save.exitCode === 0) {
        await fsp.mkdir('/etc/iptables', { recursive: true });
        await fsp.writeFile('/etc/iptables/ipset.rules', save.stdout, { mode: 0o644 });
      }
    } catch {
      /* ignore */
    }
    // netfilter-persistent save — есть на Debian/Ubuntu
    await this.executor.execute('/usr/sbin/netfilter-persistent', ['save'], {
      allowFailure: true, timeout: 30_000,
    });
  }

  // ---------------------------------------------------------------------------
  // INTERNAL: HTTP fetch (lightweight, без axios)
  // ---------------------------------------------------------------------------

  private httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        timeout: HTTP_TIMEOUT_MS,
        headers: { 'User-Agent': 'meowbox-agent/country-block' },
      }, (res) => {
        if ((res.statusCode || 0) >= 300 && (res.statusCode || 0) < 400 && res.headers.location) {
          // Следуем redirect (1 раз)
          this.httpGet(res.headers.location).then(resolve, reject);
          res.resume();
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total > 50 * 1024 * 1024) {
            req.destroy();
            reject(new Error('Body too large (>50MB)'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      });
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('HTTP request timeout'));
      });
      req.on('error', reject);
    });
  }
}
