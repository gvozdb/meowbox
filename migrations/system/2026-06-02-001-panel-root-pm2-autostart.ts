import type { SystemMigration } from './_types';

const UNIT_PATH = '/etc/systemd/system/meowbox-panel-pm2.service';
const OLD_ROOT_DROPIN = '/etc/systemd/system/pm2@root.service.d/override.conf';
const OLD_ROOT_DROPIN_DIR = '/etc/systemd/system/pm2@root.service.d';
const PM2_CANDIDATES = ['/usr/local/bin/pm2', '/usr/bin/pm2'];

function buildPanelUnit(pm2Bin: string): string {
  return `# Managed by Meowbox — autostart панели.
[Unit]
Description=PM2 process manager for Meowbox panel
Documentation=https://pm2.keymetrics.io/
After=network.target

[Service]
Type=forking
User=root
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
Environment=PM2_HOME=/root/.pm2
PIDFile=/root/.pm2/pm2.pid
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
  id: '2026-06-02-001-panel-root-pm2-autostart',
  description: 'Панель: включить отдельный systemd-autostart для root PM2',

  async up(ctx) {
    try {
      await ctx.exec.run('which', ['systemctl']);
    } catch {
      ctx.log('WARNING: systemctl не найден — autostart панели пропущен');
      return;
    }

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
      ctx.log('WARNING: pm2 не найден — autostart панели пропущен');
      return;
    }

    const desired = buildPanelUnit(pm2Bin);
    let changed = false;
    if (!(await ctx.exists(UNIT_PATH)) || (await ctx.readFile(UNIT_PATH)) !== desired) {
      changed = true;
      if (ctx.dryRun) ctx.log(`would: write ${UNIT_PATH}`);
      else {
        await ctx.writeFile(UNIT_PATH, desired, 0o644);
        ctx.log(`записан ${UNIT_PATH}`);
      }
    } else {
      ctx.log(`OK: ${UNIT_PATH} актуален`);
    }

    if (!ctx.dryRun && changed) {
      await ctx.exec.run('systemctl', ['daemon-reload']);
      ctx.log('systemctl daemon-reload выполнен');
    }

    if (ctx.dryRun) {
      ctx.log('would: pm2 save + enable meowbox-panel-pm2.service + disable pm2@root.service');
      return;
    }

    await ctx.exec.run(pm2Bin, ['save']);
    ctx.log('pm2 save выполнен');

    await ctx.exec.run('systemctl', ['enable', 'meowbox-panel-pm2.service']);
    ctx.log('meowbox-panel-pm2.service включён');

    await ctx.exec.run('systemctl', ['disable', 'pm2@root.service'], { env: process.env });
    ctx.log('pm2@root.service отключён (site-template не должен управлять панелью)');

    if (await ctx.exists(OLD_ROOT_DROPIN)) {
      await ctx.exec.run('rm', ['-f', OLD_ROOT_DROPIN]);
      ctx.log(`удалён лишний ${OLD_ROOT_DROPIN}`);
    }
    if (await ctx.exists(OLD_ROOT_DROPIN_DIR)) {
      await ctx.exec.runShell(`rmdir ${OLD_ROOT_DROPIN_DIR} 2>/dev/null || true`);
    }
  },

  async down(ctx) {
    if (!(await ctx.exists(UNIT_PATH))) return;
    if (ctx.dryRun) {
      ctx.log(`would: disable meowbox-panel-pm2.service + rm ${UNIT_PATH}`);
      return;
    }
    await ctx.exec.run('systemctl', ['disable', 'meowbox-panel-pm2.service']);
    await ctx.exec.run('rm', ['-f', UNIT_PATH]);
    await ctx.exec.run('systemctl', ['daemon-reload']);
    ctx.log(`удалён ${UNIT_PATH}`);
  },
};

export default migration;
