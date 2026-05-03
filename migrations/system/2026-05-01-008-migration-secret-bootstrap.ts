/**
 * Bootstrap MIGRATION_SECRET — AES-256-GCM ключ для шифрования источниковых
 * SSH/MySQL кредов в записях `hostpanel_migrations.source`.
 *
 * Контекст:
 *   - Страница /admin/migrate-hostpanel принимает SSH+MySQL пароли источника
 *     для подключения к старой hostPanel-VPS. Эти пароли надо хранить
 *     зашифрованными до момента запуска миграции (UI никогда не отображает их
 *     в открытом виде, бэкенд расшифровывает только перед emit'ом на агента).
 *   - Шифрование AES-256-GCM, ключ 32 байта (base64). Код шифрования живёт
 *     в api/src/common/migration-cipher.ts (тот же паттерн, что DNS_CREDENTIAL_KEY
 *     и ADMINER_SSO_KEY).
 *
 * Что делает:
 *   1. Ищет state/.env (или panelDir/.env как fallback).
 *   2. Если MIGRATION_SECRET ещё нет — генерит 32 random bytes (base64) и
 *      дописывает в .env.
 *   3. Идемпотентно: повторный запуск проверяет наличие переменной.
 */

import { randomBytes } from 'crypto';
import * as path from 'path';

import type { MigrationContext, SystemMigration } from './_types';

async function resolveEnvFile(ctx: MigrationContext): Promise<string | null> {
  const candidates = [
    path.join(ctx.config.stateDir, '.env'),
    path.join(ctx.config.panelDir, '.env'),
  ];
  for (const c of candidates) {
    if (await ctx.exists(c)) return c;
  }
  return null;
}

const migration: SystemMigration = {
  id: '2026-05-01-008-migration-secret-bootstrap',
  description: 'Сгенерировать MIGRATION_SECRET для шифрования кредов hostpanel-миграций',

  async up(ctx) {
    const envFile = await resolveEnvFile(ctx);
    if (!envFile) {
      ctx.log('WARN: state/.env не найден — пропускаю MIGRATION_SECRET');
      return;
    }

    const raw = await ctx.readFile(envFile).catch(() => '');
    if (/^MIGRATION_SECRET=.+$/m.test(raw)) {
      ctx.log('OK: MIGRATION_SECRET уже есть в .env');
      return;
    }

    if (ctx.dryRun) {
      ctx.log(`would append MIGRATION_SECRET to ${envFile}`);
      return;
    }

    const key = randomBytes(32).toString('base64');
    const sep = raw === '' || raw.endsWith('\n') ? '' : '\n';
    await ctx.writeFile(envFile, `${raw}${sep}MIGRATION_SECRET=${key}\n`);
    ctx.log(`OK: MIGRATION_SECRET дописан в ${envFile}`);
  },
};

export default migration;
