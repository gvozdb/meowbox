/**
 * Canonical systemd template for PM2 processes owned by site users.
 *
 * A single `pm2@.service` template lets every site opt in independently via
 * `systemctl enable pm2@<site-user>`.  The unit is shared by the installer
 * and the repair migration so their generated runtime stays byte-for-byte
 * identical.
 */
export const PM2_SITE_AUTOSTART_UNIT = 'pm2@.service';
export const PM2_SITE_AUTOSTART_UNIT_PATH = `/etc/systemd/system/${PM2_SITE_AUTOSTART_UNIT}`;
export const PM2_SITE_AUTOSTART_PM2_CANDIDATES = [
  '/usr/local/bin/pm2',
  '/usr/bin/pm2',
] as const;

function safeAbsolutePath(value: string, label: string): string {
  if (
    !value ||
    value !== value.trim() ||
    !value.startsWith('/') ||
    /[\0\r\n\t ]/.test(value)
  ) {
    throw new Error(`Invalid ${label} for PM2 site autostart unit`);
  }
  const withoutTrailingSlashes = value.replace(/\/+$/, '');
  return withoutTrailingSlashes || '/';
}

/** Returns the managed `pm2@.service` unit content. */
export function pm2SiteAutostartUnitContent(pm2Bin: string, sitesBasePath: string): string {
  const binary = safeAbsolutePath(pm2Bin, 'PM2 binary path');
  const base = safeAbsolutePath(sitesBasePath, 'sites base path');
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

ExecStart=${binary} resurrect
ExecReload=${binary} reload all
ExecStop=${binary} kill

[Install]
WantedBy=multi-user.target
`;
}
