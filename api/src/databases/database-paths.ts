import * as path from 'node:path';

export function getDatabaseExportsDir(): string {
  return path.resolve(
    (process.env.DB_EXPORTS_DIR || '/var/meowbox/exports').replace(/\/+$/, ''),
  );
}
