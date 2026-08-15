import type { SiteNginxOverrides } from '@meowbox/shared';

import type { SiteDomainRuntimePayload } from '../runtime/site-domain-runtime';

export interface AgentNginxDomainPayload extends SiteDomainRuntimePayload {
  readonly aliases: Array<{ domain: string; redirect: boolean }>;
  readonly sslEnabled: boolean;
  readonly certPath?: string | null;
  readonly keyPath?: string | null;
  readonly trustedCertPath?: string | null;
  readonly ocspStapling?: boolean | null;
  readonly httpsRedirect: boolean;
  readonly zoneName: string;
  readonly settings: SiteNginxOverrides;
  readonly customConfig?: string | null;
  readonly forceWriteCustom?: boolean;
}

export interface AgentNginxConfigPayload {
  readonly siteName: string;
  readonly rootPath: string;
  readonly systemUser?: string;
  readonly operationId?: string;
  readonly domains: AgentNginxDomainPayload[];
}

export interface AgentPhpPoolPayload {
  readonly siteName: string;
  readonly siteDomainId: string;
  readonly domain: string;
  readonly phpVersion: string;
  readonly runtimeKey: string;
  readonly socketPath?: string | null;
  readonly socket?: string | null;
  readonly user?: string;
  readonly systemUser?: string;
  readonly rootPath: string;
  readonly filesRelPath: string;
  readonly sslEnabled?: boolean;
  readonly tempPath?: string;
  readonly sessionPath?: string;
  readonly pmMaxChildren?: number;
  readonly customConfig?: string | null;
  readonly operationId?: string;
}

export interface AgentPhpPoolReference {
  readonly siteDomainId: string;
  readonly runtimeKey: string;
  readonly phpVersion: string;
  readonly operationId?: string;
}

export interface AgentPhpPoolPreflightPayload {
  readonly pools: AgentPhpPoolPayload[];
}

export interface AgentComposerRegeneratePayload {
  readonly siteId: string;
  readonly siteDomainId: string;
  readonly runtimeKey: string;
  readonly domain: string;
  readonly rootPath: string;
  readonly filesRelPath: string;
  readonly phpVersion: string;
  readonly operationId?: string;
}

export interface AgentModxAdminPasswordPayload {
  readonly siteDomainId: string;
  readonly runtimeKey: string;
  readonly rootPath: string;
  readonly filesRelPath: string;
  readonly phpVersion: string;
  readonly systemUser?: string;
  readonly username: string;
  readonly password: string;
  readonly createIfMissing?: boolean;
  readonly operationId?: string;
}

export interface AgentInstallPayload {
  readonly siteId: string;
  readonly siteDomainId: string;
  readonly preset: string;
  readonly rootPath: string;
  readonly filesRelPath: string;
  /**
   * API only sets this after proving another application of the same Site
   * already owns the same normalized files path. The agent still validates the
   * root and skips installation only when it is non-empty.
   */
  readonly reuseExistingRoot?: boolean;
  readonly domain: string;
  readonly phpVersion?: string | null;
  readonly runtimeKey: string;
  readonly socketPath?: string | null;
  readonly modxVersion?: string;
  readonly appPort?: number | null;
  readonly dbName?: string;
  readonly dbUser?: string;
  readonly dbPassword?: string;
  readonly dbType?: 'MARIADB' | 'MYSQL' | 'POSTGRESQL';
  readonly adminUser?: string;
  readonly adminPassword?: string;
  readonly adminEmail?: string;
  readonly systemUser?: string;
  readonly managerPath?: string;
  readonly connectorsPath?: string;
  readonly tablePrefix?: string;
  readonly operationId?: string;
}

export interface AgentModxUpdatePayload {
  readonly siteId: string;
  readonly siteDomainId: string;
  readonly preset: 'MODX_REVO' | 'MODX_3';
  readonly rootPath: string;
  readonly filesRelPath: string;
  readonly phpVersion: string;
  readonly runtimeKey: string;
  readonly socketPath?: string | null;
  readonly targetVersion: string;
  readonly domain: string;
  readonly systemUser?: string;
  readonly managerPath?: string;
  readonly connectorsPath?: string;
  readonly operationId?: string;
}

export interface AgentDeployPayload {
  readonly deployId: string;
  readonly siteDomainId: string;
  readonly preset: string;
  readonly rootPath: string;
  readonly filesRelPath: string;
  readonly gitRepository: string;
  readonly branch: string;
  readonly phpVersion?: string | null;
  readonly runtimeKey: string;
  readonly appPort?: number | null;
  readonly domain: string;
  readonly envVars?: Record<string, string>;
  readonly operationId?: string;
}

export interface AgentDeployRollbackPayload {
  readonly deployId: string;
  readonly siteDomainId: string;
  readonly rootPath: string;
  readonly filesRelPath: string;
  readonly commitSha: string;
  readonly preset: string;
  readonly domain: string;
  readonly phpVersion?: string | null;
  readonly runtimeKey: string;
  readonly appPort?: number | null;
  readonly envVars?: Record<string, string>;
  readonly operationId?: string;
}

export interface AgentMetricsPayload {
  readonly siteDomainId: string;
  readonly runtimeKey: string;
  readonly systemUser: string;
  readonly siteName: string;
  readonly rootPath: string;
  readonly filesRelPath: string;
  readonly preset: string;
  readonly phpVersion?: string | null;
  readonly appPort?: number | null;
  readonly domain: string;
  readonly operationId?: string;
}

export interface AgentSiteLogPayload {
  readonly siteDomainId: string;
  readonly runtimeKey: string;
  readonly systemUser: string;
  readonly domain: string;
  readonly type: 'access' | 'error' | 'php' | 'app';
  readonly siteName: string;
  readonly lines?: number;
  readonly operationId?: string;
}

export interface AgentOperationLogMeta {
  readonly siteId?: string;
  readonly siteDomainId?: string;
  readonly domainId?: string;
  readonly operationId?: string;
  readonly domain?: string;
}
