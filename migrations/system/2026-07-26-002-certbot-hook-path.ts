import * as fs from 'node:fs/promises';

import type { SystemMigration } from './_types';

const HOOK_PATH = '/etc/letsencrypt/renewal-hooks/deploy/meowbox-reload-nginx';
const HOOK_BODY = `#!/usr/bin/env bash
# Установлено Meowbox: 2026-07-26-002-certbot-hook-path
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
nginx -t
systemctl reload nginx
`;

const migration: SystemMigration = {
  id: '2026-07-26-002-certbot-hook-path',
  description: 'Certbot deploy-hook с детерминированным системным PATH',

  async up(ctx) {
    const current = await fs.readFile(HOOK_PATH, 'utf8').catch(() => null);
    if (current === HOOK_BODY) {
      if (!ctx.dryRun) await fs.chmod(HOOK_PATH, 0o755);
      ctx.log('certbot deploy-hook уже актуален');
      return;
    }

    if (ctx.dryRun) {
      ctx.log(`[dry-run] would update ${HOOK_PATH}`);
      return;
    }

    await ctx.writeFile(HOOK_PATH, HOOK_BODY, 0o755);
    ctx.log(`updated ${HOOK_PATH}`);
  },
};

export default migration;
