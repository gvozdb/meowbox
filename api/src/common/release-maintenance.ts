import * as fs from 'node:fs';
import * as path from 'node:path';

function fileDatabasePath(): string {
  const explicit = process.env.MEOWBOX_DATABASE_FILE?.trim();
  if (explicit) return path.resolve(explicit);

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl?.startsWith('file:')) {
    const raw = databaseUrl.slice('file:'.length).split(/[?#]/, 1)[0] ?? '';
    if (raw) return path.resolve(decodeURIComponent(raw));
  }

  const panelDir = path.resolve(process.env.MEOWBOX_PANEL_DIR?.trim() || path.join(process.cwd(), '..'));
  const stateDir = path.resolve(process.env.MEOWBOX_STATE_DIR?.trim() || path.join(panelDir, 'state'));
  return path.join(stateDir, 'data', 'meowbox.db');
}

export function releaseMaintenanceFile(): string {
  const database = fileDatabasePath();
  let canonicalDatabase = database;
  try {
    canonicalDatabase = fs.realpathSync(database);
  } catch {
    // The API cannot safely accept writes if the configured DB path is
    // unresolved; keep the deterministic marker beside that path.
  }
  return path.join(path.dirname(canonicalDatabase), 'migrations', 'release-maintenance.json');
}

export function isReleaseMaintenanceActive(): boolean {
  try {
    const metadata = fs.lstatSync(releaseMaintenanceFile());
    return metadata.isFile() || metadata.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true;
  }
}
