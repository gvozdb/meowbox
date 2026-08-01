/**
 * Bootstrap rate-limit zones for existing configs (one-shot).
 *
 * Preserves all declarations already present in meowbox-zones.conf and adds
 * only zones referenced by active managed configs. This is compatible with
 * both the historical `site_*` layout and the current `mb_*` domain layout.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  collectDeclaredRateLimitZones,
  collectReferencedRateLimitZones,
  mergeRateLimitZones,
} from './_rate-limit-zones';
import type { MigrationContext, SystemMigration } from './_types';

export interface RateLimitZonesMigrationPaths {
  zonesPath: string;
  configRoots: readonly string[];
  nginxBinary: string;
  systemctlBinary: string;
}

const DEFAULT_PATHS: RateLimitZonesMigrationPaths = {
  zonesPath: '/etc/nginx/conf.d/meowbox-zones.conf',
  configRoots: [
    '/etc/nginx/nginx.conf',
    '/etc/nginx/meowbox',
    '/etc/nginx/sites-enabled',
    '/etc/nginx/conf.d',
  ],
  nginxBinary: '/usr/sbin/nginx',
  systemctlBinary: '/usr/bin/systemctl',
};

async function readOptional(ctx: MigrationContext, file: string): Promise<string | null> {
  try {
    return await ctx.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

interface ManagedZoneState {
  referenced: Set<string>;
  externallyDeclared: Set<string>;
}

async function collectManagedZoneState(
  paths: RateLimitZonesMigrationPaths,
): Promise<ManagedZoneState> {
  const referenced = new Set<string>();
  const externallyDeclared = new Set<string>();

  const collect = (content: string): void => {
    for (const zone of collectReferencedRateLimitZones(content)) referenced.add(zone);
    for (const zone of collectDeclaredRateLimitZones(content)) externallyDeclared.add(zone);
  };

  const walk = async (entryPath: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(entryPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') {
        if (entryPath !== paths.zonesPath && entryPath.endsWith('.conf')) {
          const content = await fs.readFile(entryPath, 'utf8').catch(() => null);
          if (content !== null) collect(content);
        }
      }
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = path.join(entryPath, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (child === paths.zonesPath) continue;
        const content = await fs.readFile(child, 'utf8').catch(() => null);
        if (content === null) continue;
        collect(content);
      }
    }
  };

  for (const root of paths.configRoots) await walk(root);
  return { referenced, externallyDeclared };
}

async function buildUpdate(ctx: MigrationContext, paths: RateLimitZonesMigrationPaths) {
  const currentContent = await readOptional(ctx, paths.zonesPath);
  const zoneState = await collectManagedZoneState(paths);
  return {
    currentContent,
    result: mergeRateLimitZones(
      currentContent,
      zoneState.referenced,
      zoneState.externallyDeclared,
    ),
  };
}

async function restoreOriginal(
  ctx: MigrationContext,
  paths: RateLimitZonesMigrationPaths,
  originalContent: string | null,
): Promise<void> {
  if (originalContent === null) {
    await fs.unlink(paths.zonesPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return;
  }
  await ctx.writeFile(paths.zonesPath, originalContent);
}

export function createRateLimitZonesMigration(
  paths: RateLimitZonesMigrationPaths = DEFAULT_PATHS,
): SystemMigration {
  return {
    id: '2026-04-30-002-rate-limit-zones-bootstrap',
    description: 'Безопасно дополняет meowbox-zones.conf используемыми rate-limit zones',

    async preflight(ctx) {
      for (const executable of [paths.nginxBinary, paths.systemctlBinary]) {
        if (!(await ctx.exists(executable))) {
          return { ok: false, reason: `Не найден обязательный executable: ${executable}` };
        }
      }
      return { ok: true };
    },

    async plan(ctx) {
      const { result } = await buildUpdate(ctx, paths);
      return {
        summary:
          `preserve ${result.declaredCount - result.addedZones.length} declared zones; ` +
          `ensure ${result.referencedCount} referenced zones and site_limit; ` +
          `append ${result.addedZones.length}`,
        details: {
          declaredZones: result.declaredCount,
          referencedZones: result.referencedCount,
          zonesToAppend: result.addedZones.length,
        },
      };
    },

    async up(ctx) {
      await ctx.exec.run(paths.nginxBinary, ['-t']).catch((error) => {
        throw new Error(`nginx -t failed до изменения zones: ${(error as Error).message}`);
      });

      const { currentContent, result } = await buildUpdate(ctx, paths);

      if (ctx.dryRun) {
        ctx.log(`would append ${result.addedZones.length} missing zones to ${paths.zonesPath}`);
        return;
      }

      if (result.content === (currentContent ?? '')) {
        ctx.log(`OK: ${paths.zonesPath} уже содержит все используемые зоны`);
        return;
      }

      let wrote = false;
      try {
        await ctx.writeFile(
          paths.zonesPath,
          result.content,
          currentContent === null ? 0o644 : undefined,
        );
        wrote = true;
        await ctx.exec.run(paths.nginxBinary, ['-t']);
        await ctx.exec.run(paths.systemctlBinary, ['reload', 'nginx']);
        ctx.log(
          `OK: ${paths.zonesPath} дополнен (${result.addedZones.length} zones; ` +
          `${result.declaredCount} total)`,
        );
      } catch (error) {
        let rollbackError: Error | null = null;
        if (wrote) {
          try {
            await restoreOriginal(ctx, paths, currentContent);
            await ctx.exec.run(paths.nginxBinary, ['-t']);
            await ctx.exec.run(paths.systemctlBinary, ['reload', 'nginx']);
          } catch (restoreError) {
            rollbackError = restoreError as Error;
          }
        }
        const rollbackSuffix = rollbackError
          ? `; rollback failed: ${rollbackError.message}`
          : '; исходный zones-файл восстановлен';
        throw new Error(
          `nginx activation failed после обновления zones: ` +
          `${(error as Error).message}${rollbackSuffix}`,
        );
      }
    },
  };
}

const migration = createRateLimitZonesMigration();

export default migration;
