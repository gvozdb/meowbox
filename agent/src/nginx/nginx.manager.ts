/**
 * Nginx manager — генерирует и применяет layered-конфиги сайтов в МНОГО-ДОМЕННОЙ
 * модели:
 *
 *   /etc/nginx/sites-available/{siteName}.conf   ← главный (все server-блоки доменов)
 *   /etc/nginx/sites-enabled/{siteName}.conf     ← симлинк → sites-available
 *   /etc/nginx/meowbox/{siteName}/{domainId}/00..50-*.conf ← управляемые чанки домена
 *   /etc/nginx/meowbox/{siteName}/{domainId}/95-custom.conf ← редактируется юзером
 *
 * Контракт:
 *  1) `createSiteConfig()` регенерирует ВЕСЬ конфиг сайта (главный файл + чанки
 *     всех доменов). Чанки 00..50 переписываются полностью. Файлы `95-custom.conf`
 *     не трогаются (кроме forceWriteCustom). Директории доменов, которых нет в
 *     новом payload, удаляются.
 *  2) `setCustomConfig()` пишет ТОЛЬКО `95-custom.conf` конкретного домена и
 *     валидирует через `nginx -t`. При ошибке — откат из бэкапа.
 *  3) `removeSiteConfig()` удаляет всё: симлинк, главный файл, всю папку
 *     meowbox/{siteName}/ (включая custom — сайт удалён → custom не нужен).
 *
 * Атомарность: перед регенерацией снимается бэкап всего дерева
 * meowbox/{siteName}/ + главного файла; если `nginx -t` падает — откат.
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
  NginxSiteParams,
  renderNginxSite,
} from './templates';

const ZONES_PATH = '/etc/nginx/conf.d/meowbox-zones.conf';

const ZONES_HEADER =
`# === Meowbox global rate-limit zones (управляется агентом) ===
# Файл регенерируется при создании/удалении сайта и при изменении rate-limit настроек.
# Не редактируй вручную — изменения будут затёрты.

# Legacy fallback zone (для конфигов сайтов, которые ещё не пере-генерены под per-zone).
limit_req_zone $binary_remote_addr zone=site_limit:10m rate=30r/s;
`;

export class NginxManager {
  private readonly executor = new CommandExecutor();

  // ---------------------------------------------------------------------------
  // CREATE / UPDATE — весь сайт (все домены)
  // ---------------------------------------------------------------------------

  /**
   * Создаёт или обновляет ВЕСЬ конфиг сайта: главный файл + чанки всех доменов.
   * Чанки 00..50 переписываются полностью; `95-custom.conf` каждого домена
   * пишется только если он отсутствует и передан `customConfig`, либо если
   * `forceWriteCustom=true`. Директории доменов, отсутствующих в payload,
   * удаляются. Если `nginx -t` падает — всё дерево откатывается из бэкапа.
   */
  async createSiteConfig(site: NginxSiteParams): Promise<{ success: boolean; error?: string }> {
    if (!site.siteName) return { success: false, error: 'siteName required' };

    const rendered = renderNginxSite(site);
    const mainPath = this.mainConfigPath(site.siteName);
    const enabledLink = this.enabledLinkPath(site.siteName);
    const siteDir = this.siteIncludeDir(site.siteName);

    // Бэкап всего дерева meowbox/{siteName}/ + главного файла.
    const backup = await this.backupSite(site.siteName);

    try {
      await fs.mkdir(SITES_AVAILABLE, { recursive: true });
      await fs.mkdir(SITES_ENABLED, { recursive: true });
      await fs.mkdir(siteDir, { recursive: true });

      // 1. Чистим meowbox/{siteName}/:
      //    - директории доменов, которых нет в новом payload;
      //    - legacy flat-чанки (meowbox/{siteName}/*.conf, .legacy-monolith.conf):
      //      в мульти-доменной раскладке файлы живут только в {domainId}/,
      //      плоские .conf — наследие старой layered-схемы, иначе копятся мёртвыми.
      const wantedDomainIds = new Set(site.domains.map((d) => d.domainId));
      const existingDirs: string[] = [];
      const staleFlatFiles: string[] = [];
      try {
        const entries = await fs.readdir(siteDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) existingDirs.push(e.name);
          else if (e.isFile()) staleFlatFiles.push(e.name);
        }
      } catch { /* директории ещё нет */ }
      for (const f of staleFlatFiles) {
        await fs.unlink(path.join(siteDir, f)).catch(() => {});
      }
      for (const dir of existingDirs) {
        if (!wantedDomainIds.has(dir)) {
          await fs.rm(path.join(siteDir, dir), { recursive: true, force: true }).catch(() => {});
        }
      }

      // 2. Чанки каждого домена.
      for (const dom of rendered.domains) {
        const domDir = path.join(siteDir, dom.domainId);
        await fs.mkdir(domDir, { recursive: true });

        // Управляемые чанки 00..50 — переписываем полностью; удаляем устаревшие
        // (например 10-ssl.conf при выключении SSL).
        const desired = new Set(Object.keys(dom.chunks));
        const existing = await this.listManagedChunks(site.siteName, dom.domainId);
        for (const f of existing) {
          if (!desired.has(f)) {
            await fs.unlink(path.join(domDir, f)).catch(() => {});
          }
        }
        for (const [filename, content] of Object.entries(dom.chunks)) {
          await fs.writeFile(path.join(domDir, filename), content, 'utf8');
          await fs.chmod(path.join(domDir, filename), 0o644).catch(() => {});
        }

        // 95-custom.conf — особая логика сохранения.
        const customPath = path.join(domDir, '95-custom.conf');
        const customExists = await this.exists(customPath);
        const domInput = site.domains.find((d) => d.domainId === dom.domainId);
        const forceWrite = domInput?.forceWriteCustom === true;
        const customContent = dom.customChunk?.content;
        if (forceWrite) {
          await fs.writeFile(customPath, customContent ?? '', 'utf8');
          await fs.chmod(customPath, 0o644).catch(() => {});
        } else if (!customExists && typeof customContent === 'string') {
          await fs.writeFile(customPath, customContent, 'utf8');
          await fs.chmod(customPath, 0o644).catch(() => {});
        }
        // Файл существует и forceWriteCustom=false — оставляем (юзерский кастом).
      }

      // 3. Главный файл.
      await fs.writeFile(mainPath, rendered.mainConfig, 'utf8');
      await fs.chmod(mainPath, 0o644).catch(() => {});

      // 4. Симлинк sites-enabled.
      await fs.unlink(enabledLink).catch(() => {});
      await fs.symlink(mainPath, enabledLink);

      // 5. Тестируем и применяем.
      const test = await this.testConfig();
      if (!test.success) {
        await this.restoreFromBackup(site.siteName, backup);
        return { success: false, error: `nginx -t failed: ${test.error}` };
      }
      await this.reload();
      return { success: true };
    } catch (err) {
      await this.restoreFromBackup(site.siteName, backup).catch(() => {});
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Обновляет ТОЛЬКО `95-custom.conf` конкретного домена сайта. Используется
   * UI-вкладкой Nginx (PUT /sites/:id/nginx/custom).
   */
  async setCustomConfig(
    siteName: string,
    domainId: string,
    content: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!siteName) return { success: false, error: 'siteName required' };
    if (!domainId) return { success: false, error: 'domainId required' };
    const domDir = this.domainDir(siteName, domainId);
    const customPath = path.join(domDir, '95-custom.conf');
    const backupPath = `${customPath}.bak`;
    try {
      await fs.mkdir(domDir, { recursive: true });

      // Бэкап текущего файла.
      try {
        await fs.copyFile(customPath, backupPath);
      } catch { /* нет файла */ }

      await fs.writeFile(customPath, content, 'utf8');
      await fs.chmod(customPath, 0o644).catch(() => {});

      const test = await this.testConfig();
      if (!test.success) {
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

  /** Чтение содержимого 95-custom.conf конкретного домена (для UI). */
  async readCustomConfig(siteName: string, domainId: string): Promise<string | null> {
    try {
      return await fs.readFile(path.join(this.domainDir(siteName, domainId), '95-custom.conf'), 'utf8');
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
    const siteDir = this.siteIncludeDir(siteName);

    await fs.unlink(enabledLink).catch(() => {});
    await fs.unlink(mainPath).catch(() => {});
    await fs.rm(siteDir, { recursive: true, force: true }).catch(() => {});
    await this.reload().catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // READ
  // ---------------------------------------------------------------------------

  /** Главный файл сайта (для администратора в UI). */
  async readSiteConfig(siteName: string): Promise<string | null> {
    try {
      return await fs.readFile(this.mainConfigPath(siteName), 'utf8');
    } catch {
      return null;
    }
  }

  /** Список управляемых чанков (00..50) домена — для отладки/диагностики. */
  async listManagedChunks(siteName: string, domainId: string): Promise<string[]> {
    try {
      const all = await fs.readdir(this.domainDir(siteName, domainId));
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
  // GLOBAL ZONES (rate-limit зоны для всех доменов в одном файле)
  // ---------------------------------------------------------------------------

  /**
   * Перезаписывает `/etc/nginx/conf.d/meowbox-zones.conf` — глобальные
   * `limit_req_zone` директивы. По одной на каждую зону из payload + legacy-зона
   * `site_limit` (fallback для конфигов, ещё не пере-генеренных под per-zone).
   *
   * Атомарно с откатом: при `nginx -t` fail восстанавливаем бэкап.
   */
  async writeGlobalZones(
    zones: Array<{ zoneName: string; rps: number; enabled: boolean }>,
  ): Promise<{ success: boolean; error?: string }> {
    const backupPath = `${ZONES_PATH}.bak`;
    const lines: string[] = [ZONES_HEADER.trimEnd(), ''];
    const seen = new Set<string>();
    for (const z of zones) {
      const safe = String(z.zoneName || '').replace(/[^a-zA-Z0-9_-]/g, '_');
      if (!safe || safe === 'site_limit' || seen.has(safe)) continue;
      seen.add(safe);
      const rate = z.rps && z.rps > 0 ? z.rps : 30;
      // Зона создаётся даже если rate-limit отключён — чтобы конфиг сайта,
      // который ещё ссылается на неё, не падал на `nginx -t`.
      lines.push(`limit_req_zone $binary_remote_addr zone=${safe}:1m rate=${rate}r/s;`);
    }
    const content = lines.join('\n') + '\n';

    try { await fs.copyFile(ZONES_PATH, backupPath); } catch { /* ничего ещё нет */ }

    try {
      await fs.mkdir(path.dirname(ZONES_PATH), { recursive: true });
      await fs.writeFile(ZONES_PATH, content, 'utf8');
      await fs.chmod(ZONES_PATH, 0o644).catch(() => {});

      const test = await this.testConfig();
      if (!test.success) {
        try { await fs.copyFile(backupPath, ZONES_PATH); }
        catch { await fs.unlink(ZONES_PATH).catch(() => {}); }
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
   * Идемпотентно добавляет shared zone `{zoneName}` в meowbox-zones.conf, если
   * её там ещё нет. Нужно, когда регенерация полного списка зон со стороны API
   * невозможна (миграция Hostpanel: Site создаётся в БД master ПОСЛЕ apply-nginx).
   * Без этой страховки `nginx -t` падает: "zero size shared memory zone ...".
   *
   * NB: после persist Site мастер регенерит файл из БД авторитетно — этот
   * append временный.
   */
  async ensureZone(zoneName: string, rps = 30): Promise<void> {
    const safe = String(zoneName || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!safe || safe === 'site_limit') return;
    const zoneId = `zone=${safe}:`;
    const rate = rps && rps > 0 ? rps : 30;
    const newLine = `limit_req_zone $binary_remote_addr zone=${safe}:1m rate=${rate}r/s;`;

    let current = '';
    try { current = await fs.readFile(ZONES_PATH, 'utf8'); } catch { /* отсутствует — создадим */ }
    if (current.includes(zoneId)) return;

    const base = current && current.trim().length > 0 ? current : ZONES_HEADER;
    const next = base.endsWith('\n') ? `${base}${newLine}\n` : `${base}\n${newLine}\n`;
    await fs.mkdir(path.dirname(ZONES_PATH), { recursive: true });
    await fs.writeFile(ZONES_PATH, next, 'utf8');
    await fs.chmod(ZONES_PATH, 0o644).catch(() => {});
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
      // nginx -t возвращает >0 при ошибке конфига — это валидный сигнал,
      // не throw'абельная катастрофа.
      const r = await this.executor.execute('nginx', ['-t'], { allowFailure: true });
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
      const r = await this.executor.execute('systemctl', ['reload', 'nginx'], { allowFailure: true });
      if (r.exitCode === 0) return { success: true };
      return { success: false, error: r.stderr };
    } catch {
      return { success: true }; // systemctl недоступен — не валим операцию
    }
  }

  async restart(): Promise<{ success: boolean; error?: string }> {
    const r = await this.executor.execute('systemctl', ['restart', 'nginx'], { allowFailure: true });
    if (r.exitCode === 0) return { success: true };
    return { success: false, error: r.stderr };
  }

  async status(): Promise<{ running: boolean; version: string | null }> {
    // is-active возвращает 3 если не активен — валидно.
    const s = await this.executor.execute('systemctl', ['is-active', 'nginx'], { allowFailure: true });
    const running = s.stdout.trim() === 'active';
    let version: string | null = null;
    if (running) {
      const v = await this.executor.execute('nginx', ['-v'], { allowFailure: true });
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
    // Дедуп по basename: sites-enabled/{name}.conf — симлинк на
    // sites-available/{name}.conf, иначе один файл попадёт в hits дважды.
    const hits = new Map<string, { file: string; line: string }>();

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
        // Конфиги, сгенерированные Meowbox, пропускаем — уникальность доменов
        // внутри панели гарантирует БД (SiteDomain). Скан нужен лишь чтобы
        // поймать ЧУЖИЕ vhost'ы (другие панели, ручные конфиги).
        if (content.includes('Сгенерировано Meowbox')) continue;
        const regex = /server_name\s+([^;]+);/gi;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(content)) !== null) {
          const names = m[1].split(/\s+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
          if (names.includes(d)) {
            const base = path.basename(full);
            hits.set(base, { file: base, line: m[0].replace(/\s+/g, ' ').trim() });
            break;
          }
        }
      }
    };

    await scanDir(SITES_ENABLED);
    await scanDir(SITES_AVAILABLE);
    return [...hits.values()];
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

  /** Корневая директория чанков сайта: meowbox/{siteName}/ */
  private siteIncludeDir(siteName: string): string {
    return path.join(MEOWBOX_INCLUDE_DIR, siteName);
  }

  /** Директория чанков домена: meowbox/{siteName}/{domainId}/ */
  private domainDir(siteName: string, domainId: string): string {
    return path.join(MEOWBOX_INCLUDE_DIR, siteName, domainId);
  }

  private async exists(p: string): Promise<boolean> {
    try { await fs.access(p); return true; } catch { return false; }
  }

  /**
   * Снимок состояния сайта: содержимое главного файла + всего дерева
   * meowbox/{siteName}/ (рекурсивно). Используется для отката, если
   * `nginx -t` упадёт после регенерации.
   */
  private async backupSite(siteName: string): Promise<SiteBackup> {
    const mainPath = this.mainConfigPath(siteName);
    const siteDir = this.siteIncludeDir(siteName);
    const main = await fs.readFile(mainPath, 'utf8').catch(() => null);

    // Карта: относительный путь внутри siteDir → содержимое.
    const tree: Record<string, string> = {};
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch { return; }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          await walk(abs, relPath);
        } else if (e.isFile()) {
          tree[relPath] = await fs.readFile(abs, 'utf8').catch(() => '');
        }
      }
    };
    await walk(siteDir, '');
    return { main, tree };
  }

  private async restoreFromBackup(siteName: string, backup: SiteBackup): Promise<void> {
    const mainPath = this.mainConfigPath(siteName);
    const enabledLink = this.enabledLinkPath(siteName);
    const siteDir = this.siteIncludeDir(siteName);

    if (backup.main !== null) {
      await fs.writeFile(mainPath, backup.main, 'utf8').catch(() => {});
    } else {
      // Сайта не было до регенерации — убираем main и symlink, иначе
      // dangling symlink в sites-enabled валит nginx -t у других сайтов.
      await fs.unlink(mainPath).catch(() => {});
      await fs.unlink(enabledLink).catch(() => {});
    }

    // Полностью пересобираем дерево meowbox/{siteName}/ из бэкапа: сносим
    // текущее и восстанавливаем зафиксированное состояние.
    await fs.rm(siteDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(siteDir, { recursive: true }).catch(() => {});
    for (const [relPath, content] of Object.entries(backup.tree)) {
      const abs = path.join(siteDir, relPath);
      await fs.mkdir(path.dirname(abs), { recursive: true }).catch(() => {});
      await fs.writeFile(abs, content, 'utf8').catch(() => {});
    }
  }
}

interface SiteBackup {
  main: string | null;
  /** Относительный путь внутри meowbox/{siteName}/ → содержимое файла. */
  tree: Record<string, string>;
}
