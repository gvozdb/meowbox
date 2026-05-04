/**
 * Оркестратор миграции одного сайта со старой hostPanel.
 *
 * 13 стейджей (см. spec §6.1):
 *   1. pre-flight        — проверки конфликтов и места
 *   2. create-user       — useradd + setPassword (тот же sftp_pass из hostpanel)
 *   3. rsync-files       — rsync через sshpass от источника на slave
 *   4. db-create         — CREATE DATABASE + CREATE USER (тот же mysql_pass)
 *   5. db-dump-import    — ssh src "mysqldump --ignore-table=..." | mysql <new>
 *                         + отдельный --no-data dump для tables-no-data
 *   6. patch-modx        — sed -i по config.core.php (root + connectors + manager)
 *                          + правка core/config/config.inc.php (db creds, paths)
 *   7. apply-nginx       — генерация layered-конфига + (если есть) custom snippet
 *   8. apply-php-fpm     — generate pool с параметрами с источника
 *   9. import-cron       — bulk-create cron'ов для нового user'а
 *  10. enable-services   — Manticore (если plan.manticore.enable === true)
 *  11. copy-ssl          — scp архив LE + патч renewal/*.conf + симлинки
 *  12. verify            — curl --resolve <domain>:443:<slave_ip> → HTTP-код
 *  13. mark-running      — Site.status = RUNNING; вызывающий сохраняет в БД
 *
 * На любом сбое — текущий item помечается FAILED, выполняется per-item rollback
 * (cleanupArtifacts), но НИКОГДА не трогает существующие до миграции артефакты.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import type { Socket } from 'socket.io-client';

import { SshSourceBridge, writeMysqlOptsFile, dumpToFile, importFromGzFile } from './ssh-source';
import { PlanItem, MigrationSourceCreds } from './types';
import { validateSqlIdentifier, validateSqlPositiveInt } from './sql-safety';

import { SystemUserManager } from '../../system/user.manager';
import { DatabaseManager } from '../../database/database.manager';
import { NginxManager } from '../../nginx/nginx.manager';
import { PhpFpmManager } from '../../php/phpfpm.manager';
import { CronManager } from '../../cron/cron.manager';
import { CommandExecutor } from '../../command-executor';
import { SITES_BASE_PATH, LETSENCRYPT_LIVE_DIR } from '../../config';

interface RunCtx {
  socket: Socket | null;
  migrationId: string;
  itemId: string;
  plan: PlanItem;
  creds: MigrationSourceCreds;
  ssh: SshSourceBridge;
  exec: CommandExecutor;
  /** Soft-cancel токен — пробрасывается в долгоиграющие subprocess'ы (rsync/dump). */
  isCancelled?: () => boolean;
  /**
   * Контракт cleanup'а (см. spec §11.2): cleanup трогает только артефакты,
   * которые СОЗДАЛА текущая миграция. Каждый стейдж выставляет флаг при
   * успехе — на сбое cleanup использует флаги, чтобы не удалить чужое.
   */
  created: {
    user: boolean;
    webroot: boolean;
    db: boolean;
    nginx: boolean;
    phpfpm: boolean;
    ssl: boolean;
    cron: string[]; // ID-ы добавленных cron'ов
  };
  /**
   * Реальные креды, применённые на slave (заполняются по мере прохождения
   * стейджей). Возвращаются мастеру через RunItemResult.creds — он их
   * персистит в Site.sshPassword / Database.dbPasswordEnc (см. spec §6.2).
   */
  usedCreds: {
    sshPassword: string | null;
    dbName: string | null;
    dbUser: string | null;
    dbPassword: string | null;
    /**
     * Логин/пароль MODX-админа, перенесённые с источника (`manager_user`/
     * `manager_pass` из `modx_host_hostpanel_sites`). На hostpanel они хранятся
     * в плейне → переезжают 1-в-1 в `Site.cmsAdminUser`/`cmsAdminPassword`,
     * и блок CMS на странице сайта показывает Логин/Пароль/URL без отдельной
     * настройки оператором. Если не удалось вытащить — оставляем null,
     * UI покажет cmsAdminUser=null и блок свернётся в «Версия only»
     * (пользователь сможет задать вручную через ssh→mysql или модалку).
     */
    cmsAdminUser: string | null;
    cmsAdminPassword: string | null;
  };
}

interface StageResult {
  stage: string;
  ok: boolean;
  error?: string;
}

export interface RunItemResult {
  success: boolean;
  error?: string;
  newSiteId?: string;
  stages: StageResult[];
  /**
   * Метаданные SSL после успешного copy-ssl. ISO-строки. null если SSL не
   * переносился или openssl сломался — мастер тогда оставит SslCertificate
   * без expiresAt, обычный SSL-сканнер заполнит позже.
   */
  ssl?: {
    notBefore: string | null;
    notAfter: string | null;
  };
  /** Verify HTTP-код (из стейджа 12). */
  verifyHttpCode?: string | null;
  /**
   * Реальные креды, использованные при создании пользователя/БД на slave —
   * мастер сохраняет их в `Site.sshPassword`/`Database.dbPasswordEnc`.
   * См. spec §6.2: «В Site.sshPassword тоже сохраняем sftp_pass»,
   * «В Database.dbPasswordEnc шифруем тот же пароль (mysql_pass)».
   * Передаются ТОЛЬКО на in-memory socket-канале, НЕ логируются.
   */
  creds?: {
    sshPassword: string | null;
    dbName: string | null;
    dbUser: string | null;
    dbPassword: string | null;
    /** MODX manager_user/manager_pass с источника (см. RunCtx.usedCreds). */
    cmsAdminUser: string | null;
    cmsAdminPassword: string | null;
  };
}

const STAGES = [
  'pre-flight',
  'create-user',
  'rsync-files',
  'db-create',
  'db-dump-import',
  'patch-modx',
  'copy-ssl',
  'apply-nginx',
  'apply-php-fpm',
  'import-cron',
  'enable-services',
  'verify',
  'mark-running',
] as const;

export async function runItem(args: {
  socket: Socket | null;
  migrationId: string;
  itemId: string;
  plan: PlanItem;
  creds: MigrationSourceCreds;
  /** Soft-cancel: возвращает true → между стейджами кидаем 'Cancelled'. */
  isCancelled?: () => boolean;
}): Promise<RunItemResult> {
  const ctx: RunCtx = {
    ...args,
    ssh: new SshSourceBridge({
      host: args.creds.host,
      port: args.creds.port,
      user: args.creds.sshUser,
      password: args.creds.sshPassword,
    }),
    exec: new CommandExecutor(),
    isCancelled: args.isCancelled,
    created: {
      user: false,
      webroot: false,
      db: false,
      nginx: false,
      phpfpm: false,
      ssl: false,
      cron: [],
    },
    usedCreds: {
      sshPassword: null,
      dbName: null,
      dbUser: null,
      dbPassword: null,
      cmsAdminUser: null,
      cmsAdminPassword: null,
    },
  };
  const stages: StageResult[] = [];
  let sslMeta: { notBefore: string | null; notAfter: string | null } | undefined;
  let verifyHttpCode: string | null = null;

  let stageIdx = 0;
  const next = () => {
    if (args.isCancelled?.()) {
      throw new Error('Cancelled by operator');
    }
    const stage = STAGES[stageIdx++]!;
    emitProgress(ctx, stage, Math.floor((stageIdx / STAGES.length) * 100));
    log(ctx, `▶ ${stage}`);
    return stage;
  };

  try {
    // 0. CMS admin creds c источника (best-effort, не валим миграцию).
    // Дёргаем `manager_user`/`manager_pass` из `modx_host_hostpanel_sites`
    // через ssh→mysql. Этот же запрос делал discover.ts при scan'e, но
    // там значения вырезаются из sourceRows (spec §3.2 — не храним секреты
    // в открытом виде в БД мастера). Поэтому берём заново здесь, in-memory,
    // и отдаём мастеру через RunItemResult.creds.cmsAdminUser/Password —
    // он сразу сохранит в Site.cmsAdminUser/cmsAdminPassword.
    try {
      await fetchCmsAdminCreds(ctx);
      if (ctx.usedCreds.cmsAdminUser) {
        log(ctx, `  CMS admin: ${ctx.usedCreds.cmsAdminUser} (пароль перенесён с источника)`);
      }
    } catch (e) {
      // Не критично — оператор сможет задать вручную.
      log(ctx, `  CMS admin creds fetch warn: ${(e as Error).message}`);
    }

    // 1. pre-flight
    const s1 = next();
    await preflightStage(ctx);
    stages.push({ stage: s1, ok: true });

    // 2. create-user
    const s2 = next();
    await createUserStage(ctx);
    stages.push({ stage: s2, ok: true });

    // 3. rsync-files
    const s3 = next();
    await rsyncFilesStage(ctx);
    stages.push({ stage: s3, ok: true });

    // 4. db-create
    const s4 = next();
    await dbCreateStage(ctx);
    stages.push({ stage: s4, ok: true });

    // 5. db-dump-import
    const s5 = next();
    await dbDumpImportStage(ctx);
    stages.push({ stage: s5, ok: true });

    // 6. patch-modx (только для MODX)
    const s6 = next();
    if (ctx.plan.sourceCms === 'modx') {
      await patchModxStage(ctx);
    } else {
      log(ctx, '  not MODX — skip');
    }
    stages.push({ stage: s6, ok: true });

    // 7. copy-ssl (ДО apply-nginx — иначе nginx -t упадёт на отсутствующем cert)
    const s7 = next();
    if (ctx.plan.ssl?.transfer) {
      sslMeta = await copySslStage(ctx);
    } else {
      log(ctx, '  пропускаем — SSL не запрошен');
    }
    stages.push({ stage: s7, ok: true });

    // 8. apply-nginx
    const s8 = next();
    await applyNginxStage(ctx);
    stages.push({ stage: s8, ok: true });

    // 9. apply-php-fpm
    const s9 = next();
    await applyPhpFpmStage(ctx);
    stages.push({ stage: s9, ok: true });

    // 10. import-cron
    const s10 = next();
    await importCronStage(ctx);
    stages.push({ stage: s10, ok: true });

    // 11. enable-services
    const s11 = next();
    if (ctx.plan.manticore.enable) {
      // Реальный enable Manticore выполняется на master-стороне сразу после
      // persist Site (см. migration-hostpanel.service.ts::persistMigratedSiteRecords),
      // потому что services:site-enable требует Site.id который ещё не создан.
      // Здесь — только маркер в логе.
      log(ctx, '  Manticore enable будет выполнен мастером после persist Site');
    } else {
      log(ctx, '  не запрошено');
    }
    stages.push({ stage: s11, ok: true });

    // 12. verify
    const s12 = next();
    verifyHttpCode = await verifyStage(ctx);
    stages.push({ stage: s12, ok: true });

    // 13. mark-running (handled by caller / API service after success)
    const s13 = next();
    stages.push({ stage: s13, ok: true });

    log(ctx, `✓ migration item complete`);
    emitStatus(ctx, 'DONE');

    return {
      success: true,
      stages,
      ssl: sslMeta,
      verifyHttpCode,
      creds: { ...ctx.usedCreds },
    };
  } catch (err) {
    const msg = (err as Error).message;
    log(ctx, `✗ FAILED: ${msg}`);
    stages.push({ stage: STAGES[stageIdx - 1] || 'unknown', ok: false, error: msg });
    emitStatus(ctx, 'FAILED', msg);

    // Rollback (best-effort, никогда не валим из-за rollback'а)
    try {
      await cleanupArtifacts(ctx);
    } catch (e) {
      log(ctx, `cleanup warn: ${(e as Error).message}`);
    }

    return { success: false, error: msg, stages };
  }
}

// ═══════════════════ Stages ═══════════════════════════════════════════════

async function preflightStage(ctx: RunCtx) {
  // Path-traversal guards (spec §17.4): plan приходит с master'а — но мы
  // выполняем `useradd`, `mv`, `chown -R` по этим именам. Любая `../`
  // или нестандартный символ → отбой ДО изменений на диске.
  const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
  if (!NAME_RE.test(ctx.plan.newName)) {
    throw new Error(
      `newName='${ctx.plan.newName}' не соответствует ^[a-z][a-z0-9_-]{0,31}$`,
    );
  }
  const DIR_RE = /^[a-zA-Z0-9._-]{1,64}$/;
  if (!DIR_RE.test(ctx.plan.modxPaths.connectorsDir)) {
    throw new Error(
      `modxPaths.connectorsDir='${ctx.plan.modxPaths.connectorsDir}' содержит запрещённые символы`,
    );
  }
  if (!DIR_RE.test(ctx.plan.modxPaths.managerDir)) {
    throw new Error(
      `modxPaths.managerDir='${ctx.plan.modxPaths.managerDir}' содержит запрещённые символы`,
    );
  }
  if (
    ctx.plan.filesRelPath &&
    !/^[a-zA-Z0-9._-]{1,64}$/.test(ctx.plan.filesRelPath)
  ) {
    throw new Error(
      `filesRelPath='${ctx.plan.filesRelPath}' содержит запрещённые символы`,
    );
  }
  // sourceWebroot должен лежать под /var/www/<sourceUser>/ — иначе rsync
  // потащит чужой сайт.
  const homePrefix = `/var/www/${ctx.plan.sourceUser}/`;
  const normWebroot = path.normalize(ctx.plan.sourceWebroot || '');
  if (!normWebroot.startsWith(homePrefix) && !normWebroot.startsWith(`/var/www/${ctx.plan.sourceUser}`)) {
    throw new Error(
      `sourceWebroot='${ctx.plan.sourceWebroot}' не под /var/www/${ctx.plan.sourceUser}/`,
    );
  }

  const userManager = new SystemUserManager();
  const exists = await userManager.userExists(ctx.plan.newName);
  if (exists) {
    throw new Error(`Linux-юзер '${ctx.plan.newName}' уже существует на slave`);
  }
  // Проверка БД-конфликта: spec §2.2 требует «Database.name свободно». Master
  // делает то же на checkName, но между UI-валидацией и start может пройти
  // время → защищаемся ещё раз перед db-create.
  if (ctx.plan.sourceCms === 'modx' || ctx.plan.dbExcludeDataTables?.length) {
    const dbCheck = await ctx.exec.execute('mariadb', [
      '-N', '-B', '-e',
      `SELECT 1 FROM information_schema.schemata WHERE schema_name='${ctx.plan.newName}'`,
    ]);
    if (dbCheck.exitCode === 0 && dbCheck.stdout.trim() === '1') {
      throw new Error(`БД '${ctx.plan.newName}' уже существует на slave`);
    }
  }

  // df / -B M на webroot — нужно >= 1.5 × fsBytes
  const r = await ctx.exec.execute('df', ['-B1', '--output=avail', SITES_BASE_PATH]);
  if (r.exitCode === 0) {
    const lines = r.stdout.split('\n').filter(Boolean);
    const avail = Number(lines[1] || 0);
    if (avail > 0 && avail < ctx.plan.fsBytes * 1.5) {
      throw new Error(
        `На ${SITES_BASE_PATH} мало места: ${Math.round(avail / 1e9)}GB free vs ${Math.round(ctx.plan.fsBytes * 1.5 / 1e9)}GB needed`,
      );
    }
  }
}

async function createUserStage(ctx: RunCtx) {
  const userManager = new SystemUserManager();
  const homeDir = path.join(SITES_BASE_PATH, ctx.plan.newName);

  // SSH-пароль — берём его из hostpanel sftp_pass через SshSourceBridge:
  // на момент discovery его не сохранили в plan (security). Ре-фетчим из
  // источника прямо тут (одно SQL-чтение).
  let sftpPass = await fetchSftpPasswordFromHostpanel(ctx);
  // spec §6.2: «в hostpanel-таблице есть sftp_pass — это наш источник». Но
  // на vm120 встречаются строки с пустым sftp_pass (NULL/''), особенно для
  // ранее созданных вручную сайтов. usermod --password "" создаст
  // password-less аккаунт → SSH/SFTP отвалится. Fallback: рандом + WARN.
  let sshPasswordRandomized = false;
  if (!sftpPass || sftpPass.trim() === '') {
    sftpPass = randomBytes(16).toString('base64url');
    sshPasswordRandomized = true;
    log(ctx, `  ⚠ sftp_pass на источнике пуст — генерирую случайный пароль (см. /sites/${ctx.plan.newName}/credentials)`);
  }

  const result = await userManager.createUser(ctx.plan.newName, homeDir, sftpPass);
  if (!result.success) {
    throw new Error(`createUser failed: ${result.error}`);
  }
  ctx.created.user = true;
  ctx.created.webroot = true; // useradd создал homeDir
  // Сохраняем для return — мастер положит в Site.sshPassword (spec §6.2)
  ctx.usedCreds.sshPassword = sftpPass;
  log(
    ctx,
    sshPasswordRandomized
      ? `  пользователь ${ctx.plan.newName} создан, SSH-пароль = СЛУЧАЙНЫЙ (источник был пуст)`
      : `  пользователь ${ctx.plan.newName} создан, SSH-пароль = тот же что на источнике`,
  );
}

async function rsyncFilesStage(ctx: RunCtx) {
  const sourceHome = `/var/www/${ctx.plan.sourceUser}`;
  const targetHome = path.join(SITES_BASE_PATH, ctx.plan.newName);

  // Готовим rsync include/exclude
  // По дефолту берём всё из homeIncludes.checked, exclude'им неотмеченные
  const excludes = ctx.plan.homeIncludes
    .filter((f) => !f.checked)
    .map((f) => f.kind === 'dir' ? `/${f.name}/` : `/${f.name}`);
  const extraExcludes = ctx.plan.rsyncExtraExcludes;
  const allExcludes = [...excludes, ...extraExcludes];

  const sshSpec = (ctx.ssh as SshSourceBridge).rsyncSshSpec();
  const env = { ...process.env, ...(ctx.ssh as SshSourceBridge).rsyncEnv() };

  const args = [
    '-aHAX',
    // progress2 → один сводный % по всем файлам.
    // name0 → не печатает имена файлов (тихо, без громких логов).
    '--info=progress2,name0',
    '--no-inc-recursive',
    '-e', sshSpec,
    ...allExcludes.flatMap((e) => ['--exclude', e]),
    `${ctx.creds.sshUser}@${ctx.creds.host}:${sourceHome}/`,
    `${targetHome}/`,
  ];

  log(ctx, `  rsync ${sourceHome}/ → ${targetHome}/  (${allExcludes.length} excludes)`);

  // Маппим внутристейджевый прогресс rsync (0..100%) на общую шкалу миграции.
  // 'rsync-files' — 3-й стейдж из 13 (см. STAGES). Stage-base считаем из той же
  // формулы, что и в next() (см. выше).
  const stageIdx1 = STAGES.indexOf('rsync-files') + 1; // 1-based
  const stageStartPct = ((stageIdx1 - 1) / STAGES.length) * 100;
  const stageEndPct = (stageIdx1 / STAGES.length) * 100;
  let lastEmittedPct = -1;
  let lastEmittedAt = 0;

  // Регексп под `--info=progress2` rsync. Пример строки:
  //   "  1,234,567,890  45%   12.34MB/s    0:01:23 (xfr#1234, to-chk=5678/9012)"
  // Захватываем percent (group 2), speed (group 3), eta (group 4).
  const RSYNC_PROGRESS_RE = /^[\s\d,]+\s+(\d{1,3})%\s+(\S+)\s+(\d+:\d+:\d+)/;

  const handleLine = (line: string) => {
    const m = line.match(RSYNC_PROGRESS_RE);
    if (!m) {
      // Не прогресс-строка — обычный лог (warning/error/summary).
      log(ctx, `    ${line}`);
      return;
    }
    const subPct = Math.max(0, Math.min(100, parseInt(m[1]!, 10)));
    const speed = m[2]!;
    const eta = m[3]!;
    const overall = stageStartPct + (subPct / 100) * (stageEndPct - stageStartPct);
    const overallInt = Math.floor(overall);
    const now = Date.now();
    // Throttle: не чаще раза в секунду И только если процент сдвинулся.
    if (overallInt !== lastEmittedPct && now - lastEmittedAt >= 800) {
      lastEmittedPct = overallInt;
      lastEmittedAt = now;
      emitProgress(ctx, 'rsync-files', overallInt);
      log(ctx, `    rsync ${subPct}% @ ${speed} eta ${eta}`);
    }
  };

  await runStreaming('rsync', args, {
    env,
    onLine: handleLine,
    timeoutMs: 12 * 60 * 60 * 1000,
    isCancelled: ctx.isCancelled,
  });

  // chown -R newName:newName на webroot (после rsync файлы пришли с UID источника)
  await ctx.exec.execute('chown', ['-R', `${ctx.plan.newName}:${ctx.plan.newName}`, targetHome]);
  log(ctx, `  chown -R ${ctx.plan.newName}:${ctx.plan.newName} ${targetHome}`);
}

async function dbCreateStage(ctx: RunCtx) {
  // Из hostpanel-таблицы тащим mysql_db / mysql_user / mysql_pass
  const src = await fetchHostpanelDbCreds(ctx);
  const dbManager = new DatabaseManager();

  // На slave имя БД и юзера = Site.name (ctx.plan.newName), пароль — тот же,
  // что и в источнике. Спека §6.2: «БД-юзера с тем же mysql_user/mysql_pass».
  // (имя БД переименовали под Site.name, но пароль и сам факт креда
  // переезжают как есть — иначе MODX не подключится после patch-modx).
  const result = await dbManager.createDatabase({
    name: ctx.plan.newName,
    type: 'MARIADB',
    dbUser: ctx.plan.newName,
    password: src.dbPass,
  });
  if (!result.success) {
    throw new Error(`DB create failed: ${result.error}`);
  }
  ctx.created.db = true;
  // Сохраняем креды для return — мастер зашифрует в Database.dbPasswordEnc
  ctx.usedCreds.dbName = ctx.plan.newName;
  ctx.usedCreds.dbUser = ctx.plan.newName;
  ctx.usedCreds.dbPassword = src.dbPass || null;
  log(ctx, `  CREATE DATABASE ${ctx.plan.newName}, USER ${ctx.plan.newName} (тот же пароль что у источника)`);
}

async function dbDumpImportStage(ctx: RunCtx) {
  const src = await fetchHostpanelDbCreds(ctx);

  // Готовим список --ignore-table для tables-no-data.
  // Имена таблиц — строго whitelist (spec §17.2). Кривые отбрасываем
  // молча: оператор сам увидит warning в логе если таблица не пропустится.
  validateSqlIdentifier(src.dbName, 'src.dbName');
  const ignoreArgs: string[] = [];
  for (const t of ctx.plan.dbExcludeDataTables) {
    try {
      validateSqlIdentifier(t, 'tableName');
    } catch {
      log(ctx, `  ⚠ skipping invalid table name: '${t}'`);
      continue;
    }
    ignoreArgs.push(`--ignore-table=${src.dbName}.${t}`);
  }

  const remoteCmd = (ctx.ssh as SshSourceBridge).buildMysqldumpRemote({
    user: ctx.creds.mysqlUser,
    password: ctx.creds.mysqlPassword,
    host: ctx.creds.mysqlHost,
    port: ctx.creds.mysqlPort,
    database: src.dbName,
    extraArgs: ignoreArgs,
  });

  // Локальный mysql/mariadb для импорта
  const localOpts = await writeMysqlOptsFile({
    user: 'root',
    password: '', // root-сокет, mariadb на ubuntu — без пароля для root@unix
  });

  // Куда складывать .sql.gz: /var/lib для durability (не tmpfs!).
  // Имя: <new>-<itemId>.sql.gz — itemId уникален, retry перезапишет файл.
  const dumpDir = '/var/lib/meowbox-migration';
  await fs.mkdir(dumpDir, { recursive: true, mode: 0o700 }).catch(() => {});
  const dumpFile = path.join(dumpDir, `${ctx.plan.newName}-${ctx.itemId}.sql.gz`);
  const noDataDumpFile = path.join(dumpDir, `${ctx.plan.newName}-${ctx.itemId}-schema.sql.gz`);

  // Внутренний retry для dump-стадии: если ssh умер посередине — у нас
  // частичный gzip-файл, попытка №2 перезапишет его. До 3 попыток с
  // экспоненциальным бэкоффом. Каждая попытка — новый ssh-процесс с
  // ServerAlive (см. SSH_OPTS).
  const dumpAttempt = async (
    label: string,
    remote: string,
    out: string,
    timeoutMs: number,
    maxRetries: number,
  ): Promise<{ ok: boolean; bytes: number; lastError: string }> => {
    let lastError = '';
    let bytes = 0;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      log(
        ctx,
        `  [${label}] dump→file попытка ${attempt}/${maxRetries}: ${out}`,
      );
      const r = await dumpToFile({
        ssh: ctx.ssh,
        remoteCommand: remote,
        outputPath: out,
        onLog: (line) => log(ctx, line),
        timeoutMs,
        isCancelled: ctx.isCancelled,
      });
      bytes = r.bytesWritten;
      if (r.exitCode === 0) {
        // exit=0 ещё не значит что файл валидный — ssh может вернуть 0,
        // если remote-команда отдала EOF посередине дампа (читалась
        // частично закрытая mysqldump-сессия). Проверяем целостность gz:
        // если `gzip -t` падает — файл обрезан, нужен retry.
        const gzCheck = await checkGzIntegrity(out);
        if (gzCheck.ok) {
          const mb = (bytes / 1024 / 1024).toFixed(1);
          log(ctx, `  [${label}] dump→file OK: ${mb} MB (gzip integrity OK)`);
          return { ok: true, bytes, lastError: '' };
        }
        lastError = `gz integrity check failed: ${gzCheck.error.slice(0, 300)} (file ${bytes} B)`;
        log(
          ctx,
          `  [${label}] dump→file ssh exit=0 НО gz битый: ${lastError} — retry`,
        );
        if (attempt < maxRetries) {
          const backoff = Math.min(60_000, 5_000 * 2 ** (attempt - 1));
          log(ctx, `  [${label}] backoff ${backoff}ms перед retry...`);
          await new Promise((res) => setTimeout(res, backoff));
        }
        continue;
      }
      lastError = r.stderr.slice(0, 500);
      log(
        ctx,
        `  [${label}] dump→file попытка ${attempt} упала (exit=${r.exitCode}): ${lastError}`,
      );
      // Cancel-токен — не ретраим
      if (ctx.isCancelled?.()) break;
      if (attempt < maxRetries) {
        const backoff = Math.min(60_000, 5_000 * 2 ** (attempt - 1));
        log(ctx, `  [${label}] backoff ${backoff}ms перед retry...`);
        await new Promise((res) => setTimeout(res, backoff));
      }
    }
    return { ok: false, bytes, lastError };
  };

  // На failure импорта НЕ удаляем dump-файл — оператор может посмотреть
  // содержимое (`zcat | head -n N` от падающей строки) и понять что не так.
  // Помечаем `keepDumpOnFailure=true` если упал именно import, чтобы finally
  // оставил файл. Удаляются файлы только при успехе.
  let keepDumpOnFailure = false;
  try {
    log(
      ctx,
      `  Stage 1/2: dump в файл ${dumpFile} (gzip-1, ssh-keepalive, stall 10min)`,
    );
    const dumpRes = await dumpAttempt(
      'data',
      remoteCmd,
      dumpFile,
      2 * 60 * 60 * 1000, // 2 ч на одну попытку — большие dumps укладываются
      3,
    );
    if (!dumpRes.ok) {
      throw new Error(
        `Dump→file failed после 3 попыток: ${dumpRes.lastError || 'unknown'}`,
      );
    }
    if (dumpRes.bytes < 32) {
      throw new Error(
        `Dump→file: подозрительно маленький файл (${dumpRes.bytes} B), возможно ssh не подключился`,
      );
    }

    log(ctx, `  Stage 2/2: import gunzip ${dumpFile} → mariadb ${ctx.plan.newName}`);
    // --default-character-set=utf8mb4 — должен совпадать с dump'ом.
    // --init-command — снимаем strict-режим/FK-проверки на время импорта:
    //   старые MODX-дампы часто содержат строки длиннее новых VARCHAR-колонок,
    //   нулевые DATE, и т.п. — без релакса strict-режима MariaDB их режектит.
    //   FK выключаем на время импорта, чтобы порядок таблиц не имел значения.
    const importRes = await importFromGzFile({
      inputPath: dumpFile,
      localCommand: 'mariadb',
      localArgs: [
        `--defaults-extra-file=${localOpts}`,
        '--max-allowed-packet=1G',
        '--default-character-set=utf8mb4',
        `--init-command=SET sql_mode='', SESSION FOREIGN_KEY_CHECKS=0, SESSION UNIQUE_CHECKS=0`,
        ctx.plan.newName,
      ],
      onLog: (line) => log(ctx, line),
      timeoutMs: 4 * 60 * 60 * 1000,
      isCancelled: ctx.isCancelled,
    });
    if (importRes.exitCode !== 0) {
      // mariadb на ошибке echo'ит failing query внутри `--------------\n<sql>\n--------------\n`,
      // и уже потом строку `ERROR <code> ...`. Slice(0, 500) часто отрезается на
      // самом dump'е, не доходя до ERROR-строки. Вытаскиваем именно ERROR-line
      // (если есть) и пишем её первой, чтобы оператор видел причину сразу.
      keepDumpOnFailure = true;
      log(ctx, `  ⚠ dump оставлен на диске для диагностики: ${dumpFile}`);
      throw new Error(`Import failed: ${extractMariaDbError(importRes.stderr)}`);
    }
    log(ctx, `  ✓ data dump+import OK`);

    // Отдельным проходом — schema-only для tables-no-data
    if (ctx.plan.dbExcludeDataTables.length > 0) {
      const noDataCmd = (ctx.ssh as SshSourceBridge).buildMysqldumpRemote({
        user: ctx.creds.mysqlUser,
        password: ctx.creds.mysqlPassword,
        host: ctx.creds.mysqlHost,
        port: ctx.creds.mysqlPort,
        database: src.dbName,
        extraArgs: ['--no-data', ...ctx.plan.dbExcludeDataTables.map((t) => `'${t}'`)],
      });
      log(ctx, `  schema-only dump для ${ctx.plan.dbExcludeDataTables.length} таблиц`);
      const sd = await dumpAttempt(
        'schema',
        noDataCmd,
        noDataDumpFile,
        15 * 60 * 1000, // 15 мин — schema-only маленький
        2,
      );
      if (!sd.ok) {
        log(ctx, `  WARN: schema-only dump не прошёл: ${sd.lastError}`);
      } else {
        const ir = await importFromGzFile({
          inputPath: noDataDumpFile,
          localCommand: 'mariadb',
          localArgs: [
            `--defaults-extra-file=${localOpts}`,
            '--max-allowed-packet=1G',
            '--default-character-set=utf8mb4',
            `--init-command=SET sql_mode='', SESSION FOREIGN_KEY_CHECKS=0, SESSION UNIQUE_CHECKS=0`,
            ctx.plan.newName,
          ],
          onLog: (line) => log(ctx, line),
          timeoutMs: 15 * 60 * 1000,
          isCancelled: ctx.isCancelled,
        });
        if (ir.exitCode !== 0) {
          log(ctx, `  WARN: schema-only import не прошёл: ${extractMariaDbError(ir.stderr)}`);
        } else {
          log(ctx, `  ✓ schema-only dump+import OK`);
        }
      }
    }
  } finally {
    await fs.unlink(localOpts).catch(() => {});
    if (!keepDumpOnFailure) {
      await fs.unlink(dumpFile).catch(() => {});
      await fs.unlink(noDataDumpFile).catch(() => {});
    }
  }
}

async function patchModxStage(ctx: RunCtx) {
  const newRoot = path.join(SITES_BASE_PATH, ctx.plan.newName, 'www');
  const oldRoot = ctx.plan.sourceWebroot.replace(/\/$/, '');

  // 1) www/config.core.php (имя config.inc.php — стандартное `config`)
  const files = [
    `${newRoot}/config.core.php`,
    `${newRoot}/${ctx.plan.modxPaths.connectorsDir}/config.core.php`,
    `${newRoot}/${ctx.plan.modxPaths.managerDir}/config.core.php`,
  ];

  for (const f of files) {
    try {
      await fs.access(f);
    } catch {
      log(ctx, `  skip ${f} (нет файла)`);
      continue;
    }
    // Вместо `sed` — читаем/пишем напрямую: command-executor блокирует
    // `|` как shell-meta, а другие разделители (`#`, `@`) ненадёжны (могут
    // встречаться в путях). split/join — литеральная замена без regex-эскейпов.
    let content = await fs.readFile(f, 'utf-8');
    if (content.includes(oldRoot)) {
      content = content.split(oldRoot).join(newRoot);
      await fs.writeFile(f, content);
      log(ctx, `  patched: ${f}`);
    } else {
      log(ctx, `  skip ${f} (oldRoot не найден внутри)`);
    }
  }

  // 2) www/core/config/config.inc.php — db creds + paths
  const configIncPath = `${newRoot}/core/config/config.inc.php`;
  try {
    let content = await fs.readFile(configIncPath, 'utf-8');
    const dbCreds = await fetchHostpanelDbCreds(ctx);
    // Меняем пути
    content = content.replace(
      new RegExp(oldRoot.replace(/[.[\]^$*+?{}/|]/g, '\\$&'), 'g'),
      newRoot,
    );
    // Меняем db user / pass / dbase на новые (= newName / тот же pass / newName)
    content = content.replace(/(\$database_user\s*=\s*['"])[^'"]+/g, `$1${ctx.plan.newName}`);
    content = content.replace(/(\$database_password\s*=\s*['"])[^'"]+/g, `$1${dbCreds.dbPass}`);
    content = content.replace(/(\$dbase\s*=\s*['"])[^'"]+/g, `$1${ctx.plan.newName}`);
    await fs.writeFile(configIncPath, content);
    log(ctx, `  patched: ${configIncPath}`);
  } catch (e) {
    log(ctx, `  config.inc.php: ${(e as Error).message}`);
  }
}

async function applyNginxStage(ctx: RunCtx) {
  const nginx = new NginxManager();
  const homeDir = path.join(SITES_BASE_PATH, ctx.plan.newName);
  const filesRelPath = ctx.plan.filesRelPath || 'www';
  // ВАЖНО: миграция Hostpanel создаёт Site в БД master ПОСЛЕ apply-nginx
  // (см. migration-hostpanel.service.ts::persistMigratedSiteRecords). Поэтому
  // обычный путь "API регенерит meowbox-zones.conf перед nginx:create-config"
  // здесь не отрабатывает, и `nginx -t` падает с
  // "zero size shared memory zone site_<newName>". Страхуемся идемпотентным
  // append'ом зоны прямо в агенте — после persist API перепишет файл целиком.
  await nginx.ensureZoneForSite(ctx.plan.newName);
  // spec §7.2: если на источнике есть `if ($host != $main_host) return 301`
  // — все алиасы 301-редиректят на главный домен. Передаём это в NginxManager
  // через формат `{domain, redirect: true}[]` (см. NginxAliasInput в templates.ts).
  const aliasInputs = ctx.plan.aliasesRedirectToMain === true
    ? ctx.plan.newAliases.map((d) => ({ domain: d, redirect: true }))
    : ctx.plan.newAliases;
  const result = await nginx.createSiteConfig({
    siteName: ctx.plan.newName,
    siteType: ctx.plan.sourceCms === 'modx' ? 'MODX_REVO' : 'CUSTOM',
    domain: ctx.plan.newDomain,
    aliases: aliasInputs,
    rootPath: homeDir,
    filesRelPath,
    phpVersion: ctx.plan.phpVersion,
    phpEnabled: true,
    sslEnabled: !!ctx.plan.ssl?.transfer,
    httpsRedirect: !!ctx.plan.ssl?.transfer,
    settings: ctx.plan.nginxHsts === true ? { hsts: true } : undefined,
    certPath: ctx.plan.ssl ? `${LETSENCRYPT_LIVE_DIR}/${ctx.plan.newDomain}/fullchain.pem` : undefined,
    keyPath: ctx.plan.ssl ? `${LETSENCRYPT_LIVE_DIR}/${ctx.plan.newDomain}/privkey.pem` : undefined,
    customConfig: ctx.plan.nginxCustomConfig || undefined,
  } as Parameters<typeof nginx.createSiteConfig>[0]);
  if (!result.success) {
    throw new Error(`apply-nginx failed: ${result.error}`);
  }
  ctx.created.nginx = true;
  log(ctx, `  nginx layered конфиг применён + reload`);
}

async function applyPhpFpmStage(ctx: RunCtx) {
  const fpm = new PhpFpmManager();
  const result = await fpm.createPool({
    siteName: ctx.plan.newName,
    domain: ctx.plan.newDomain,
    phpVersion: ctx.plan.phpVersion,
    user: ctx.plan.newName,
    rootPath: path.join(SITES_BASE_PATH, ctx.plan.newName),
    sslEnabled: !!ctx.plan.ssl?.transfer,
    customConfig: ctx.plan.phpFpm.custom || null,
  } as Parameters<typeof fpm.createPool>[0]);
  if (!result.success) {
    throw new Error(`apply-php-fpm failed: ${result.error}`);
  }
  ctx.created.phpfpm = true;
  log(ctx, `  php-fpm pool создан (PHP ${ctx.plan.phpVersion})`);
}

async function importCronStage(ctx: RunCtx) {
  const cm = new CronManager();
  const accepted = ctx.plan.cronJobs.filter((j) => j.target === 'this-site');
  if (accepted.length === 0) {
    log(ctx, `  нет cron-задач для импорта`);
    return;
  }
  for (const [idx, job] of accepted.entries()) {
    const id = `mig-${ctx.itemId.slice(0, 8)}-${idx}`;
    const r = await cm.addJob({
      id,
      schedule: job.schedule,
      command: job.command,
      enabled: true,
      user: ctx.plan.newName,
    });
    if (!r.success) {
      log(ctx, `  WARN: cron "${job.command.slice(0, 40)}..." failed: ${r.error}`);
      continue;
    }
    ctx.created.cron.push(id);
    log(ctx, `  + cron ${job.schedule} ${job.command.slice(0, 60)}`);
  }
}

async function copySslStage(
  ctx: RunCtx,
): Promise<{ notBefore: string | null; notAfter: string | null }> {
  if (!ctx.plan.ssl?.transfer) {
    return { notBefore: null, notAfter: null };
  }

  // Качаем три ресурса с источника. tmpRoot всегда чистим в конце —
  // иначе при ретраях /tmp забивается.
  const tmpRoot = `/tmp/meowbox-ssl-${ctx.itemId}`;
  await fs.mkdir(tmpRoot, { recursive: true });
  // Внутренний helper: гарантируем cleanup tmpRoot при любом исходе.
  const cleanupTmp = async () => {
    try { await fs.rm(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  return await copySslStageImpl(ctx, tmpRoot).finally(cleanupTmp);
}

async function copySslStageImpl(
  ctx: RunCtx,
  tmpRoot: string,
): Promise<{ notBefore: string | null; notAfter: string | null }> {
  if (!ctx.plan.ssl?.transfer) {
    return { notBefore: null, notAfter: null };
  }

  const sshSpec = (ctx.ssh as SshSourceBridge).rsyncSshSpec();
  const env = { ...process.env, ...(ctx.ssh as SshSourceBridge).rsyncEnv() };

  const sourceArchive = ctx.plan.ssl.sourceArchiveDir;
  const sourceLive = ctx.plan.ssl.sourceLiveDir;
  const sourceRenewal = ctx.plan.ssl.sourceRenewalConf;

  // Через rsync (рекурсивно с симлинками)
  await runStreaming('rsync', [
    '-aHAX', '-e', sshSpec,
    `${ctx.creds.sshUser}@${ctx.creds.host}:${sourceArchive}/`,
    `${tmpRoot}/archive/`,
  ], { env, onLine: (l) => log(ctx, `    ${l}`), timeoutMs: 300_000, isCancelled: ctx.isCancelled });

  await runStreaming('rsync', [
    '-aHAX', '-e', sshSpec,
    `${ctx.creds.sshUser}@${ctx.creds.host}:${sourceLive}/`,
    `${tmpRoot}/live/`,
  ], { env, onLine: (l) => log(ctx, `    ${l}`), timeoutMs: 300_000, isCancelled: ctx.isCancelled });

  await runStreaming('rsync', [
    '-aHAX', '-e', sshSpec,
    `${ctx.creds.sshUser}@${ctx.creds.host}:${sourceRenewal}`,
    `${tmpRoot}/renewal.conf`,
  ], { env, onLine: (l) => log(ctx, `    ${l}`), timeoutMs: 60_000, isCancelled: ctx.isCancelled });

  // Перемещаем в целевые папки. Имена папок: используем NEW domain — это значит
  // надо переименовать архив на лету (rename old → new). Старое имя — sourceDomain.
  const sourceDomain = path.basename(sourceLive);
  const newDomain = ctx.plan.newDomain;
  const live = `/etc/letsencrypt/live/${newDomain}`;
  const archive = `/etc/letsencrypt/archive/${newDomain}`;
  const renewal = `/etc/letsencrypt/renewal/${newDomain}.conf`;

  await ctx.exec.execute('mkdir', ['-p', '/etc/letsencrypt/live', '/etc/letsencrypt/archive', '/etc/letsencrypt/renewal']);

  // forceCleanStaleLE — мастер уже проверил, что в БД нет ни Site, ни
  // SslCertificate на этот домен → значит LE-папки на диске orphan
  // (остатки после удаления сайта; `certbot revoke` фейлится на migrated
  // сертах из-за account mismatch и оставляет файлы). Сносим перед mv,
  // иначе copy-ssl упадёт с «уже существует». Идемпотентно.
  if (ctx.plan.ssl.forceCleanStaleLE) {
    log(ctx, '  forceCleanStaleLE=true → сносим orphan LE-артефакты для ' + newDomain);
    await fs.rm(live, { recursive: true, force: true }).catch(() => {});
    await fs.rm(archive, { recursive: true, force: true }).catch(() => {});
    await fs.rm(renewal, { force: true }).catch(() => {});
  }

  // Если уже есть — не перетираем (чужой LE-серт). Бросаем ошибку, чтобы
  // мастер не создал SslCertificate с пустыми датами и не повесил
  // requiresSslReissue на сайт впустую.
  const exists = await fs.stat(live).then(() => true).catch(() => false);
  if (exists) {
    throw new Error(
      `${live} уже существует на slave — другая миграция/сайт уже использует этот домен. ` +
      `Либо очисти LE-папку вручную, либо отключи SSL transfer в плане.`,
    );
  }

  await ctx.exec.execute('mv', [`${tmpRoot}/archive`, archive]);
  await ctx.exec.execute('mv', [`${tmpRoot}/live`, live]);
  await ctx.exec.execute('mv', [`${tmpRoot}/renewal.conf`, renewal]);

  // Переименовываем файлы внутри (если sourceDomain !== newDomain)
  if (sourceDomain !== newDomain) {
    // в archive — файлы вида cert{N}.pem, не зависят от имени
    // в live — симлинки указывают на ../../archive/<sourceDomain>/cert{N}.pem
    // Релинкуем
    const liveFiles = ['cert.pem', 'chain.pem', 'fullchain.pem', 'privkey.pem'];
    for (const f of liveFiles) {
      const fp = `${live}/${f}`;
      try {
        const target = await fs.readlink(fp);
        const newTarget = target.replace(`/${sourceDomain}/`, `/${newDomain}/`);
        await fs.unlink(fp);
        await ctx.exec.execute('ln', ['-s', newTarget, fp]);
      } catch { /* not a symlink — skip */ }
    }
  }

  // ВСЕГДА патчим renewal.conf:
  //   - archive/cert/chain/fullchain/privkey пути с sourceDomain → newDomain
  //   - webroot_path: /var/www/html → наш webroot (spec §9.2)
  //   - post_hook → systemctl reload nginx (наш стандарт)
  // НЕ трогаем `account` — если первый renew не пройдёт, certbot создаст новый
  // account автоматически.
  try {
    let rconf = await fs.readFile(renewal, 'utf-8');
    if (sourceDomain !== newDomain) {
      rconf = rconf.replace(new RegExp(`/${sourceDomain}/`, 'g'), `/${newDomain}/`);
    }
    const filesRel = ctx.plan.filesRelPath || 'www';
    const newWebroot = path.join(SITES_BASE_PATH, ctx.plan.newName, filesRel);
    // webroot_path в renewal.conf — одно значение (один путь), без trailing
    // запятой. Если в исходнике comma-list (несколько сайтов в одном renewal),
    // оставляем все хвосты как есть, заменяем только первый путь.
    rconf = rconf.replace(/^webroot_path\s*=.*$/m, `webroot_path = ${newWebroot}`);
    // [[webroot_map]] секция: домен = путь
    rconf = rconf.replace(
      /^([\w.-]+)\s*=\s*\/[^\n]*$/gm,
      (_m, dom: string) => `${dom} = ${newWebroot}`,
    );
    rconf = rconf.replace(/^post_hook\s*=.*$/gm, 'post_hook = systemctl reload nginx');
    await fs.writeFile(renewal, rconf);
  } catch (e) {
    log(ctx, `  WARN renewal.conf patch: ${(e as Error).message}`);
  }

  await ctx.exec.execute('chown', ['-R', 'root:root', live, archive, renewal]);

  // nginx -t — проверка синтаксиса перед reload
  const nt = await ctx.exec.execute('nginx', ['-t']);
  if (nt.exitCode !== 0) {
    log(ctx, `  WARN: nginx -t failed: ${nt.stderr.slice(0, 300)} (SSL-серт скопирован, но reload не делаю)`);
  } else {
    await ctx.exec.execute('systemctl', ['reload', 'nginx']).catch(() => {});
    log(ctx, `  nginx -t OK + reload`);
  }
  ctx.created.ssl = true;
  log(ctx, `  SSL перенесён: ${live}`);

  // Извлекаем notBefore / notAfter из cert.pem — мастер сохранит их в SslCertificate
  // (иначе SSL-мониторинг покажет "expiresAt unknown" пока не отработает sweep).
  let notBefore: string | null = null;
  let notAfter: string | null = null;
  try {
    const certPath = `${live}/cert.pem`;
    const r = await ctx.exec.execute('openssl', [
      'x509', '-in', certPath, '-noout', '-startdate', '-enddate',
    ]);
    if (r.exitCode === 0) {
      const nbMatch = r.stdout.match(/notBefore=(.+)/);
      const naMatch = r.stdout.match(/notAfter=(.+)/);
      if (nbMatch?.[1]) notBefore = new Date(nbMatch[1].trim()).toISOString();
      if (naMatch?.[1]) notAfter = new Date(naMatch[1].trim()).toISOString();
      log(ctx, `  cert dates: notBefore=${notBefore} notAfter=${notAfter}`);
    }
  } catch (e) {
    log(ctx, `  WARN openssl x509 dates: ${(e as Error).message}`);
  }
  return { notBefore, notAfter };
}

async function verifyStage(ctx: RunCtx): Promise<string | null> {
  // Простой curl с --resolve в обход DNS
  const slaveIp = await detectSlaveIp(ctx);
  if (!slaveIp) {
    log(ctx, `  не удалось определить IP slave — пропускаю verify`);
    return null;
  }
  const r = await ctx.exec.execute('curl', [
    '-sk', '-o', '/dev/null',
    '-w', '%{http_code}',
    '--resolve', `${ctx.plan.newDomain}:443:${slaveIp}`,
    '--resolve', `${ctx.plan.newDomain}:80:${slaveIp}`,
    '-I', `https://${ctx.plan.newDomain}/`,
    '--max-time', '15',
  ]);
  const code = r.stdout?.trim() || null;
  log(ctx, `  HTTP ${code || '???'} via slave-IP ${slaveIp}`);
  return code;
}

/**
 * Cleanup-контракт (см. spec §11.2): удаляем ТОЛЬКО артефакты, которые
 * текущая миграция создала. Флаги в ctx.created выставляются в конце каждого
 * успешного стейджа. Чужие/предсуществовавшие артефакты НЕ трогаются.
 *
 * Если pre-flight упал (юзер уже существовал) — ни один из флагов не выставлен,
 * cleanup ничего не делает.
 */
async function cleanupArtifacts(ctx: RunCtx) {
  log(ctx, `► rollback: cleanup (created=${JSON.stringify({
    user: ctx.created.user,
    db: ctx.created.db,
    nginx: ctx.created.nginx,
    phpfpm: ctx.created.phpfpm,
    ssl: ctx.created.ssl,
    cron: ctx.created.cron.length,
  })})`);

  // Удаляем cron'ы (per-id) — у них точные ID, безопасно
  if (ctx.created.cron.length > 0) {
    const cm = new CronManager();
    for (const id of ctx.created.cron) {
      await cm.removeJob(id, ctx.plan.newName).catch(() => {});
    }
  }

  if (ctx.created.nginx) {
    const nginx = new NginxManager();
    await nginx.removeSiteConfig(ctx.plan.newName).catch(() => {});
  }
  if (ctx.created.phpfpm) {
    const fpm = new PhpFpmManager();
    await fpm.removePool(ctx.plan.newName, ctx.plan.phpVersion).catch(() => {});
  }
  if (ctx.created.db) {
    try {
      const dm = new DatabaseManager();
      await dm.dropDatabase(ctx.plan.newName, 'MARIADB', ctx.plan.newName);
    } catch {
      /* ignore */
    }
  }
  if (ctx.created.ssl) {
    // Удаляем только LE-папки этого домена (созданные этой миграцией)
    await ctx.exec
      .execute('rm', ['-rf', `/etc/letsencrypt/live/${ctx.plan.newDomain}`])
      .catch(() => {});
    await ctx.exec
      .execute('rm', ['-rf', `/etc/letsencrypt/archive/${ctx.plan.newDomain}`])
      .catch(() => {});
    await ctx.exec
      .execute('rm', ['-f', `/etc/letsencrypt/renewal/${ctx.plan.newDomain}.conf`])
      .catch(() => {});
  }
  if (ctx.created.user) {
    const userManager = new SystemUserManager();
    await userManager.deleteUser(ctx.plan.newName).catch(() => {});
    // homeDir удалится через `userdel -r`; если осталось — добиваем
    if (ctx.created.webroot) {
      const homeDir = path.join(SITES_BASE_PATH, ctx.plan.newName);
      await ctx.exec.execute('rm', ['-rf', homeDir]).catch(() => {});
    }
  }
}

// ═══════════════════ Helpers ══════════════════════════════════════════════

function emitProgress(ctx: RunCtx, stage: string, percent: number) {
  ctx.socket?.emit('migrate:hostpanel:item:progress', {
    migrationId: ctx.migrationId,
    itemId: ctx.itemId,
    stage,
    progress: percent,
  });
}

function emitStatus(ctx: RunCtx, status: string, errorMsg?: string) {
  ctx.socket?.emit('migrate:hostpanel:item:status', {
    migrationId: ctx.migrationId,
    itemId: ctx.itemId,
    status,
    errorMsg,
  });
}

function log(ctx: RunCtx, line: string) {
  ctx.socket?.emit('migrate:hostpanel:item:log', {
    migrationId: ctx.migrationId,
    itemId: ctx.itemId,
    line,
  });
}

function runStreaming(
  cmd: string,
  args: string[],
  opts: {
    env?: NodeJS.ProcessEnv;
    onLine?: (line: string) => void;
    timeoutMs?: number;
    /**
     * Stall-watchdog: если N мс не было ни одного байта — kill с явной
     * ошибкой. По дефолту 10 минут. Передай 0 чтобы отключить (мы НЕ
     * отключаем для rsync — даже большой rsync шлёт прогресс каждые
     * несколько секунд).
     */
    stallTimeoutMs?: number;
    /**
     * Soft-cancel: вызывается каждые 2с — если возвращает true, шлём SIGTERM.
     * Используется migration handler'ом для прерывания зависших rsync/dump.
     */
    isCancelled?: () => boolean;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrBuf = '';
    let cancelled = false;
    let stalled = false;

    const STALL_DEFAULT_MS = 10 * 60 * 1000;
    const stallMs = opts.stallTimeoutMs === undefined ? STALL_DEFAULT_MS : opts.stallTimeoutMs;
    let lastActivityAt = Date.now();
    const bumpActivity = () => { lastActivityAt = Date.now(); };

    const onChunk = (chunk: Buffer) => {
      bumpActivity();
      const s = chunk.toString();
      // Сплитим и по \n, и по \r — rsync --info=progress2 шлёт обновления
      // прогресса через возврат каретки (\r) без \n. Без этого все апдейты
      // склеиваются в одну гигантскую "строку" пока не придёт финальный \n.
      const lines = s.split(/[\r\n]/);
      for (const line of lines) {
        if (line.trim()) opts.onLine?.(line.trim());
      }
    };
    proc.stdout.on('data', onChunk);
    proc.stderr.on('data', (chunk) => {
      bumpActivity();
      stderrBuf += chunk.toString();
      onChunk(chunk);
    });
    let timer: NodeJS.Timeout | null = null;
    let cancelTimer: NodeJS.Timeout | null = null;
    let stallTimer: NodeJS.Timeout | null = null;
    if (opts.timeoutMs) {
      timer = setTimeout(() => proc.kill('SIGTERM'), opts.timeoutMs);
    }
    if (stallMs > 0) {
      stallTimer = setInterval(() => {
        const idleMs = Date.now() - lastActivityAt;
        if (idleMs >= stallMs) {
          stalled = true;
          opts.onLine?.(
            `  ⚠ STALL: ${cmd} не выдаёт данных ${Math.round(idleMs / 1000)}s — kill`,
          );
          try { proc.kill('SIGTERM'); } catch { /* dead */ }
          setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch { /* dead */ }
          }, 5_000);
        }
      }, Math.max(5_000, Math.floor(stallMs / 10)));
    }
    if (opts.isCancelled) {
      cancelTimer = setInterval(() => {
        if (opts.isCancelled?.()) {
          cancelled = true;
          opts.onLine?.('  ⚠ cancel-token поднят — шлю SIGTERM');
          try { proc.kill('SIGTERM'); } catch { /* уже мёртв */ }
          // Если за 5с не успел умереть — добиваем SIGKILL
          setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch { /* уже мёртв */ }
          }, 5_000);
        }
      }, 2_000);
    }
    proc.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      if (cancelTimer) clearInterval(cancelTimer);
      if (stallTimer) clearInterval(stallTimer);
      if (cancelled) reject(new Error('Cancelled by operator'));
      else if (stalled) reject(new Error(`${cmd}: stalled (no output for ${Math.round(stallMs / 1000)}s)`));
      else if (code === 0) resolve();
      else reject(new Error(`${cmd} exit ${code}: ${stderrBuf.slice(0, 500)}`));
    });
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (cancelTimer) clearInterval(cancelTimer);
      if (stallTimer) clearInterval(stallTimer);
      reject(err);
    });
  });
}

/**
 * mariadb cli на ошибке выводит stderr вида:
 *   --------------
 *   <SQL который упал>
 *   --------------
 *
 *   ERROR 1064 (42000) at line N: <message>
 *   ...
 * Slice(0, N) от начала режет нас в середине echo'нутого SQL, ERROR-строка
 * никогда не доходит до оператора. Вытаскиваем именно ERROR-строку (+ ещё
 * до 1500 символов контекста), а сырой query показываем хвостом.
 */
/**
 * Проверка целостности gzip-файла: `gzip -t` распаковывает в /dev/null
 * и проверяет CRC. Если файл обрезан — exit≠0 + сообщение типа
 * "unexpected end of file".
 *
 * spawn'ом напрямую (минуя CommandExecutor allowlist) — gzip-семейство
 * нам нужна как low-level утилита, и так уже используется в `runGunzipToFile`
 * (через child_process.spawn).
 */
function checkGzIntegrity(filePath: string): Promise<{ ok: boolean; error: string }> {
  return new Promise((resolve) => {
    const proc = spawn('gzip', ['-t', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
    proc.on('exit', (code) => {
      resolve({ ok: code === 0, error: stderr.trim() || `gzip -t exit=${code}` });
    });
    proc.on('error', (err) => {
      resolve({ ok: false, error: `spawn gzip failed: ${err.message}` });
    });
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* dead */ }
      resolve({ ok: false, error: 'gzip -t timeout 60s' });
    }, 60_000).unref();
  });
}

function extractMariaDbError(raw: string): string {
  if (!raw) return '<empty stderr>';
  const lines = raw.split('\n');
  const errorLineIdx = lines.findIndex((l) => /^ERROR \d+/.test(l.trim()));
  if (errorLineIdx >= 0) {
    const errLine = lines[errorLineIdx]!.trim();
    // Дополнительные строки после ERROR (могут быть стек/детали). Берём до 5 строк.
    const tail = lines.slice(errorLineIdx + 1, errorLineIdx + 6).join('\n').trim();
    // SQL-контекст: 1-2 строки перед ERROR (внутри dashed-блоков).
    const ctxLines = lines.slice(Math.max(0, errorLineIdx - 4), errorLineIdx);
    const ctx = ctxLines.join('\n').slice(-400).trim();
    let out = errLine;
    if (tail) out += `\n${tail}`;
    if (ctx) out += `\n[ctx] ${ctx.replace(/\n+/g, ' | ').slice(0, 400)}`;
    return out.slice(0, 2000);
  }
  // ERROR-строки нет — возможно это OOM/segfault/что-то нестандартное.
  // Возвращаем хвост (последний контент часто информативнее начала).
  return raw.trim().slice(-1500);
}

/**
 * Тянет `manager_user`/`manager_pass` MODX-админа с источника
 * (`modx_host_hostpanel_sites.id = sourceSiteId`). На hostpanel пароль лежит
 * в плейне → можем 1-в-1 переложить в `Site.cmsAdminUser`/`cmsAdminPassword`,
 * чтобы блок CMS на странице сайта показывал Логин/Пароль/URL без отдельной
 * настройки оператором.
 *
 * Best-effort: если запрос не удался / поля пустые — оставляем `usedCreds`
 * с null'ами, миграция продолжается (вызывается из try/catch в runItem).
 *
 * Кладём в `ctx.usedCreds.cmsAdminUser`/`cmsAdminPassword`, мастер забирает
 * через `RunItemResult.creds`. Открытым текстом в БД мастера ничего не
 * сохраняется кроме итогового `Site.cmsAdminPassword` — это **тот же**
 * пароль, что лежит в открытом виде в hostpanel-таблице источника, никаких
 * новых утечек не вносим.
 */
async function fetchCmsAdminCreds(ctx: RunCtx): Promise<void> {
  const escSh = (s: string) => s.replace(/[\\$`"]/g, '\\$&');
  const prefixCore = ctx.creds.hostpanelTablePrefix.replace(/_$/, '');
  if (prefixCore) validateSqlIdentifier(prefixCore, 'hostpanelTablePrefix');
  const sourceSiteId = validateSqlPositiveInt(ctx.plan.sourceSiteId, 'sourceSiteId');
  const sql = `SELECT manager_user, manager_pass FROM ${ctx.creds.hostpanelTablePrefix}hostpanel_sites WHERE id=${sourceSiteId}`;
  const cmd =
    `MYSQL_PWD='${escSh(ctx.creds.mysqlPassword)}' mysql -h '${escSh(ctx.creds.mysqlHost)}' ` +
    `-P ${ctx.creds.mysqlPort} -u '${escSh(ctx.creds.mysqlUser)}' -B -N --raw ` +
    `'${escSh(ctx.creds.hostpanelDb)}' -e "${sql}"`;
  const r = await ctx.ssh.run(cmd, { timeout: 30_000, trim: false });
  if (r.exitCode !== 0) {
    throw new Error(`fetch manager_user/pass failed: ${(r.stderr || '').slice(0, 200)}`);
  }
  const cols = r.stdout.trimEnd().split('\t');
  const user = (cols[0] || '').trim();
  const pass = cols[1] || '';
  if (user) ctx.usedCreds.cmsAdminUser = user;
  if (pass) ctx.usedCreds.cmsAdminPassword = pass;
}

async function fetchSftpPasswordFromHostpanel(ctx: RunCtx): Promise<string> {
  const escSh = (s: string) => s.replace(/[\\$`"]/g, '\\$&');
  // spec §17.2: hostpanelTablePrefix и sourceSiteId интерполируются в SQL —
  // валидируем перед каждым SELECT. Префикс может быть пустым (тогда таблица
  // = `hostpanel_sites`), либо `modx_host_` etc.
  const prefixCore = ctx.creds.hostpanelTablePrefix.replace(/_$/, '');
  if (prefixCore) validateSqlIdentifier(prefixCore, 'hostpanelTablePrefix');
  const sourceSiteId = validateSqlPositiveInt(ctx.plan.sourceSiteId, 'sourceSiteId');
  const sql = `SELECT sftp_pass FROM ${ctx.creds.hostpanelTablePrefix}hostpanel_sites WHERE id=${sourceSiteId}`;
  const cmd =
    `MYSQL_PWD='${escSh(ctx.creds.mysqlPassword)}' mysql -h '${escSh(ctx.creds.mysqlHost)}' ` +
    `-P ${ctx.creds.mysqlPort} -u '${escSh(ctx.creds.mysqlUser)}' -B -N --raw ` +
    `'${escSh(ctx.creds.hostpanelDb)}' -e "${sql}"`;
  const r = await ctx.ssh.run(cmd);
  if (r.exitCode !== 0) throw new Error(`fetch sftp_pass failed: ${r.stderr}`);
  return r.stdout;
}

async function fetchHostpanelDbCreds(
  ctx: RunCtx,
): Promise<{ dbName: string; dbUser: string; dbPass: string }> {
  const escSh = (s: string) => s.replace(/[\\$`"]/g, '\\$&');
  const prefixCore = ctx.creds.hostpanelTablePrefix.replace(/_$/, '');
  if (prefixCore) validateSqlIdentifier(prefixCore, 'hostpanelTablePrefix');
  const sourceSiteId = validateSqlPositiveInt(ctx.plan.sourceSiteId, 'sourceSiteId');
  const sql = `SELECT mysql_db, mysql_user, mysql_pass FROM ${ctx.creds.hostpanelTablePrefix}hostpanel_sites WHERE id=${sourceSiteId}`;
  const cmd =
    `MYSQL_PWD='${escSh(ctx.creds.mysqlPassword)}' mysql -h '${escSh(ctx.creds.mysqlHost)}' ` +
    `-P ${ctx.creds.mysqlPort} -u '${escSh(ctx.creds.mysqlUser)}' -B -N --raw ` +
    `'${escSh(ctx.creds.hostpanelDb)}' -e "${sql}"`;
  const r = await ctx.ssh.run(cmd, { trim: false });
  const cols = r.stdout.trimEnd().split('\t');
  let dbName = cols[0] || '';
  let dbUser = cols[1] || '';
  let dbPass = cols[2] || '';

  // Fallback chain (см. spec §13.2 + §14.2): если в hostpanel-таблице
  // mysql_pass пуст / mysql_db пуст — пытаемся вычитать с источника
  // dumper.yaml → config.xml. Это критично для миграций, где hostpanel
  // частично заполнен.
  if (!dbPass || !dbName) {
    const sourceHome = `/var/www/${ctx.plan.sourceUser}`;
    if (!dbPass || !dbName) {
      try {
        const dumperRaw = await ctx.ssh.readFile(`${sourceHome}/dumper.yaml`);
        if (dumperRaw) {
          const { parseDumperYaml } = await import('./parsers/dumper-yaml.parser');
          const d = parseDumperYaml(dumperRaw);
          if (!dbPass && d.database?.pass) dbPass = d.database.pass;
          if (!dbName && d.database?.name) dbName = d.database.name;
          if (!dbUser && d.database?.user) dbUser = d.database.user;
        }
      } catch { /* ignore */ }
    }
    if (!dbPass || !dbName) {
      try {
        const xmlRaw = await ctx.ssh.readFile(`${sourceHome}/config.xml`);
        if (xmlRaw) {
          const { parseConfigXml } = await import('./parsers/config-xml.parser');
          const x = parseConfigXml(xmlRaw);
          if (!dbPass && x.databasePassword) dbPass = x.databasePassword;
          if (!dbName && x.database) dbName = x.database;
          if (!dbUser && x.databaseUser) dbUser = x.databaseUser;
        }
      } catch { /* ignore */ }
    }
  }

  return {
    dbName: dbName || ctx.plan.newName,
    dbUser: dbUser || ctx.plan.newName,
    dbPass,
  };
}

async function detectSlaveIp(ctx: RunCtx): Promise<string | null> {
  // Простейший detect — `hostname -I | awk '{print $1}'`
  const r = await ctx.exec.execute('curl', ['-s', '--max-time', '5', 'https://api.ipify.org']);
  if (r.exitCode === 0 && r.stdout.trim()) return r.stdout.trim();
  return null;
}
