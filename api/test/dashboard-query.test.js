'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { DashboardQueryService } = require('../src/dashboard/dashboard-query.service');

function scopedPrisma(siteCount, domainCount) {
  const calls = [];
  const capture = (model, method, args, value) => {
    calls.push({ model, method, args });
    return value;
  };
  return {
    calls,
    site: {
      groupBy: (args) => capture('site', 'groupBy', args, [{ status: 'RUNNING', _count: { _all: siteCount } }]),
      findMany: (args) => capture('site', 'findMany', args, []),
    },
    siteDomain: {
      count: (args) => capture('siteDomain', 'count', args, domainCount),
      findMany: (args) => capture('siteDomain', 'findMany', args, []),
      groupBy: (args) => capture('siteDomain', 'groupBy', args, []),
    },
    operation: {
      findMany: (args) => capture('operation', 'findMany', args, []),
    },
    healthCheckPing: {
      groupBy: (args) => capture('healthCheckPing', 'groupBy', args, []),
    },
  };
}

test('site snapshot query count stays constant from 10 to 10000 sites', async () => {
  const run = async (siteCount, domainCount) => {
    const prisma = scopedPrisma(siteCount, domainCount);
    const service = new DashboardQueryService(prisma);
    const result = await service.loadSites(
      { userId: 'admin-1', role: 'ADMIN' },
      '2026-08-23T10:00:00.000Z',
    );
    return { prisma, result };
  };
  const small = await run(10, 50);
  const large = await run(10_000, 50_000);
  assert.equal(small.prisma.calls.length, large.prisma.calls.length);
  assert.equal(large.result.section.total, 10_000);
  assert.equal(large.result.section.managedDomains, 50_000);
  assert.ok(large.result.section.items.length <= 8);
  assert.ok(Buffer.byteLength(JSON.stringify(large.result.section)) < 128 * 1024);
});

test('MANAGER site loader applies ownership in every entity query', async () => {
  const prisma = scopedPrisma(1, 1);
  const service = new DashboardQueryService(prisma);
  await service.loadSites(
    { userId: 'manager-1', role: 'MANAGER' },
    '2026-08-23T10:00:00.000Z',
  );

  const source = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '../src/dashboard/dashboard-query.service.ts'),
    'utf8',
  );
  assert.match(source, /siteWhere:[\s\S]*?\{ userId: context\.userId \}/);
  assert.match(source, /domainWhere:[\s\S]*?\{ site: \{ userId: context\.userId \} \}/);
  assert.match(source, /context\.role === 'ADMIN'\s*\? this\.prisma\.resticCheck\.findFirst/);
  assert.match(source, /if \(context\.role === 'MANAGER'\) \{[\s\S]*?Журнал не содержит надёжной связи/);
});

test('outage aggregation stays on scoped domain IDs and existing composite index', async () => {
  const pingCalls = [];
  const domain = {
    id: 'domain-1',
    siteId: 'site-1',
    domain: 'example.test',
    appStatus: 'ERROR',
    appErrorMessage: 'health check failed',
    updatedAt: new Date('2026-08-23T09:59:00.000Z'),
    site: { name: 'example', displayName: 'Example' },
  };
  const prisma = {
    site: {
      groupBy: async () => [],
      findMany: async () => [],
    },
    siteDomain: {
      count: async () => 1,
      findMany: async (args) => args.where?.appStatus === 'ERROR' ? [domain] : [],
      groupBy: async () => [],
    },
    operation: { findMany: async () => [] },
    healthCheckPing: {
      groupBy: async (args) => {
        pingCalls.push(args);
        return args.where.reachable === true
          ? []
          : [{
              siteDomainId: 'domain-1',
              _count: { _all: 2 },
              _max: { createdAt: new Date('2026-08-23T09:58:00.000Z') },
            }];
      },
    },
  };

  const result = await new DashboardQueryService(prisma).loadSites(
    { userId: 'manager-1', role: 'MANAGER' },
    '2026-08-23T10:00:00.000Z',
  );

  assert.equal(pingCalls.length, 2);
  assert.deepEqual(
    pingCalls.map((call) => call.where.siteDomainId.in),
    [['domain-1'], ['domain-1']],
  );
  assert.equal(result.healthProblems.length, 1);
  assert.equal(result.healthProblems[0].sampleCount, 2);
});
