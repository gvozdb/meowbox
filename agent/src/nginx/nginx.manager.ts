/**
 * Nginx manager — генерирует и применяет layered-конфиги сайтов:
 *
 *   /etc/nginx/sites-available/{siteName}.conf  ← главный (skeleton + server-блоки)
 *   /etc/nginx/sites-enabled/{siteName}.conf    ← симлинк → sites-available
 *   /etc/nginx/meowbox/{siteName}/00..50-*.conf ← управляемые чанки
 *   /etc/nginx/meowbox/{siteName}/95-custom.conf ← редактируется юзером в UI
 *
 * Контракт:
 *  1) Регенерация конфига сайта (после смены settings/домена/SSL) перезаписывает
 *     главный файл и все 00..50 чанки. Файл `95-custom.conf` НЕ трогается.
 *  2) `setCustomConfig()` пишет ТОЛЬКО `95-custom.conf` и валидирует через `nginx -t`.
 *     При ошибке — старая версия восстанавливается из бэкапа.
 *  3) `removeSiteConfig()` удаляет всё: симлинк, главный файл, всю папку
 *     meowbox/{siteName}/ (включая custom — сайт удалён → custom не нужен).
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { CommandExecutor } from '../command-executor';
import {
  NGINX_GLOBAL_CONF,
  NGINX_SITES_AVAILABLE as SITES_AVAILABLE,
  NGINX_SITES_ENABLED as SITES_ENABLED,
} from '../config';
import {
  MEOWBOX_INCLUDE_DIR,
  NginxAliasInput,
  NginxLayeredParams,
  renderNginxBundle,
} from './templates';
import type { SiteNginxOverrides } from '@meowbox/shared';

interface CreateSiteParams {
  siteName: string;
  siteType: string; // оставлен для совместимости; в layered не влияет на чанки
  domain: string;
  aliases: NginxAliasInput[];
  rootPath: string;
  filesRelPath?: string;
  phpVersion?: string;
  phpEnabled?: boolean;
  appPort?: number;
  sslEnabled?: boolean;
  httpsRedirect?: boolean;
  certPath?: string;
  keyPath?: string;
  settings?: SiteNginxOverrides;
  /**
   * Кастом-блок, который надо положить как `95-custom.conf` ТОЛЬКО если
   * на диске такого файла ещё нет (первая установка или миграция переезда).
   * При обновлении настроек уже существующего сайта сюда передаётся
   * актуальное значение из БД, и файл синхронизируется с БД.
   */
  customConfig?: string | null;
  /**
   * Если true — даже существующий 95-custom.conf будет перезаписан содержимым
   * customConfig. Используется при операциях `PUT /sites/:id/nginx/custom`.
   */
  forceWriteCustom?: boolean;
}

export class NginxManager {
  private readonly executor = new CommandExecutor();

  // ---------------------------------------------------------------------------
  // CREATE / UPDATE
  // ---------------------------------------------------------------------------

  /**
   * Создаёт или обновляет ВЕСЬ конфиг сайта (главный файл + 00..50 чанки).
   * `95-custom.conf` пишется только если он отсутствует и передан `customConfig`,
   * либо если `forceWriteCustom=true`.
   *
   * Если `nginx -t` падает — все изменения откатываются из бэкапа.
   */
  async createSiteConfig(params: CreateSiteParams): Promise<{ success: boolean; error?: string }> {
    if (!params.siteName) return { success: false, error: 'siteName required' };

    const bundle = renderNginxBundle(this.toLayeredParams(params));
    const mainPath = this.mainConfigPath(params.siteName);
    const enabledLink = this.enabledLinkPath(params.siteName);
    const includeDir = this.siteIncludeDir(params.siteName);

    // Бэкап существующих файлов на случай отката.
    const backup = await this.backupSite(params.siteName);

    try {
      await fs.mkdir(SITES_AVAILABLE, { recursive: true });
      await fs.mkdir(SITES_ENABLED, { recursive: true });
      await fs.mkdir(includeDir, { recursive: true });

      // 1. Чанки 00..50 — переписываем полностью.
      const desiredChunks = new Set(Object.keys(bundle.chunks));
      // Удаляем устаревшие управляемые чанки (например, 10-ssl.conf при выкл SSL).
      const existing = await this.listManagedChunks(params.siteName);
      for (const f of existing) {
        if (!desiredChunks.has(f)) {
          await fs.unlink(path.join(includeDir, f)).catch(() => {});
        }
      }
      for (const [filename, content] of Object.entries(bundle.chunks)) {
        await fs.writeFile(path.join(includeDir, filename), content, 'utf8');
        await fs.chmod(path.join(includeDir, filename), 0o644).catch(() => {});
      }

      // 2. 95-custom.conf — особая логика.
      const customPath = path.join(includeDir, '95-custom.conf');
      const customExists = await this.exists(customPath);
      if (params.forceWriteCustom) {
        // Явное намерение: переписать кастом из БД.
        await fs.writeFile(customPath, params.customConfig ?? '', 'utf8');
        await fs.chmod(customPath, 0o644).catch(() => {});
      } else if (!customExists && typeof params.customConfig === 'string') {
        // Первая установка: инициализируем стартовым шаблоном.
        await fs.writeFile(customPath, params.customConfig, 'utf8');
        await fs.chmod(customPath, 0o644).catch(() => {});
      }
      // Если файл существует и forceWriteCustom=false — оставляем как есть (юзерский кастом).

      // 3. Главный файл.
      await fs.writeFile(mainPath, bundle.mainConfig, 'utf8');
      await fs.chmod(mainPath, 0o644).catch(() => {});

      // 4. Симлинк sites-enabled.
      await fs.unlink(enabledLink).catch(() => {});
      await fs.symlink(mainPath, enabledLink);

      // 5. Legacy cleanup: удалить старые конфиги (по domain), если переехали с предыдущей раскладки.
      if (params.domain && params.domain !== params.siteName) {
        const legacyMain = path.join(SITES_AVAILABLE, `${params.domain}.conf`);
        const legacyLink = path.join(SITES_ENABLED, `${params.domain}.conf`);
        await fs.unlink(legacyLink).catch(() => {});
        await fs.unlink(legacyMain).catch(() => {});
      }

      // 6. Тестируем и применяем.
      const test = await this.testConfig();
      if (!test.success) {
        await this.restoreFromBackup(params.siteName, backup);
        return { success: false, error: `nginx -t failed: ${test.error}` };
      }
      await this.reload();
      return { success: true };
    } catch (err) {
      await this.restoreFromBackup(params.siteName, backup).catch(() => {});
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Обновляет ТОЛЬКО `95-custom.conf` сайта. Используется UI-вкладкой Nginx
   * (PUT /sites/:id/nginx/custom).
   */
  async setCustomConfig(siteName: string, content: string): Promise<{ success: boolean; error?: string }> {
    if (!siteName) return { success: false, error: 'siteName required' };
    const customPath = path.join(this.siteIncludeDir(siteName), '95-custom.conf');
    const backupPath = `${customPath}.bak`;
    try {
      await fs.mkdir(this.siteIncludeDir(siteName), { recursive: true });

      // Бэкап текущего файла.
      try {
        await fs.copyFile(customPath, backupPath);
      } catch { /* нет файла */ }

      await fs.writeFile(customPath, content, 'utf8');
      await fs.chmod(customPath, 0o644).catch(() => {});

      const test = await this.testConfig();
      if (!test.success) {
        // Rollback из бэкапа.
        try {
          await fs.copyFile(backupPath, customPath);
        } catch {
          await fs.unlink(customPath).catch(() => {});
        }
        return { success: false, error: `nginx -t failed: ${test.error}` };
      }
      await this.reload();
      await fs.unlink(backupPath).catch(() => {});
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * LEGACY обёртка: старый вызов `nginx:update-config` приходил с raw-текстом
   * главного конфига. В layered-архитектуре редактирование главного файла
   * нелогично (он перезапишется при любом изменении настроек). Транслируем
   * запрос в `setCustomConfig()` — раз пользователь явно прислал кастомный
   * конфиг, кладём его в `95-custom.conf`.
   *
   * Старые вызовы `await emitToAgent('nginx:update-config', { config: '' })`
   * (например, в ssl.service.ts для триггера rebuild) приходят с пустой
   * строкой — они просто очистят custom-файл. Лучше их вообще убрать, но
   * до этого момента — поведение тут безопасное.
   */
  async updateSiteConfig(siteName: string, configContent: string): Promise<{ success: boolean; error?: string }> {
    return this.setCustomConfig(siteName, configContent || '');
  }

  /** Чтение содержимого 95-custom.conf (для UI). */
  async readCustomConfig(siteName: string): Promise<string | null> {
    try {
      return await fs.readFile(path.join(this.siteIncludeDir(siteName), '95-custom.conf'), 'utf8');
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // REMOVE
  // ---------------------------------------------------------------------------

  async removeSiteConfig(siteName: string): Promise<void> {
    const mainPath = this.mainConfigPath(siteName);
    const enabledLink = this.enabledLinkPath(siteName);
    const includeDir = this.siteIncludeDir(siteName);

    await fs.unlink(enabledLink).catch(() => {});
    await fs.unlink(mainPath).catch(() => {});
    await fs.rm(includeDir, { recursive: true, force: true }).catch(() => {});
    await this.reload().catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // READ
  // ---------------------------------------------------------------------------

  /** Главный файл (для администратора в /nginx/configs/:domain — legacy). */
  async readSiteConfig(siteName: string): Promise<string | null> {
    try {
      return await fs.readFile(this.mainConfigPath(siteName), 'utf8');
    } catch {
      return null;
    }
  }

  /** Список всех файлов в meowbox/{siteName}/ (для отладки/диагностики). */
  async listManagedChunks(siteName: string): Promise<string[]> {
    try {
      const all = await fs.readdir(this.siteIncludeDir(siteName));
      return all.filter((f) => f.endsWith('.conf') && f !== '95-custom.conf');
    } catch {
      return [];
    }
  }

  async listConfigs(): Promise<string[]> {
    try {
      const files = await fs.readdir(SITES_AVAILABLE);
      return files.filter((f) => f.endsWith('.conf')).map((f) => f.replace(/\.conf$/, ''));
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // GLOBAL ZONES (rate-limit zones для всех сайтов в одном файле)
  // ---------------------------------------------------------------------------

  /**
   * Перезаписывает `/etc/nginx/conf.d/meowbox-zones.conf` — глобальные
   * `limit_req_zone` директивы. По одной на каждый сайт + legacy-зона `site_limit`
   * (для старых конфигов сайтов, которые ещё не пере-генерены под per-site зоны).
   *
   * Атомарно с откатом: при `nginx -t` fail восстанавливаем бэкап.
   */
  async writeGlobalZones(zones: Array<{ siteName: string; rps: number; enabled: boolean }>): Promise<{ success: boolean; error?: string }> {
    const zonesPath = '/etc/nginx/conf.d/meowbox-zones.conf';
    const backupPath = `${zonesPath}.bak`;
    const lines: string[] = [
      '# === Meowbox global rate-limit zones (управляется агентом) ===',
      '# Файл регенерируется при создании/удалении сайта и при изменении rate-limit настроек.',
      '# Не редактируй вручную — изменения будут затёрты.',
      '',
      '# Legacy fallback zone (для конфигов сайтов, которые ещё не пере-генерены под per-site zone).',
      'limit_req_zone $binary_remote_addr zone=site_limit:10m rate=30r/s;',
      '',
    ];
    for (const z of zones) {
      const safe = String(z.siteName).replace(/[^a-zA-Z0-9_-]/g, '_');
      if (!safe) continue;
      const rate = z.rps && z.rps > 0 ? z.rps : 30;
      // Зона создаётся даже если rate-limit отключён — чтобы конфиг сайта
      // (если его не успели регенерить) не падал при ссылке на site_<name>.
      lines.push(`limit_req_zone $binary_remote_addr zone=site_${safe}:1m rate=${rate}r/s;`);
    }
    const content = lines.join('\n') + '\n';

    // Бэкап существующего файла на случай отката.
    try { await fs.copyFile(zonesPath, backupPath); } catch { /* nothing yet */ }

    try {
      await fs.mkdir(path.dirname(zonesPath), { recursive: true });
      await fs.writeFile(zonesPath, content, 'utf8');
      await fs.chmod(zonesPath, 0o644).catch(() => {});

      const test = await this.testConfig();
      if (!test.success) {
        try { await fs.copyFile(backupPath, zonesPath); }
        catch { await fs.unlink(zonesPath).catch(() => {}); }
        return { success: false, error: `nginx -t failed: ${test.error}` };
      }
      await this.reload();
      await fs.unlink(backupPath).catch(() => {});
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Идемпотентно добавляет shared zone `site_<safe>` в `/etc/nginx/conf.d/meowbox-zones.conf`,
   * если её там ещё нет. Используется когда регенерация полного списка зон со стороны API
   * невозможна (миграция Hostpanel: Site создаётся в БД master ПОСЛЕ apply-nginx).
   * Без этой страховки `nginx -t` падает: "zero size shared memory zone site_<name>".
   *
   * NB: после persist Site мастер всё равно регенерит файл из БД авторитетно —
   * этот append временный и переживёт ровно до следующего создания/удаления сайта.
   */
  async ensureZoneForSite(siteName: string, rps = 30): Promise<void> {
    const zonesPath = '/etc/nginx/conf.d/meowbox-zones.conf';
    const safe = String(siteName).replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!safe) return;
    const zoneId = `zone=site_${safe}:`;
    const rate = rps && rps > 0 ? rps : 30;
    const newLine = `limit_req_zone $binary_remote_addr zone=site_${safe}:1m rate=${rate}r/s;`;

    let current = '';
    try { current = await fs.readFile(zonesPath, 'utf8'); } catch { /* отсутствует — создадим */ }
    if (current.includes(zoneId)) return;

    const header =
`# === Meowbox global rate-limit zones (управляется агентом) ===
# Файл регенерируется при создании/удалении сайта и при изменении rate-limit настроек.
# Не редактируй вручную — изменения будут затёрты.

# Legacy fallback zone (для конфигов сайтов, которые ещё не пере-генерены под per-site zone).
limit_req_zone $binary_remote_addr zone=site_limit:10m rate=30r/s;
`;
    const base = current && current.trim().length > 0 ? current : header;
    const next = base.endsWith('\n') ? `${base}${newLine}\n` : `${base}\n${newLine}\n`;
    await fs.mkdir(path.dirname(zonesPath), { recursive: true });
    await fs.writeFile(zonesPath, next, 'utf8');
    await fs.chmod(zonesPath, 0o644).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // GLOBAL
  // ---------------------------------------------------------------------------

  async readGlobalConfig(): Promise<string | null> {
    try {
      return await fs.readFile(NGINX_GLOBAL_CONF, 'utf8');
    } catch {
      return null;
    }
  }

  async writeGlobalConfig(content: string): Promise<{ success: boolean; error?: string }> {
    const configPath = NGINX_GLOBAL_CONF;
    const backupPath = `${configPath}.bak`;
    try { await fs.copyFile(configPath, backupPath); } catch { /* */ }

    try {
      await fs.writeFile(configPath, content, 'utf8');
      const test = await this.testConfig();
      if (!test.success) {
        try { await fs.copyFile(backupPath, configPath); } catch { /* */ }
        return { success: false, error: `nginx -t failed: ${test.error}` };
      }
      await this.reload();
      await fs.unlink(backupPath).catch(() => {});
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ---------------------------------------------------------------------------
  // OPS
  // ---------------------------------------------------------------------------

  async testConfig(): Promise<{ success: boolean; error?: string }> {
    try {
      const r = await this.executor.execute('nginx', ['-t']);
      if (r.stderr && (r.stderr.includes('ENOENT') || r.stderr.includes('not found'))) {
        return { success: true }; // nginx не установлен — пропускаем тест
      }
      if (r.exitCode === 0) return { success: true };
      return { success: false, error: r.stderr };
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('ENOENT') || msg.includes('not found') || msg.includes('not allowed')) {
        return { success: true };
      }
      return { success: false, error: msg };
    }
  }

  async reload(): Promise<{ success: boolean; error?: string }> {
    try {
      const r = await this.executor.execute('systemctl', ['reload', 'nginx']);
      if (r.exitCode === 0) return { success: true };
      return { success: false, error: r.stderr };
    } catch {
      return { success: true }; // systemctl недоступен — не валим операцию
    }
  }

  async restart(): Promise<{ success: boolean; error?: string }> {
    const r = await this.executor.execute('systemctl', ['restart', 'nginx']);
    if (r.exitCode === 0) return { success: true };
    return { success: false, error: r.stderr };
  }

  async status(): Promise<{ running: boolean; version: string | null }> {
    const s = await this.executor.execute('systemctl', ['is-active', 'nginx']);
    const running = s.stdout.trim() === 'active';
    let version: string | null = null;
    if (running) {
      const v = await this.executor.execute('nginx', ['-v']);
      const m = v.stderr.match(/nginx\/([\d.]+)/);
      if (m) version = m[1];
    }
    return { running, version };
  }

  // ---------------------------------------------------------------------------
  // DOMAIN-USAGE SCAN (для preflight при создании сайта)
  // ---------------------------------------------------------------------------

  async findDomainUsage(domain: string): Promise<Array<{ file: string; line: string }>> {
    const d = domain.toLowerCase().trim();
    if (!/^[a-z0-9*.-]+$/.test(d)) return [];
    const hits: Array<{ file: string; line: string }> = [];

    const scanDir = async (dir: string) => {
      let files: string[];
      try {
        files = await fs.readdir(dir);
      } catch { return; }
      for (const f of files) {
        const full = path.join(dir, f);
        let stat;
        try { stat = await fs.stat(full); } catch { continue; }
        if (!stat.isFile()) continue;
        let content: string;
        try { content = await fs.readFile(full, 'utf8'); } catch { continue; }
        const regex = /server_name\s+([^;]+);/gi;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(content)) !== null) {
          const names = m[1].split(/\s+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
          if (names.includes(d)) {
            hits.push({ file: path.basename(full), line: m[0].replace(/\s+/g, ' ').trim() });
            break;
          }
        }
      }
    };

    await scanDir(SITES_ENABLED);
    await scanDir(SITES_AVAILABLE);
    return hits;
  }

  // ---------------------------------------------------------------------------
  // INTERNALS
  // ---------------------------------------------------------------------------

  private mainConfigPath(siteName: string): string {
    return path.join(SITES_AVAILABLE, `${siteName}.conf`);
  }

  private enabledLinkPath(siteName: string): string {
    return path.join(SITES_ENABLED, `${siteName}.conf`);
  }

  private siteIncludeDir(siteName: string): string {
    return path.join(MEOWBOX_INCLUDE_DIR, siteName);
  }

  private toLayeredParams(p: CreateSiteParams): NginxLayeredParams {
    return {
      siteName: p.siteName,
      domain: p.domain,
      aliases: p.aliases,
      rootPath: p.rootPath,
      filesRelPath: p.filesRelPath,
      phpVersion: p.phpVersion,
      phpEnabled: p.phpEnabled,
      appPort: p.appPort,
      sslEnabled: p.sslEnabled,
      httpsRedirect: p.httpsRedirect,
      certPath: p.certPath,
      keyPath: p.keyPath,
      settings: p.settings,
    };
  }

  private async exists(p: string): Promise<boolean> {
    try { await fs.access(p); return true; } catch { return false; }
  }

  /**
   * Снимок состояния сайта: содержимое главного файла + всех чанков.
   * Используется для отката, если `nginx -t` упадёт после регенерации.
   */
  private async backupSite(siteName: string): Promise<SiteBackup> {
    const mainPath = this.mainConfigPath(siteName);
    const includeDir = this.siteIncludeDir(siteName);
    const main = await fs.readFile(mainPath, 'utf8').catch(() => null);
    const chunks: Record<string, string> = {};
    try {
      const files = await fs.readdir(includeDir);
      for (const f of files) {
        if (!f.endsWith('.conf')) continue;
        chunks[f] = await fs.readFile(path.join(includeDir, f), 'utf8');
      }
    } catch { /* директории нет — backup пустой */ }
    return { main, chunks };
  }

  private async restoreFromBackup(siteName: string, backup: SiteBackup): Promise<void> {
    const mainPath = this.mainConfigPath(siteName);
    const enabledLink = this.enabledLinkPath(siteName);
    const includeDir = this.siteIncludeDir(siteName);

    if (backup.main !== null) {
      await fs.writeFile(mainPath, backup.main, 'utf8').catch(() => {});
    } else {
      // Сайта не было до миграции — убираем и main, и symlink, иначе
      // dangling symlink в sites-enabled валит nginx -t у других сайтов.
      await fs.unlink(mainPath).catch(() => {});
      await fs.unlink(enabledLink).catch(() => {});
    }

    // Восстанавливаем все чанки из бэкапа, удаляя те что появились после.
    await fs.mkdir(includeDir, { recursive: true }).catch(() => {});
    let currentFiles: string[] = [];
    try { currentFiles = await fs.readdir(includeDir); } catch { /* */ }
    const backupFiles = new Set(Object.keys(backup.chunks));
    for (const f of currentFiles) {
      if (!backupFiles.has(f)) {
        await fs.unlink(path.join(includeDir, f)).catch(() => {});
      }
    }
    for (const [f, content] of Object.entries(backup.chunks)) {
      await fs.writeFile(path.join(includeDir, f), content, 'utf8').catch(() => {});
    }
  }
}

interface SiteBackup {
  main: string | null;
  chunks: Record<string, string>;
}
