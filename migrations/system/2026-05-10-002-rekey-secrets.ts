/**
 * Rekey всех зашифрованных blob'ов на единый master-key.
 *
 * См. docs/specs/2026-05-10-master-key-unification.md §4.3.
 *
 * Что делает (идемпотентно, retry-safe):
 *   1. Делает snapshot (через tools/snapshot.sh) — БД и ключи копируются в
 *      state/data/snapshots/pre-rekey-<ts>/.
 *   2. Перешифровывает существующие enc-поля старым ключом → новым:
 *      - Database.dbPasswordEnc        (legacy .dns-key → HKDF databases)
 *      - DnsProviderCredentials.encryptedJson (legacy .dns-key → HKDF dns)
 *      - VpnService.configBlob, VpnUser.credsBlob (legacy .vpn-key → HKDF vpn)
 *      - MigrationSource.encryptedCreds (legacy MIGRATION_SECRET → HKDF migration)
 *   3. Шифрует plain поля sshPassword/cmsAdminPassword → sshPasswordEnc/
 *      cmsAdminPasswordEnc, обнуляет старые plain поля.
 *   4. Переименовывает legacy ключи: `.vpn-key` → `.vpn-key.legacy.<ts>`,
 *      `.dns-key` → `.dns-key.legacy.<ts>`.
 *
 * Идемпотентность:
 *   - Каждый blob: сначала пробуем расшифровать НОВЫМ ключом — если выходит,
 *     значит уже мигрирован, skip. Иначе расшифровываем legacy → шифруем новым.
 *   - Plain поля: проверяем что enc-поле NULL, иначе skip.
 *
 * Не делает:
 *   - Не удаляет legacy-ключи (только rename) — оставляем на 30 дней для отката.
 *     Отдельная миграция (cleanup) удалит их позже.
 *   - Не дропает plain колонки sshPassword/cmsAdminPassword из schema —
 *     отдельная prisma миграция через 30 дней.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { SystemMigration } from './_types';

const KEY_LEN = 32;

interface RekeyContext {
  masterKey: Buffer;
  legacyVpn: Buffer | null;
  legacyDns: Buffer | null;
  legacyMigration: Buffer | null;
  legacyKeyPaths: Array<{ path: string; domain: string }>;
}

// ---------------------------------------------------------------------------
// AES-256-GCM helpers (локальные, чтобы не зависеть от api-cipher'ов в runtime
// миграции — runner запускается до того, как nest полностью поднят).
// ---------------------------------------------------------------------------

function encGcm(key: Buffer, plain: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

function decGcm(key: Buffer, encoded: string): Buffer {
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < 12 + 16 + 1) throw new Error('payload too short');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 12 + 16);
  const ct = buf.subarray(12 + 16);
  const dc = crypto.createDecipheriv('aes-256-gcm', key, iv);
  dc.setAuthTag(tag);
  return Buffer.concat([dc.update(ct), dc.final()]);
}

function hkdf(master: Buffer, domain: string): Buffer {
  const info = Buffer.from(`meowbox:${domain}:v1`, 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), info, KEY_LEN));
}

// ---------------------------------------------------------------------------
// Загрузка ключей
// ---------------------------------------------------------------------------

function tryReadFile(p: string): Buffer | null {
  try {
    const b = fs.readFileSync(p);
    return b.length === KEY_LEN ? b : null;
  } catch {
    return null;
  }
}

/** Подгрузка простого KEY="VALUE" формата в process.env. Без override существующих. */
function loadEnvFile(file: string): void {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const key = m[1];
      if (process.env[key]) continue; // не оверрайдим
      let val = m[2];
      val = val.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      process.env[key] = val;
    }
  } catch {
    /* нет файла — ок */
  }
}

function tryReadEnvKey(varName: string): Buffer | null {
  const v = process.env[varName]?.trim();
  if (!v) return null;
  try {
    const b = Buffer.from(v, 'base64');
    return b.length === KEY_LEN ? b : null;
  } catch {
    return null;
  }
}

function loadMaster(stateDir: string): Buffer {
  const fromEnv = tryReadEnvKey('MEOWBOX_MASTER_KEY');
  if (fromEnv) return fromEnv;
  const file = path.join(stateDir, 'data', '.master-key');
  const fromFile = tryReadFile(file);
  if (fromFile) return fromFile;
  throw new Error(
    `Master-key не найден ни в env, ни в ${file}. Запусти миграцию ` +
      `2026-05-10-001-master-key-bootstrap ПЕРЕД 2026-05-10-002-rekey-secrets.`,
  );
}

function findLegacyKey(
  stateDir: string,
  filenames: string[],
  envVar: string | null,
): { key: Buffer; path: string | null } | null {
  if (envVar) {
    const fromEnv = tryReadEnvKey(envVar);
    if (fromEnv) return { key: fromEnv, path: null };
  }
  // Ищем во ВСЕХ возможных директориях — release (state/data) и legacy (data).
  const candidateDirs = [
    path.join(stateDir, 'data'),
    '/opt/meowbox/data',
    process.env.MEOWBOX_DATA_DIR?.trim(),
  ].filter((d): d is string => !!d);
  const seen = new Set<string>();
  for (const dir of candidateDirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const fn of filenames) {
      const full = path.join(dir, fn);
      const k = tryReadFile(full);
      if (k) return { key: k, path: full };
      try {
        for (const entry of fs.readdirSync(dir)) {
          if (entry.startsWith(`${fn}.legacy.`)) {
            const k2 = tryReadFile(path.join(dir, entry));
            if (k2) return { key: k2, path: path.join(dir, entry) };
          }
        }
      } catch {
        /* dir отсутствует */
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Re-key helpers — пробуем decrypt новым ключом; если получилось — skip.
// Иначе decrypt legacy → encrypt новым.
// ---------------------------------------------------------------------------

function rekeyBlob(
  blob: string,
  newKey: Buffer,
  legacyKey: Buffer | null,
): { rekeyed: string | null; alreadyNew: boolean; error?: string } {
  // 1) Уже на новом ключе?
  try {
    decGcm(newKey, blob);
    return { rekeyed: null, alreadyNew: true };
  } catch {
    /* нет — пробуем legacy */
  }
  if (!legacyKey) {
    return { rekeyed: null, alreadyNew: false, error: 'legacy key missing' };
  }
  let plain: Buffer;
  try {
    plain = decGcm(legacyKey, blob);
  } catch (e) {
    return { rekeyed: null, alreadyNew: false, error: `decrypt failed: ${(e as Error).message}` };
  }
  const newBlob = encGcm(newKey, plain);
  return { rekeyed: newBlob, alreadyNew: false };
}

function encryptPlainPassword(plain: string, newKey: Buffer): string {
  return encGcm(newKey, Buffer.from(JSON.stringify({ password: plain }), 'utf8'));
}

// ---------------------------------------------------------------------------
// Основная миграция
// ---------------------------------------------------------------------------

const migration: SystemMigration = {
  id: '2026-05-10-002-rekey-secrets',
  description: 'Rekey всех зашифрованных secrets на единый master-key + plain SSH/CMS → enc',

  async up(ctx) {
    const stateDir = ctx.config.stateDir;

    // Загружаем state/.env — runner не делает этого автоматически, а нам нужны
    // legacy env-ключи (DNS_CREDENTIAL_KEY, MIGRATION_SECRET и т.п.) для
    // расшифровки старых blob'ов.
    loadEnvFile(`${stateDir}/.env`);
    // Legacy раскладка: /opt/meowbox/.env (на случай если state/.env отсутствует)
    loadEnvFile(`${ctx.config.panelDir}/.env`);

    const masterKey = loadMaster(stateDir);

    // Деривируем все нужные ключи
    const newKeys = {
      vpn: hkdf(masterKey, 'vpn'),
      dns: hkdf(masterKey, 'dns'),
      databases: hkdf(masterKey, 'databases'),
      migration: hkdf(masterKey, 'migration'),
      ssh: hkdf(masterKey, 'ssh'),
      cms: hkdf(masterKey, 'cms'),
    };

    // Загружаем legacy ключи (могут быть NULL — тогда blob'ы с legacy
    // расшифровать не сможем, миграция логирует и идёт дальше).
    const legacyVpn = findLegacyKey(stateDir, ['.vpn-key'], 'VPN_SECRET_KEY');
    const legacyDns = findLegacyKey(stateDir, ['.dns-key'], 'DNS_CREDENTIAL_KEY');
    const legacyMigration = findLegacyKey(stateDir, [], 'MIGRATION_SECRET');

    ctx.log(
      `Legacy keys: vpn=${legacyVpn ? '✓' : '✗'} dns=${legacyDns ? '✓' : '✗'} ` +
        `migration=${legacyMigration ? '✓' : '✗'}`,
    );

    if (ctx.dryRun) {
      ctx.log('dry-run: остальные шаги пропускаются');
      return;
    }

    // 1) Snapshot перед опасной операцией
    try {
      const res = await ctx.exec.runShell(`bash ${ctx.config.panelDir}/tools/snapshot.sh`);
      const snapPath = res.stdout.trim().split('\n').pop() || 'unknown';
      ctx.log(`Snapshot: ${snapPath}`);
    } catch (e) {
      ctx.log(`WARN: snapshot.sh failed: ${(e as Error).message}. Продолжаем (legacy ключи всё ещё есть).`);
    }

    // 2) Site.sshPassword (plain) → sshPasswordEnc
    const sitesWithSsh = (await ctx.prisma.$queryRawUnsafe<
      Array<{ id: string; ssh_password: string | null; ssh_password_enc: string | null }>
    >(`SELECT id, ssh_password, ssh_password_enc FROM sites WHERE ssh_password IS NOT NULL`));
    let sshMigrated = 0;
    for (const row of sitesWithSsh) {
      if (row.ssh_password_enc) {
        // Уже мигрирован — просто обнулим plain
        await ctx.prisma.$executeRawUnsafe(`UPDATE sites SET ssh_password = NULL WHERE id = ?`, row.id);
        continue;
      }
      const enc = encryptPlainPassword(row.ssh_password!, newKeys.ssh);
      await ctx.prisma.$executeRawUnsafe(
        `UPDATE sites SET ssh_password_enc = ?, ssh_password = NULL WHERE id = ?`,
        enc,
        row.id,
      );
      sshMigrated++;
    }
    ctx.log(`Sites: migrated ${sshMigrated} plain sshPassword → sshPasswordEnc`);

    // 3) Site.cmsAdminPassword (plain) → cmsAdminPasswordEnc
    const sitesWithCms = await ctx.prisma.$queryRawUnsafe<
      Array<{ id: string; cms_admin_password: string | null; cms_admin_password_enc: string | null }>
    >(`SELECT id, cms_admin_password, cms_admin_password_enc FROM sites WHERE cms_admin_password IS NOT NULL`);
    let cmsMigrated = 0;
    for (const row of sitesWithCms) {
      if (row.cms_admin_password_enc) {
        await ctx.prisma.$executeRawUnsafe(`UPDATE sites SET cms_admin_password = NULL WHERE id = ?`, row.id);
        continue;
      }
      const enc = encryptPlainPassword(row.cms_admin_password!, newKeys.cms);
      await ctx.prisma.$executeRawUnsafe(
        `UPDATE sites SET cms_admin_password_enc = ?, cms_admin_password = NULL WHERE id = ?`,
        enc,
        row.id,
      );
      cmsMigrated++;
    }
    ctx.log(`Sites: migrated ${cmsMigrated} plain cmsAdminPassword → cmsAdminPasswordEnc`);

    // 4) Databases.dbPasswordEnc — legacy .dns-key → new HKDF databases
    const dbsWithEnc = await ctx.prisma.$queryRawUnsafe<
      Array<{ id: string; db_password_enc: string | null }>
    >(`SELECT id, db_password_enc FROM databases WHERE db_password_enc IS NOT NULL`);
    let dbsRekeyed = 0;
    let dbsAlreadyNew = 0;
    let dbsFailed = 0;
    for (const row of dbsWithEnc) {
      const res = rekeyBlob(row.db_password_enc!, newKeys.databases, legacyDns?.key ?? null);
      if (res.alreadyNew) {
        dbsAlreadyNew++;
        continue;
      }
      if (!res.rekeyed) {
        ctx.log(`WARN: databases.${row.id} rekey failed: ${res.error}`);
        dbsFailed++;
        continue;
      }
      await ctx.prisma.$executeRawUnsafe(
        `UPDATE databases SET db_password_enc = ? WHERE id = ?`,
        res.rekeyed,
        row.id,
      );
      dbsRekeyed++;
    }
    ctx.log(`Databases: rekeyed=${dbsRekeyed} alreadyNew=${dbsAlreadyNew} failed=${dbsFailed}`);

    // 5) DNS-providers — пробуем найти таблицу. Схема может слегка отличаться
    // (см. schema.prisma — кодовое имя `DnsProvider` / `dns_providers`).
    await rekeyTable(ctx, {
      table: 'dns_providers',
      idCol: 'id',
      blobCol: 'credentials_enc',
      newKey: newKeys.dns,
      legacyKey: legacyDns?.key ?? null,
      label: 'DnsProviders',
    });

    // 6) VPN — VpnService.configBlob и VpnUser.credsBlob
    await rekeyTable(ctx, {
      table: 'vpn_services',
      idCol: 'id',
      blobCol: 'config_blob',
      newKey: newKeys.vpn,
      legacyKey: legacyVpn?.key ?? null,
      label: 'VpnService.configBlob',
    });
    await rekeyTable(ctx, {
      table: 'vpn_users',
      idCol: 'id',
      blobCol: 'creds_blob',
      newKey: newKeys.vpn,
      legacyKey: legacyVpn?.key ?? null,
      label: 'VpnUser.credsBlob',
    });

    // 7) Hostpanel migration sources — encrypted creds
    await rekeyTable(ctx, {
      table: 'migration_sources',
      idCol: 'id',
      blobCol: 'encrypted_creds',
      newKey: newKeys.migration,
      legacyKey: legacyMigration?.key ?? null,
      label: 'MigrationSource.encryptedCreds',
    });

    // 8) Rename legacy keys
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    for (const lk of [legacyVpn, legacyDns]) {
      if (lk?.path && fs.existsSync(lk.path) && !lk.path.includes('.legacy.')) {
        const newPath = `${lk.path}.legacy.${ts}`;
        try {
          fs.renameSync(lk.path, newPath);
          ctx.log(`Renamed legacy: ${lk.path} → ${newPath}`);
        } catch (e) {
          ctx.log(`WARN: rename ${lk.path} failed: ${(e as Error).message}`);
        }
      }
    }

    // 9) DROP старых plain-колонок sites.ssh_password / sites.cms_admin_password
    //
    // КРИТИЧНО: UPDATE ... = NULL не очищает физические страницы SQLite — старый
    // plain text остаётся в b-tree до VACUUM. Если кто-то снимет .db файл (через
    // бэкап, дамп, кражу диска) — он может вытащить старые пароли из dead pages.
    //
    // Поэтому:
    //   1. DROP COLUMN (SQLite 3.35+, у нас 3.45+) — структурно убираем колонки.
    //   2. VACUUM — переписываем БД с нуля, dead pages уничтожаются.
    //
    // Идемпотентность: проверяем колонки через PRAGMA table_info, дропаем только
    // если они ещё есть.
    const sitesCols = await ctx.prisma.$queryRawUnsafe<Array<{ name: string }>>(
      `PRAGMA table_info('sites')`,
    );
    const colNames = new Set(sitesCols.map((c) => c.name));
    let droppedAny = false;
    if (colNames.has('ssh_password')) {
      await ctx.prisma.$executeRawUnsafe(`ALTER TABLE "sites" DROP COLUMN "ssh_password"`);
      ctx.log('Dropped column sites.ssh_password (plain text)');
      droppedAny = true;
    }
    if (colNames.has('cms_admin_password')) {
      await ctx.prisma.$executeRawUnsafe(`ALTER TABLE "sites" DROP COLUMN "cms_admin_password"`);
      ctx.log('Dropped column sites.cms_admin_password (plain text)');
      droppedAny = true;
    }

    // 10) VACUUM — обязательно после DROP COLUMN, иначе dead pages с plain
    // паролями остаются в файле. Делаем всегда (даже если не дропали колонки в
    // этом проходе — defensive: возможно, в прошлом проходе только UPDATE
    // прошёл, а VACUUM не успел).
    try {
      await ctx.prisma.$executeRawUnsafe(`VACUUM`);
      ctx.log('VACUUM done — dead pages с plain паролями физически удалены из .db файла');
    } catch (e) {
      ctx.log(`WARN: VACUUM failed: ${(e as Error).message}. БД может содержать остатки plain паролей в dead pages.`);
    }

    if (droppedAny) {
      ctx.log('Rekey-secrets done: plain-колонки удалены, БД vacuumed. Legacy ключи → .legacy.<ts>.');
    } else {
      ctx.log('Rekey-secrets done: plain-колонок уже не было. БД vacuumed.');
    }
  },
};

/** Generic rekey для пар (table, blob_col). Skip если таблица не существует. */
async function rekeyTable(
  ctx: Parameters<SystemMigration['up']>[0],
  opts: {
    table: string;
    idCol: string;
    blobCol: string;
    newKey: Buffer;
    legacyKey: Buffer | null;
    label: string;
  },
): Promise<void> {
  // Проверка существования таблицы и колонки
  const tableExists = await ctx.prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
    opts.table,
  );
  if (tableExists.length === 0) {
    ctx.log(`${opts.label}: table '${opts.table}' не существует — skip`);
    return;
  }
  const colInfo = await ctx.prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `PRAGMA table_info('${opts.table}')`,
  );
  if (!colInfo.some((c) => c.name === opts.blobCol)) {
    ctx.log(`${opts.label}: column '${opts.blobCol}' нет в '${opts.table}' — skip`);
    return;
  }

  const rows = await ctx.prisma.$queryRawUnsafe<Array<Record<string, string | null>>>(
    `SELECT ${opts.idCol}, ${opts.blobCol} FROM ${opts.table} WHERE ${opts.blobCol} IS NOT NULL`,
  );
  let rekeyed = 0;
  let alreadyNew = 0;
  let failed = 0;
  for (const row of rows) {
    const id = row[opts.idCol];
    const blob = row[opts.blobCol];
    if (!id || !blob) continue;
    const res = rekeyBlob(blob, opts.newKey, opts.legacyKey);
    if (res.alreadyNew) {
      alreadyNew++;
      continue;
    }
    if (!res.rekeyed) {
      ctx.log(`WARN: ${opts.label}.${id} rekey failed: ${res.error}`);
      failed++;
      continue;
    }
    await ctx.prisma.$executeRawUnsafe(
      `UPDATE ${opts.table} SET ${opts.blobCol} = ? WHERE ${opts.idCol} = ?`,
      res.rekeyed,
      id,
    );
    rekeyed++;
  }
  ctx.log(`${opts.label}: rekeyed=${rekeyed} alreadyNew=${alreadyNew} failed=${failed}`);
}

export default migration;
