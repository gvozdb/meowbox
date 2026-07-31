'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ForbiddenException } = require('@nestjs/common');
const { FilesService } = require('../src/files/files.service');

function createService(applicationRoot) {
  return new FilesService(
    {
      requireOwnedSiteDomain: async () => ({
        applicationRoot,
        site: { systemUser: null },
      }),
    },
    {
      isAgentConnected: () => false,
    },
  );
}

function upload(name, content) {
  return {
    originalname: Buffer.from(name, 'utf8').toString('latin1'),
    buffer: Buffer.from(content),
  };
}

test('download path rejects a symlink escape', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-file-path-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, 'app');
  const outside = path.join(fixture, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(outside, path.join(root, 'escape'));

  const service = createService(root);
  await assert.rejects(
    () =>
      service.resolveFilePath(
        'site-id',
        'domain-id',
        'user-id',
        'ADMIN',
        'escape/secret.txt',
      ),
    ForbiddenException,
  );
});

test('upload rejects a symlinked directory outside the application root', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-upload-path-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, 'app');
  const outside = path.join(fixture, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'uploads'));

  const service = createService(root);
  await assert.rejects(
    () =>
      service.uploadFile(
        'site-id',
        'domain-id',
        'user-id',
        'ADMIN',
        'uploads',
        upload('payload.txt', 'payload'),
      ),
    ForbiddenException,
  );
  assert.equal(fs.existsSync(path.join(outside, 'payload.txt')), false);
});

test('upload replaces a final symlink without modifying its outside target', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-upload-file-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, 'app');
  const uploads = path.join(root, 'uploads');
  const outside = path.join(fixture, 'outside');
  fs.mkdirSync(uploads, { recursive: true });
  fs.mkdirSync(outside);
  const outsideTarget = path.join(outside, 'victim.txt');
  const uploadTarget = path.join(uploads, 'victim.txt');
  fs.writeFileSync(outsideTarget, 'original');
  fs.symlinkSync(outsideTarget, uploadTarget);

  const service = createService(root);
  await service.uploadFile(
    'site-id',
    'domain-id',
    'user-id',
    'ADMIN',
    'uploads',
    upload('victim.txt', 'replacement'),
  );

  assert.equal(fs.readFileSync(outsideTarget, 'utf8'), 'original');
  assert.equal(fs.lstatSync(uploadTarget).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(uploadTarget, 'utf8'), 'replacement');
});
