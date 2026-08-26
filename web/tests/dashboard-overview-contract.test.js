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

function webSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === '.nuxt' || entry.name === '.output' || entry.name === 'tests') {
      return [];
    }
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) return webSourceFiles(absolute);
    return /\.(?:ts|vue|css)$/.test(entry.name) ? [absolute] : [];
  });
}

function cssBlock(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS block ${selector}`);
  return match[1];
}

function hexVariable(block, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`${escaped}:\\s*(#[0-9a-f]{6})`, 'i'));
  assert.ok(match, `missing hex variable ${name}`);
  return [1, 3, 5].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16));
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

test('global text and action palettes meet WCAG AA contrast', () => {
  const rootBlock = cssBlock(globalCss, ':root');
  const lightBlock = cssBlock(globalCss, 'html.theme-light');
  const darkBackground = [10, 10, 15];
  const lightBackground = [243, 244, 246];
  const textTokens = [
    '--text-primary', '--text-heading', '--text-secondary', '--text-tertiary',
    '--text-muted', '--text-faint', '--text-placeholder', '--success-text',
    '--danger-text', '--warning-text', '--info-text', '--violet-text',
    '--orange-text', '--pink-text',
  ];

  for (const token of textTokens) {
    assert.ok(contrastRatio(hexVariable(rootBlock, token), darkBackground) >= 4.5, `${token} fails dark AA`);
    assert.ok(contrastRatio(hexVariable(lightBlock, token), lightBackground) >= 4.5, `${token} fails light AA`);
  }

  for (const palette of ['amber', 'violet', 'emerald', 'sapphire', 'rose', 'teal', 'fuchsia']) {
    const darkPaletteBlock = cssBlock(globalCss, `html.palette-${palette}`);
    const lightPaletteBlock = cssBlock(globalCss, `html.theme-light.palette-${palette}`);
    assert.ok(contrastRatio(hexVariable(darkPaletteBlock, '--primary-text'), darkBackground) >= 4.5, `${palette} accent fails dark AA`);
    assert.ok(contrastRatio(hexVariable(lightPaletteBlock, '--primary-text'), lightBackground) >= 4.5, `${palette} accent fails light AA`);
    for (const token of ['--primary-action', '--primary-action-hover']) {
      assert.ok(
        contrastRatio(hexVariable(darkPaletteBlock, token), [255, 255, 255]) >= 4.5,
        `${palette} ${token} fails AA`,
      );
    }
  }
  for (const token of ['--danger-action', '--danger-action-hover', '--info-action', '--info-action-hover']) {
    assert.ok(contrastRatio(hexVariable(rootBlock, token), [255, 255, 255]) >= 4.5, `${token} fails AA`);
  }

  assert.doesNotMatch(page, /--text-(?:tertiary|muted):/);
  assert.match(page, /--dashboard-status-success: var\(--success-text\)/);
  assert.match(page, /Операционный центр/);
  assert.doesNotMatch(page, /Operations control room|Problems Inbox/);
});

test('theme-aware semantic colors replace light-only foreground colors', () => {
  const forbiddenForeground = /(?<![-\w])color\s*:\s*(?:var\(--(?:primary|primary-light|success|success-light|danger|danger-light)\)|#(?:4ade80|86efac|22c55e|f87171|fca5a5|fda4a4|ef4444|60a5fa|38bdf8|818cf8|a78bfa|fbbf24|fcd34d|fdba74)|rgb\((?:52,\s*211,\s*153|56,\s*189,\s*248|96,\s*165,\s*250|129,\s*140,\s*248|147,\s*197,\s*253|168,\s*85,\s*247|192,\s*132,\s*252|229,\s*115,\s*115|244,\s*114,\s*182|248,\s*113,\s*113|250,\s*204,\s*21|251,\s*146,\s*60)\)|rgba\(\s*(?:var\(--primary-rgb\)|34,\s*197,\s*94|59,\s*130,\s*246|129,\s*140,\s*248|139,\s*92,\s*246|168,\s*85,\s*247|239,\s*68,\s*68|252,\s*165,\s*165)\s*,)/i;
  for (const file of webSourceFiles(root)) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), forbiddenForeground, file);
  }
  assert.match(globalCss, /--primary-action: #a16207/);
  assert.match(globalCss, /--danger-action: #b91c1c/);
  assert.match(globalCss, /--info-action: #1d4ed8/);
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
