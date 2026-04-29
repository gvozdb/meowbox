/**
 * Создаёт глобальный nginx-файл /etc/nginx/conf.d/meowbox-zones.conf с
 * объявлением shared-зоны `site_limit`, на которую ссылается
 * 50-security.conf через `limit_req zone=site_limit`.
 *
 * Без этого файла на свежем сервере любой site config валится на nginx -t:
 *   "zero size shared memory zone site_limit"
 *
 * Идемпотентно: если файл уже существует — миграция no-op.
 */

import * as fs from 'node:fs/promises';

import type { SystemMigration } from './_types';

const ZONES_FILE = '/etc/nginx/conf.d/meowbox-zones.conf';
const ZONES_CONTENT = `# === Meowbox global shared zones (управляется install.sh / миграцией) ===
# Rate limit: 30 req/sec на IP, burst настраивается в конфиге сайта.
limit_req_zone $binary_remote_addr zone=site_limit:10m rate=30r/s;
`;

const migration: SystemMigration = {
  id: '2026-04-30-001-nginx-global-zones',
  description: 'Создаёт /etc/nginx/conf.d/meowbox-zones.conf (limit_req_zone site_limit)',

  async up(ctx) {
    if (await ctx.exists(ZONES_FILE)) {
      ctx.log(`${ZONES_FILE} уже существует — skip`);
      return;
    }
    if (ctx.dryRun) {
      ctx.log(`would write ${ZONES_FILE}`);
      return;
    }
    await fs.writeFile(ZONES_FILE, ZONES_CONTENT, 'utf8');
    await fs.chmod(ZONES_FILE, 0o644).catch(() => {});
    ctx.log(`created ${ZONES_FILE}`);
  },
};

export default migration;
