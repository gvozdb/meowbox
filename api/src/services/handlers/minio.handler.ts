import { AgentRelayService } from '../../gateway/agent-relay.service';
import { MINIO_API_ENDPOINT, MINIO_DEFAULT_REGION } from '@meowbox/shared';
import { ServiceHandler } from '../service.handler';
import {
  ConnectionInfo,
  ServiceMetrics,
  SiteContext,
  SiteServiceStatus,
} from '../service.types';

/**
 * MinIO uses one private server daemon and per-site IAM tenants. Unlike Redis
 * and Manticore, stop/start is intentionally unavailable at site scope: one
 * site's action must never interrupt object storage for another site.
 */
export class MinioServiceHandler implements ServiceHandler {
  readonly key = 'minio';
  readonly preserveRecordOnDisableFailure = true;

  constructor(private readonly agent: AgentRelayService) {}

  async isInstalledOnServer(): Promise<{ installed: boolean; version: string | null }> {
    const r = await this.agent.emitToAgent<{ installed: boolean; version: string | null }>(
      'minio:server-status',
      {},
      30_000,
    );
    if (!r.success) throw new Error(r.error || 'minio:server-status failed');
    return r.data!;
  }

  async installOnServer(): Promise<{ version: string }> {
    const r = await this.agent.emitToAgent<{ version: string }>(
      'minio:server-install',
      {},
      600_000,
    );
    if (!r.success) throw new Error(r.error || 'minio:server-install failed');
    return r.data!;
  }

  async uninstallFromServer(): Promise<void> {
    const r = await this.agent.emitToAgent<unknown>('minio:server-uninstall', {}, 300_000);
    if (!r.success) throw new Error(r.error || 'minio:server-uninstall failed');
  }

  async enableForSite(site: SiteContext, _config: Record<string, unknown>): Promise<void> {
    const r = await this.agent.emitToAgent<unknown>(
      'minio:site-enable',
      {
        siteId: site.id,
        siteName: site.name,
        systemUser: site.systemUser,
        rootPath: site.rootPath,
      },
      180_000,
    );
    if (!r.success) throw new Error(r.error || 'minio:site-enable failed');
  }

  async disableForSite(site: SiteContext): Promise<void> {
    const r = await this.agent.emitToAgent<unknown>(
      'minio:site-disable',
      { siteId: site.id, siteName: site.name, rootPath: site.rootPath },
      300_000,
    );
    if (!r.success) throw new Error(r.error || 'minio:site-disable failed');
  }

  async startForSite(): Promise<void> {
    throw new Error('MinIO is a shared daemon and cannot be started from a site');
  }

  async stopForSite(): Promise<void> {
    throw new Error('MinIO is a shared daemon and cannot be stopped from a site');
  }

  async statusForSite(_site: SiteContext): Promise<SiteServiceStatus> {
    try {
      const r = await this.agent.emitToAgent<{ status: SiteServiceStatus }>(
        'minio:site-status',
        {},
        15_000,
      );
      return r.success && r.data ? r.data.status : 'ERROR';
    } catch {
      return 'ERROR';
    }
  }

  async metricsForSite(site: SiteContext): Promise<ServiceMetrics> {
    try {
      const r = await this.agent.emitToAgent<{ diskBytes: number; bucket: string }>(
        'minio:site-metrics',
        { siteId: site.id, siteName: site.name },
        30_000,
      );
      if (!r.success || !r.data) return { items: [] };
      return {
        items: [
          { label: 'Bucket', value: r.data.bucket },
          { label: 'Размер', value: humanBytes(r.data.diskBytes) },
        ],
        diskBytes: r.data.diskBytes,
      };
    } catch {
      return { items: [] };
    }
  }

  connectionInfoForSite(site: SiteContext): ConnectionInfo {
    return {
      items: [
        { label: 'S3 endpoint', value: MINIO_API_ENDPOINT, copyable: true },
        { label: 'Region', value: MINIO_DEFAULT_REGION, copyable: true },
        { label: 'Credentials', value: `${site.rootPath}/.meowbox/minio/.env`, copyable: true },
        { label: 'Секреты', value: 'хранятся только в .env файле сайта (0600)', copyable: false },
      ],
      hint:
        'Используй S3 SDK с path-style URL. Access key, secret key и имя bucket лежат в .meowbox/minio/.env; API MinIO не открыт в интернет.',
    };
  }

  async logsForSite(_site: SiteContext, lines: number = 200): Promise<string> {
    try {
      const r = await this.agent.emitToAgent<{ content: string }>(
        'minio:site-logs',
        { lines },
        30_000,
      );
      return r.success && r.data ? r.data.content : r.error || '(no logs)';
    } catch (err) {
      return `Ошибка чтения логов: ${(err as Error).message}`;
    }
  }

  async reconfigureForSite(): Promise<void> {
    throw new Error('MinIO has no per-site runtime configuration');
  }
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
