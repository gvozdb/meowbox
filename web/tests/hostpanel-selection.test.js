'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const webRoot = path.resolve(__dirname, '..');

function loadTypeScript(file) {
  const source = fs.readFileSync(file, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: file,
  }).outputText;
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = module.paths;
  loaded._compile(output, file);
  return loaded.exports;
}

const selection = loadTypeScript(path.join(webRoot, 'utils/hostpanel-selection.ts'));

test('hostpanel first-run defaults include only current selectable items', () => {
  const items = [
    { id: 'site-a', status: 'PLANNED', plan: { defaultSelected: true } },
    { id: 'site-b', status: 'PLANNED', plan: { defaultSelected: false } },
    { id: 'blocked', status: 'BLOCKED', plan: { blockedReason: 'Unsupported PHP' } },
    { id: 'skipped', status: 'SKIPPED', plan: { defaultSelected: true } },
  ];

  assert.deepEqual(selection.getDefaultSelectedHostpanelItemIds(items), ['site-a']);
  assert.deepEqual(selection.getSelectableHostpanelItemIds(items), ['site-a', 'site-b']);
});

test('hostpanel selection drops stale and duplicate ids', () => {
  assert.deepEqual(
    selection.getCurrentSelectionIds(
      ['site-a', 'site-b', 'site-c'],
      ['stale-id', 'site-c', 'site-c', 'site-a'],
    ),
    ['site-a', 'site-c'],
  );
});

test('hostpanel migration switch replaces selection with ids from the new migration', () => {
  const previous = new Set(['old-a', 'old-b']);
  const current = selection.createCurrentSelection(['new-a', 'new-b'], previous);
  assert.deepEqual([...current], []);

  const restored = selection.createCurrentSelection(
    ['new-a', 'new-b'],
    [...previous, 'new-b'],
  );
  assert.deepEqual([...restored], ['new-b']);
});

test('hostpanel single-item toggle is atomic and ignores foreign ids', () => {
  const selected = selection.toggleCurrentSelection(['site-a', 'site-b'], [], 'site-b');
  assert.deepEqual([...selected], ['site-b']);
  assert.deepEqual(
    [...selection.toggleCurrentSelection(['site-a', 'site-b'], selected, 'site-b')],
    [],
  );
  assert.deepEqual(
    [...selection.toggleCurrentSelection(['site-a', 'site-b'], selected, 'foreign')],
    ['site-b'],
  );
});

test('hostpanel page never counts or submits the raw selection set', () => {
  const page = fs.readFileSync(
    path.join(webRoot, 'pages/admin/migrate-hostpanel/index.vue'),
    'utf8',
  );
  assert.doesNotMatch(page, /selectedItems\.size/);
  assert.doesNotMatch(page, /Array\.from\(selectedItems\.value\)/);
  assert.doesNotMatch(page, /selectedItems\.value\.(?:add|delete|clear)\(/);
  assert.match(page, /itemIds: selectedCurrentItemIds\.value/);
  assert.match(page, /replaceSelectedItems\(\[\]\)/);
});
