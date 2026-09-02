'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const helperPath = path.join(root, 'utils/idempotency-key.ts');

async function loadHelper() {
  const source = fs.readFileSync(helperPath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

test('browser UUID uses native randomUUID when available', async () => {
  const { createBrowserUuid } = await loadHelper();
  const expected = 'd9428888-122b-4e99-8e4c-f43f3b7c4eaf';
  const actual = createBrowserUuid({
    randomUUID: () => expected,
    getRandomValues: () => { throw new Error('fallback must not run'); },
  });
  assert.equal(actual, expected);
});

test('browser UUID falls back to getRandomValues with RFC 4122 version and variant bits', async () => {
  const { createBrowserUuid } = await loadHelper();
  const actual = createBrowserUuid({
    getRandomValues: (target) => {
      target.set(Uint8Array.from({ length: 16 }, (_, index) => index));
      return target;
    },
  });
  assert.equal(actual, '00010203-0405-4607-8809-0a0b0c0d0e0f');
});

test('web mutations use the compatible UUID helper', () => {
  const sourceFiles = ['components', 'composables', 'pages', 'utils']
    .flatMap((directory) => fs.readdirSync(path.join(root, directory), { recursive: true })
      .filter((file) => /\.(?:ts|vue)$/.test(file))
      .map((file) => path.join(directory, file)));
  for (const file of sourceFiles) {
    if (file === 'utils/idempotency-key.ts') continue;
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /randomUUID/);
  }
});
