import * as path from 'node:path';

import {
  requiresLegacyNginxRuntimeAdapter,
  type LegacySystemMigrationArtifact,
} from './system-plan-compat';
import type { MigrationContext, SystemMigration } from './system/_types';

interface DomainRuntimeRow {
  readonly id: string;
  readonly filesRelPath: string;
  readonly preset: string;
  readonly phpVersion: string | null;
  readonly runtimeKey: string;
  readonly isPrimary: boolean;
  readonly appPort: number | null;
  readonly site: { readonly name: string };
}

interface LegacyDomainInput {
  readonly domainId?: unknown;
  readonly [key: string]: unknown;
}

interface LegacySiteInput {
  readonly siteName?: unknown;
  readonly domains?: unknown;
  readonly [key: string]: unknown;
}

interface AgentTemplatesModule {
  renderNginxSite(site: LegacySiteInput): unknown;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Legacy Nginx runtime adapter requires ${field}`);
  }
  return value.trim();
}

function enrichLegacySite(
  input: LegacySiteInput,
  runtimeByDomainId: ReadonlyMap<string, DomainRuntimeRow>,
): LegacySiteInput {
  const siteName = requiredText(input.siteName, 'siteName');
  if (!Array.isArray(input.domains)) {
    throw new Error(`Legacy Nginx runtime adapter requires domains for ${siteName}`);
  }

  const domains = input.domains.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`Legacy Nginx runtime adapter received an invalid domain for ${siteName}`);
    }
    const domain = candidate as LegacyDomainInput;
    const domainId = requiredText(domain.domainId, 'domainId');
    const runtime = runtimeByDomainId.get(domainId);
    if (!runtime) {
      throw new Error(`Legacy Nginx runtime adapter found no SiteDomain runtime for ${domainId}`);
    }
    if (runtime.site.name !== siteName) {
      throw new Error(
        `Legacy Nginx runtime adapter site mismatch for ${domainId}: ` +
        `payload=${siteName}, database=${runtime.site.name}`,
      );
    }

    return {
      ...domain,
      filesRelPath: runtime.filesRelPath,
      preset: runtime.preset,
      phpVersion: runtime.phpVersion,
      runtimeKey: runtime.runtimeKey,
      isPrimary: runtime.isPrimary,
      appPort: runtime.appPort,
      socketPath: undefined,
      socket: undefined,
    };
  });

  return { ...input, domains };
}

/**
 * Historical migrations load the candidate renderer dynamically. Keep that
 * renderer strict and adapt only exact reviewed migration artifacts while
 * they execute in this isolated runner process.
 */
export async function applySystemMigrationWithCompatibility(
  artifact: LegacySystemMigrationArtifact,
  migration: Pick<SystemMigration, 'up'>,
  ctx: MigrationContext,
): Promise<void> {
  if (!requiresLegacyNginxRuntimeAdapter(artifact)) {
    await migration.up(ctx);
    return;
  }

  const runtimeRows = await ctx.prisma.siteDomain.findMany({
    select: {
      id: true,
      filesRelPath: true,
      preset: true,
      phpVersion: true,
      runtimeKey: true,
      isPrimary: true,
      appPort: true,
      site: { select: { name: true } },
    },
  }) as DomainRuntimeRow[];
  const runtimeByDomainId = new Map<string, DomainRuntimeRow>();
  for (const runtime of runtimeRows) {
    if (runtimeByDomainId.has(runtime.id)) {
      throw new Error(`Duplicate SiteDomain runtime metadata for ${runtime.id}`);
    }
    runtimeByDomainId.set(runtime.id, runtime);
  }

  const templatesPath = path.join(
    ctx.config.currentDir,
    'agent',
    'dist',
    'nginx',
    'templates.js',
  );
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const templates = require(templatesPath) as AgentTemplatesModule;
  if (typeof templates.renderNginxSite !== 'function') {
    throw new Error(`Legacy Nginx runtime adapter cannot load renderNginxSite from ${templatesPath}`);
  }

  const originalRender = templates.renderNginxSite;
  const compatibleRender = (site: LegacySiteInput): unknown => (
    originalRender(enrichLegacySite(site, runtimeByDomainId))
  );
  templates.renderNginxSite = compatibleRender;
  ctx.log(`compat: enriched legacy Nginx payload from ${runtimeRows.length} SiteDomain runtime row(s)`);

  try {
    await migration.up(ctx);
  } finally {
    templates.renderNginxSite = originalRender;
  }
}
