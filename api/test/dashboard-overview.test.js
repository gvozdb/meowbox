'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DashboardOverviewService,
  enforceDashboardResponseCap,
} = require('../src/dashboard/dashboard-overview.service');
const { MonitoringService } = require('../src/monitoring/monitoring.service');
const {
  dashboardAdminHealthyFixture,
  dashboardCriticalFixture,
  dashboardLegacyFixture,
  dashboardManagerEmptyFixture,
  dashboardPartialFixture,
} = require('../../shared/src/dashboard-fixtures');

const generatedAt = '2026-08-23T08:00:00.000Z';
const okSource = {
  availability: 'OK',
  observedAt: generatedAt,
  staleAfterSeconds: 60,
  message: null,
};

function dependencies(overrides = {}) {
  const query = {
    loadSites: async () => ({
      section: { ...dashboardAdminHealthyFixture.sites, source: okSource },
      siteProblems: [],
      domainProblems: [],
      healthProblems: [],
    }),
    loadOperations: async () => ({
      active: [], failures: [], activeCandidates: [],
    }),
    loadProtection: async () => ({
      section: { ...dashboardAdminHealthyFixture.protection, source: okSource },
      backupFailures: [],
      overdueBackups: [],
      invalidSchedules: [],
      coverageGapCount: 0,
      repositoryFailure: null,
      sslProblems: [],
    }),
    loadSecurity: async () => ({ ...dashboardAdminHealthyFixture.security, source: okSource }),
    loadActivity: async () => ({ source: okSource, items: [] }),
    loadAdminState: async () => ({ dnsProviders: [], update: null }),
    ...overrides.query,
  };
  const monitoring = {
    getLatestMetrics: () => ({
      cpuPercent: 10,
      memoryPercent: 50,
      memoryUsed: 100,
      memoryTotal: 200,
      diskPercent: 30,
      diskUsed: 30,
      diskTotal: 100,
      networkRx: 1,
      networkTx: 2,
      hostname: 'test-host',
      cpuCores: 4,
      loadAverage: [0.1, 0.2, 0.3],
      disks: [{
        mountPoint: '/',
        totalBytes: 100 * 1024 ** 3,
        usedBytes: 30 * 1024 ** 3,
        availableBytes: 70 * 1024 ** 3,
        usagePercent: 30,
      }],
      uptimeSeconds: 3600,
      collectedAt: new Date().toISOString(),
    }),
    getHistory: async () => [],
    ...overrides.monitoring,
  };
  const diagnostics = {
    getSnapshot: () => ({
      source: okSource,
      agentConnected: true,
      agentDisconnectedAt: null,
      services: [],
      nginx: { source: okSource, valid: true, errorMessage: null, drift: [] },
      dns: {
        source: {
          availability: 'UNSUPPORTED',
          observedAt: null,
          staleAfterSeconds: null,
          message: null,
        },
        items: [],
      },
    }),
    getInstalledVersion: () => 'v1.0.0',
    isPartial: () => false,
    ...overrides.diagnostics,
  };
  return { query, monitoring, diagnostics };
}

test('ADMIN overview returns one bounded v1 snapshot without mutations', async () => {
  const deps = dependencies();
  const service = new DashboardOverviewService(deps.query, deps.monitoring, deps.diagnostics);
  const overview = await service.getOverview('admin-1', 'ADMIN');
  assert.equal(overview.contractVersion, 1);
  assert.equal(overview.role, 'ADMIN');
  assert.equal(overview.security.source.availability, 'OK');
  assert.equal(overview.server.uptimeSeconds, 3600);
  assert.ok(Buffer.byteLength(JSON.stringify(overview)) <= 128 * 1024);
});

test('MANAGER snapshot omits host metrics, security and infrastructure services', async () => {
  const deps = dependencies();
  const service = new DashboardOverviewService(deps.query, deps.monitoring, deps.diagnostics);
  const overview = await service.getOverview('manager-1', 'MANAGER');
  assert.equal(overview.role, 'MANAGER');
  assert.equal(overview.security, null);
  assert.equal(overview.resources.source.availability, 'UNSUPPORTED');
  assert.equal(overview.resources.cpuUsagePercent, null);
  assert.deepEqual(overview.runtime.services, []);
  assert.equal(overview.server.hostname, null);
  assert.equal(overview.server.installedVersion, null);
});

test('incomplete metric source stays unavailable instead of becoming healthy zero data', async () => {
  const deps = dependencies({
    monitoring: {
      getLatestMetrics: () => ({
        cpuPercent: null,
        memoryPercent: null,
        memoryUsed: null,
        memoryTotal: null,
        diskPercent: null,
        diskUsed: null,
        diskTotal: null,
        networkRx: null,
        networkTx: null,
        hostname: null,
        cpuCores: null,
        loadAverage: null,
        disks: [],
        uptimeSeconds: null,
        collectedAt: new Date().toISOString(),
      }),
    },
  });
  const overview = await new DashboardOverviewService(
    deps.query,
    deps.monitoring,
    deps.diagnostics,
  ).getOverview('admin-1', 'ADMIN');
  assert.equal(overview.resources.source.availability, 'UNAVAILABLE');
  assert.equal(overview.resources.cpuUsagePercent, null);
  assert.equal(overview.resources.disks.length, 0);
  assert.equal(overview.overall.state, 'UNKNOWN');
});

test('one failed source returns a valid partial snapshot and UNKNOWN overall state', async () => {
  const deps = dependencies({
    query: { loadSites: async () => { throw new Error('db password=secret'); } },
  });
  const service = new DashboardOverviewService(deps.query, deps.monitoring, deps.diagnostics);
  const overview = await service.getOverview('admin-1', 'ADMIN');
  assert.equal(overview.contractVersion, 1);
  assert.equal(overview.sites.source.availability, 'UNAVAILABLE');
  assert.doesNotMatch(overview.sites.source.message, /secret/);
  assert.equal(overview.overall.state, 'UNKNOWN');
  assert.equal(overview.protection.source.availability, 'OK');
});

test('response cap truncates bounded problem list before exceeding byte budget', () => {
  const overview = structuredClone(dashboardAdminHealthyFixture);
  overview.problems.items = Array.from({ length: 100 }, (_, index) => ({
    id: `SITE_ERROR:SITE:${index}`,
    code: 'SITE_ERROR',
    severity: 'CRITICAL',
    category: 'SITE',
    title: 'X'.repeat(100),
    summary: 'Y'.repeat(240),
    entity: { kind: 'SITE', id: String(index), label: 'Z'.repeat(120) },
    occurredAt: generatedAt,
    observedAt: generatedAt,
    action: { kind: 'NAVIGATE', target: 'SITE', entityId: String(index), label: 'Open' },
  }));
  overview.problems.total = 100;
  overview.problems.critical = 100;
  const capped = enforceDashboardResponseCap(overview, 16 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(capped)) <= 16 * 1024);
  assert.equal(capped.problems.truncated, true);
  assert.ok(capped.problems.items.length < 100);
});

test('response cap also bounds oversized low-priority metric collections', () => {
  const overview = structuredClone(dashboardAdminHealthyFixture);
  overview.problems.items = [];
  overview.resources.disks = Array.from({ length: 200 }, (_, index) => ({
    mountPoint: `/volume/${index}/${'x'.repeat(120)}`,
    totalBytes: 1024,
    usedBytes: 512,
    availableBytes: 512,
    usagePercent: 50,
  }));
  const capped = enforceDashboardResponseCap(overview, 8 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(capped)) <= 8 * 1024);
  assert.ok(capped.resources.disks.length < 200);
});

test('all representative contract fixtures remain below the response budget', () => {
  for (const fixture of [
    dashboardAdminHealthyFixture,
    dashboardCriticalFixture,
    dashboardLegacyFixture,
    dashboardManagerEmptyFixture,
    dashboardPartialFixture,
  ]) {
    assert.ok(Buffer.byteLength(JSON.stringify(fixture)) <= 128 * 1024);
  }
});

test('unsupported roles fail before any source loader executes', async () => {
  let called = false;
  const deps = dependencies({ query: { loadSites: async () => { called = true; } } });
  const service = new DashboardOverviewService(deps.query, deps.monitoring, deps.diagnostics);
  await assert.rejects(() => service.getOverview('viewer-1', 'VIEWER'), /not available/);
  assert.equal(called, false);
});

test('invalid metrics stay unknown and never persist fabricated zero values', async () => {
  let writes = 0;
  const monitoring = new MonitoringService({
    metricsSnapshot: { create: async () => { writes += 1; } },
  });
  monitoring.updateLatest({
    cpuUsagePercent: Number.NaN,
    memoryUsedBytes: -1,
    memoryTotalBytes: 0,
    memoryUsagePercent: 101,
    disks: [{
      mountPoint: '/',
      totalBytes: 0,
      usedBytes: 0,
      availableBytes: 0,
      usagePercent: 0,
    }],
    network: null,
    uptimeSeconds: -1,
    collectedAt: 'invalid',
  });
  const invalid = monitoring.getLatestMetrics();
  assert.equal(invalid.cpuPercent, null);
  assert.equal(invalid.memoryPercent, null);
  assert.equal(invalid.networkRx, null);
  assert.deepEqual(invalid.disks, []);
  await monitoring.saveSnapshot();
  assert.equal(writes, 0);

  monitoring.updateLatest({
    cpuUsagePercent: 0,
    memoryUsedBytes: 512,
    memoryTotalBytes: 1024,
    memoryUsagePercent: 50,
    disks: [{
      mountPoint: '/',
      totalBytes: 1024,
      usedBytes: 256,
      availableBytes: 768,
      usagePercent: 25,
    }],
    network: { rxBytesPerSec: 0, txBytesPerSec: 0 },
    uptimeSeconds: 0,
    collectedAt: new Date().toISOString(),
  });
  await monitoring.saveSnapshot();
  assert.equal(writes, 1);
});
