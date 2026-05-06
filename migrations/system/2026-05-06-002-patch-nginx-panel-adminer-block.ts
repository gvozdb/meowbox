/**
 * Дописать блок `location /adminer/` в /etc/nginx/sites-available/meowbox-panel.
 *
 * Контекст:
 *   - Установка Adminer (sso.php + pool meowbox-adminer) сделана миграцией
 *     2026-04-30-006, но она НЕ патчит nginx server-блок ("чужой конфиг").
 *   - На панелях, поставленных до появления adminer-блока в install.sh,
 *     `/adminer/sso.php?ticket=...` отдаёт 404 → Adminer не открывается.
 *   - install.sh сейчас умеет писать корректный server-блок, но `make update`
 *     его не перегенерирует — апгрейд без миграции не лечит.
 *
 * Что делает (идемпотентно):
 *   1. Если в конфиге уже есть `location /adminer/` — skip.
 *   2. Резолвит ADMINER_DIR: state/adminer (release-mode) или tools/adminer.
 *   3. Бэкап конфига в `<conf>.bak.<timestamp>`.
 *   4. Вставляет блок прямо ПЕРЕД финальным `location / {` (Nuxt catch-all).
 *      Если такой строки нет — fallback: вставка перед последней `}` в файле.
 *   5. `nginx -t`. На фейле — восстанавливает бэкап и бросает ошибку.
 *   6. `nginx -s reload`.
 *
 * Только Debian/Ubuntu: на других ОС — skip.
 */

import * as path from 'node:path';

import type { SystemMigration } from './_types';

const NGINX_CONF = '/etc/nginx/sites-available/meowbox-panel';

function buildAdminerBlock(adminerDir: string): string {
  // Точная копия из install.sh (raw, без shell-escape `\$`).
  // Внутри nginx: $uri / $args / $1 — переменные nginx, не bash.
  return `
    # ---------------------------------------------------------------------
    # Adminer (встроенный, /adminer/) — отдельный PHP-FPM пул
    # /adminer/sso.php — обмен одноразового SSO-ticket'а на сессионную куку
    # /adminer/        — сам Adminer (читает credentials из куки)
    # Добавлено миграцией 2026-05-06-002 (старый install не писал этот блок).
    # ---------------------------------------------------------------------
    location ^~ /adminer/ {
        alias ${adminerDir}/;
        index index.php;

        add_header X-Robots-Tag "noindex,nofollow" always;
        add_header X-Frame-Options "SAMEORIGIN" always;

        client_max_body_size 128m;

        try_files $uri $uri/ /adminer/index.php?$args;

        location ~ ^/adminer/lib/ {
            deny all;
            return 403;
        }

        location ~ ^/adminer/(index|sso|adminer)\\.php$ {
            alias ${adminerDir}/;
            try_files /$1.php =404;

            fastcgi_pass unix:/run/php/meowbox-adminer.sock;
            fastcgi_index index.php;
            fastcgi_param SCRIPT_FILENAME ${adminerDir}/$1.php;
            fastcgi_param DOCUMENT_ROOT ${adminerDir};
            include fastcgi_params;
            fastcgi_read_timeout 120s;
            fastcgi_buffers 16 16k;
            fastcgi_buffer_size 32k;
        }
    }

`;
}

async function resolveAdminerDir(ctx: { config: { stateDir: string; currentDir: string }; exists: (p: string) => Promise<boolean> }): Promise<string> {
  // Predпочитаем state/adminer (он же — таргет симлинка current/tools/adminer).
  // На случай legacy-инсталла без state/ — фолбэк на tools/adminer.
  const stateAdminer = path.join(ctx.config.stateDir, 'adminer');
  if (await ctx.exists(stateAdminer)) return stateAdminer;
  const toolsAdminer = path.join(ctx.config.currentDir, 'tools', 'adminer');
  return toolsAdminer;
}

const migration: SystemMigration = {
  id: '2026-05-06-002-patch-nginx-panel-adminer-block',
  description: 'Добавить location /adminer/ в meowbox-panel.conf на старых установках (фикс 404 sso.php)',

  async up(ctx) {
    if (!(await ctx.exists('/usr/bin/apt-get'))) {
      ctx.log('SKIP: apt-get не найден — поддерживается только Debian/Ubuntu');
      return;
    }

    if (!(await ctx.exists(NGINX_CONF))) {
      ctx.log(`SKIP: ${NGINX_CONF} не существует — панель не установлена через install.sh`);
      return;
    }

    const conf = await ctx.readFile(NGINX_CONF);

    // Идемпотентность: уже пропатчено — выходим.
    if (/location\s+\^?~?\s*\/adminer\//.test(conf)) {
      ctx.log('OK: location /adminer/ уже есть в конфиге, ничего не делаю');
      return;
    }

    const adminerDir = await resolveAdminerDir(ctx);
    ctx.log(`ADMINER_DIR = ${adminerDir}`);

    if (!(await ctx.exists(path.join(adminerDir, 'sso.php')))) {
      ctx.log(
        `WARN: ${adminerDir}/sso.php не найден. ` +
        'Сначала должна отработать миграция 2026-04-30-006-install-adminer-on-existing. ' +
        'Прерываюсь, чтобы не получить рабочий nginx-блок без рабочего PHP.',
      );
      throw new Error(`Adminer files missing in ${adminerDir} — re-run migration runner после установки adminer`);
    }

    // Точка вставки: ПЕРЕД финальным `location / {` (Nuxt catch-all).
    // Этот блок в шаблоне install.sh — последняя локация в server-блоке.
    const block = buildAdminerBlock(adminerDir);
    const catchAllRe = /^([ \t]*)location\s+\/\s*\{/m;
    const m = catchAllRe.exec(conf);

    let patched: string;
    if (m) {
      const insertAt = m.index;
      patched = conf.slice(0, insertAt) + block + conf.slice(insertAt);
      ctx.log('Вставка перед `location / {` (Nuxt catch-all)');
    } else {
      // Fallback: перед последней `}` в файле (закрытие server-блока).
      const lastBrace = conf.lastIndexOf('}');
      if (lastBrace < 0) {
        throw new Error(`${NGINX_CONF} не похож на nginx-конфиг — нет ни одной '}'`);
      }
      patched = conf.slice(0, lastBrace) + block + conf.slice(lastBrace);
      ctx.log('WARN: catch-all `location / {` не найден, вставляю перед последней `}`');
    }

    if (ctx.dryRun) {
      ctx.log(`would patch ${NGINX_CONF} (insert ${block.length} bytes)`);
      ctx.log('would run: nginx -t && nginx -s reload');
      return;
    }

    // Бэкап рядом с конфигом (rollback при `nginx -t` фейле).
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${NGINX_CONF}.bak.${ts}`;
    await ctx.exec.run('cp', ['-a', NGINX_CONF, backup]);
    ctx.log(`Backup: ${backup}`);

    await ctx.writeFile(NGINX_CONF, patched);

    try {
      await ctx.exec.run('nginx', ['-t']);
    } catch (e) {
      // Откат: возвращаем оригинал, чтобы nginx остался в рабочем состоянии.
      ctx.log(`ERR: nginx -t упал, откатываю конфиг`);
      await ctx.exec.run('cp', ['-a', backup, NGINX_CONF]);
      throw new Error(`nginx -t failed after patch: ${(e as Error).message}`);
    }

    await ctx.exec.runShell('systemctl reload nginx || nginx -s reload');
    ctx.log('OK: nginx reloaded, /adminer/ теперь доступен');
  },
};

export default migration;
