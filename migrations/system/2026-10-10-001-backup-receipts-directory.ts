import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SystemMigration } from './_types';

const migration: SystemMigration = {
  id: '2026-10-10-001-backup-receipts-directory',
  description: 'Create private bounded backup receipt journal directory',
  async up(ctx) {
    const directory = path.join(ctx.config.stateDir, 'data', 'backup-receipts');
    if (ctx.dryRun) { ctx.log(`Ensure private directory: ${directory}`); return; }
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
  },
};
export default migration;
