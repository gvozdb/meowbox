import { createHash } from 'node:crypto';

import type { MigrationContext, MigrationPlan, SystemMigration } from './_types';

const MIGRATION_ID = '2026-09-07-001-release-failed-ssl-issue-locks';
const DOMAIN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

interface RepairCandidate {
  id: string;
}

type RepairTransaction = Pick<
  MigrationContext['prisma'],
  'operation' | 'operationLock'
>;

async function inspect(ctx: MigrationContext): Promise<RepairCandidate[]> {
  const operations = await ctx.prisma.operation.findMany({
    where: {
      type: 'SSL_ISSUE',
      actionId: 'ssl.issue',
      status: 'NEEDS_ATTENTION',
      executionMode: 'QUEUED',
      recoveryPolicy: 'RECONCILE_ONLY',
      retryable: false,
      siteDomainId: { not: null },
      agentJobs: {
        some: {
          actionId: 'agent.ssl.issue',
          step: 'certbot',
          state: 'FAILED',
        },
      },
    },
    select: {
      id: true,
      agentJobs: {
        select: { actionId: true, step: true, state: true },
      },
      siteDomain: {
        select: {
          domain: true,
          sslCertificate: {
            select: { status: true, certPath: true, keyPath: true },
          },
        },
      },
    },
    orderBy: { id: 'asc' },
  });

  const candidates: RepairCandidate[] = [];
  for (const operation of operations) {
    const domain = operation.siteDomain?.domain.trim().toLowerCase();
    const certificate = operation.siteDomain?.sslCertificate;
    const terminalFailure =
      operation.agentJobs.length === 1 &&
      operation.agentJobs[0]?.actionId === 'agent.ssl.issue' &&
      operation.agentJobs[0]?.step === 'certbot' &&
      operation.agentJobs[0]?.state === 'FAILED';
    if (
      !domain ||
      !DOMAIN.test(domain) ||
      domain.includes('..') ||
      !terminalFailure ||
      certificate?.status !== 'NONE' ||
      certificate.certPath !== null ||
      certificate.keyPath !== null
    ) {
      continue;
    }

    const liveDir = `/etc/letsencrypt/live/${domain}`;
    if (
      await ctx.exists(`${liveDir}/fullchain.pem`) ||
      await ctx.exists(`${liveDir}/privkey.pem`)
    ) {
      continue;
    }
    candidates.push({ id: operation.id });
  }
  return candidates;
}

function buildPlan(candidates: RepairCandidate[]): MigrationPlan {
  return {
    summary: candidates.length === 0
      ? 'No confirmed failed SSL issuance locks require repair'
      : `Release ${candidates.length} confirmed failed SSL issuance lock owner(s)`,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(candidates.map(({ id }) => id)))
      .digest('hex'),
    details: { repairCount: candidates.length },
  };
}

const migration: SystemMigration = {
  id: MIGRATION_ID,
  description: 'Release locks retained by confirmed failed SSL issuance jobs',

  async plan(ctx) {
    return buildPlan(await inspect(ctx));
  },

  async up(ctx) {
    const candidates = await inspect(ctx);
    let repaired = 0;
    for (const candidate of candidates) {
      const changed = await ctx.prisma.$transaction(async (tx: RepairTransaction) => {
        const updated = await tx.operation.updateMany({
          where: {
            id: candidate.id,
            type: 'SSL_ISSUE',
            actionId: 'ssl.issue',
            status: 'NEEDS_ATTENTION',
          },
          data: {
            status: 'FAILED',
            cancelOutcome: 'NOT_REQUESTED',
          },
        });
        if (updated.count !== 1) return false;
        await tx.operationLock.deleteMany({
          where: { operationId: candidate.id },
        });
        return true;
      });
      if (changed) repaired++;
    }
    ctx.log(`OK: released ${repaired} confirmed failed SSL issuance lock owner(s)`);
  },
};

export const __failedSslIssueLockRepairTest = { buildPlan };

export default migration;
