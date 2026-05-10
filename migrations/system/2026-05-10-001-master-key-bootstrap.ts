/**
 * Bootstrap единого master-key (`.master-key` в state/data/).
 *
 * См. docs/specs/2026-05-10-master-key-unification.md §4.2.
 *
 * Что делает (идемпотентно):
 *   1. Если есть `MEOWBOX_MASTER_KEY` в env — пропускает (env приоритетнее
 *      файла).
 *   2. Если файл уже существует и валидной длины (32 байта) — пропускает.
 *   3. Иначе генерит 32 random байта, пишет в `${STATE_DIR}/data/.master-key`
 *      perms 600 (atomic via tmp+rename).
 *
 * После создания файла **обязательно** обновляет `state/.env`:
 *   - Записывает `ADMINER_SSO_KEY = base64(HKDF(master, 'meowbox:adminer-sso:v1'))`.
 *     PHP-плагин Adminer'а читает плоский ключ из .env (не знает про HKDF),
 *     поэтому master-key синхронизируется в env при bootstrap'е. Если
 *     ADMINER_SSO_KEY уже стоит — НЕ переписываем (это могут быть существующие
 *     токены, которые мы не хотим инвалидировать; rekey будет в отдельной
 *     миграции по согласованию).
 *
 * НЕ ДЕЛАЕТ:
 *   - Не перешифровывает существующие blob'ы в БД (это делает миграция
 *     `2026-05-10-002-rekey-secrets`).
 *   - Не удаляет legacy ключи (`.vpn-key`, `.dns-key`).
 */

import * as crypto from 'crypto';
import type { SystemMigration } from './_types';

const KEY_FILENAME = '.master-key';
const KEY_LEN = 32;

function resolveStateDataDir(stateDir: string): string {
  // В release-раскладке state = /opt/meowbox/state, data = state/data.
  return `${stateDir}/data`;
}

const migration: SystemMigration = {
  id: '2026-05-10-001-master-key-bootstrap',
  description: 'Bootstrap единого .master-key (HKDF для всех cipher\'ов)',

  async up(ctx) {
    const dataDir = resolveStateDataDir(ctx.config.stateDir);
    const filePath = `${dataDir}/${KEY_FILENAME}`;

    // 1) ENV override?
    if (process.env.MEOWBOX_MASTER_KEY?.trim()) {
      ctx.log('MEOWBOX_MASTER_KEY уже задан в env — skip bootstrap файла');
    } else if (await ctx.exists(filePath)) {
      const fs = await import('fs');
      const buf = fs.readFileSync(filePath);
      if (buf.length !== KEY_LEN) {
        throw new Error(
          `${filePath} существует, но имеет ${buf.length} байт вместо ${KEY_LEN}. ` +
            `Восстанови валидный ключ из бэкапа или удали файл (всё зашифрованное в БД станет нечитаемо).`,
        );
      }
      ctx.log(`OK: ${filePath} уже существует (${KEY_LEN} байт)`);
    } else {
      if (ctx.dryRun) {
        ctx.log(`would create ${filePath} with 32 random bytes (mode 600)`);
      } else {
        const fs = await import('fs');
        fs.mkdirSync(dataDir, { recursive: true });
        const key = crypto.randomBytes(KEY_LEN);
        const tmp = `${filePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, key, { mode: 0o600 });
        try {
          fs.chmodSync(tmp, 0o600);
        } catch {
          /* umask */
        }
        fs.renameSync(tmp, filePath);
        ctx.log(
          `OK: создан ${filePath} (32 байта). БЭКАПЬ этот файл — без него ` +
            `все секреты в БД (SSH-пароли, БД-пароли, VPN-конфиги, DNS-креды) станут нечитаемыми.`,
        );
      }
    }

    // 2) Синхронизация ADMINER_SSO_KEY с HKDF(master, 'adminer-sso')
    // PHP-сторона читает плоский ключ из .env; чтобы не вводить два разных
    // ключа для Node и PHP — производим один из master.
    await syncAdminerSsoKey(ctx, filePath);
  },
};

async function syncAdminerSsoKey(
  ctx: Parameters<SystemMigration['up']>[0],
  masterKeyPath: string,
): Promise<void> {
  const envPath = `${ctx.config.stateDir}/.env`;
  if (!(await ctx.exists(envPath))) {
    ctx.log(`.env не найден на ${envPath} — пропускаю sync ADMINER_SSO_KEY`);
    return;
  }

  // Загружаем master-key (env приоритет, иначе файл)
  let masterKey: Buffer | null = null;
  const fromEnv = process.env.MEOWBOX_MASTER_KEY?.trim();
  if (fromEnv) {
    try {
      const buf = Buffer.from(fromEnv, 'base64');
      if (buf.length === KEY_LEN) masterKey = buf;
    } catch {
      /* invalid */
    }
  }
  if (!masterKey) {
    const fs = await import('fs');
    try {
      const buf = fs.readFileSync(masterKeyPath);
      if (buf.length === KEY_LEN) masterKey = buf;
    } catch {
      /* нет файла */
    }
  }
  if (!masterKey) {
    ctx.log('master-key недоступен — пропускаю sync ADMINER_SSO_KEY');
    return;
  }

  // HKDF derive
  const info = Buffer.from('meowbox:adminer-sso:v1', 'utf8');
  const ab = crypto.hkdfSync('sha256', masterKey, Buffer.alloc(0), info, KEY_LEN);
  const derived = Buffer.from(ab).toString('base64');

  // Читаем .env, ищем ADMINER_SSO_KEY=
  const env = await ctx.readFile(envPath);
  const lines = env.split('\n');
  let foundIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*ADMINER_SSO_KEY\s*=/.test(lines[i])) {
      foundIdx = i;
      break;
    }
  }

  if (foundIdx >= 0) {
    const m = lines[foundIdx].match(/=\s*(?:"([^"]*)"|(.+?))\s*$/);
    const current = (m?.[1] ?? m?.[2] ?? '').trim();
    if (current === derived) {
      ctx.log('ADMINER_SSO_KEY уже синхронизирован с master-key');
      return;
    }
    // Переписываем ВСЕГДА — единый источник правды это master-key.
    // Активные Adminer-сессии инвалидируются, юзеры повторно залогинятся через
    // основной аккаунт панели (Adminer SSO — короткоживущий ticket-based flow).
    if (ctx.dryRun) {
      ctx.log(`would rewrite ADMINER_SSO_KEY in ${envPath} (was: ${current.slice(0, 8)}..., new: ${derived.slice(0, 8)}...)`);
      return;
    }
    lines[foundIdx] = `ADMINER_SSO_KEY="${derived}"`;
    await ctx.writeFile(envPath, lines.join('\n'), 0o600);
    ctx.log(`OK: переписал ADMINER_SSO_KEY в ${envPath} (synced from master-key). Активные Adminer-сессии инвалидированы.`);
    // process.env обновим тоже, чтобы текущий рантайм (если миграция запускается
    // в одном процессе с API) сразу подхватил новое значение.
    process.env.ADMINER_SSO_KEY = derived;
    return;
  }

  // Нет ADMINER_SSO_KEY — добавляем
  if (ctx.dryRun) {
    ctx.log(`would append ADMINER_SSO_KEY="${derived.slice(0, 8)}..." to ${envPath}`);
    return;
  }
  const append = `\n# Adminer SSO key (derived from .master-key via HKDF)\nADMINER_SSO_KEY="${derived}"\n`;
  await ctx.writeFile(envPath, env + append, 0o600);
  process.env.ADMINER_SSO_KEY = derived;
  ctx.log(`OK: добавил ADMINER_SSO_KEY в ${envPath} (derived из master-key)`);
}

export default migration;
