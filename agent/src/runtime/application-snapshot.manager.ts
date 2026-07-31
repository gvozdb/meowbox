import * as fsp from 'fs/promises';
import * as path from 'path';
import { CommandExecutor } from '../command-executor';
import { DatabaseManager } from '../database/database.manager';
import {
  ALLOWED_SITE_ROOT_PREFIXES,
  BACKUP_LOCAL_PATH,
  isUnderAllowedSiteRoot,
  isUnderBackupStorage,
} from '../config';
import {
  resolveSiteDomainRoot,
  validateRuntimeKey,
} from './site-domain-runtime';

const OPERATION_ID_RE = /^[A-Za-z0-9._:-]{8,160}$/;
const DATABASE_NAME_RE = /^[A-Za-z0-9_-]+$/;

export interface SnapshotDatabase {
  name: string;
  type: string;
}

export interface ApplicationSnapshotParams {
  operationId: string;
  siteName: string;
  siteDomainId: string;
  runtimeKey: string;
  rootPath: string;
  filesRelPath: string;
  databases: SnapshotDatabase[];
}

interface SnapshotManifest {
  contractVersion: 1;
  operationId: string;
  siteDomainId: string;
  runtimeKey: string;
  rootPath: string;
  filesRelPath: string;
  filesArchive: string;
  databases: Array<SnapshotDatabase & { dumpFile: string }>;
  createdAt: string;
}

interface DatabaseRollbackDump {
  readonly name: string;
  readonly type: string;
  readonly filePath: string;
}

export class ApplicationSnapshotManager {
  private readonly executor = new CommandExecutor();
  private readonly databases = new DatabaseManager();

  async preflightCreateRoot(params: {
    rootPath: string;
    filesRelPath: string;
  }): Promise<{
    success: boolean;
    applicationRoot?: string;
    exists?: boolean;
    error?: string;
  }> {
    try {
      const root = this.validateSiteRoot(params.rootPath);
      const realRoot = await fsp.realpath(root);
      if (realRoot !== root) {
        throw new Error('Site root must not be a symlink');
      }

      const applicationRoot = resolveSiteDomainRoot(
        realRoot,
        params.filesRelPath,
      );
      if (applicationRoot === realRoot) {
        throw new Error('Application root cannot equal Site root');
      }

      let existingAncestor = applicationRoot;
      while (!(await this.exists(existingAncestor))) {
        const parent = path.dirname(existingAncestor);
        if (parent === existingAncestor) {
          throw new Error('Application root has no valid parent');
        }
        existingAncestor = parent;
      }
      const realAncestor = await fsp.realpath(existingAncestor);
      if (
        realAncestor !== realRoot &&
        !realAncestor.startsWith(`${realRoot}${path.sep}`)
      ) {
        throw new Error('Application root escapes Site root through a symlink');
      }

      if (!(await this.exists(applicationRoot))) {
        return { success: true, applicationRoot, exists: false };
      }

      const stat = await fsp.lstat(applicationRoot);
      if (stat.isSymbolicLink()) {
        throw new Error('Application root must not be a symlink');
      }
      if (!stat.isDirectory()) {
        throw new Error('Application root exists and is not a directory');
      }
      const realApplicationRoot = await fsp.realpath(applicationRoot);
      if (
        realApplicationRoot !== realRoot &&
        !realApplicationRoot.startsWith(`${realRoot}${path.sep}`)
      ) {
        throw new Error('Application root escapes Site root through a symlink');
      }
      if ((await fsp.readdir(realApplicationRoot)).length > 0) {
        throw new Error('Application root already exists and is not empty');
      }

      return {
        success: true,
        applicationRoot: realApplicationRoot,
        exists: true,
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async snapshot(
    params: ApplicationSnapshotParams,
  ): Promise<{ success: boolean; snapshotPath?: string; error?: string }> {
    try {
      this.validateOperationId(params.operationId);
      const runtimeKey = validateRuntimeKey(params.runtimeKey);
      const { root, applicationRoot } = await this.resolveRoots(
        params.rootPath,
        params.filesRelPath,
      );
      const snapshotPath = this.snapshotPath(params.operationId);
      const manifestPath = path.join(snapshotPath, 'manifest.json');

      if (await this.exists(manifestPath)) {
        return { success: true, snapshotPath };
      }
      if (await this.exists(snapshotPath)) {
        throw new Error(
          `Incomplete snapshot already exists for operation ${params.operationId}`,
        );
      }

      const tempPath = `${snapshotPath}.partial-${process.pid}-${Date.now()}`;
      await fsp.mkdir(tempPath, { recursive: true, mode: 0o700 });
      try {
        const archive = path.join(tempPath, 'files.tar.gz');
        const relative = path.relative(root, applicationRoot);
        const tar = await this.executor.execute(
          'tar',
          ['-C', root, '-czf', archive, '--', relative],
          { timeout: 900_000, allowFailure: true },
        );
        if (tar.exitCode !== 0) {
          throw new Error(`Application archive failed: ${tar.stderr}`);
        }

        const databaseDumps: SnapshotManifest['databases'] = [];
        for (const [index, database] of params.databases.entries()) {
          if (!DATABASE_NAME_RE.test(database.name)) {
            throw new Error(`Invalid database name: ${database.name}`);
          }
          const exported = await this.databases.exportDatabase(
            database.name,
            database.type,
          );
          if (!exported.success || !exported.filePath) {
            throw new Error(
              `Database snapshot failed for ${database.name}: ${exported.error}`,
            );
          }
          const dumpFile = `database-${index}-${database.name}.sql`;
          await fsp.copyFile(exported.filePath, path.join(tempPath, dumpFile));
          await fsp.unlink(exported.filePath).catch(() => undefined);
          databaseDumps.push({ ...database, dumpFile });
        }

        const manifest: SnapshotManifest = {
          contractVersion: 1,
          operationId: params.operationId,
          siteDomainId: params.siteDomainId,
          runtimeKey,
          rootPath: root,
          filesRelPath: params.filesRelPath,
          filesArchive: 'files.tar.gz',
          databases: databaseDumps,
          createdAt: new Date().toISOString(),
        };
        await fsp.writeFile(
          path.join(tempPath, 'manifest.json'),
          `${JSON.stringify(manifest, null, 2)}\n`,
          { encoding: 'utf8', mode: 0o600 },
        );
        await fsp.rename(tempPath, snapshotPath);
        return { success: true, snapshotPath };
      } catch (error) {
        const failedPath = `${tempPath}.failed`;
        await fsp.rename(tempPath, failedPath).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async restore(
    snapshotPathInput: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const snapshotPath = path.resolve(snapshotPathInput);
      if (!isUnderBackupStorage(snapshotPath)) {
        throw new Error('Snapshot path is outside backup storage');
      }
      const manifest = JSON.parse(
        await fsp.readFile(path.join(snapshotPath, 'manifest.json'), 'utf8'),
      ) as SnapshotManifest;
      if (
        manifest.contractVersion !== 1 ||
        this.snapshotPath(manifest.operationId) !== snapshotPath ||
        manifest.filesArchive !== 'files.tar.gz' ||
        !Array.isArray(manifest.databases)
      ) {
        throw new Error('Invalid application snapshot manifest');
      }
      validateRuntimeKey(manifest.runtimeKey);
      for (const database of manifest.databases) {
        if (
          !DATABASE_NAME_RE.test(database.name) ||
          !['MARIADB', 'MYSQL', 'POSTGRESQL'].includes(database.type) ||
          !/^database-\d+-[A-Za-z0-9_-]+\.sql$/.test(database.dumpFile)
        ) {
          throw new Error('Invalid database entry in application snapshot');
        }
        await this.snapshotFile(snapshotPath, database.dumpFile);
      }
      const filesArchive = await this.snapshotFile(
        snapshotPath,
        manifest.filesArchive,
      );

      const { root, applicationRoot } = await this.resolveRootsForRestore(
        manifest.rootPath,
        manifest.filesRelPath,
      );
      const stagingRoot = path.join(
        root,
        `.meowbox-restore-${manifest.runtimeKey}-${Date.now()}`,
      );
      await fsp.mkdir(stagingRoot, { recursive: false, mode: 0o700 });

      const extracted = await this.executor.execute(
        'tar',
        [
          '-C',
          stagingRoot,
          '-xzf',
          filesArchive,
          '--',
          manifest.filesRelPath,
        ],
        { timeout: 900_000, allowFailure: true },
      );
      if (extracted.exitCode !== 0) {
        await fsp
          .rename(stagingRoot, `${stagingRoot}.failed`)
          .catch(() => undefined);
        throw new Error(`Application restore failed: ${extracted.stderr}`);
      }
      let realStagedApplication: string;
      let rollbackDumps: DatabaseRollbackDump[] = [];
      let databaseMutationStarted = false;
      const trashRoot = path.join(root, '.meowbox-trash');
      const rollbackPath = path.join(
        trashRoot,
        `${manifest.operationId}-${manifest.runtimeKey}-pre-restore-${Date.now()}`,
      );
      let previousMoved = false;
      let applicationSwapped = false;
      try {
        const stagedApplication = resolveSiteDomainRoot(
          stagingRoot,
          manifest.filesRelPath,
        );
        const stagedStat = await fsp.lstat(stagedApplication);
        if (stagedStat.isSymbolicLink() || !stagedStat.isDirectory()) {
          throw new Error('Application snapshot extracted an invalid root');
        }
        realStagedApplication = await fsp.realpath(stagedApplication);
        if (
          realStagedApplication !== stagingRoot &&
          !realStagedApplication.startsWith(`${stagingRoot}${path.sep}`)
        ) {
          throw new Error('Application snapshot escapes restore staging');
        }

        rollbackDumps = await this.captureDatabaseRollbackDumps(
          manifest.databases,
        );
        for (const database of manifest.databases) {
          databaseMutationStarted = true;
          const imported = await this.databases.importDatabase(
            database.name,
            database.type,
            await this.snapshotFile(snapshotPath, database.dumpFile),
          );
          if (!imported.success) {
            throw new Error(
              `Database restore failed for ${database.name}: ${imported.error}`,
            );
          }
        }

        await fsp.mkdir(path.dirname(applicationRoot), {
          recursive: true,
          mode: 0o750,
        });
        if (await this.exists(applicationRoot)) {
          await fsp.mkdir(trashRoot, { recursive: true, mode: 0o700 });
          await fsp.rename(applicationRoot, rollbackPath);
          previousMoved = true;
        }
        await fsp.rename(realStagedApplication, applicationRoot);
        applicationSwapped = true;
        await fsp.rm(stagingRoot, { recursive: true, force: true });
      } catch (error) {
        if (applicationSwapped && (await this.exists(applicationRoot))) {
          const failedRestorePath = `${applicationRoot}.restore-failed-${Date.now()}`;
          await fsp
            .rename(applicationRoot, failedRestorePath)
            .catch(() => undefined);
        }
        if (previousMoved && (await this.exists(rollbackPath))) {
          await fsp.rename(rollbackPath, applicationRoot).catch(() => undefined);
        }
        if (await this.exists(stagingRoot)) {
          await fsp
            .rename(stagingRoot, `${stagingRoot}.failed`)
            .catch(() => undefined);
        }
        const rollbackErrors = databaseMutationStarted
          ? await this.restoreDatabaseRollbackDumps(rollbackDumps)
          : [];
        const suffix = rollbackErrors.length > 0
          ? `; database rollback failed: ${rollbackErrors.join('; ')}`
          : '';
        throw new Error(`${(error as Error).message}${suffix}`);
      } finally {
        await Promise.all(
          rollbackDumps.map((dump) =>
            fsp.unlink(dump.filePath).catch(() => undefined),
          ),
        );
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async trashApplication(params: {
    operationId: string;
    runtimeKey: string;
    rootPath: string;
    filesRelPath: string;
  }): Promise<{ success: boolean; trashPath?: string; error?: string }> {
    try {
      this.validateOperationId(params.operationId);
      const runtimeKey = validateRuntimeKey(params.runtimeKey);
      const root = this.validateSiteRoot(params.rootPath);
      const applicationRoot = resolveSiteDomainRoot(
        root,
        params.filesRelPath,
      );
      if (applicationRoot === root) {
        throw new Error('Application root cannot equal Site root');
      }
      const trashDir = path.join(root, '.meowbox-trash');
      const trashPath = path.join(
        trashDir,
        `${params.operationId}-${runtimeKey}`,
      );
      if (await this.exists(trashPath)) {
        if (!(await this.exists(applicationRoot))) {
          return { success: true, trashPath };
        }
        throw new Error('Application and its trash target both exist');
      }
      if (!(await this.exists(applicationRoot))) {
        return { success: true, trashPath };
      }
      await this.resolveRoots(root, params.filesRelPath);
      await fsp.mkdir(trashDir, { recursive: true, mode: 0o700 });
      await fsp.rename(applicationRoot, trashPath);
      return { success: true, trashPath };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async trashSiteRoot(params: {
    operationId: string;
    rootPath: string;
  }): Promise<{ success: boolean; trashPath?: string; error?: string }> {
    try {
      this.validateOperationId(params.operationId);
      const root = this.validateSiteRoot(params.rootPath);
      const parent = path.dirname(root);
      const trashDir = path.join(parent, '.meowbox-trash');
      const trashPath = path.join(
        trashDir,
        `${path.basename(root)}-${params.operationId}`,
      );
      if (await this.exists(trashPath)) {
        if (!(await this.exists(root))) return { success: true, trashPath };
        throw new Error('Site root and its trash target both exist');
      }
      if (!(await this.exists(root))) return { success: true, trashPath };
      const realRoot = await fsp.realpath(root);
      if (realRoot !== root || !isUnderAllowedSiteRoot(realRoot)) {
        throw new Error('Invalid Site root or symlink escape');
      }
      await fsp.mkdir(trashDir, { recursive: true, mode: 0o700 });
      await fsp.rename(root, trashPath);
      return { success: true, trashPath };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  private async resolveRoots(
    rootPath: string,
    filesRelPath: string,
  ): Promise<{ root: string; applicationRoot: string }> {
    const root = this.validateSiteRoot(rootPath);
    const applicationRoot = resolveSiteDomainRoot(root, filesRelPath);
    if (applicationRoot === root) {
      throw new Error('Application root cannot equal Site root');
    }
    const [realRoot, realApplicationRoot] = await Promise.all([
      fsp.realpath(root),
      fsp.realpath(applicationRoot),
    ]);
    if (
      realRoot !== root ||
      (realApplicationRoot !== realRoot &&
        !realApplicationRoot.startsWith(`${realRoot}${path.sep}`))
    ) {
      throw new Error('Application root escapes Site root through a symlink');
    }
    return { root: realRoot, applicationRoot: realApplicationRoot };
  }

  private async snapshotFile(
    snapshotPath: string,
    filename: string,
  ): Promise<string> {
    const resolved = path.resolve(snapshotPath, filename);
    if (
      path.dirname(resolved) !== snapshotPath ||
      path.basename(resolved) !== filename
    ) {
      throw new Error('Application snapshot file escapes its snapshot');
    }
    const metadata = await fsp.lstat(resolved);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('Application snapshot contains an unsafe file');
    }
    return resolved;
  }

  private async captureDatabaseRollbackDumps(
    databases: SnapshotDatabase[],
  ): Promise<DatabaseRollbackDump[]> {
    const dumps: DatabaseRollbackDump[] = [];
    try {
      for (const database of databases) {
        const exported = await this.databases.exportDatabase(
          database.name,
          database.type,
        );
        if (!exported.success || !exported.filePath) {
          throw new Error(
            `Database rollback snapshot failed for ${database.name}: ${exported.error}`,
          );
        }
        dumps.push({
          name: database.name,
          type: database.type,
          filePath: exported.filePath,
        });
      }
      return dumps;
    } catch (error) {
      await Promise.all(
        dumps.map((dump) => fsp.unlink(dump.filePath).catch(() => undefined)),
      );
      throw error;
    }
  }

  private async restoreDatabaseRollbackDumps(
    dumps: DatabaseRollbackDump[],
  ): Promise<string[]> {
    const failures: string[] = [];
    for (const dump of dumps) {
      const restored = await this.databases.importDatabase(
        dump.name,
        dump.type,
        dump.filePath,
      );
      if (!restored.success) {
        failures.push(`${dump.name}: ${restored.error || 'unknown error'}`);
      }
    }
    return failures;
  }

  private async resolveRootsForRestore(
    rootPath: string,
    filesRelPath: string,
  ): Promise<{ root: string; applicationRoot: string }> {
    const root = this.validateSiteRoot(rootPath);
    const realRoot = await fsp.realpath(root);
    if (realRoot !== root) throw new Error('Site root must not be a symlink');
    const applicationRoot = resolveSiteDomainRoot(realRoot, filesRelPath);
    if (applicationRoot === realRoot) {
      throw new Error('Application root cannot equal Site root');
    }
    return { root: realRoot, applicationRoot };
  }

  private validateSiteRoot(rootPath: string): string {
    const root = path.resolve(rootPath || '');
    if (
      !isUnderAllowedSiteRoot(root) ||
      ALLOWED_SITE_ROOT_PREFIXES.includes(root)
    ) {
      throw new Error('Invalid Site root');
    }
    return root;
  }

  private snapshotPath(operationId: string): string {
    this.validateOperationId(operationId);
    const value = path.resolve(
      BACKUP_LOCAL_PATH,
      'operation-snapshots',
      operationId,
    );
    if (!isUnderBackupStorage(value)) {
      throw new Error('Invalid snapshot path');
    }
    return value;
  }

  private validateOperationId(operationId: string): void {
    if (!OPERATION_ID_RE.test(operationId || '')) {
      throw new Error('Invalid operationId');
    }
  }

  private async exists(value: string): Promise<boolean> {
    try {
      await fsp.lstat(value);
      return true;
    } catch {
      return false;
    }
  }
}
