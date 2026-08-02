import { createHash } from 'node:crypto';
import * as path from 'node:path';

import type { MigrationContext, MigrationPlan } from './system/_types';

type CandidateRequirement = 'agent-nginx-manager' | 'agent-nginx-templates';

interface LegacySystemPlanCompatibility {
  readonly id: string;
  readonly checksum: string;
  readonly summary: string;
  readonly requirements: readonly CandidateRequirement[];
  readonly applyAdapter?: 'legacy-nginx-domain-runtime';
}

export interface LegacySystemMigrationArtifact {
  readonly id: string;
  readonly checksum: string;
}

interface CountRow {
  readonly count: bigint | number;
}

const SHA256 = /^[a-f0-9]{64}$/;

/**
 * These migrations shipped before the zero-write plan contract. Their source
 * files must stay immutable because the runner stores checksums of compiled
 * artifacts. This bridge therefore plans only the exact reviewed artifacts;
 * any source/compiler drift invalidates the compatibility entry.
 */
export const LEGACY_SYSTEM_PLAN_COMPATIBILITY: readonly LegacySystemPlanCompatibility[] = [
  {
    id: '2026-07-04-001-ssl-trusted-certificate-nginx',
    checksum: '55678857e6823848d02db34d65476a77f2074dd4dd9b997cf56580b62aa9d7c6',
    summary: 'Reconcile Nginx trusted-certificate directives and missing certificate chains',
    requirements: ['agent-nginx-templates'],
    applyAdapter: 'legacy-nginx-domain-runtime',
  },
  {
    id: '2026-07-04-002-ssl-stapling-ocsp-guard',
    checksum: '9f4e23f975d0c111b62e17b338015ae7a6b0395e24430e9a9762f78e50086dbd',
    summary: 'Reconcile OCSP stapling guards in managed SSL chunks',
    requirements: ['agent-nginx-templates'],
    applyAdapter: 'legacy-nginx-domain-runtime',
  },
  {
    id: '2026-07-04-003-remove-stale-ssl-chunks',
    checksum: '8fc04ac0c57fd01f9a780b47a7b72277dba4062b123360eeafded1e2862c0e17',
    summary: 'Remove stale managed SSL chunks for domains without usable certificates',
    requirements: [],
  },
  {
    id: '2026-07-04-004-ssl-usable-statuses-nginx',
    checksum: '2a29d8b2d4440c2f2ba71e71ddd67116ac9953e5765688c37393d1517472072e',
    summary: 'Reconcile HTTPS runtime for all usable certificate statuses',
    requirements: ['agent-nginx-templates'],
    applyAdapter: 'legacy-nginx-domain-runtime',
  },
  {
    id: '2026-07-04-005-ssl-trusted-certificate-alias-redirects',
    checksum: '5498630226108d714dc9f5f3160e79e7061689322829fd870c43a20f50a57234',
    summary: 'Reconcile trusted-certificate directives in HTTPS alias redirects',
    requirements: ['agent-nginx-templates'],
    applyAdapter: 'legacy-nginx-domain-runtime',
  },
  {
    id: '2026-07-04-006-ssl-ocsp-system-ca-fallback',
    checksum: '60a6daa2001cfe5cd25e9c3621701be97ab56afbf7c822a1519d7f02ba1d1acb',
    summary: 'Reconcile OCSP trusted-chain fallback in managed Nginx SSL runtime',
    requirements: ['agent-nginx-templates'],
    applyAdapter: 'legacy-nginx-domain-runtime',
  },
  {
    id: '2026-07-26-001-ssl-renewal-reliability',
    checksum: 'bd884499800b0300dfafa6f5ec15129db96417508ee7261cdea7a88da59d8141',
    summary: 'Reconcile certbot renewal hook, timer ownership and managed ACME HTTP runtime',
    requirements: ['agent-nginx-templates'],
    applyAdapter: 'legacy-nginx-domain-runtime',
  },
  {
    id: '2026-07-26-002-certbot-hook-path',
    checksum: '9f0e1905caacbc38973824a7397e5aa2b9de3a7de3b04a36097c15ec485903c4',
    summary: 'Reconcile deterministic system PATH in the certbot deploy hook',
    requirements: [],
  },
  {
    id: '2026-07-26-003-stable-acme-webroot',
    checksum: 'e11dd40832c569d7e8d208adc382eb337d631355f39c609c0bfaa44a20443059',
    summary: 'Reconcile the stable shared ACME webroot in Nginx and certbot renewal state',
    requirements: ['agent-nginx-templates', 'agent-nginx-manager'],
    applyAdapter: 'legacy-nginx-domain-runtime',
  },
];

const compatibilityById = new Map(
  LEGACY_SYSTEM_PLAN_COMPATIBILITY.map((entry) => [entry.id, entry]),
);

if (compatibilityById.size !== LEGACY_SYSTEM_PLAN_COMPATIBILITY.length) {
  throw new Error('Legacy system migration plan compatibility contains duplicate ids');
}
for (const entry of LEGACY_SYSTEM_PLAN_COMPATIBILITY) {
  if (!SHA256.test(entry.checksum)) {
    throw new Error(`Invalid legacy system migration plan checksum for ${entry.id}`);
  }
}

function requirementPath(
  requirement: CandidateRequirement,
  ctx: MigrationContext,
): string {
  switch (requirement) {
    case 'agent-nginx-manager':
      return path.join(
        ctx.config.currentDir,
        'agent',
        'dist',
        'nginx',
        'nginx.manager.js',
      );
    case 'agent-nginx-templates':
      return path.join(
        ctx.config.currentDir,
        'agent',
        'dist',
        'nginx',
        'templates.js',
      );
  }
}

function compatibilityForArtifact(
  artifact: LegacySystemMigrationArtifact,
): LegacySystemPlanCompatibility | null {
  const compatibility = compatibilityById.get(artifact.id);
  if (!compatibility) return null;
  if (artifact.checksum !== compatibility.checksum) {
    throw new Error(
      `Legacy system migration compatibility is stale for ${artifact.id}: ` +
      `expected=${compatibility.checksum.slice(0, 12)}, ` +
      `actual=${artifact.checksum.slice(0, 12)}`,
    );
  }
  return compatibility;
}

export function requiresLegacyNginxRuntimeAdapter(
  artifact: LegacySystemMigrationArtifact,
): boolean {
  return compatibilityForArtifact(artifact)?.applyAdapter === 'legacy-nginx-domain-runtime';
}

async function countRows(
  ctx: MigrationContext,
  table: 'site_domains' | 'sites',
): Promise<number> {
  const rows = await ctx.prisma.$queryRawUnsafe<CountRow[]>(
    `SELECT COUNT(*) AS count FROM "${table}"`,
  );
  const count = rows.length === 1 ? Number(rows[0].count) : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Compatibility plan received an invalid ${table} count`);
  }
  return count;
}

export async function planLegacySystemMigration(
  artifact: LegacySystemMigrationArtifact,
  ctx: MigrationContext,
): Promise<MigrationPlan | null> {
  const compatibility = compatibilityForArtifact(artifact);
  if (!compatibility) return null;

  const requiredArtifacts = [...compatibility.requirements];
  for (const requirement of compatibility.requirements) {
    const candidate = requirementPath(requirement, ctx);
    if (!(await ctx.exists(candidate))) {
      throw new Error(
        `Compatibility plan preflight failed for ${artifact.id}: ` +
        `missing ${requirement} (${candidate})`,
      );
    }
  }

  const [siteCount, domainCount] = await Promise.all([
    countRows(ctx, 'sites'),
    countRows(ctx, 'site_domains'),
  ]);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({
      id: artifact.id,
      checksum: artifact.checksum,
      siteCount,
      domainCount,
      requiredArtifacts,
    }))
    .digest('hex');

  return {
    summary:
      `${compatibility.summary}; sites=${siteCount}; domains=${domainCount}`,
    fingerprint,
    details: {
      compatibility: 'checksum-bound-legacy-plan',
      migrationId: artifact.id,
      siteCount,
      domainCount,
      requiredArtifacts,
    },
  };
}
