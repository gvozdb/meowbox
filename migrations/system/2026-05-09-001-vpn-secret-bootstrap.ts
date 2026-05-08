/**
 * Bootstrap master-ключа VPN (`.vpn-key` в data-директории).
 *
 * См. docs/specs/2026-05-09-vpn-management.md §6.
 *
 * Если файла нет — создаём (32 байта random, perms 600). Идемпотентно: если
 * файл уже есть и валидной длины — пропускаем. Невалидной длины (битый/чужой
 * файл) — миграция падает с понятной ошибкой; оператор должен решить:
 * грохнуть файл руками (потеряем все зашифрованные VPN-конфиги) или
 * заимпортить старый ключ.
 */

import * as crypto from 'crypto';
import type { SystemMigration } from './_types';

const KEY_FILENAME = '.vpn-key';
const KEY_LEN = 32;

const migration: SystemMigration = {
  id: '2026-05-09-001-vpn-secret-bootstrap',
  description: 'Bootstrap VPN master-key (.vpn-key)',

  async up(ctx) {
    const dataDir = process.env.MEOWBOX_DATA_DIR?.trim() || '/opt/meowbox/data';
    const filePath = `${dataDir}/${KEY_FILENAME}`;

    // 1) Если задан VPN_SECRET_KEY в env — файл не нужен.
    if (process.env.VPN_SECRET_KEY?.trim()) {
      ctx.log('VPN_SECRET_KEY уже задан в env — skip bootstrap файла');
      return;
    }

    // 2) Файл уже есть?
    if (await ctx.exists(filePath)) {
      const fs = await import('fs');
      const buf = fs.readFileSync(filePath);
      if (buf.length !== KEY_LEN) {
        throw new Error(
          `${filePath} существует, но имеет ${buf.length} байт вместо ${KEY_LEN}. ` +
            `Удали файл руками (потеряем все VPN-конфиги) или восстанови валидный ключ из бэкапа.`,
        );
      }
      ctx.log(`OK: ${filePath} уже существует (${KEY_LEN} байт)`);
      return;
    }

    if (ctx.dryRun) {
      ctx.log(`would create ${filePath} with 32 random bytes (mode 600)`);
      return;
    }

    // 3) Создаём.
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
      `OK: создан ${filePath} (32 байта). БЭКАПЬ этот файл вместе с БД — ` +
        `без него VPN-конфиги нечитаемы.`,
    );
  },
};

export default migration;
