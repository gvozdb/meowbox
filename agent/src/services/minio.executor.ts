import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  MINIO_API_ENDPOINT,
  MINIO_API_HOST,
  MINIO_API_PORT,
  MINIO_CONSOLE_PORT,
  MINIO_CLIENT_BINARY,
  MINIO_CONFIG_DIR,
  MINIO_DATA_DIR,
  MINIO_HOME_DIR,
  MINIO_ROOT_CREDENTIALS_PATH,
  MINIO_RUNTIME_DIR,
  MINIO_SERVER_BINARY,
  MINIO_SERVICE_USER,
  MINIO_SYSTEMD_UNIT,
  MINIO_SYSTEMD_UNIT_PATH,
  MINIO_DEFAULT_REGION,
  minioSystemdUnitContent,
} from '@meowbox/shared';
import { CommandExecutor } from '../command-executor';

const SAFE_SITE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const SITE_ID_RE = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const MINIO_ALIAS = 'meowbox';

export interface MinioServerStatus {
  installed: boolean;
  version: string | null;
}

export interface MinioSiteEnableParams {
  siteId: string;
  siteName: string;
  systemUser: string;
  rootPath: string;
}

export interface MinioSiteContextParams {
  siteId: string;
  siteName: string;
  systemUser?: string;
  rootPath?: string;
}

interface RootCredentials {
  user: string;
  password: string;
}

export interface MinioTenant {
  bucket: string;
  accessKey: string;
  policyName: string;
}

/**
 * MinIO executor.
 *
 * MinIO is one shared, loopback-only daemon. A site activation provisions an
 * isolated bucket plus a dedicated IAM user and policy, then writes only that
 * site's S3 credentials to `${rootPath}/.meowbox/minio/.env` (0600).
 */
export class MinioExecutor {
  constructor(private readonly cmd: CommandExecutor) {}

  async serverStatus(): Promise<MinioServerStatus> {
    const [serverBinary, clientBinary, unit, credentials] = await Promise.all([
      this.isRegularFile(MINIO_SERVER_BINARY),
      this.isRegularFile(MINIO_CLIENT_BINARY),
      this.isRegularFile(MINIO_SYSTEMD_UNIT_PATH),
      this.isRegularFile(MINIO_ROOT_CREDENTIALS_PATH),
    ]);
    const installed = serverBinary && clientBinary && unit && credentials;
    if (!serverBinary) return { installed, version: null };

    const version = await this.readVersion();
    return { installed, version };
  }

  async serverInstall(): Promise<{ version: string }> {
    const alreadyActive = await this.isUnitActive();
    if (!alreadyActive) await this.assertPortAvailable();

    await this.ensureSystemUser();
    await this.ensureRuntimeDirectories();
    await this.downloadManagedBinary('minio', this.serverDownloadUrl(), MINIO_SERVER_BINARY);
    await this.downloadManagedBinary('mc', this.clientDownloadUrl(), MINIO_CLIENT_BINARY);
    await this.ensureRootCredentials();
    await this.writeManagedFile(MINIO_SYSTEMD_UNIT_PATH, minioSystemdUnitContent(), 0o644);

    await this.cmd.execute('systemctl', ['daemon-reload']);
    const start = await this.cmd.execute(
      'systemctl',
      ['enable', '--now', MINIO_SYSTEMD_UNIT],
      { allowFailure: true, timeout: 120_000 },
    );
    if (start.exitCode !== 0) {
      throw new Error(`systemctl enable ${MINIO_SYSTEMD_UNIT} failed: ${this.commandError(start)}`);
    }
    await this.waitForHealth();

    const status = await this.serverStatus();
    if (!status.installed) throw new Error('MinIO installation is incomplete');
    return { version: status.version || 'unknown' };
  }

  async serverUninstall(): Promise<void> {
    const stop = await this.cmd.execute(
      'systemctl',
      ['disable', '--now', MINIO_SYSTEMD_UNIT],
      { allowFailure: true, timeout: 120_000 },
    );
    if (stop.exitCode !== 0 && !this.isMissingResourceError(stop)) {
      throw new Error(`Cannot stop ${MINIO_SYSTEMD_UNIT}: ${this.commandError(stop)}`);
    }

    await this.unlinkIfExists(MINIO_SYSTEMD_UNIT_PATH);
    await fs.rm(MINIO_RUNTIME_DIR, { recursive: true, force: true });
    await fs.rm(MINIO_CONFIG_DIR, { recursive: true, force: true });
    // Данные намеренно остаются: удаление сервиса не должно молча уничтожать S3.
    await this.cmd.execute('systemctl', ['daemon-reload']);
  }

  async siteEnable(params: MinioSiteEnableParams): Promise<void> {
    this.assertSiteParams(params);
    await this.assertServerReady();

    const tenant = minioTenantForSite(params.siteId, params.siteName);
    const secretKey = randomBytes(20).toString('hex');
    const mcEnv = await this.adminEnvironment();

    const createBucket = await this.cmd.execute(
      MINIO_CLIENT_BINARY,
      ['mb', '--ignore-existing', this.remoteBucket(tenant.bucket)],
      { env: mcEnv, allowFailure: true, timeout: 60_000 },
    );
    if (createBucket.exitCode !== 0) {
      throw new Error(`Cannot create MinIO bucket: ${this.commandError(createBucket)}`);
    }

    const policyPath = await this.writeTenantPolicy(tenant);
    const applyPolicy = await this.cmd.execute(
      MINIO_CLIENT_BINARY,
      ['admin', 'policy', 'create', MINIO_ALIAS, tenant.policyName, policyPath],
      { env: mcEnv, allowFailure: true, timeout: 60_000 },
    );
    if (applyPolicy.exitCode !== 0) {
      throw new Error(`Cannot apply MinIO policy: ${this.commandError(applyPolicy)}`);
    }

    // The DB record is created before this handler runs. If the previous
    // activation crashed after creating the IAM user but before persisting the
    // record, replace that deterministic tenant user so retry gets a usable
    // credential pair instead of an opaque "user already exists" failure.
    await this.removeTenantUserIfPresent(tenant, mcEnv);

    const createUser = await this.cmd.execute(
      MINIO_CLIENT_BINARY,
      ['admin', 'user', 'add', MINIO_ALIAS, tenant.accessKey, secretKey],
      { env: mcEnv, allowFailure: true, timeout: 60_000 },
    );
    if (createUser.exitCode !== 0) {
      throw new Error(`Cannot create MinIO site user: ${this.commandError(createUser)}`);
    }

    const attachPolicy = await this.cmd.execute(
      MINIO_CLIENT_BINARY,
      ['admin', 'policy', 'attach', MINIO_ALIAS, tenant.policyName, '--user', tenant.accessKey],
      { env: mcEnv, allowFailure: true, timeout: 60_000 },
    );
    if (attachPolicy.exitCode !== 0) {
      throw new Error(`Cannot attach MinIO policy: ${this.commandError(attachPolicy)}`);
    }

    await this.writeSiteEnv(params, tenant, secretKey);
  }

  async siteDisable(params: MinioSiteContextParams): Promise<void> {
    this.assertSiteIdentity(params);
    if (params.rootPath && !path.isAbsolute(params.rootPath)) {
      throw new Error('MinIO rootPath must be absolute');
    }
    await this.assertServerReady();

    const tenant = minioTenantForSite(params.siteId, params.siteName);
    const mcEnv = await this.adminEnvironment();
    const removeBucket = await this.cmd.execute(
      MINIO_CLIENT_BINARY,
      ['rb', '--force', this.remoteBucket(tenant.bucket)],
      { env: mcEnv, allowFailure: true, timeout: 300_000 },
    );
    if (removeBucket.exitCode !== 0 && !this.isMissingBucketError(removeBucket)) {
      throw new Error(`Cannot remove MinIO bucket: ${this.commandError(removeBucket)}`);
    }

    await this.runMcIgnoringMissing(
      MINIO_CLIENT_BINARY,
      ['admin', 'policy', 'detach', MINIO_ALIAS, tenant.policyName, '--user', tenant.accessKey],
      mcEnv,
      'detach MinIO policy',
    );
    await this.runMcIgnoringMissing(
      MINIO_CLIENT_BINARY,
      ['admin', 'user', 'rm', MINIO_ALIAS, tenant.accessKey],
      mcEnv,
      'remove MinIO site user',
    );
    await this.runMcIgnoringMissing(
      MINIO_CLIENT_BINARY,
      ['admin', 'policy', 'remove', MINIO_ALIAS, tenant.policyName],
      mcEnv,
      'remove MinIO policy',
    );

    await this.unlinkIfExists(this.tenantPolicyPath(tenant));
    if (params.rootPath) {
      await fs.rm(path.join(params.rootPath, '.meowbox', 'minio'), {
        recursive: true,
        force: true,
      });
    }
  }

  async siteStart(_params: MinioSiteContextParams): Promise<void> {
    throw new Error('MinIO is shared by sites and cannot be started from a single site');
  }

  async siteStop(_params: MinioSiteContextParams): Promise<void> {
    throw new Error('MinIO is shared by sites and cannot be stopped from a single site');
  }

  async siteStatus(): Promise<{ status: 'RUNNING' | 'STOPPED' | 'ERROR' }> {
    const result = await this.cmd.execute(
      'systemctl',
      ['is-active', MINIO_SYSTEMD_UNIT],
      { allowFailure: true },
    );
    const output = result.stdout.trim();
    if (output === 'active') return { status: 'RUNNING' };
    if (output === 'failed') return { status: 'ERROR' };
    return { status: 'STOPPED' };
  }

  async siteMetrics(params: MinioSiteContextParams): Promise<{ diskBytes: number; bucket: string }> {
    this.assertSiteIdentity(params);
    const tenant = minioTenantForSite(params.siteId, params.siteName);
    const bucketPath = path.join(MINIO_DATA_DIR, tenant.bucket);
    const result = await this.cmd.execute('du', ['-sb', bucketPath], { allowFailure: true });
    const diskBytes = result.exitCode === 0
      ? Number.parseInt(/^\s*(\d+)/.exec(result.stdout)?.[1] || '0', 10) || 0
      : 0;
    return { diskBytes, bucket: tenant.bucket };
  }

  async siteLogs(lines: number): Promise<{ content: string }> {
    const result = await this.cmd.execute(
      'journalctl',
      [
        '-u',
        MINIO_SYSTEMD_UNIT,
        '-n',
        String(Math.max(1, Math.min(5000, lines))),
        '--no-pager',
      ],
      { allowFailure: true },
    );
    return { content: result.stdout || '(нет логов)' };
  }

  async siteReconfigure(_params: MinioSiteContextParams): Promise<void> {
    throw new Error('MinIO has no per-site runtime configuration');
  }

  private async assertServerReady(): Promise<void> {
    const status = await this.serverStatus();
    if (!status.installed) throw new Error('MinIO is not installed on this server');
    const service = await this.siteStatus();
    if (service.status !== 'RUNNING') {
      throw new Error(`MinIO service is not running (${service.status.toLowerCase()})`);
    }
  }

  private async ensureSystemUser(): Promise<void> {
    const existing = await this.cmd.execute('id', ['-u', MINIO_SERVICE_USER], { allowFailure: true });
    if (existing.exitCode !== 0) {
      const create = await this.cmd.execute(
        'useradd',
        ['--system', '--home-dir', MINIO_HOME_DIR, '--shell', '/usr/sbin/nologin', '--user-group', MINIO_SERVICE_USER],
        { allowFailure: true },
      );
      if (create.exitCode !== 0) {
        throw new Error(`Cannot create ${MINIO_SERVICE_USER}: ${this.commandError(create)}`);
      }
    }
  }

  private async ensureRuntimeDirectories(): Promise<void> {
    await fs.mkdir(MINIO_RUNTIME_DIR, { recursive: true, mode: 0o755 });
    await fs.mkdir(MINIO_HOME_DIR, { recursive: true, mode: 0o750 });
    await fs.mkdir(MINIO_DATA_DIR, { recursive: true, mode: 0o750 });
    await fs.mkdir(MINIO_CONFIG_DIR, { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(MINIO_CONFIG_DIR, 'policies'), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(MINIO_CONFIG_DIR, 'mc'), { recursive: true, mode: 0o700 });
    await this.cmd.execute('chown', ['root:root', MINIO_RUNTIME_DIR, MINIO_CONFIG_DIR]);
    await this.cmd.execute('chown', ['-R', `${MINIO_SERVICE_USER}:${MINIO_SERVICE_USER}`, MINIO_HOME_DIR]);
    await this.cmd.execute('chmod', ['755', MINIO_RUNTIME_DIR]);
    await this.cmd.execute('chmod', ['750', MINIO_HOME_DIR, MINIO_DATA_DIR]);
    await this.cmd.execute('chmod', ['700', MINIO_CONFIG_DIR, path.join(MINIO_CONFIG_DIR, 'policies'), path.join(MINIO_CONFIG_DIR, 'mc')]);
  }

  private async assertPortAvailable(): Promise<void> {
    for (const port of [MINIO_API_PORT, MINIO_CONSOLE_PORT]) {
      const listeners = await this.cmd.execute(
        'ss',
        ['-ltnH', `( sport = :${port} )`],
        { allowFailure: true },
      );
      if (listeners.stdout.trim()) {
        throw new Error(`TCP port ${port} is already in use; MinIO requires it on loopback`);
      }
    }
  }

  private async isUnitActive(): Promise<boolean> {
    const result = await this.cmd.execute(
      'systemctl',
      ['is-active', '--quiet', MINIO_SYSTEMD_UNIT],
      { allowFailure: true },
    );
    return result.exitCode === 0;
  }

  private async ensureRootCredentials(): Promise<RootCredentials> {
    await this.assertNotSymlink(MINIO_ROOT_CREDENTIALS_PATH);
    const existing = await this.readRootCredentials();
    if (existing) return existing;

    const credentials = {
      user: `mb${randomBytes(9).toString('hex')}`,
      password: randomBytes(20).toString('hex'),
    };
    const content = [
      '# Generated by Meowbox. Keep root credentials out of site directories.',
      `MINIO_ROOT_USER=${credentials.user}`,
      `MINIO_ROOT_PASSWORD=${credentials.password}`,
      'MINIO_BROWSER=off',
      '',
    ].join('\n');
    await this.writeManagedFile(MINIO_ROOT_CREDENTIALS_PATH, content, 0o600);
    await this.cmd.execute('chown', ['root:root', MINIO_ROOT_CREDENTIALS_PATH]);
    await this.cmd.execute('chmod', ['600', MINIO_ROOT_CREDENTIALS_PATH]);
    return credentials;
  }

  private async readRootCredentials(): Promise<RootCredentials | null> {
    let content: string;
    try {
      content = await fs.readFile(MINIO_ROOT_CREDENTIALS_PATH, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const values = parseEnv(content);
    const user = values.MINIO_ROOT_USER;
    const password = values.MINIO_ROOT_PASSWORD;
    if (!user || !password || !/^mb[a-f0-9]{18}$/.test(user) || !/^[a-f0-9]{40}$/.test(password)) {
      throw new Error('MinIO root credential file has an invalid format');
    }
    return { user, password };
  }

  private async adminEnvironment(): Promise<Record<string, string>> {
    const credentials = await this.ensureRootCredentials();
    return {
      MC_CONFIG_DIR: path.join(MINIO_CONFIG_DIR, 'mc'),
      [`MC_HOST_${MINIO_ALIAS}`]: `http://${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@${MINIO_API_HOST}:${MINIO_API_PORT}`,
    };
  }

  private async waitForHealth(): Promise<void> {
    let lastError = '';
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const health = await this.cmd.execute(
        'curl',
        ['--fail', '--silent', '--show-error', '--max-time', '5', `${MINIO_API_ENDPOINT}/minio/health/live`],
        { allowFailure: true, timeout: 10_000 },
      );
      if (health.exitCode === 0) return;
      lastError = this.commandError(health);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`MinIO health check failed: ${lastError || 'timeout'}`);
  }

  private async downloadManagedBinary(name: string, url: string, target: string): Promise<void> {
    const existing = await this.isRegularFile(target);
    if (existing) return;

    await this.assertNotSymlink(target);
    const suffix = `${process.pid}-${randomBytes(6).toString('hex')}`;
    const downloadPath = `${target}.download-${suffix}`;
    const checksumPath = `${target}.sha256-${suffix}`;
    try {
      const download = await this.cmd.execute(
        'curl',
        ['--fail', '--silent', '--show-error', '--location', '--retry', '3', '--output', downloadPath, url],
        { allowFailure: true, timeout: 600_000 },
      );
      if (download.exitCode !== 0) {
        throw new Error(`Cannot download ${name}: ${this.commandError(download)}`);
      }
      const checksum = await this.cmd.execute(
        'curl',
        ['--fail', '--silent', '--show-error', '--location', '--retry', '3', '--output', checksumPath, `${url}.sha256sum`],
        { allowFailure: true, timeout: 60_000 },
      );
      if (checksum.exitCode !== 0) {
        throw new Error(`Cannot download ${name} checksum: ${this.commandError(checksum)}`);
      }

      const [binary, checksumText] = await Promise.all([
        fs.readFile(downloadPath),
        fs.readFile(checksumPath, 'utf8'),
      ]);
      const expected = /^([a-f0-9]{64})\s+/im.exec(checksumText)?.[1]?.toLowerCase();
      const actual = createHash('sha256').update(binary).digest('hex');
      if (!expected || expected !== actual) {
        throw new Error(`Downloaded ${name} checksum mismatch`);
      }

      await fs.chmod(downloadPath, 0o755);
      await fs.rename(downloadPath, target);
      await this.cmd.execute('chown', ['root:root', target]);
      await this.cmd.execute('chmod', ['755', target]);
    } finally {
      await fs.unlink(downloadPath).catch(() => {});
      await fs.unlink(checksumPath).catch(() => {});
    }
  }

  private async readVersion(): Promise<string | null> {
    const result = await this.cmd.execute(MINIO_SERVER_BINARY, ['--version'], { allowFailure: true });
    if (result.exitCode !== 0) return null;
    return /RELEASE\.[^\s]+/.exec(result.stdout)?.[0] || result.stdout.trim() || null;
  }

  private serverDownloadUrl(): string {
    return `https://dl.min.io/community/server/minio/release/linux-${this.architecture()}/minio`;
  }

  private clientDownloadUrl(): string {
    return `https://dl.min.io/client/mc/release/linux-${this.architecture()}/mc`;
  }

  private architecture(): 'amd64' | 'arm64' {
    if (process.arch === 'x64') return 'amd64';
    if (process.arch === 'arm64') return 'arm64';
    throw new Error(`Unsupported MinIO architecture: ${process.arch}`);
  }

  private async writeTenantPolicy(tenant: MinioTenant): Promise<string> {
    const policyPath = this.tenantPolicyPath(tenant);
    await this.writeManagedFile(policyPath, renderTenantPolicy(tenant.bucket), 0o600);
    await this.cmd.execute('chown', ['root:root', policyPath]);
    await this.cmd.execute('chmod', ['600', policyPath]);
    return policyPath;
  }

  private async removeTenantUserIfPresent(
    tenant: MinioTenant,
    mcEnv: Record<string, string>,
  ): Promise<void> {
    await this.runMcIgnoringMissing(
      MINIO_CLIENT_BINARY,
      ['admin', 'user', 'rm', MINIO_ALIAS, tenant.accessKey],
      mcEnv,
      'replace incomplete MinIO site user',
    );
  }

  private async runMcIgnoringMissing(
    command: string,
    args: string[],
    env: Record<string, string>,
    action: string,
  ): Promise<void> {
    const result = await this.cmd.execute(command, args, {
      env,
      allowFailure: true,
      timeout: 60_000,
    });
    if (result.exitCode !== 0 && !this.isMissingResourceError(result)) {
      throw new Error(`Cannot ${action}: ${this.commandError(result)}`);
    }
  }

  private async writeSiteEnv(params: MinioSiteEnableParams, tenant: MinioTenant, secretKey: string): Promise<void> {
    const meowboxDir = path.join(params.rootPath, '.meowbox');
    const serviceDir = path.join(meowboxDir, 'minio');
    const envPath = path.join(serviceDir, '.env');
    await this.cmd.execute('mkdir', ['-p', serviceDir]);
    await this.cmd.execute('chown', ['-R', `${params.systemUser}:${params.systemUser}`, meowboxDir]);
    await this.cmd.execute('chmod', ['700', meowboxDir, serviceDir]);
    await this.writeManagedFile(envPath, renderSiteEnv(tenant, secretKey), 0o600);
    await this.cmd.execute('chown', [`${params.systemUser}:${params.systemUser}`, envPath]);
    await this.cmd.execute('chmod', ['600', envPath]);
  }

  private async writeManagedFile(target: string, content: string, mode: number): Promise<void> {
    await this.assertNotSymlink(target);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    try {
      await fs.writeFile(temp, content, { mode });
      await fs.chmod(temp, mode);
      await fs.rename(temp, target);
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }

  private tenantPolicyPath(tenant: MinioTenant): string {
    return path.join(MINIO_CONFIG_DIR, 'policies', `${tenant.policyName}.json`);
  }

  private remoteBucket(bucket: string): string {
    return `${MINIO_ALIAS}/${bucket}`;
  }

  private assertSiteParams(params: MinioSiteEnableParams): void {
    this.assertSiteIdentity(params);
    if (!params.systemUser || !SAFE_SITE_NAME.test(params.systemUser)) {
      throw new Error(`Unsafe MinIO system user: ${params.systemUser}`);
    }
    if (!path.isAbsolute(params.rootPath)) {
      throw new Error('MinIO rootPath must be absolute');
    }
  }

  private assertSiteIdentity(params: Pick<MinioSiteContextParams, 'siteId' | 'siteName'>): void {
    if (!SITE_ID_RE.test(params.siteId)) throw new Error(`Unsafe MinIO site id: ${params.siteId}`);
    if (!SAFE_SITE_NAME.test(params.siteName)) throw new Error(`Unsafe MinIO site name: ${params.siteName}`);
  }

  private async isRegularFile(target: string): Promise<boolean> {
    try {
      const stat = await fs.lstat(target);
      return stat.isFile() && !stat.isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async assertNotSymlink(target: string): Promise<void> {
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) throw new Error(`Refusing symlink target: ${target}`);
      if (stat.isDirectory()) throw new Error(`Refusing directory target: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  private async unlinkIfExists(target: string): Promise<void> {
    try {
      await fs.unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  private isMissingBucketError(result: { stdout: string; stderr: string }): boolean {
    return this.isMissingResourceError(result);
  }

  private isMissingResourceError(result: { stdout: string; stderr: string }): boolean {
    return /not found|not loaded|does not exist|doesn't exist/i.test(`${result.stdout}\n${result.stderr}`);
  }

  private commandError(result: { stdout: string; stderr: string }): string {
    return (result.stderr || result.stdout || 'unknown command failure').trim().slice(0, 500);
  }
}

export function minioTenantForSite(siteId: string, siteName: string): MinioTenant {
  if (!SITE_ID_RE.test(siteId)) throw new Error(`Unsafe MinIO site id: ${siteId}`);
  if (!SAFE_SITE_NAME.test(siteName)) throw new Error(`Unsafe MinIO site name: ${siteName}`);
  const hash = createHash('sha256').update(siteId).digest('hex');
  const normalizedName = siteName.replace(/_/g, '-').replace(/-+/g, '-').slice(0, 42).replace(/-+$/, '');
  return {
    bucket: `mb-${normalizedName}-${hash.slice(0, 10)}`,
    accessKey: `mb${hash.slice(0, 18)}`,
    policyName: `meowbox-site-${hash.slice(0, 12)}`,
  };
}

export function renderTenantPolicy(bucket: string): string {
  if (!/^mb-[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error(`Unsafe MinIO bucket name: ${bucket}`);
  }
  const bucketArn = `arn:aws:s3:::${bucket}`;
  return `${JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['s3:GetBucketLocation', 's3:ListBucket', 's3:ListBucketMultipartUploads'],
        Resource: [bucketArn],
      },
      {
        Effect: 'Allow',
        Action: [
          's3:GetObject',
          's3:PutObject',
          's3:DeleteObject',
          's3:AbortMultipartUpload',
          's3:ListMultipartUploadParts',
        ],
        Resource: [`${bucketArn}/*`],
      },
    ],
  }, null, 2)}\n`;
}

export function renderSiteEnv(tenant: MinioTenant, secretKey: string): string {
  if (!/^mb[a-f0-9]{18}$/.test(tenant.accessKey) || !/^[a-f0-9]{40}$/.test(secretKey)) {
    throw new Error('Unsafe MinIO tenant credentials');
  }
  return [
    '# S3-compatible MinIO credentials for this site.',
    '# Generated by Meowbox. Do not commit this file.',
    `MEOWBOX_MINIO_ENDPOINT=${MINIO_API_ENDPOINT}`,
    `MEOWBOX_MINIO_REGION=${MINIO_DEFAULT_REGION}`,
    `MEOWBOX_MINIO_BUCKET=${tenant.bucket}`,
    `MEOWBOX_MINIO_ACCESS_KEY=${tenant.accessKey}`,
    `MEOWBOX_MINIO_SECRET_KEY=${secretKey}`,
    'MEOWBOX_MINIO_FORCE_PATH_STYLE=true',
    '',
  ].join('\n');
}

function parseEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z0-9_]+)=([^\r\n]*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}
