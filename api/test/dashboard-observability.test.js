'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  dashboardDiagnosticFailureReason,
  dashboardDiagnosticMetricSamples,
  dashboardOverviewMetricSamples,
} = require('../src/common/dashboard-observability');

test('overview metrics use bounded labels and aggregate problems without entity data', () => {
  const problem = (id) => ({
    id,
    code: 'SITE_ERROR',
    severity: 'CRITICAL',
    category: 'SITE',
    title: 'Private site title',
    summary: 'Private summary',
    entity: { kind: 'SITE', id, label: 'Private entity label' },
    occurredAt: null,
    observedAt: '2026-08-23T08:00:00.000Z',
    action: null,
  });
  const samples = dashboardOverviewMetricSamples({
    durationMs: 12.6,
    role: 'ADMIN',
    localOrProxy: 'local',
    partialSources: ['sites', 'sites', 'runtime'],
    problems: [problem('site-secret-1'), problem('site-secret-2')],
  });

  assert.deepEqual(samples[0], {
    name: 'dashboard_overview_duration_ms',
    value: 13,
    labels: { role: 'ADMIN', local_or_proxy: 'local' },
  });
  assert.equal(
    samples.filter((sample) => sample.name === 'dashboard_overview_partial_failure_total').length,
    2,
  );
  assert.deepEqual(samples.at(-1), {
    name: 'dashboard_problem_count',
    value: 2,
    labels: { code: 'SITE_ERROR', severity: 'CRITICAL' },
  });
  const serialized = JSON.stringify(samples);
  assert.doesNotMatch(serialized, /site-secret|Private/);
});

test('diagnostic metrics emit safe reason codes without raw errors', () => {
  const reason = dashboardDiagnosticFailureReason(
    new Error('connect ECONNREFUSED with private details'),
  );
  const samples = dashboardDiagnosticMetricSamples({
    diagnostic: 'nginx_drift',
    durationMs: Number.NaN,
    failureReason: reason,
  });

  assert.equal(reason, 'unexpected');
  assert.deepEqual(samples, [
    {
      name: 'dashboard_diagnostic_duration_ms',
      value: 0,
      labels: { diagnostic: 'nginx_drift' },
    },
    {
      name: 'dashboard_diagnostic_failure_total',
      value: 1,
      labels: { diagnostic: 'nginx_drift', reason: 'unexpected' },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(samples), /ECONNREFUSED|private/);
});

test('diagnostic failure classifier keeps label cardinality finite', () => {
  assert.equal(dashboardDiagnosticFailureReason(new Error('Agent disconnected')), 'agent_disconnected');
  assert.equal(dashboardDiagnosticFailureReason(new Error('request timed out')), 'timeout');
  assert.equal(dashboardDiagnosticFailureReason(new Error('Agent rejected request')), 'agent_rejected');
  assert.equal(dashboardDiagnosticFailureReason(new Error('Prisma query failed')), 'database');
  assert.equal(dashboardDiagnosticFailureReason(new Error('EACCES')), 'permission');
  assert.equal(dashboardDiagnosticFailureReason(new Error('invalid payload')), 'invalid_response');
});
