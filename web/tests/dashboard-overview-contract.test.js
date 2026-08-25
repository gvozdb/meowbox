'use strict';

const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const root = resolve(__dirname, '..');
const composable = readFileSync(resolve(root, 'composables/useDashboardOverview.ts'), 'utf8');
const navigation = readFileSync(resolve(root, 'utils/dashboard-navigation.ts'), 'utf8');
const page = readFileSync(resolve(root, 'pages/index.vue'), 'utf8');
const problems = readFileSync(resolve(root, 'components/dashboard/DashboardProblemsInbox.vue'), 'utf8');
const resources = readFileSync(resolve(root, 'components/dashboard/DashboardResourceStrip.vue'), 'utf8');
const runtime = readFileSync(resolve(root, 'components/dashboard/DashboardRuntimePanel.vue'), 'utf8');
const pulse = readFileSync(resolve(root, 'components/dashboard/DashboardServerPulse.vue'), 'utf8');
const globalCss = readFileSync(resolve(root, 'assets/global.css'), 'utf8');
const layout = readFileSync(resolve(root, 'layouts/default.vue'), 'utf8');
const telemetry = readFileSync(resolve(root, 'utils/dashboard-telemetry.ts'), 'utf8');

function relativeLuminance([red, green, blue]) {
  const channels = [red, green, blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function blend(foreground, alpha, background) {
  return foreground.map((channel, index) => Math.round(
    (channel * alpha) + (background[index] * (1 - alpha)),
  ));
}

function webSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === '.nuxt' || entry.name === '.output' || entry.name === 'tests') {
      return [];
    }
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) return webSourceFiles(absolute);
    return /\.(?:ts|vue)$/.test(entry.name) ? [absolute] : [];
  });
}

test('web keeps the CommonJS shared package type-only', () => {
  const runtimeSharedImport = /import\s+(?!type\b)[^;]*from\s+['"]@meowbox\/shared['"]/gs;
  for (const file of webSourceFiles(root)) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), runtimeSharedImport, file);
  }
});

test('overview fails closed and enters legacy mode only on 404', () => {
  assert.match(composable, /item\.contractVersion !== DASHBOARD_CONTRACT_VERSION/);
  assert.match(composable, /statusOf\(overviewError\) !== 404/);
  assert.doesNotMatch(composable, /\[401,\s*403,\s*404/);
  assert.match(composable, /\[401, 403\]\.includes\(statusOf\(result\.reason\)/);
});

test('polling is selected-server safe, non-overlapping, cancellable and visibility-aware', () => {
  assert.match(composable, /const POLL_INTERVAL_MS = 30_000/);
  assert.match(composable, /if \(request\?\.key === serverKey\) return/);
  assert.match(composable, /request\.controller\.abort\(\)/);
  assert.match(composable, /document\.hidden/);
  assert.match(composable, /document\.addEventListener\('visibilitychange'/);
  assert.match(composable, /\(serverStore\.currentServerId \|\| 'main'\) !== serverKey/);
  assert.match(composable, /snapshots\.get\(serverKey\)/);
});

test('navigation registry allowlists every v1 action and rejects unknown targets', () => {
  for (const target of ['MONITORING', 'SITES', 'SITE', 'SERVICES', 'BACKUPS', 'SSL', 'DNS', 'UPDATES', 'ACTIVITY']) {
    assert.match(navigation, new RegExp(`case '${target}'`));
  }
  assert.match(navigation, /default:\s*\n\s*return null/);
  assert.match(navigation, /u0000-\\u001f/);
  assert.match(navigation, /encodeURIComponent\(value\)/);
});

test('page preserves fixed operations-first order and contains no mutating quick action', () => {
  const order = [
    'DashboardServerPulse',
    'DashboardProblemsInbox',
    'DashboardResourceStrip',
    'DashboardSitesPanel',
    'DashboardRuntimePanel',
    'DashboardProtectionPanel',
    'DashboardSecurityPanel',
    'DashboardActivityPanel',
  ];
  let offset = 0;
  for (const component of order) {
    const next = page.indexOf(`<${component}`, offset);
    assert.notEqual(next, -1, `missing or misordered ${component}`);
    offset = next + component.length;
  }
  assert.doesNotMatch(page, /restartNginx|\/nginx\/reload/);
});

test('Problems dialog traps focus and restores trigger focus', () => {
  assert.match(problems, /\.showModal\(\)/);
  assert.match(problems, /@close="restoreFocus"/);
  assert.match(problems, /@keydown="trapDialogFocus"/);
  assert.match(problems, /event\.key !== 'Tab'/);
  assert.match(problems, /dialog\.value\.contains\(active\)/);
  assert.match(problems, /openButton\.value\?\.focus\(\)/);
  assert.match(problems, /aria-labelledby="all-problems-title"/);
});

test('dashboard states and progress remain accessible without color or motion', () => {
  assert.match(page, /aria-live="polite"/);
  assert.match(resources, /role="progressbar"/);
  assert.match(resources, /aria-label="Загрузка процессора"/);
  assert.match(runtime, /role="progressbar"/);
  assert.match(runtime, /:aria-label="`Прогресс операции для \$\{operation\.target\}`"/);
  assert.match(runtime, /Работает/);
  assert.match(pulse, /HEALTHY: 'В норме'/);
  assert.match(globalCss, /:focus-visible/);
  assert.match(globalCss, /prefers-reduced-motion: reduce/);
  assert.match(globalCss, /@media \(max-width: 620px\)[\s\S]*min-height: 44px/);
});

test('dashboard text palette meets WCAG AA contrast in dark and light themes', () => {
  for (const declaration of [
    '--text-tertiary: rgba(255, 255, 255, 0.58)',
    '--text-muted: rgba(255, 255, 255, 0.5)',
    '--text-tertiary: rgba(0, 0, 0, 0.62)',
    '--text-muted: rgba(0, 0, 0, 0.56)',
    '--dashboard-status-success: #15803d',
    '--dashboard-status-warning: #92400e',
    '--dashboard-status-danger: #b91c1c',
  ]) {
    assert.ok(page.includes(declaration), `missing accessible token ${declaration}`);
  }

  const darkBackground = [10, 10, 15];
  const lightBackground = [255, 255, 255];
  const pairs = [
    [blend([255, 255, 255], 0.58, darkBackground), darkBackground],
    [blend([255, 255, 255], 0.5, darkBackground), darkBackground],
    [blend([0, 0, 0], 0.62, lightBackground), lightBackground],
    [blend([0, 0, 0], 0.56, lightBackground), lightBackground],
    [[74, 222, 128], darkBackground],
    [[251, 191, 36], darkBackground],
    [[248, 113, 113], darkBackground],
    [[21, 128, 61], lightBackground],
    [[146, 64, 14], lightBackground],
    [[185, 28, 28], lightBackground],
  ];
  for (const [foreground, background] of pairs) {
    assert.ok(contrastRatio(foreground, background) >= 4.5);
  }
});

test('closed mobile navigation stays out of keyboard order', () => {
  assert.match(layout, /aria-controls="main-sidebar"/);
  assert.match(layout, /aria-label="Переключить тему"/);
  assert.match(layout, /\.sidebar \{[\s\S]*visibility: hidden;[\s\S]*transform: translateX\(-100%\)/);
  assert.match(layout, /\.sidebar--open \{[\s\S]*visibility: visible;/);
});

test('dashboard telemetry is bounded and excludes values and entity labels', () => {
  for (const event of [
    'dashboard_contract_unsupported',
    'dashboard_full_refresh_failure',
    'dashboard_section_unavailable',
  ]) {
    assert.match(telemetry, new RegExp(`'${event}'`));
  }
  assert.match(composable, /reportedContractUnsupported/);
  assert.match(composable, /reportedRefreshFailures/);
  assert.match(composable, /reportedUnavailableSections/);
  assert.doesNotMatch(telemetry, /metric|entity|serverId|serverKey|displayName|hostname|value:/);
});
