'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createDashboardProblem,
  deriveDashboardOverall,
  detectDashboardProblems,
  sanitizeDashboardText,
} = require('../src/dashboard/dashboard-problems');
const { dashboardCronState } = require('../src/dashboard/dashboard-backup-schedule');
const {
  managedDnsExpectedHash,
  managedDnsRecordHash,
  preserveManagedDnsMarker,
  withManagedDnsMarker,
} = require('../src/dns/dns-managed-record');

const generatedAt = '2026-08-23T10:00:00.000Z';
const okSource = {
  availability: 'OK',
  observedAt: generatedAt,
  staleAfterSeconds: 60,
  message: null,
};

function input(overrides = {}) {
  return {
    generatedAt,
    role: 'ADMIN',
    metrics: null,
    resources: {
      source: okSource,
      collectedAt: generatedAt,
      cpuUsagePercent: 5,
      cpuCores: 4,
      memoryUsedBytes: 1,
      memoryTotalBytes: 2,
      memoryUsagePercent: 50,
      loadAverage: [0.1, 0.1, 0.1],
      disks: [],
      network: null,
      history: { cpu: [], memory: [], rootDisk: [] },
    },
    sites: {
      section: {
        source: okSource,
        total: 0,
        running: 0,
        error: 0,
        deploying: 0,
        managedDomains: 0,
        items: [],
      },
      siteProblems: [],
      domainProblems: [],
      healthProblems: [],
    },
    operations: { active: [], failures: [], activeCandidates: [] },
    protection: {
      section: {
        source: okSource,
        backup: {
          eligibleSiteCount: 0,
          protectedSiteCount: 0,
          latestSuccessfulAt: null,
          failedLast24Hours: 0,
          overdueScheduleCount: 0,
          activeCount: 0,
          repositoryCheckState: 'UNCONFIGURED',
          repositoryCheckedAt: null,
        },
        ssl: {
          valid: 0,
          expiring: 0,
          expiredOrError: 0,
          nearestExpiryDomain: null,
          nearestExpiryDays: null,
          exceptions: [],
        },
      },
      backupFailures: [],
      overdueBackups: [],
      invalidSchedules: [],
      coverageGapCount: 0,
      repositoryFailure: null,
      sslProblems: [],
    },
    admin: { dnsProviders: [], update: null },
    diagnostics: {
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
    },
    sourceStates: [okSource],
    unsupportedCapabilityCount: 0,
    ...overrides,
  };
}

test('unknown source is not converted to a healthy or actionable problem', () => {
  const unavailable = { ...okSource, availability: 'UNAVAILABLE' };
  const detected = detectDashboardProblems(input({ sourceStates: [unavailable] }));
  assert.equal(detected.total, 0);
  assert.equal(deriveDashboardOverall(detected, [unavailable]).state, 'UNKNOWN');
});

test('disk thresholds are exact and deterministic', () => {
  const disk = (usagePercent, availableBytes) => ({
    mountPoint: '/',
    totalBytes: 100,
    usedBytes: usagePercent,
    availableBytes,
    usagePercent,
  });
  const below = detectDashboardProblems(input({
    resources: { ...input().resources, disks: [disk(79.9, 6 * 1024 ** 3)] },
  }));
  assert.equal(below.total, 0);

  const warning = detectDashboardProblems(input({
    resources: { ...input().resources, disks: [disk(80, 6 * 1024 ** 3)] },
  }));
  assert.equal(warning.items[0].code, 'DISK_USAGE_WARNING');
  assert.equal(warning.items[0].severity, 'WARNING');

  const critical = detectDashboardProblems(input({
    resources: { ...input().resources, disks: [disk(95, 10 * 1024 ** 3)] },
  }));
  assert.equal(critical.items[0].code, 'DISK_USAGE_CRITICAL');
  assert.equal(critical.items[0].severity, 'CRITICAL');
});

test('agent grace boundaries are enforced', () => {
  const diagnosticsAt = (seconds) => ({
    ...input().diagnostics,
    agentConnected: false,
    agentDisconnectedAt: new Date(Date.parse(generatedAt) - seconds * 1000).toISOString(),
  });
  assert.equal(detectDashboardProblems(input({ diagnostics: diagnosticsAt(29) })).total, 0);
  assert.equal(
    detectDashboardProblems(input({ diagnostics: diagnosticsAt(30) })).items[0].severity,
    'WARNING',
  );
  assert.equal(
    detectDashboardProblems(input({ diagnostics: diagnosticsAt(120) })).items[0].severity,
    'CRITICAL',
  );
});

test('SSL detector handles 3/4/14/15 day boundaries', () => {
  const detected = (daysRemaining) => detectDashboardProblems(input({
    protection: {
      ...input().protection,
      sslProblems: [{
        id: `cert-${daysRemaining}`,
        siteId: 'site-1',
        domain: 'example.test',
        status: 'ACTIVE',
        expiresAt: new Date(Date.parse(generatedAt) + daysRemaining * 86400000).toISOString(),
        daysRemaining,
        updatedAt: generatedAt,
      }],
    },
  }));
  assert.equal(detected(3).items[0].code, 'SSL_EXPIRING_CRITICAL');
  assert.equal(detected(4).items[0].code, 'SSL_EXPIRING_WARNING');
  assert.equal(detected(14).items[0].code, 'SSL_EXPIRING_WARNING');
  assert.equal(detected(15).total, 0);
});

test('optional missing service and intentionally stopped site are neutral', () => {
  const result = detectDashboardProblems(input({
    sites: {
      ...input().sites,
      section: {
        ...input().sites.section,
        total: 1,
        items: [{
          id: 'site-1',
          displayName: 'Stopped',
          primaryDomain: 'stopped.test',
          status: 'STOPPED',
          affectedDomainCount: 0,
          availabilityPercent: null,
          availabilitySampleCount: 0,
          activeOperation: false,
          updatedAt: generatedAt,
        }],
      },
    },
    diagnostics: {
      ...input().diagnostics,
      services: [
        {
          id: 'service:postgresql',
          name: 'PostgreSQL',
          scope: 'CORE',
          siteId: null,
          installed: false,
          expectedState: 'OPTIONAL',
          actualState: 'MISSING',
          checkedAt: generatedAt,
        },
        {
          id: 'pm2:meowbox-api',
          name: 'Meowbox API',
          scope: 'CORE',
          siteId: null,
          installed: null,
          expectedState: 'RUNNING',
          actualState: 'UNKNOWN',
          checkedAt: generatedAt,
        },
      ],
    },
  }));
  assert.equal(result.total, 0);
});

test('DNS drift requires two current successful checks', () => {
  const dns = (confirmedChecks, availability = 'OK') => ({
    ...input().diagnostics,
    dns: {
      source: { ...okSource, availability },
      items: [{
        recordId: 'record-1',
        providerId: 'provider-1',
        label: 'example.test',
        confirmedChecks,
        observedAt: generatedAt,
      }],
    },
  });
  assert.equal(detectDashboardProblems(input({ diagnostics: dns(1) })).total, 0);
  assert.equal(
    detectDashboardProblems(input({ diagnostics: dns(2) })).items[0].code,
    'DNS_RECORD_DRIFT',
  );
  assert.equal(
    detectDashboardProblems(input({ diagnostics: dns(3, 'UNAVAILABLE') })).total,
    0,
  );
});

test('problem text is redacted, bounded and sorted deterministically', () => {
  const text = sanitizeDashboardText(
    'https://user:pass@example.test/?token=secret Bearer abcdef password=hunter2',
    'fallback',
    60,
  );
  assert.ok(text.length <= 60);
  assert.doesNotMatch(text, /pass|secret|abcdef|hunter2/);

  const first = createDashboardProblem({
    code: 'SITE_ERROR',
    severity: 'CRITICAL',
    category: 'SITE',
    title: 'Error',
    summary: 'Error',
    entity: { kind: 'SITE', id: 'site-1', label: 'Site' },
    observedAt: generatedAt,
  });
  const second = createDashboardProblem({
    code: 'SITE_ERROR',
    severity: 'CRITICAL',
    category: 'SITE',
    title: 'Error changed',
    summary: 'Error changed',
    entity: { kind: 'SITE', id: 'site-1', label: 'Site' },
    observedAt: generatedAt,
  });
  assert.equal(first.id, second.id);
});

test('metrics freshness boundaries do not turn instantaneous load into a problem', () => {
  const metricsAt = (seconds) => ({
    cpuPercent: 100,
    memoryPercent: 100,
    memoryUsed: 2,
    memoryTotal: 2,
    diskPercent: null,
    diskUsed: null,
    diskTotal: null,
    networkRx: null,
    networkTx: null,
    hostname: 'test',
    cpuCores: 1,
    loadAverage: [100, 100, 100],
    disks: [],
    uptimeSeconds: 1,
    collectedAt: new Date(Date.parse(generatedAt) - seconds * 1000).toISOString(),
  });
  assert.equal(detectDashboardProblems(input({ metrics: metricsAt(45) })).total, 0);
  assert.equal(detectDashboardProblems(input({ metrics: metricsAt(46) })).items[0].severity, 'WARNING');
  assert.equal(detectDashboardProblems(input({ metrics: metricsAt(121) })).items[0].severity, 'CRITICAL');
});

test('site, domain and real health evidence produce scoped problems without duplicates', () => {
  const baseSites = input().sites;
  const result = detectDashboardProblems(input({
    sites: {
      ...baseSites,
      siteProblems: [
        { id: 'site-1', label: 'Broken', status: 'ERROR', errorMessage: null, updatedAt: generatedAt },
        { id: 'site-1', label: 'Broken', status: 'ERROR', errorMessage: null, updatedAt: generatedAt },
      ],
      domainProblems: [{
        id: 'domain-1', siteId: 'site-1', label: 'broken.test', siteLabel: 'Broken',
        appStatus: 'ERROR', errorMessage: null, updatedAt: generatedAt,
      }],
      healthProblems: [
        { siteId: 'site-1', domainId: 'domain-1', siteLabel: 'Broken', domain: 'broken.test', sampleCount: 1, reachableCount: 0, observedAt: generatedAt },
        { siteId: 'site-2', domainId: 'domain-2', siteLabel: 'Down', domain: 'down.test', sampleCount: 2, reachableCount: 0, observedAt: generatedAt },
        { siteId: 'site-3', domainId: 'domain-3', siteLabel: 'Unknown', domain: 'unknown.test', sampleCount: 0, reachableCount: 0, observedAt: generatedAt },
      ],
    },
  }));
  assert.deepEqual(result.items.map((problem) => problem.code).sort(), [
    'DOMAIN_APPLICATION_ERROR', 'SITE_ERROR', 'SITE_UNAVAILABLE',
  ]);
});

test('backup detectors cover failure, coverage, overdue, invalid cron and repository state', () => {
  const protection = input().protection;
  const result = detectDashboardProblems(input({
    protection: {
      ...protection,
      backupFailures: [{ id: 'backup-1', siteId: 'site-1', siteLabel: 'Site', errorMessage: 'failed', occurredAt: generatedAt }],
      overdueBackups: [
        { id: 'schedule-1', siteId: 'site-1', label: 'Daily', missedExecutions: 1, expectedAt: generatedAt },
        { id: 'schedule-2', siteId: 'site-2', label: 'Hourly', missedExecutions: 2, expectedAt: generatedAt },
      ],
      invalidSchedules: [{ id: 'schedule-3', siteId: 'site-3', label: 'Bad cron' }],
      coverageGapCount: 2,
      repositoryFailure: { id: 'check-1', siteId: null, siteLabel: 'Global', errorMessage: null, observedAt: generatedAt },
    },
  }));
  const codes = new Set(result.items.map((problem) => problem.code));
  for (const code of ['BACKUP_LATEST_FAILED', 'BACKUP_COVERAGE_GAP', 'BACKUP_OVERDUE', 'BACKUP_SCHEDULE_INVALID', 'BACKUP_REPOSITORY_CHECK_FAILED']) {
    assert.ok(codes.has(code), `missing ${code}`);
  }
  assert.equal(result.items.find((problem) => problem.id.includes('schedule-1')).severity, 'WARNING');
  assert.equal(result.items.find((problem) => problem.id.includes('schedule-2')).severity, 'CRITICAL');
});

test('SSL explicit error, expired and unknown states retain distinct semantics', () => {
  const certificate = (id, status, expiresAt, daysRemaining) => ({
    id, siteId: 'site-1', domain: `${id}.test`, status, expiresAt, daysRemaining, updatedAt: generatedAt,
  });
  const result = detectDashboardProblems(input({
    protection: {
      ...input().protection,
      sslProblems: [
        certificate('error', 'ERROR', null, null),
        certificate('expired', 'ACTIVE', new Date(Date.parse(generatedAt) - 1).toISOString(), -1),
        certificate('unknown', 'PENDING', null, null),
      ],
    },
  }));
  assert.deepEqual(new Set(result.items.map((problem) => problem.code)), new Set([
    'SSL_ERROR', 'SSL_EXPIRED', 'SSL_EXPECTED_BUT_UNKNOWN',
  ]));
});

test('operation timeout uses known policies and PM2 grace only for matching operations', () => {
  const operation = (type, startedAt, siteId = 'site-1') => ({
    id: `${type}-${startedAt}`, type, status: 'RUNNING', siteId, entityLabel: 'Site',
    currentStep: null, errorMessage: null, startedAt, completedAt: null, updatedAt: generatedAt,
  });
  const exactly = new Date(Date.parse(generatedAt) - 60 * 60 * 1000).toISOString();
  const overdue = new Date(Date.parse(generatedAt) - 60 * 60 * 1000 - 1).toISOString();
  const pm2 = {
    id: 'pm2:site-1:app', name: 'app', scope: 'SITE', siteId: 'site-1', installed: false,
    expectedState: 'RUNNING', actualState: 'MISSING', checkedAt: generatedAt,
  };
  const noStale = detectDashboardProblems(input({
    operations: { active: [], failures: [], activeCandidates: [operation('DOMAIN_DEPLOY', exactly), operation('UNKNOWN', overdue)] },
  }));
  assert.equal(noStale.items.some((problem) => problem.code === 'OPERATION_STALE'), false);

  const matching = detectDashboardProblems(input({
    operations: { active: [], failures: [], activeCandidates: [operation('DOMAIN_DEPLOY', overdue)] },
    diagnostics: { ...input().diagnostics, services: [pm2] },
  }));
  assert.equal(matching.items.some((problem) => problem.code === 'PM2_PROCESS_MISSING'), false);
  assert.equal(matching.items.some((problem) => problem.code === 'OPERATION_STALE'), true);

  const unrelated = detectDashboardProblems(input({
    operations: { active: [], failures: [], activeCandidates: [operation('BACKUP_RESTORE', generatedAt)] },
    diagnostics: { ...input().diagnostics, services: [pm2] },
  }));
  assert.equal(unrelated.items.some((problem) => problem.code === 'PM2_PROCESS_MISSING'), true);

  const failed = operation('DOMAIN_DEPLOY', generatedAt);
  failed.status = 'FAILED';
  failed.completedAt = generatedAt;
  failed.errorMessage = 'deploy failed';
  const failedResult = detectDashboardProblems(input({
    operations: { active: [], failures: [failed], activeCandidates: [] },
    sites: {
      ...input().sites,
      siteProblems: [{ id: 'site-1', label: 'Site', status: 'ERROR', errorMessage: null, updatedAt: generatedAt }],
    },
  }));
  const failureProblem = failedResult.items.find((problem) => problem.code === 'OPERATION_RECENTLY_FAILED');
  assert.equal(failureProblem.severity, 'CRITICAL');
});

test('cached diagnostic and admin evidence enables all supported problem classes', () => {
  const result = detectDashboardProblems(input({
    diagnostics: {
      ...input().diagnostics,
      nginx: {
        source: okSource,
        valid: false,
        errorMessage: 'invalid',
        drift: [{
          id: 'site-1:main',
          siteId: 'site-1',
          label: 'site.conf',
          missing: false,
          observedAt: generatedAt,
        }],
      },
      services: [
        { id: 'service:nginx', name: 'Nginx', scope: 'CORE', siteId: null, installed: true, expectedState: 'RUNNING', actualState: 'FAILED', checkedAt: generatedAt },
        { id: 'pm2:meowbox-api', name: 'API', scope: 'CORE', siteId: null, installed: true, expectedState: 'RUNNING', actualState: 'FAILED', checkedAt: generatedAt },
      ],
    },
    admin: {
      dnsProviders: [{ id: 'dns-1', label: 'DNS', status: 'ERROR', errorMessage: null, observedAt: generatedAt }],
      update: { status: 'failed', fromVersion: '1', toVersion: '2', errorMessage: null, observedAt: generatedAt },
    },
  }));
  const codes = new Set(result.items.map((problem) => problem.code));
  for (const code of ['NGINX_CONFIG_INVALID', 'NGINX_MANAGED_CONFIG_DRIFT', 'CORE_SERVICE_INACTIVE', 'PM2_PROCESS_UNHEALTHY', 'DNS_PROVIDER_ERROR', 'UPDATE_FAILED']) {
    assert.ok(codes.has(code), `missing ${code}`);
  }
});

test('detector exceptions are isolated and become a safe source problem', () => {
  const failures = [];
  const result = detectDashboardProblems(input({
    resources: { ...input().resources, disks: [null] },
  }), (detector, error) => failures.push({ detector, error }));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].detector, 'metrics');
  assert.equal(result.items.some((problem) => problem.code === 'DATA_SOURCE_UNAVAILABLE'), true);
});

test('cron helper distinguishes grace, missed executions, timezone and invalid input', () => {
  const base = new Date('2026-08-23T00:00:00.000Z');
  assert.equal(dashboardCronState('not cron', base, new Date('2026-08-23T12:00:00.000Z'), 'UTC').state, 'INVALID');
  assert.equal(dashboardCronState('0 * * * *', base, new Date('2026-08-23T01:15:00.000Z'), 'UTC').state, 'NOT_DUE');
  const due = dashboardCronState('0 * * * *', base, new Date('2026-08-23T02:16:00.000Z'), 'UTC');
  assert.equal(due.state, 'DUE');
  assert.equal(due.missedExecutions, 2);
  const amsterdam = dashboardCronState('0 3 * * *', base, new Date('2026-08-24T02:00:00.000Z'), 'Europe/Amsterdam');
  assert.notEqual(amsterdam.state, 'INVALID');
});

test('managed DNS hashes survive provider normalization and preserve the desired marker', () => {
  const desired = withManagedDnsMarker({
    type: 'CNAME', name: 'WWW.', content: 'Target.Example.', priority: null, proxied: undefined, comment: 'operator note',
  });
  const expected = managedDnsExpectedHash(desired.comment);
  assert.equal(expected, managedDnsRecordHash({
    type: 'cname', name: 'www', content: 'target.example', priority: undefined, proxied: false,
  }));
  const refreshed = preserveManagedDnsMarker(desired.comment, 'provider note');
  assert.equal(managedDnsExpectedHash(refreshed), expected);
  assert.match(refreshed, /provider note/);
  assert.doesNotMatch(refreshed, /operator note/);
});
