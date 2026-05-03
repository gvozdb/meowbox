/**
 * Discovery — пробинг сервера-источника hostPanel:
 *   1. SSH-проверка (whoami, distro)
 *   2. MySQL-проверка (SELECT 1)
 *   3. Чтение хостпанельной таблицы sites
 *   4. Для каждого сайта: list /var/www/<user>/, парсинг nginx/dumper/config.xml/config.inc.php
 *   5. Чтение root crontab + per-user crontabs (фильтрация и маппинг)
 *   6. Детект Manticore + список индексов
 *
 * Не меняет состояние источника. Использует только чтение через SshSourceBridge.
 *
 * Результат отдаётся API через socket.io ack-callback (`migrate:hostpanel:probe`).
 */

import { SshSourceBridge } from './ssh-source';
import {
  DiscoveryResult,
  MigrationSourceCreds,
  PlanItem,
  PlanItemCronJob,
  PlanItemSslInfo,
  ShortlistItem,
  ShortlistResult,
} from './types';
import { parseDumperYaml } from './parsers/dumper-yaml.parser';
import { parseConfigXml } from './parsers/config-xml.parser';
import { parseModxConfigInc } from './parsers/modx-config-inc.parser';
import { parseHostpanelNginx } from './parsers/nginx.parser';
import { parseCrontab } from './parsers/crontab.parser';
import { validateSqlIdentifier } from './sql-safety';
import { SUPPORTED_PHP_VERSIONS } from '../../config';

interface HostpanelSiteRow {
  id: number;
  idx: number;
  name: string;
  group: string;
  user: string;
  site: string;
  status: string;
  php: string;
  cms: string;
  version: string;
  layout: string;
  sftp_port: number;
  sftp_user: string;
  sftp_pass: string;
  mysql_site: string;
  mysql_db: string;
  mysql_user: string;
  mysql_pass: string;
  mysql_table_prefix: string;
  connectors_site: string;
  manager_site: string;
  manager_user: string;
  manager_pass: string;
  path: string;
  active: number;
  lock: number;
}

const HOME_OFF_BY_DEFAULT = new Set([
  'tmp', '.ssh', '.bash_logout', '.bashrc', '.profile', '.DS_Store',
  'pass.txt', 'chmod', 'access.nginx', 'domains.nginx', 'main.nginx',
  'config.xml', 'dumper.yaml',
]);

const DB_TABLE_NO_DATA_SUFFIXES = [
  'manager_log', 'session', 'smart_session',
  'register_messages', 'register_queues', 'register_topics',
  'active_users',
];

/**
 * Live-progress callback. Дёргается на каждом значимом шаге discovery —
 * agent.service.ts проксирует в socket → API broadcast'ит в комнату миграции
 * → UI отображает в реальном времени. Без onLog discovery работает молча
 * (на случай вызова из тестов/скриптов).
 *
 * step/total — для прогресс-бара. Шаги верхнеуровневые: SSH-check, distro,
 * sites-list, root-cron, user-crons, build-plan-per-site (каждый сайт).
 */
export type DiscoverLogCallback = (msg: string, step?: number, total?: number) => void;

/**
 * Phase 1 — Shortlist. Быстрый probe источника без тяжёлых per-site операций
 * (нет du -sb, нет размеров БД, нет парсинга nginx/config.xml). Только то,
 * что нужно для отображения галочки «выбрать сайт» в UI.
 *
 * Шаги:
 *   1. SSH whoami
 *   2. distro / nginx / mysql / php / manticore
 *   3. SELECT * FROM hostpanel_sites
 *   4. root crontab + per-user crontabs (для systemCronJobs — отображается
 *      в Step 3 поверх плана, оператор видит сразу)
 *   5. ОДИН вызов `du -sh /var/www/* /` (одна walk-traversal вместо N) —
 *      опционально с timeout, на огромных серверах могут быть «—»
 */
export async function runShortlist(
  creds: MigrationSourceCreds,
  onLog?: DiscoverLogCallback,
): Promise<ShortlistResult> {
  const log: DiscoverLogCallback = onLog ?? (() => {});
  const ssh = new SshSourceBridge({
    host: creds.host,
    port: creds.port,
    user: creds.sshUser,
    password: creds.sshPassword,
  });

  const TOTAL_STEPS = 5;

  // 1) SSH
  log(`Подключаюсь по SSH к ${creds.host}:${creds.port} как ${creds.sshUser}...`, 1, TOTAL_STEPS);
  const whoami = await ssh.run('whoami', { timeout: 30_000 });
  if (whoami.exitCode !== 0) {
    throw new Error(`SSH connection failed: ${whoami.stderr || 'no error message'}`);
  }
  if (whoami.stdout !== creds.sshUser) {
    throw new Error(
      `SSH: получили '${whoami.stdout}' вместо '${creds.sshUser}' — кривой логин?`,
    );
  }
  log(`✓ SSH-коннект ОК (whoami=${whoami.stdout})`, 1, TOTAL_STEPS);

  // 2) Source meta
  log('Определяю distro / nginx / mysql / php / manticore...', 2, TOTAL_STEPS);
  const sourceMeta = await detectSourceMeta(ssh);
  log(
    `✓ ${sourceMeta.distroId} ${sourceMeta.distroVersion}, nginx=${sourceMeta.nginxVersion ?? '—'}, ` +
    `mysql=${sourceMeta.mysqlVersion ?? '—'}, php=[${sourceMeta.phpVersionsInstalled.join(', ')}], ` +
    `manticore=${sourceMeta.manticoreInstalled ? `да (${sourceMeta.manticoreIndexes.length} индексов)` : 'нет'}`,
    2, TOTAL_STEPS,
  );

  // 3) hostpanel sites
  log(`Читаю список сайтов из ${creds.hostpanelDb}.${creds.hostpanelTablePrefix}hostpanel_sites...`, 3, TOTAL_STEPS);
  const sitesRaw = await fetchHostpanelSites(ssh, creds);
  const knownSiteUsers = new Set(sitesRaw.map((s) => s.user));
  log(`✓ Найдено сайтов: ${sitesRaw.length}`, 3, TOTAL_STEPS);

  // 4) Crontabs (нужны для systemCronJobs в UI и для будущего deep-probe)
  log('Читаю crontab root...', 4, TOTAL_STEPS);
  const rootCron = await ssh.run('crontab -u root -l 2>/dev/null || true');
  const rootParsed = parseCrontab(rootCron.stdout, 'root', knownSiteUsers);
  const rootRawTotal = countActiveCronLines(rootCron.stdout);
  const rootBySiteTotal = Array.from(rootParsed.bySite.values()).reduce(
    (n, arr) => n + arr.length,
    0,
  );
  log(
    `✓ root cron: всего активных строк ${rootRawTotal}, ` +
      `${rootParsed.system.length} system + ${rootBySiteTotal} per-site после фильтрации`,
    4, TOTAL_STEPS,
  );

  // 5) Грубые размеры www/. Один вызов `du -sh /var/www/<u>/www`
  //    через xargs — все за одну walk-traversal. Timeout 90с — на больших
  //    серверах du всё равно может тормозить. На таймауте — sizes=null.
  log(`Грубая оценка размеров (du -sh, может занять до 90с)...`, 5, TOTAL_STEPS);
  const sizesByUser = await collectApproxSizes(ssh, sitesRaw.map((s) => s.user));
  const knownSizes = Array.from(sizesByUser.values()).filter((v) => v !== null).length;
  log(`✓ Размеры собрал у ${knownSizes}/${sitesRaw.length} сайтов`, 5, TOTAL_STEPS);

  // Build shortlist items
  const items: ShortlistItem[] = sitesRaw.map((row) => {
    const phpV = row.php;
    const phpUnsupported = phpV && !SUPPORTED_PHP_VERSIONS.includes(phpV);
    const isAdminerLike =
      (row.cms === '' && (row.name === 'Adminer' || row.site.startsWith('db.'))) ||
      row.user === 'pma';
    const isHostUser = row.user === 'host';
    const warnings: string[] = [];
    if (isAdminerLike) warnings.push('Это Adminer-сайт — обычно не нужно переносить.');
    if (isHostUser) warnings.push('Это сама старая hostPanel — не переноси, не нужна.');
    if (phpV && !SUPPORTED_PHP_VERSIONS.includes(phpV)) {
      // Идёт в blockedReason ниже, дублируется в warnings оператору.
      warnings.push(
        `PHP ${phpV} не поддерживается meowbox (нужен Force PHP-override).`,
      );
    }
    return {
      sourceSiteId: row.id,
      sourceUser: row.user,
      sourceDomain: row.site,
      sourceName: row.name,
      sourceCms: row.cms === 'modx' ? 'modx' : null,
      sourceCmsVersion: row.version,
      sourcePhpVersion: phpV,
      sourceMysqlDb: row.mysql_db,
      newName: sanitizeName(row.user),
      newDomain: row.site,
      defaultSelected: !isAdminerLike && !isHostUser,
      fsBytesApprox: sizesByUser.get(row.user) ?? null,
      warnings,
      blockedReason: phpUnsupported
        ? `PHP ${phpV} не поддерживается meowbox (поддерживаемые: ${SUPPORTED_PHP_VERSIONS.join(', ')}).`
        : undefined,
    };
  });

  // Snapshot строк hostpanel-таблицы (без паролей, spec §3.2)
  const sourceRows: Record<number, Record<string, unknown>> = {};
  for (const row of sitesRaw) {
    const {
      mysql_pass: _omit1,
      sftp_pass: _omit2,
      manager_pass: _omit3,
      ...redacted
    } = row;
    sourceRows[row.id] = redacted;
  }

  return {
    sourceMeta,
    items,
    sourceRows,
    systemCronJobs: rootParsed.system,
    warnings: [],
  };
}

/**
 * Phase 2 — Deep probe только по выбранным сайтам. Делает повторный
 * shortlist (cheap — пара секунд без `du`) + полный buildPlanItem для
 * sourceSiteIds, что прислал оператор.
 *
 * Сайты, которых нет в выбранном списке, не возвращаются — мастер их
 * пометит SKIPPED.
 */
export async function runDeepProbeSelected(
  creds: MigrationSourceCreds,
  sourceSiteIds: number[],
  onLog?: DiscoverLogCallback,
): Promise<DiscoveryResult> {
  const log: DiscoverLogCallback = onLog ?? (() => {});
  const ssh = new SshSourceBridge({
    host: creds.host,
    port: creds.port,
    user: creds.sshUser,
    password: creds.sshPassword,
  });

  // Минимальный re-probe — без `du -sh` (мы и так сейчас сами полно
  // посчитаем du -sb по выбранным сайтам). Только sites + crontabs +
  // sourceMeta.
  log('Подключаюсь по SSH (deep-probe)...', 1);
  const whoami = await ssh.run('whoami', { timeout: 30_000 });
  if (whoami.exitCode !== 0) {
    throw new Error(`SSH connection failed: ${whoami.stderr || 'no error'}`);
  }
  log('✓ SSH ОК', 1);

  log('Source meta...', 2);
  const sourceMeta = await detectSourceMeta(ssh);
  log('✓ Source meta получены', 2);

  log('Список сайтов...', 3);
  const allSitesRaw = await fetchHostpanelSites(ssh, creds);
  const knownSiteUsers = new Set(allSitesRaw.map((s) => s.user));
  // Фильтруем только выбранные оператором IDs. Между фазой 1 и 2 список на
  // источнике мог измениться (оператор там что-то удалил) — отсутствующие
  // молча выкидываем из плана, мастер пометит их FAILED при попытке запуска.
  const requestedIds = new Set(sourceSiteIds);
  const sitesRaw = allSitesRaw.filter((s) => requestedIds.has(s.id));
  log(`✓ Найдено выбранных: ${sitesRaw.length} из ${requestedIds.size}`, 3);

  log('Читаю crontab root...', 4);
  const rootCron = await ssh.run('crontab -u root -l 2>/dev/null || true');
  const rootParsed = parseCrontab(rootCron.stdout, 'root', knownSiteUsers);
  log(`✓ root cron: ${rootParsed.system.length} system + ${rootParsed.bySite.size} site-bound users`, 4);

  log(`Читаю crontab для ${sitesRaw.length} выбранных пользователей...`, 5);
  const perUserCrons = new Map<string, PlanItemCronJob[]>();
  for (const row of sitesRaw) {
    const r = await ssh.run(`crontab -u '${row.user}' -l 2>/dev/null || true`);
    if (r.stdout.trim()) {
      const parsed = parseCrontab(r.stdout, row.user, knownSiteUsers);
      const flat = [
        ...(parsed.bySite.get(row.user) || []),
        ...parsed.system.map((j) => ({ ...j, target: 'this-site' as const })),
      ];
      perUserCrons.set(row.user, flat);
    }
  }
  log(`✓ user crontabs: ${perUserCrons.size} непустых`, 5);

  // Per-site полный probe (тяжёлая часть — du -sb, DB size, nginx/config.xml/dumper)
  const totalSites = sitesRaw.length;
  const sites: PlanItem[] = [];
  for (let i = 0; i < sitesRaw.length; i++) {
    const row = sitesRaw[i];
    const stepNo = 5 + i + 1;
    const stepTotal = 5 + totalSites;
    log(`[${i + 1}/${totalSites}] Сбор плана для «${row.name || row.user}» (${row.site || '—'})`, stepNo, stepTotal);
    const item = await buildPlanItem(ssh, creds, row, {
      cronFromRoot: rootParsed.bySite.get(row.user) || [],
      cronFromUser: perUserCrons.get(row.user) || [],
      installedPhp: sourceMeta.phpVersionsInstalled,
    }, log);
    sites.push(item);
  }
  log(`✓ Все ${totalSites} выбранных сайтов разобраны`, 5 + totalSites, 5 + totalSites);

  const sourceRows: Record<number, Record<string, unknown>> = {};
  for (const row of sitesRaw) {
    const {
      mysql_pass: _omit1,
      sftp_pass: _omit2,
      manager_pass: _omit3,
      ...redacted
    } = row;
    sourceRows[row.id] = redacted;
  }

  return {
    sourceMeta,
    sites,
    sourceRows,
    systemCronJobs: rootParsed.system,
    warnings: [],
  };
}

/**
 * Backward-compat: старый монолитный entry-point. Делает shortlist +
 * deep-probe ВСЕХ сайтов. Оставлен на случай если кто-то ещё дёргает по
 * старому контракту (тесты, скрипты). UI использует runShortlist +
 * runDeepProbeSelected.
 */
export async function runDiscovery(
  creds: MigrationSourceCreds,
  onLog?: DiscoverLogCallback,
): Promise<DiscoveryResult> {
  const log: DiscoverLogCallback = onLog ?? (() => {});
  const ssh = new SshSourceBridge({
    host: creds.host,
    port: creds.port,
    user: creds.sshUser,
    password: creds.sshPassword,
  });

  // 1) Sanity SSH
  log(`Подключаюсь по SSH к ${creds.host}:${creds.port} как ${creds.sshUser}...`, 1);
  const whoami = await ssh.run('whoami', { timeout: 30_000 });
  if (whoami.exitCode !== 0) {
    throw new Error(`SSH connection failed: ${whoami.stderr || 'no error message'}`);
  }
  if (whoami.stdout !== creds.sshUser) {
    throw new Error(
      `SSH: получили '${whoami.stdout}' вместо '${creds.sshUser}' — кривой логин?`,
    );
  }
  log(`✓ SSH-коннект ОК (whoami=${whoami.stdout})`, 1);

  // 2) Distro / nginx / mysql / php / manticore
  log('Определяю distro / nginx / mysql / php / manticore...', 2);
  const sourceMeta = await detectSourceMeta(ssh);
  log(
    `✓ ${sourceMeta.distroId} ${sourceMeta.distroVersion}, nginx=${sourceMeta.nginxVersion ?? '—'}, ` +
    `mysql=${sourceMeta.mysqlVersion ?? '—'}, php=[${sourceMeta.phpVersionsInstalled.join(', ')}], ` +
    `manticore=${sourceMeta.manticoreInstalled ? `да (${sourceMeta.manticoreIndexes.length} индексов)` : 'нет'}`,
    2,
  );

  // 3) Сайты из hostpanel-таблицы
  log(`Читаю список сайтов из ${creds.hostpanelDb}.${creds.hostpanelTablePrefix}hostpanel_sites...`, 3);
  const sitesRaw = await fetchHostpanelSites(ssh, creds);
  const knownSiteUsers = new Set(sitesRaw.map((s) => s.user));
  log(`✓ Найдено сайтов: ${sitesRaw.length}`, 3);

  // 4) Crontab — root и каждый user.
  // Считаем «сырые» (все непустые/некомментные строки) и «активные» (которые
  // парсер взял в работу: system + bySite). Раньше показывали `bySite.size`,
  // что было числом юзеров с привязками, а не строк — оператор путался.
  log('Читаю crontab root...', 4);
  const rootCron = await ssh.run('crontab -u root -l 2>/dev/null || true');
  const rootParsed = parseCrontab(rootCron.stdout, 'root', knownSiteUsers);
  const rootRawTotal = countActiveCronLines(rootCron.stdout);
  const rootBySiteTotal = Array.from(rootParsed.bySite.values()).reduce(
    (n, arr) => n + arr.length,
    0,
  );
  const rootAccepted = rootParsed.system.length + rootBySiteTotal;
  log(
    `✓ root cron: всего активных строк ${rootRawTotal}, из них взято ${rootAccepted} ` +
      `(${rootParsed.system.length} system + ${rootBySiteTotal} per-site), ` +
      `остальные отфильтрованы (dumper/certbot/letsencrypt и т.п.)`,
    4,
  );

  log(`Читаю crontab для ${knownSiteUsers.size} пользователей...`, 5);
  const perUserCrons = new Map<string, PlanItemCronJob[]>();
  let totalUserCronLines = 0;
  for (const u of knownSiteUsers) {
    const r = await ssh.run(`crontab -u '${u}' -l 2>/dev/null || true`);
    if (r.stdout.trim()) {
      const parsed = parseCrontab(r.stdout, u, knownSiteUsers);
      // Все строки этого юзера, независимо от path-маппинга, привязываем к нему
      const flat = [
        ...(parsed.bySite.get(u) || []),
        ...parsed.system.map((j) => ({ ...j, target: 'this-site' as const })),
      ];
      perUserCrons.set(u, flat);
      totalUserCronLines += flat.length;
    }
  }
  log(
    `✓ user crontabs: ${perUserCrons.size} непустых, всего активных строк ${totalUserCronLines}`,
    5,
  );

  // 5) Для каждого сайта — собираем PlanItem
  const totalSites = sitesRaw.length;
  const sites: PlanItem[] = [];
  for (let i = 0; i < sitesRaw.length; i++) {
    const row = sitesRaw[i];
    const stepNo = 5 + i + 1;
    const stepTotal = 5 + totalSites;
    log(`[${i + 1}/${totalSites}] Сбор плана для «${row.name || row.user}» (${row.site || '—'})`, stepNo, stepTotal);
    const item = await buildPlanItem(ssh, creds, row, {
      cronFromRoot: rootParsed.bySite.get(row.user) || [],
      cronFromUser: perUserCrons.get(row.user) || [],
      installedPhp: sourceMeta.phpVersionsInstalled,
    }, log);
    sites.push(item);
  }
  log(`✓ Все ${totalSites} сайтов разобраны`, 5 + totalSites, 5 + totalSites);

  // Снимок исходных строк hostpanel-таблицы — без полей с паролями (spec §3.2).
  // Используется мастером для записи в `hostpanel_migration_items.sourceData`.
  const sourceRows: Record<number, Record<string, unknown>> = {};
  for (const row of sitesRaw) {
    const {
      mysql_pass: _omit1,
      sftp_pass: _omit2,
      manager_pass: _omit3,
      ...redacted
    } = row;
    sourceRows[row.id] = redacted;
  }

  return {
    sourceMeta,
    sites,
    sourceRows,
    systemCronJobs: rootParsed.system,
    warnings: [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════

async function detectSourceMeta(ssh: SshSourceBridge): Promise<DiscoveryResult['sourceMeta']> {
  const distro = await ssh.run('. /etc/os-release && echo "${ID}|${VERSION_ID}"');
  const [distroId = 'unknown', distroVersion = ''] = distro.stdout.split('|');

  const nginxV = await ssh.run('nginx -v 2>&1 | head -1 | sed -nE "s/.*nginx\\/([0-9.]+).*/\\1/p" || true');
  const mysqlV = await ssh.run('mysql --version 2>/dev/null | sed -nE "s/.*Distrib ([0-9a-z.]+).*/\\1/p" || true');

  // PHP: ищем установленные `phpX.Y-fpm` бинарники
  const phpList = await ssh.run(
    'ls /etc/php 2>/dev/null | grep -E "^[0-9]+\\.[0-9]+$" | sort -V || true',
  );
  const phpVersionsInstalled = phpList.stdout.split('\n').filter((s) => /^[0-9]+\.[0-9]+$/.test(s));

  // Manticore
  const manticorePs = await ssh.run('pgrep -af "searchd|manticore" 2>/dev/null | head -1 || true');
  const manticoreInstalled = manticorePs.stdout.trim().length > 0;
  let manticoreIndexes: string[] = [];
  if (manticoreInstalled) {
    const dataLs = await ssh.run(
      'ls /var/lib/manticore 2>/dev/null | grep -vE "^(binlog|data|state\\.sql|manticore\\.json)$" || true',
    );
    manticoreIndexes = dataLs.stdout.split('\n').filter(Boolean);
  }

  return {
    distroId,
    distroVersion,
    nginxVersion: nginxV.stdout.trim() || null,
    mysqlVersion: mysqlV.stdout.trim() || null,
    phpVersionsInstalled,
    manticoreInstalled,
    manticoreIndexes,
  };
}

async function fetchHostpanelSites(
  ssh: SshSourceBridge,
  creds: MigrationSourceCreds,
): Promise<HostpanelSiteRow[]> {
  const tableName = `${creds.hostpanelTablePrefix}hostpanel_sites`;
  // spec §17.2: validateSqlIdentifier — единая точка валидации.
  // hostpanelTablePrefix может оканчиваться на `_` (modx_host_) — снимаем
  // его перед проверкой. Пустой prefix — валидно (таблица без префикса).
  const prefixCore = creds.hostpanelTablePrefix.replace(/_$/, '');
  if (prefixCore) validateSqlIdentifier(prefixCore, 'hostpanelTablePrefix');
  validateSqlIdentifier(creds.hostpanelDb, 'hostpanelDb', { allowDash: true });
  // Через ssh→mysql на источнике, JSON-output (--silent + tab-separated парсим вручную)
  const escSh = (s: string) => s.replace(/[\\$`"]/g, '\\$&');
  const sql = `SELECT id, idx, name, \\\`group\\\`, user, site, status, php, cms, version, layout, sftp_port, sftp_user, sftp_pass, mysql_site, mysql_db, mysql_user, mysql_pass, mysql_table_prefix, connectors_site, manager_site, manager_user, manager_pass, path, active, \\\`lock\\\` FROM ${tableName}`;
  const cmd =
    `MYSQL_PWD='${escSh(creds.mysqlPassword)}' mysql -h '${escSh(creds.mysqlHost)}' ` +
    `-P ${creds.mysqlPort} -u '${escSh(creds.mysqlUser)}' -B -N --raw ` +
    `'${escSh(creds.hostpanelDb)}' -e "${sql}"`;

  const r = await ssh.run(cmd, { timeout: 60_000, trim: false });
  if (r.exitCode !== 0) {
    throw new Error(`MySQL probe failed: ${r.stderr || 'unknown error'}`);
  }
  const lines = r.stdout.split('\n').filter(Boolean);
  return lines.map((line) => {
    const cols = line.split('\t');
    return {
      id: Number(cols[0]) || 0,
      idx: Number(cols[1]) || 0,
      name: cols[2] || '',
      group: cols[3] || '',
      user: cols[4] || '',
      site: cols[5] || '',
      status: cols[6] || '',
      php: cols[7] || '',
      cms: cols[8] || '',
      version: cols[9] || '',
      layout: cols[10] || '',
      sftp_port: Number(cols[11]) || 22,
      sftp_user: cols[12] || '',
      sftp_pass: cols[13] || '',
      mysql_site: cols[14] || '',
      mysql_db: cols[15] || '',
      mysql_user: cols[16] || '',
      mysql_pass: cols[17] || '',
      mysql_table_prefix: cols[18] || '',
      connectors_site: cols[19] || '',
      manager_site: cols[20] || '',
      manager_user: cols[21] || '',
      manager_pass: cols[22] || '',
      path: cols[23] || '',
      active: Number(cols[24]) || 0,
      lock: Number(cols[25]) || 0,
    };
  });
}

interface BuildContext {
  cronFromRoot: PlanItemCronJob[];
  cronFromUser: PlanItemCronJob[];
  installedPhp: string[];
}

async function buildPlanItem(
  ssh: SshSourceBridge,
  creds: MigrationSourceCreds,
  row: HostpanelSiteRow,
  ctx: BuildContext,
  log: DiscoverLogCallback = () => {},
): Promise<PlanItem> {
  const homeDir = `/var/www/${row.user}`;
  const webroot = row.path || `${homeDir}/www/`;
  const tag = `  [${row.user}]`;

  // 1) Содержимое хомдиры
  log(`${tag} ls ${homeDir}/`);
  let homeFiles: { name: string; kind: 'file' | 'dir'; bytes: number }[] = [];
  try {
    homeFiles = await ssh.listDir(homeDir);
  } catch {
    homeFiles = [];
  }

  // 2) Парсим nginx (все 3 файла)
  log(`${tag} парсинг nginx (access/domains/main)`);
  const nginxAccess = (await ssh.readFile(`${homeDir}/access.nginx`)) || '';
  const nginxDomains = (await ssh.readFile(`${homeDir}/domains.nginx`)) || '';
  const nginxMain = (await ssh.readFile(`${homeDir}/main.nginx`)) || '';
  const nginx = parseHostpanelNginx(nginxAccess + '\n' + nginxDomains + '\n' + nginxMain);

  // 3) Парсим dumper.yaml
  const dumperRaw = await ssh.readFile(`${homeDir}/dumper.yaml`);
  const dumper = dumperRaw ? parseDumperYaml(dumperRaw) : null;

  // 4) Парсим config.xml
  const configXmlRaw = await ssh.readFile(`${homeDir}/config.xml`);
  const configXml = configXmlRaw ? parseConfigXml(configXmlRaw) : null;

  // 5) Парсим www/core/config/config.inc.php (если MODX)
  const isModx = row.cms === 'modx';
  let configInc = null as ReturnType<typeof parseModxConfigInc> | null;
  if (isModx) {
    const configIncRaw = await ssh.readFile(`${webroot.replace(/\/$/, '')}/core/config/config.inc.php`);
    if (configIncRaw) configInc = parseModxConfigInc(configIncRaw);
  }

  // 6) Размеры
  log(`${tag} du -sb www/ (может быть медленно на больших сайтах)`);
  const fsBytes = await ssh.dirSize(`${homeDir}/www`);
  log(`${tag} ✓ www = ${(fsBytes / 1024 / 1024).toFixed(1)} MB`);

  let dbBytes = 0;
  // spec §13.2 / §14.2: если в hostpanel mysql_db пуст — fallback на
  // dumper.yaml::database.name → config.xml::database. Размер тогда тоже
  // нужно посчитать по правильному имени, иначе в UI будет «0 GB» и
  // оператор может пропустить большую базу.
  const effectiveDbName =
    row.mysql_db ||
    dumper?.database?.name ||
    configXml?.database ||
    '';
  if (effectiveDbName) {
    const dbName = effectiveDbName.replace(/[\\$`"']/g, '');
    let dbNameValid = false;
    try {
      validateSqlIdentifier(dbName, 'row.mysql_db', { allowDash: true });
      dbNameValid = true;
    } catch { /* пропускаем размер БД, не валим discovery */ }
    if (dbNameValid) {
      log(`${tag} размер БД '${dbName}'`);
      const r = await ssh.run(
        `MYSQL_PWD='${creds.mysqlPassword.replace(/[\\$`"]/g, '\\$&')}' ` +
        `mysql -h '${creds.mysqlHost}' -P ${creds.mysqlPort} -u '${creds.mysqlUser}' -B -N -e ` +
        `"SELECT IFNULL(SUM(data_length+index_length),0) FROM information_schema.tables WHERE table_schema='${dbName}'"`,
        { timeout: 30_000 },
      );
      dbBytes = Number(r.stdout) || 0;
      log(`${tag} ✓ DB ${dbName} = ${(dbBytes / 1024 / 1024).toFixed(1)} MB`);
    }
  }

  // 7) Mapping
  const newName = sanitizeName(row.user);
  const newDomain = nginx.mainDomain || row.site;
  const newAliases = nginx.aliases.length > 0 ? nginx.aliases : [];

  // 8) homeIncludes — формируем галочки
  const homeIncludes = homeFiles.map((f) => ({
    name: f.name,
    kind: f.kind,
    bytes: f.bytes,
    checked: !HOME_OFF_BY_DEFAULT.has(f.name),
  }));

  // 9) rsyncExtraExcludes — preset из dumper + наши defaults
  const baseExcludes = [
    '/www/core/cache/*',
    '/www/core/logs/*',
    '/www/_modxbackup/*',
    '/www/assets/components/*/tmp/*',
  ];
  const dumperExcludes = (dumper?.exclude || []).filter((s) => !!s);
  const rsyncExtraExcludes = Array.from(new Set([...baseExcludes, ...dumperExcludes]));

  // 10) dbExcludeDataTables — авто-prefilled (только для MODX)
  const tablePrefix =
    configInc?.tablePrefix || row.mysql_table_prefix || configXml?.tablePrefix || '';
  const dbExcludeDataTables = isModx && tablePrefix
    ? DB_TABLE_NO_DATA_SUFFIXES.map((s) => `${tablePrefix}${s}`)
    : [];

  // 11) cron'ы для этого сайта (из root по path-маппингу + per-user).
  // Дедуп по (schedule, command): на старых hostpanel-серверах часто одна
  // и та же задача дублирована и в /etc/crontab (sudo -u <user>), и в
  // crontab пользователя — без дедупа site cron на новом сервере побежит
  // дважды.
  const cronJobs: PlanItemCronJob[] = [];
  const cronSeen = new Set<string>();
  for (const j of [...ctx.cronFromRoot, ...ctx.cronFromUser]) {
    const key = `${j.schedule}|${j.command}`;
    if (cronSeen.has(key)) continue;
    cronSeen.add(key);
    cronJobs.push(j);
  }

  // 12) SSL
  const ssl: PlanItemSslInfo | null = await detectSslInfo(ssh, newDomain);

  // 13) Manager/Connectors dirs — приоритет hostpanel → nginx → config.xml
  // → config.inc.php → fallback (spec §14.2). config.xml/config.inc.php хранят
  // абсолютные пути либо URL-форму ('/adminka/') — вытаскиваем последний
  // непустой сегмент.
  const cfgManagerDir = configXml?.contextMgrPath
    ? stripSlashes(lastPathSegment(configXml.contextMgrPath))
    : '';
  const cfgConnectorsDir = configXml?.contextConnectorsPath
    ? stripSlashes(lastPathSegment(configXml.contextConnectorsPath))
    : '';
  // 4-й fallback: реально заполненный config.inc.php (manager_url/connectors_url
  // = '/adminka/' и '/connectors_xxx/'). Когда hostpanel.manager_site пустое
  // и nginx-блок не сматчился (одиночный location вместо группового) — без
  // этого fallback'а managerDir уйдёт в дефолтный 'manager', и MODX-админка
  // в новом сайте просто не откроется.
  const incManagerDir = configInc?.managerUrl
    ? stripSlashes(lastPathSegment(configInc.managerUrl))
    : configInc?.managerPath
      ? stripSlashes(lastPathSegment(configInc.managerPath))
      : '';
  const incConnectorsDir = configInc?.connectorsUrl
    ? stripSlashes(lastPathSegment(configInc.connectorsUrl))
    : configInc?.connectorsPath
      ? stripSlashes(lastPathSegment(configInc.connectorsPath))
      : '';
  const managerDir =
    stripSlashes(row.manager_site) ||
    nginx.managerDir ||
    cfgManagerDir ||
    incManagerDir ||
    'manager';
  const connectorsDir =
    stripSlashes(row.connectors_site) ||
    nginx.connectorsDir ||
    cfgConnectorsDir ||
    incConnectorsDir ||
    'connectors';

  // 14) PHP-FPM — читаем pool с источника по anchor (имя пула совпадает с user
  // в hostPanel), извлекаем ключевые параметры. Если pool не найден — дефолты.
  const phpFpm = await readSourcePhpFpmPool(ssh, row.user, row.php);

  // 15) nginx custom-snippet (CSP / bot-блок / неопознанные директивы).
  // HSTS не пишем сюда — он отслеживается через `Site.nginxHsts` и layered
  // 50-security шаблон сам вставит add_header (иначе при regen в UI флаг бы
  // потерялся). См. spec §7.2.
  const nginxCustomLines: string[] = [];
  if (nginx.csp) {
    nginxCustomLines.push(`add_header Content-Security-Policy "${nginx.csp}" always;`);
  }
  if (nginx.botBlock) {
    nginxCustomLines.push(
      '# bot-block (перенесён с hostpanel)',
      'if ($http_user_agent ~* (AhrefsBot|SemrushBot|MJ12bot|DotBot|PetalBot|BLEXBot)) { return 444; }',
    );
  }
  // MODX 2.x SEO-friendly URLs. layered-шаблоны (см. agent/src/nginx/templates.ts)
  // НЕ умеют рендерить @modx-rewrite сами — материализуем здесь, в custom,
  // чтобы friendly URLs работали после миграции. Spec §7.2.
  if (nginx.modxFriendlyUrls) {
    nginxCustomLines.push(
      '',
      '# MODX SEO-friendly URLs (перенесено с hostpanel)',
      'error_page 404 = @modx;',
      'location @modx {',
      '    rewrite ^/(.*)$ /index.php?q=$1&$args last;',
      '}',
    );
  }
  if (nginx.unknownSnippet) {
    nginxCustomLines.push('', nginx.unknownSnippet);
  }
  const nginxCustomConfig = nginxCustomLines.join('\n');

  // 15a) filesRelPath — webroot относительно /var/www/<u>/. Источник: nginx
  // root → fallback hostpanel.path → fallback 'www'. Spec §7.2.
  const filesRelPath = computeFilesRelPath(row.user, nginx.root, webroot);

  // 16) Warnings + blocked
  const warnings: string[] = [];
  let blockedReason: string | undefined;

  const phpV = row.php;
  if (!phpV) {
    warnings.push('PHP-версия не указана в hostpanel — будет 8.2 по умолчанию.');
  }
  if (phpV && !SUPPORTED_PHP_VERSIONS.includes(phpV)) {
    blockedReason =
      `PHP ${phpV} не поддерживается meowbox (поддерживаемые: ${SUPPORTED_PHP_VERSIONS.join(', ')}).`;
  } else if (phpV && !ctx.installedPhp.includes(phpV)) {
    warnings.push(`PHP ${phpV} не установлен на slave — поставь его в /php перед стартом.`);
  }

  if (row.cms === '' && (row.name === 'Adminer' || newDomain.startsWith('db.'))) {
    warnings.push('Это Adminer-сайт со старой панели — обычно не нужно переносить.');
  }
  if (row.user === 'host') {
    warnings.push('Это сама старая hostPanel — не переноси, не нужна.');
  }
  // spec §7.2: MODX SEO-friendly URLs detected. Наш стандартный layered
  // MODX_REVO шаблон сам генерит rewrite на index.php — флага достаточно
  // как информационного сигнала для оператора (если на источнике CMS не MODX,
  // но friendly URLs детектились — нужна ручная настройка).
  if (nginx.modxFriendlyUrls && !isModx) {
    warnings.push(
      'На источнике обнаружены MODX SEO-friendly URLs (rewrite на index.php), но сайт не помечен как MODX. После миграции проверь rewrite-блок вручную в /sites/<id>?tab=nginx.',
    );
  }

  return {
    sourceSiteId: row.id,
    sourceUser: row.user,
    sourceDomain: row.site,
    sourceWebroot: webroot,
    sourceCms: isModx ? 'modx' : null,
    sourceCmsVersion: row.version,
    sourcePhpVersion: phpV,
    sourceMysqlPrefix: tablePrefix,

    newName,
    newDomain,
    newAliases,
    aliasesRedirectToMain: nginx.aliasesRedirectToMain,
    phpVersion: phpV || '8.2',

    homeIncludes,
    rsyncExtraExcludes,
    dbExcludeDataTables,
    cronJobs,
    ssl,
    manticore: { enable: false },
    modxPaths: { connectorsDir, managerDir },
    phpFpm,
    nginxCustomConfig,
    nginxHsts: nginx.hsts,
    filesRelPath,

    fsBytes,
    dbBytes,

    warnings,
    blockedReason,
  };
}

async function detectSslInfo(ssh: SshSourceBridge, domain: string): Promise<PlanItemSslInfo | null> {
  if (!/^[a-zA-Z0-9.-]+$/.test(domain)) return null;
  const liveDir = `/etc/letsencrypt/live/${domain}`;
  const archiveDir = `/etc/letsencrypt/archive/${domain}`;
  const renewalConf = `/etc/letsencrypt/renewal/${domain}.conf`;

  const r = await ssh.run(`test -d '${liveDir}' && echo OK || echo NOPE`);
  if (r.stdout !== 'OK') return null;

  // Извлекаем SAN из cert.pem
  const certInfo = await ssh.run(
    `openssl x509 -in '${liveDir}/cert.pem' -noout -text 2>/dev/null | grep -oP 'DNS:[^,\\n ]+' | sed 's/DNS://g' | tr '\\n' ',' || true`,
  );
  const domainsInCert = certInfo.stdout
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    transfer: true,
    sourceLiveDir: liveDir,
    sourceArchiveDir: archiveDir,
    sourceRenewalConf: renewalConf,
    domainsInCert,
  };
}

// ═══════════════════════════════════════════════════════════════════════════

/**
 * Чтение PHP-FPM pool'а с источника. Файл может называться разными именами
 * (по `<user>.conf`, `<user>-fpm.conf`, `<anchor>.conf`), поэтому ищем grep'ом
 * любую конфу в pool.d, у которой `[<user>]` совпадает с linux-user сайта.
 */
async function readSourcePhpFpmPool(
  ssh: SshSourceBridge,
  user: string,
  phpVersion: string,
): Promise<PlanItem['phpFpm']> {
  const defaults: PlanItem['phpFpm'] = {
    pm: 'ondemand',
    pmMaxChildren: 10,
    uploadMaxFilesize: '100M',
    postMaxSize: '100M',
    memoryLimit: '256M',
    custom: '',
  };
  if (!user || !/^[a-zA-Z0-9_-]+$/.test(user)) return defaults;
  // Иногда php-fpm не установлен или путь нестандартный — best-effort.
  const phpDir = phpVersion && /^[0-9]+\.[0-9]+$/.test(phpVersion) ? phpVersion : '';
  const candidates = phpDir
    ? [`/etc/php/${phpDir}/fpm/pool.d`]
    : ['/etc/php/8.4/fpm/pool.d', '/etc/php/8.2/fpm/pool.d', '/etc/php/8.0/fpm/pool.d', '/etc/php/7.4/fpm/pool.d'];

  for (const dir of candidates) {
    // Ищем файл с заголовком [user]
    const r = await ssh.run(
      `grep -lE '^\\[${user}\\]' ${dir}/*.conf 2>/dev/null | head -1 || true`,
      { timeout: 10_000 },
    );
    const file = r.stdout.trim();
    if (!file) continue;
    const content = await ssh.readFile(file);
    if (!content) continue;
    return parsePhpFpmPool(content, defaults);
  }
  return defaults;
}

function parsePhpFpmPool(raw: string, defaults: PlanItem['phpFpm']): PlanItem['phpFpm'] {
  const get = (re: RegExp): string | null => raw.match(re)?.[1]?.trim() || null;
  const pmStr = get(/^\s*pm\s*=\s*(\w+)/m);
  const pm: PlanItem['phpFpm']['pm'] =
    pmStr === 'static' || pmStr === 'dynamic' || pmStr === 'ondemand'
      ? pmStr
      : defaults.pm;
  const pmMaxChildren = Number(get(/^\s*pm\.max_children\s*=\s*(\d+)/m)) || defaults.pmMaxChildren;
  const uploadMax = get(/php_admin_value\[upload_max_filesize\]\s*=\s*(\S+)/) || defaults.uploadMaxFilesize;
  const postMax = get(/php_admin_value\[post_max_size\]\s*=\s*(\S+)/) || defaults.postMaxSize;
  const memLimit = get(/php_admin_value\[memory_limit\]\s*=\s*(\S+)/) || defaults.memoryLimit;

  // custom = строки php_admin_value/php_value/env, которые мы не вытащили в стандартные поля
  const customLines: string[] = [];
  const customRe = /^(php_admin_value|php_admin_flag|php_value|php_flag|env)\[[^\]]+\]\s*=\s*.+$/gm;
  let m: RegExpExecArray | null;
  while ((m = customRe.exec(raw)) !== null) {
    const line = m[0];
    if (/upload_max_filesize|post_max_size|memory_limit/.test(line)) continue;
    customLines.push(line.trim());
  }

  return {
    pm,
    pmMaxChildren,
    uploadMaxFilesize: uploadMax,
    postMaxSize: postMax,
    memoryLimit: memLimit,
    custom: customLines.join('\n'),
  };
}

/**
 * Грубая оценка размеров www-директорий. Делает ОДИН вызов `du` через все
 * пути сразу — экономия N walk-traversal'ов. Парсит human-readable вывод
 * (`37G`, `2.1G`, `512M`, `34K`) обратно в байты-приблизительно.
 *
 * Timeout 90с. На фейле возвращает map где у всех юзеров null — фронт
 * покажет «—» в колонке размера, но не упадёт.
 *
 * Возвращает Map<sourceUser, bytes|null>.
 */
async function collectApproxSizes(
  ssh: SshSourceBridge,
  users: string[],
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  for (const u of users) result.set(u, null);
  if (users.length === 0) return result;

  // Только валидные имена — паранойя на случай мусора в hostpanel.user
  const safe = users.filter((u) => /^[a-z_][a-z0-9_-]*$/.test(u));
  if (safe.length === 0) return result;

  // `du -sh /var/www/<u>/www 2>/dev/null` для каждого юзера — формирует
  // одну строку в стдаут на каждый существующий путь. Несуществующие пути
  // молча пропускаются (через 2>/dev/null).
  const args = safe.map((u) => `/var/www/${u}/www`).join(' ');
  const r = await ssh.run(`du -sh ${args} 2>/dev/null || true`, { timeout: 90_000 });
  // Каждая строка: "37G\t/var/www/allgifts/www"
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^([0-9.,]+)([KMGTP]?)\s+\/var\/www\/([a-z_][a-z0-9_-]*)\/www$/);
    if (!m) continue;
    const num = parseFloat(m[1].replace(',', '.'));
    if (!Number.isFinite(num)) continue;
    const mult: Record<string, number> = {
      '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5,
    };
    const bytes = Math.round(num * (mult[m[2]] ?? 1));
    result.set(m[3], bytes);
  }
  return result;
}

/**
 * Считает «активные» строки crontab — без пустых и без комментариев. Не
 * пытается отличить корректную cron-строку от шума: задача — показать
 * оператору сколько вообще на сервере живых задач (включая отфильтрованные
 * парсером — dumper/certbot и т.п.). Парсер потом покажет, сколько он взял.
 */
function countActiveCronLines(raw: string): number {
  let n = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    if (/^\s*#/.test(line)) continue;
    n += 1;
  }
  return n;
}

function sanitizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[^a-z]+/, '')
    .substring(0, 32);
}

function stripSlashes(s: string): string {
  return (s || '').replace(/^\/+|\/+$/g, '');
}

function lastPathSegment(p: string): string {
  const trimmed = (p || '').replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}

/**
 * Webroot относительно /var/www/<sourceUser>/. Используется для `Site.filesRelPath`
 * и nginx-`root` на slave. Если nginx указывает /var/www/u/public_html/,
 * вернёт `'public_html'`. Если ничего не нашли — `'www'`.
 */
function computeFilesRelPath(
  sourceUser: string,
  nginxRoot: string | null,
  hostpanelPath: string,
): string {
  const homePrefix = `/var/www/${sourceUser}/`;
  const candidates = [nginxRoot, hostpanelPath].filter(Boolean) as string[];
  for (const raw of candidates) {
    let p = raw.trim().replace(/\/+$/, '');
    if (p.startsWith(homePrefix)) p = p.slice(homePrefix.length);
    else if (p.startsWith('/var/www/')) {
      // другой пользователь? игнорируем — это не наш webroot.
      continue;
    }
    p = p.replace(/^\/+/, '');
    // Берём первый сегмент (например `www/site_root` → `www`).
    const seg = p.split('/').filter(Boolean)[0];
    if (seg && /^[a-zA-Z0-9._-]+$/.test(seg)) return seg;
  }
  return 'www';
}
