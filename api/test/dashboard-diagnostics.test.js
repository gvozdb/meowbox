'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { DashboardDiagnosticsService } = require('../src/dashboard/dashboard-diagnostics.service');
const { DnsService } = require('../src/dns/dns.service');
const { withManagedDnsMarker } = require('../src/dns/dns-managed-record');

function diagnosticsPrisma() {
  return {
    database: { groupBy: async () => [] },
    siteDomain: { groupBy: async () => [], findMany: async () => [] },
    siteService: { findMany: async () => [] },
    site: { findMany: async () => [] },
    dnsProviderAccount: { findMany: async () => [] },
    dnsRecord: { findMany: async () => [] },
  };
}

function successResponse() {
  return {
    success: true,
    data: {
      observedAt: new Date().toISOString(),
      services: [{
        id: 'service:nginx', name: 'Nginx', siteId: null, installed: true,
        expectedState: 'RUNNING', actualState: 'RUNNING', checkedAt: new Date().toISOString(),
      }],
      nginx: { valid: true, error: null, files: [], partial: false },
    },
  };
}

test('core diagnostics is single-flight and preserves successful cache after failure', async () => {
  let emitCount = 0;
  let resolveEmit;
  const agent = {
    connected: true,
    isAgentConnected() { return this.connected; },
    emitToAgent() {
      emitCount += 1;
      return new Promise((resolve) => { resolveEmit = resolve; });
    },
  };
  const service = new DashboardDiagnosticsService(diagnosticsPrisma(), agent);
  const first = service.refreshCore();
  const concurrent = service.refreshCore();
  assert.equal(first, concurrent);
  await new Promise((resolve) => setImmediate(resolve));
  resolveEmit(successResponse());
  await first;
  assert.equal(emitCount, 1);
  assert.equal(service.getSnapshot().services.length, 1);

  agent.emitToAgent = async () => successResponse();
  await service.refreshPm2();
  agent.emitToAgent = async () => { throw new Error('temporary failure'); };
  await service.refreshCore();
  const cached = service.getSnapshot();
  assert.equal(cached.services.length, 1);
  assert.equal(cached.source.availability, 'STALE');
  assert.match(cached.source.message, /temporary failure/);
});

test('agent disconnect during a probe cannot publish a successful diagnostic', async () => {
  const agent = {
    connected: true,
    isAgentConnected() { return this.connected; },
    async emitToAgent() {
      this.connected = false;
      return successResponse();
    },
  };
  const service = new DashboardDiagnosticsService(diagnosticsPrisma(), agent);
  await service.refreshCore();
  const snapshot = service.getSnapshot();
  assert.equal(snapshot.services.length, 0);
  assert.equal(snapshot.source.availability, 'UNAVAILABLE');
});

test('DNS provider sync uses at most three workers and backs off failed providers', async () => {
  const accounts = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  const service = new DnsService({
    dnsProviderAccount: { findMany: async () => accounts },
  });
  let active = 0;
  let maxActive = 0;
  const calls = [];
  service.syncProviderFull = async (id) => {
    calls.push(id);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    if (id === 'b') throw new Error('rate limited');
  };

  const first = await service.syncAllProvidersCron();
  assert.ok(maxActive <= 3);
  assert.equal(first.find((item) => item.accountId === 'b').ok, false);
  const callsAfterFirst = calls.filter((id) => id === 'b').length;
  await service.syncAllProvidersCron();
  assert.equal(calls.filter((id) => id === 'b').length, callsAfterFirst);
});

test('diagnostic calls use separate budgeted Agent probes', async () => {
  const calls = [];
  const agent = {
    isAgentConnected: () => true,
    async emitToAgent(event, params, timeout) {
      calls.push({ event, params, timeout });
      return successResponse();
    },
  };
  const service = new DashboardDiagnosticsService(diagnosticsPrisma(), agent);

  await service.refreshCore();
  await service.refreshNginxValidation();
  await service.refreshPm2();
  await service.refreshNginxDrift();

  assert.deepEqual(calls.map((call) => call.timeout), [5_000, 10_000, 20_000, 30_000]);
  assert.equal(calls[0].params.validateNginx, false);
  assert.equal(calls[1].params.validateNginx, true);
  assert.equal(calls[2].params.includeSiteProcesses, true);
  assert.equal(calls[2].params.compareNginx, false);
  assert.equal(calls[3].params.includeSiteProcesses, false);
  assert.equal(calls[3].params.compareNginx, true);
});

test('large diagnostic inventory stays partial until every bounded batch is covered', async () => {
  const sites = Array.from({ length: 7 }, (_, index) => ({
    id: `site-${String(index).padStart(2, '0')}`,
    name: `site_${index}`,
    status: 'RUNNING',
    rootPath: `/var/www/site_${index}`,
    systemUser: `site_${index}`,
    domains: [],
  }));
  const prisma = diagnosticsPrisma();
  prisma.site.findMany = async ({ where, take }) => {
    const cursor = where?.id?.gt;
    return sites.filter((site) => !cursor || site.id > cursor).slice(0, take);
  };
  const calls = [];
  const service = new DashboardDiagnosticsService(prisma, {
    isAgentConnected: () => true,
    emitToAgent: async (_event, params) => {
      calls.push(params);
      return successResponse();
    },
  });

  await service.refreshNginxDrift();
  assert.equal(calls.at(-1).sites.length, 7);

  for (let batch = 0; batch < 3; batch += 1) {
    await service.refreshPm2();
    assert.equal(calls.at(-1).sites.length, 2);
    assert.equal(service.isPartial(), true);
  }
  await service.refreshPm2();
  assert.equal(calls.at(-1).sites.length, 1);
  assert.equal(service.isPartial(), false);
});

test('DNS mismatch confirmation advances only after a new provider observation', async () => {
  let recordsCachedAt = new Date();
  const desired = withManagedDnsMarker({
    type: 'A',
    name: '@',
    content: '192.0.2.10',
    priority: null,
    proxied: false,
    comment: null,
  });
  const prisma = diagnosticsPrisma();
  prisma.dnsProviderAccount.findMany = async () => [{
    id: 'provider-1',
    status: 'ACTIVE',
    lastSyncAt: recordsCachedAt,
  }];
  prisma.dnsRecord.findMany = async () => [{
    id: 'record-1',
    type: desired.type,
    name: desired.name,
    content: '192.0.2.11',
    priority: desired.priority,
    proxied: desired.proxied,
    comment: desired.comment,
    updatedAt: recordsCachedAt,
    zone: {
      domain: 'example.test',
      accountId: 'provider-1',
      recordsCachedAt,
    },
  }];
  const service = new DashboardDiagnosticsService(prisma, {
    isAgentConnected: () => false,
  });

  await service.refreshDns();
  assert.equal(service.getSnapshot().dns.items[0].confirmedChecks, 1);
  await service.refreshDns();
  assert.equal(service.getSnapshot().dns.items[0].confirmedChecks, 1);
  recordsCachedAt = new Date(recordsCachedAt.getTime() + 10 * 60_000);
  await service.refreshDns();
  assert.equal(service.getSnapshot().dns.items[0].confirmedChecks, 2);
});
