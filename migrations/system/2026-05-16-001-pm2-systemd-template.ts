/**
 * Устанавливает systemd-шаблон `pm2@.service` для автозагрузки PM2-демонов
 * сайтов при старте сервера.
 *
 * Зачем шаблон, а не `pm2 startup`:
 *   `pm2 startup` генерирует только конкретный `pm2-<user>.service` на одного
 *   юзера. Нам нужен один шаблон-юнит и N инстансов `pm2@<user>` — по одному
 *   на каждый сайт с Node-приложением. `%i` в template подставляется в имя
 *   юзера (= Site.name) и в путь домашней директории сайта.
 *
 * Тумблер автозагрузки в панели = `systemctl enable/disable pm2@<user>`.
 * На старте сервера `ExecStart=pm2 resurrect` поднимает процессы из dump.pm2.
 *
 * Идемпотентно: пишет файл только если его содержимое отличается; daemon-reload
 * вызывается только при фактической записи.
 *
 * Совместимость: требует systemd. Если systemctl нет — миграция логирует
 * warning и завершается без падения (автозагрузка Node-приложений работать не
 * будет, но остальная панель — да).
 */

import type { SystemMigration } from './_types';

const UNIT_PATH = '/etc/systemd/system/pm2@.service';
const PM2_CANDIDATES = ['/usr/local/bin/pm2', '/usr/bin/pm2'];

function buildUnit(pm2Bin: string, sitesBasePath: string): string {
  const base = sitesBasePath.replace(/\/+$/, '');
  return `# Managed by Meowbox — systemd-шаблон автозагрузки PM2-демона сайта.
# Инстанс: pm2@<site-user>.service  (%i = системный юзер сайта = Site.name)
[Unit]
Description=PM2 process manager for %i (Meowbox)
Documentation=https://pm2.keymetrics.io/
After=network.target

[Service]
Type=forking
User=%i
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
Environment=PM2_HOME=${base}/%i/.pm2
PIDFile=${base}/%i/.pm2/pm2.pid
Restart=on-failure
RestartSec=10

ExecStart=${pm2Bin} resurrect
ExecReload=${pm2Bin} reload all
ExecStop=${pm2Bin} kill

[Install]
WantedBy=multi-user.target
`;
}

const migration: SystemMigration = {
  id: '2026-05-16-001-pm2-systemd-template',
  description: 'Node-приложения: установить systemd-шаблон pm2@.service для автозагрузки',

  async up(ctx) {
    // systemd обязателен.
    let hasSystemctl = true;
    try {
      await ctx.exec.run('which', ['systemctl']);
    } catch {
      hasSystemctl = false;
    }
    if (!hasSystemctl) {
      ctx.log(
        'WARNING: systemctl не найден — пропускаю установку pm2@.service. ' +
          'Автозагрузка Node-приложений работать не будет.',
      );
      return;
    }

    // Поиск бинаря pm2: сперва кандидаты, затем `which`.
    let pm2Bin = '';
    for (const cand of PM2_CANDIDATES) {
      if (await ctx.exists(cand)) {
        pm2Bin = cand;
        break;
      }
    }
    if (!pm2Bin) {
      try {
        const r = await ctx.exec.run('which', ['pm2']);
        pm2Bin = r.stdout.trim().split('\n')[0] || '';
      } catch {
        pm2Bin = '';
      }
    }
    if (!pm2Bin) {
      ctx.log('WARNING: бинарь pm2 не найден — пропускаю установку pm2@.service.');
      return;
    }

    const desired = buildUnit(pm2Bin, ctx.config.sitesBasePath);

    // Идемпотентность: если файл уже содержит ровно то же — ничего не делаем.
    if (await ctx.exists(UNIT_PATH)) {
      const current = await ctx.readFile(UNIT_PATH);
      if (current === desired) {
        ctx.log(`OK: ${UNIT_PATH} актуален`);
        return;
      }
    }

    if (ctx.dryRun) {
      ctx.log(`would: write ${UNIT_PATH} (pm2=${pm2Bin}) + systemctl daemon-reload`);
      return;
    }

    await ctx.writeFile(UNIT_PATH, desired, 0o644);
    ctx.log(`записан ${UNIT_PATH} (pm2=${pm2Bin})`);

    await ctx.exec.run('systemctl', ['daemon-reload']);
    ctx.log('systemctl daemon-reload выполнен');
  },

  async down(ctx) {
    if (!(await ctx.exists(UNIT_PATH))) return;
    if (ctx.dryRun) {
      ctx.log(`would: rm ${UNIT_PATH} + daemon-reload`);
      return;
    }
    await ctx.exec.run('rm', ['-f', UNIT_PATH]);
    await ctx.exec.run('systemctl', ['daemon-reload']);
    ctx.log(`удалён ${UNIT_PATH}`);
  },
};

export default migration;
