/**
 * Перевод существующих сайтов на МУЛЬТИ-ДОМЕННУЮ nginx-раскладку.
 *
 * До: layered-схема с одним доменом —
 *   /etc/nginx/sites-available/{name}.conf  (server-блоки прямо в файле)
 *   /etc/nginx/meowbox/{name}/00..95-*.conf  (плоские чанки)
 *
 * После: один сайт = N основных доменов (`SiteDomain`) —
 *   /etc/nginx/sites-available/{name}.conf       (server-блок на каждый домен)
 *   /etc/nginx/meowbox/{name}/{domainId}/00..95-*.conf  (чанки per-domain)
 *
 * Зачем миграция, а не "регенерация по кнопке":
 *  - новые per-domain чанки ссылаются на rate-limit зону `mb_{domainId}`,
 *    которой нет в /etc/nginx/conf.d/meowbox-zones.conf (там legacy `site_{name}`);
 *  - первый же `nginx:create-config` на старом сайте падает `nginx -t`
 *    ("unknown limit_req zone"), агент откатывает конфиг → сайт навсегда
 *    застревает в старой раскладке. Любое изменение домена/алиаса/SSL
 *    молча не применяется.
 *
 * Что делает миграция (атомарно, с откатом):
 *  1. Рендерит для КАЖДОГО сайта мульти-доменный конфиг через
 *     `renderNginxSite` из собранного агента (agent/dist/nginx/templates.js).
 *  2. Пишет глобальный meowbox-zones.conf со всеми зонами `mb_{domainId}`.
 *  3. Пишет главные файлы + per-domain чанки, удаляет legacy flat-чанки.
 *  4. `nginx -t`. Упал — полный откат (главные файлы, деревья meowbox/{name}/,
 *     zones-файл восстанавливаются из снапшота) и throw. ОК — reload.
 *
 * Идемпотентность:
 *  - сайт, чей главный файл уже в мульти-доменной раскладке (маркер
 *    "# Домены:"), пропускается;
 *  - zones-файл переписывается всегда — содержимое детерминировано;
 *  - 95-custom.conf берётся из БД (`SiteDomain.nginxCustomConfig`), который
 *    backfill уже заполнил — повторный запуск даёт тот же результат.
 *
 * Требует: собранный агент на диске. Работающий API/agent НЕ нужен.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { siteNginxOverrides, nginxZoneName } from '@meowbox/shared';

import type { SystemMigration, MigrationContext } from './_types';

const SITES_AVAILABLE = '/etc/nginx/sites-available';
const SITES_ENABLED = '/etc/nginx/sites-enabled';
const MEOWBOX_INCLUDE_DIR = '/etc/nginx/meowbox';
const ZONES_PATH = '/etc/nginx/conf.d/meowbox-zones.conf';

/** Маркер мульти-доменного главного файла (его пишет новый renderNginxSite). */
const MULTI_DOMAIN_MARKER = '# Домены:';

// --- Контракт собранного агента (agent/dist/nginx/templates.js) -------------

interface RenderedDomain {
  domainId: string;
  chunks: Record<string, string>;
  customChunk?: { filename: string; content: string };
}
interface RenderedNginxSite {
  mainConfig: string;
  domains: RenderedDomain[];
}
interface AgentTemplatesModule {
  renderNginxSite(site: {
    siteName: string;
    rootPath: string;
    phpEnabled: boolean;
    phpVersion?: string;
    systemUser?: string;
    domains: Array<{
      domainId: string;
      domain: string;
      aliases: Array<{ domain: string; redirect: boolean }>;
      filesRelPath: string;
      appPort?: number | null;
      sslEnabled: boolean;
      certPath?: string | null;
      keyPath?: string | null;
      httpsRedirect: boolean;
      zoneName: string;
      settings: ReturnType<typeof siteNginxOverrides>;
      customConfig?: string | null;
    }>;
  }): RenderedNginxSite;
}

// --- Helpers ----------------------------------------------------------------

/** Парсит JSON-массив алиасов домена в нормализованную форму. */
function parseAliases(raw: string | null | undefined): Array<{ domain: string; redirect: boolean }> {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: Array<{ domain: string; redirect: boolean }> = [];
  for (const it of arr) {
    if (it && typeof it === 'object' && typeof (it as { domain?: unknown }).domain === 'string') {
      const dm = (it as { domain: string }).domain.trim();
      if (dm) out.push({ domain: dm, redirect: (it as { redirect?: unknown }).redirect === true });
    } else if (typeof it === 'string' && it.trim()) {
      out.push({ domain: it.trim(), redirect: false });
    }
  }
  return out;
}

/** Глобальный zones-файл: legacy `site_limit` + по одной зоне на домен. */
function buildZonesFile(zones: Array<{ zoneName: string; rps: number }>): string {
  const lines: string[] = [
    '# === Meowbox global rate-limit zones (управляется агентом) ===',
    '# Файл регенерируется при создании/удалении сайта и при изменении rate-limit настроек.',
    '# Не редактируй вручную — изменения будут затёрты.',
    '',
    '# Legacy fallback zone (для конфигов сайтов, которые ещё не пере-генерены под per-zone).',
    'limit_req_zone $binary_remote_addr zone=site_limit:10m rate=30r/s;',
    '',
  ];
  const seen = new Set<string>();
  for (const z of zones) {
    const safe = String(z.zoneName || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!safe || safe === 'site_limit' || seen.has(safe)) continue;
    seen.add(safe);
    const rate = z.rps && z.rps > 0 ? z.rps : 30;
    lines.push(`limit_req_zone $binary_remote_addr zone=${safe}:1m rate=${rate}r/s;`);
  }
  return lines.join('\n') + '\n';
}

/** Снимок дерева директории: относительный путь → содержимое файла. */
async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  const walk = async (d: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      const rp = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, rp);
      else if (e.isFile()) tree[rp] = await fs.readFile(abs, 'utf8').catch(() => '');
    }
  };
  await walk(dir, '');
  return tree;
}

/** Полностью пересобирает дерево директории из снапшота. */
async function restoreTree(dir: string, tree: Record<string, string>): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  for (const [rel, content] of Object.entries(tree)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true }).catch(() => {});
    await fs.writeFile(abs, content, 'utf8').catch(() => {});
  }
}

async function findBinary(ctx: MigrationContext, candidates: string[]): Promise<string | null> {
  for (const p of candidates) {
    if (await ctx.exists(p)) return p;
  }
  return null;
}

/** Снапшот состояния одного сайта (для отката). */
interface SiteSnapshot {
  name: string;
  main: string | null;
  tree: Record<string, string>;
}

const migration: SystemMigration = {
  id: '2026-05-15-002-nginx-multi-domain-rebuild',
  description: 'Перевод существующих сайтов на мульти-доменную nginx-раскладку + per-domain rate-limit зоны',

  async preflight(ctx) {
    const templatesPath = path.join(ctx.config.currentDir, 'agent', 'dist', 'nginx', 'templates.js');
    if (!(await ctx.exists(templatesPath))) {
      return { ok: false, reason: `agent/dist/nginx/templates.js не найден (${templatesPath}). Сначала make build.` };
    }
    return { ok: true };
  },

  async up(ctx) {
    const templatesPath = path.join(ctx.config.currentDir, 'agent', 'dist', 'nginx', 'templates.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const templates: AgentTemplatesModule = require(templatesPath);
    if (typeof templates.renderNginxSite !== 'function') {
      throw new Error('agent templates.js не экспортирует renderNginxSite — пересобери агента (make build).');
    }

    const sites = await ctx.prisma.site.findMany({
      include: { domains: { include: { sslCertificate: true }, orderBy: { position: 'asc' } } },
    });
    if (sites.length === 0) {
      ctx.log('Сайтов нет — миграция no-op');
      return;
    }
    ctx.log(`Сайтов в БД: ${sites.length}`);

    // --- Все rate-limit зоны (по всем доменам всех сайтов) -------------------
    const allZones: Array<{ zoneName: string; rps: number }> = [];
    for (const site of sites) {
      for (const d of site.domains) {
        allZones.push({
          zoneName: nginxZoneName(d.id),
          rps: d.nginxRateLimitRps && d.nginxRateLimitRps > 0 ? d.nginxRateLimitRps : 30,
        });
      }
    }
    const zonesContent = buildZonesFile(allZones);

    // --- Фаза A: рендер в памяти (чисто, без I/O) ----------------------------
    // Если рендер падает — выходим до записи на диск.
    const toWrite: Array<{ name: string; rendered: RenderedNginxSite }> = [];
    let alreadyMulti = 0;

    for (const site of sites) {
      if (site.domains.length === 0) {
        ctx.log(`  [${site.name}] !! нет ни одного SiteDomain — пропуск (запусти backfill)`);
        continue;
      }

      const mainPath = path.join(SITES_AVAILABLE, `${site.name}.conf`);
      const cur = await fs.readFile(mainPath, 'utf8').catch(() => null);
      if (cur && cur.includes(MULTI_DOMAIN_MARKER)) {
        alreadyMulti++;
        ctx.log(`  [${site.name}] уже мульти-доменный — skip`);
        continue;
      }

      const rendered = templates.renderNginxSite({
        siteName: site.name,
        rootPath: site.rootPath,
        phpEnabled: !!site.phpVersion,
        phpVersion: site.phpVersion ?? undefined,
        systemUser: site.systemUser ?? undefined,
        domains: site.domains.map((d) => {
          const ssl = d.sslCertificate;
          const sslActive = !!(ssl && ssl.status === 'ACTIVE' && ssl.certPath && ssl.keyPath);
          return {
            domainId: d.id,
            domain: d.domain,
            aliases: parseAliases(d.aliases),
            filesRelPath: d.filesRelPath?.trim() || site.filesRelPath?.trim() || 'www',
            appPort: d.appPort ?? null,
            sslEnabled: sslActive,
            certPath: sslActive ? ssl!.certPath : null,
            keyPath: sslActive ? ssl!.keyPath : null,
            httpsRedirect: d.httpsRedirect,
            zoneName: nginxZoneName(d.id),
            settings: siteNginxOverrides(d),
            customConfig: d.nginxCustomConfig ?? null,
          };
        }),
      });
      toWrite.push({ name: site.name, rendered });
    }

    if (ctx.dryRun) {
      ctx.log(`[dry-run] переписал бы zones-файл (${allZones.length} зон) + ${toWrite.length} сайтов; ` +
        `уже мульти-доменных: ${alreadyMulti}`);
      return;
    }

    if (toWrite.length === 0) {
      // Сайты не трогаем, но zones-файл всё равно приводим к актуальному виду.
      ctx.log('Все сайты уже мульти-доменные — синхронизирую только zones-файл');
    }

    // --- Фаза B: снапшоты для отката ----------------------------------------
    const zonesBackup = await fs.readFile(ZONES_PATH, 'utf8').catch(() => null);
    const siteSnapshots: SiteSnapshot[] = [];
    for (const { name } of toWrite) {
      const mainPath = path.join(SITES_AVAILABLE, `${name}.conf`);
      siteSnapshots.push({
        name,
        main: await fs.readFile(mainPath, 'utf8').catch(() => null),
        tree: await snapshotTree(path.join(MEOWBOX_INCLUDE_DIR, name)),
      });
    }

    // --- Фаза C: запись -----------------------------------------------------
    await fs.mkdir(path.dirname(ZONES_PATH), { recursive: true });
    await fs.writeFile(ZONES_PATH, zonesContent, 'utf8');
    await fs.chmod(ZONES_PATH, 0o644).catch(() => {});

    for (const { name, rendered } of toWrite) {
      const siteDir = path.join(MEOWBOX_INCLUDE_DIR, name);
      const mainPath = path.join(SITES_AVAILABLE, `${name}.conf`);
      const enabledLink = path.join(SITES_ENABLED, `${name}.conf`);

      await fs.mkdir(siteDir, { recursive: true });

      // Чанки каждого домена в meowbox/{name}/{domainId}/.
      for (const dom of rendered.domains) {
        const domDir = path.join(siteDir, dom.domainId);
        await fs.mkdir(domDir, { recursive: true });
        for (const [filename, content] of Object.entries(dom.chunks)) {
          await fs.writeFile(path.join(domDir, filename), content, 'utf8');
          await fs.chmod(path.join(domDir, filename), 0o644).catch(() => {});
        }
        if (dom.customChunk) {
          const customPath = path.join(domDir, dom.customChunk.filename);
          await fs.writeFile(customPath, dom.customChunk.content, 'utf8');
          await fs.chmod(customPath, 0o644).catch(() => {});
        }
      }

      // Удаляем legacy flat-чанки (meowbox/{name}/*.conf, .legacy-monolith.conf):
      // в мульти-доменной раскладке файлы живут только в {domainId}/.
      try {
        const entries = await fs.readdir(siteDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isFile()) await fs.unlink(path.join(siteDir, e.name)).catch(() => {});
        }
      } catch { /* директории нет — нечего чистить */ }

      // Главный файл + симлинк sites-enabled.
      await fs.writeFile(mainPath, rendered.mainConfig, 'utf8');
      await fs.chmod(mainPath, 0o644).catch(() => {});
      await fs.unlink(enabledLink).catch(() => {});
      await fs.symlink(mainPath, enabledLink);

      ctx.log(`  [${name}] переписан мульти-доменно (доменов: ${rendered.domains.length})`);
    }

    // --- Фаза D: nginx -t + reload (с откатом) ------------------------------
    const nginxBin = await findBinary(ctx, ['/usr/sbin/nginx', '/usr/local/sbin/nginx', '/usr/bin/nginx']);
    if (!nginxBin) {
      ctx.log('nginx бинарь не найден — пропускаю nginx -t. Перезагрузи nginx вручную: systemctl reload nginx');
      ctx.log(`OK: zones=${allZones.length}, rebuilt=${toWrite.length}, already_multi=${alreadyMulti}`);
      return;
    }

    try {
      const r = await ctx.exec.run(nginxBin, ['-t']);
      ctx.log(`nginx -t OK (${(r.stderr || '').replace(/\n/g, ' ').slice(0, 200)})`);
    } catch (e) {
      ctx.log(`nginx -t FAILED: ${(e as Error).message} — выполняю откат`);
      // Откат: zones-файл.
      if (zonesBackup !== null) {
        await fs.writeFile(ZONES_PATH, zonesBackup, 'utf8').catch(() => {});
      } else {
        await fs.unlink(ZONES_PATH).catch(() => {});
      }
      // Откат: каждый переписанный сайт.
      for (const snap of siteSnapshots) {
        const mainPath = path.join(SITES_AVAILABLE, `${snap.name}.conf`);
        const enabledLink = path.join(SITES_ENABLED, `${snap.name}.conf`);
        if (snap.main !== null) {
          await fs.writeFile(mainPath, snap.main, 'utf8').catch(() => {});
        } else {
          await fs.unlink(mainPath).catch(() => {});
          await fs.unlink(enabledLink).catch(() => {});
        }
        await restoreTree(path.join(MEOWBOX_INCLUDE_DIR, snap.name), snap.tree);
        ctx.log(`  [${snap.name}] откат выполнен`);
      }
      throw new Error(`nginx -t упал после перевода на мульти-домен — выполнен полный откат. Детали: ${(e as Error).message}`);
    }

    const systemctlBin = await findBinary(ctx, ['/usr/bin/systemctl', '/bin/systemctl']);
    if (systemctlBin) {
      await ctx.exec.run(systemctlBin, ['reload', 'nginx']).catch((e) => {
        ctx.log(`systemctl reload nginx skipped: ${(e as Error).message}`);
      });
    }

    ctx.log(`OK: zones=${allZones.length}, rebuilt=${toWrite.length}, already_multi=${alreadyMulti}`);
  },
};

export default migration;
