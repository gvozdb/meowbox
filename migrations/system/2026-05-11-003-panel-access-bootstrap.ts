/**
 * Bootstrap для фичи «Доступ к панели» (settings → access):
 *   - Создаёт ACME webroot `/var/www/meowbox-acme` (для certbot --webroot).
 *   - Кладёт renewal post-hook, чтобы после авто-renew certbot перечитал nginx.
 *   - Создаёт директорию /etc/ssl/meowbox/panel для self-signed cert'ов.
 *   - Сидит дефолтный PanelSetting('panel-access') если ещё нет.
 *
 * Сид НЕ копирует PANEL_DOMAIN из .env: при первичной установке домена ещё нет
 * (install.sh всегда ставит http), оператор привязывает домен через UI.
 *
 * Идемпотентно: повторный запуск — no-op.
 */

import type { SystemMigration } from './_types';

const ACME_WEBROOT = '/var/www/meowbox-acme';
const SELFSIGNED_DIR = '/etc/ssl/meowbox/panel';
const RENEW_HOOK_PATH = '/etc/letsencrypt/renewal-hooks/deploy/meowbox-reload-nginx';

const HOOK_BODY = `#!/usr/bin/env bash
# Установлено meowbox: 2026-05-11-003-panel-access-bootstrap
# certbot вызывает этот скрипт после успешного renew/выпуска. Дёргаем nginx
# reload, чтобы новые cert/key подхватились без перезапуска сервиса.
set -e
nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
`;

const migration: SystemMigration = {
  id: '2026-05-11-003-panel-access-bootstrap',
  description: 'Bootstrap для Settings → Доступ к панели (ACME webroot, renewal hook, дефолты)',

  async up(ctx) {
    if (ctx.dryRun) {
      ctx.log(`would create ${ACME_WEBROOT}, ${SELFSIGNED_DIR}, ${RENEW_HOOK_PATH}, seed panelSetting('panel-access')`);
      return;
    }

    // 1) ACME webroot — должен быть читаем nginx'у.
    try {
      await ctx.exec.runShell(`mkdir -p ${ACME_WEBROOT} && chmod 0755 ${ACME_WEBROOT}`);
      ctx.log(`OK: ${ACME_WEBROOT} готов`);
    } catch (e) {
      ctx.log(`WARN: не удалось создать ${ACME_WEBROOT}: ${(e as Error).message}`);
    }

    // 2) Директория self-signed cert'ов — 0700, только root.
    try {
      await ctx.exec.runShell(`mkdir -p ${SELFSIGNED_DIR} && chmod 0700 ${SELFSIGNED_DIR}`);
      ctx.log(`OK: ${SELFSIGNED_DIR} готов`);
    } catch (e) {
      ctx.log(`WARN: не удалось создать ${SELFSIGNED_DIR}: ${(e as Error).message}`);
    }

    // 3) renewal post-hook — для авто-перевыпуска certbot.timer.
    if (!(await ctx.exists(RENEW_HOOK_PATH))) {
      try {
        await ctx.exec.runShell(`mkdir -p /etc/letsencrypt/renewal-hooks/deploy`);
        await ctx.writeFile(RENEW_HOOK_PATH, HOOK_BODY, 0o755);
        ctx.log(`OK: установлен renewal-hook ${RENEW_HOOK_PATH}`);
      } catch (e) {
        ctx.log(`WARN: renewal-hook не записан: ${(e as Error).message}`);
      }
    } else {
      ctx.log(`OK: renewal-hook уже на месте`);
    }

    // 4) Sid дефолтных настроек panel-access (если ещё не существует).
    //    Используем raw upsert через prisma.panelSetting (KV-стор).
    try {
      const existing = await ctx.prisma.panelSetting.findUnique({ where: { key: 'panel-access' } });
      if (!existing) {
        const defaults = {
          domain: null,
          certMode: 'NONE',
          httpsRedirect: false,
          denyIpAccess: false,
          certIssuedAt: null,
          certExpiresAt: null,
          certPath: null,
          keyPath: null,
          leLastError: null,
          leEmail: null,
        };
        await ctx.prisma.panelSetting.create({
          data: { key: 'panel-access', value: JSON.stringify(defaults) },
        });
        ctx.log(`OK: создана дефолтная запись panelSetting('panel-access')`);
      } else {
        ctx.log(`OK: panelSetting('panel-access') уже существует`);
      }
    } catch (e) {
      ctx.log(`WARN: seed panel-access default fail: ${(e as Error).message}`);
    }

    ctx.log('Panel-access bootstrap done');
  },
};

export default migration;
