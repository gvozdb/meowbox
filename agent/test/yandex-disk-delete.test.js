'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { deleteYandexDiskBackup } = require('../src/backup/yandex-disk-delete');
const { BACKUP_HOSTS } = require('../src/config');
const operationUrl = `https://${BACKUP_HOSTS.YANDEX_DISK_API}/v1/disk/operations/test-operation`;
const accepted = (href = operationUrl) => new Response(JSON.stringify({ href, method: 'GET' }), { status: 202 });
const operation = (status) => new Response(JSON.stringify({ status }));

function stubFetch(t, responses) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), options });
    assert.ok(responses.length, 'unexpected request');
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  });
  return requests;
}

test('Yandex deletion accepts confirmed deletion and an already absent file', async (t) => {
  const requests = stubFetch(t, [new Response(null, { status: 204 }), new Response(null, { status: 404 })]);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await deleteYandexDiskBackup('/backup file.tar.gz', 'test-token'), { success: true });
  }
  assert.equal(requests[0].options.method, 'DELETE');
  assert.equal(requests[0].options.redirect, 'error');
  assert.match(requests[0].url, /path=%2Fbackup%20file.tar.gz&permanently=true$/);
});

test('Yandex async deletion polls until success without repeating DELETE', async (t) => {
  const requests = stubFetch(t, [accepted(), operation('in-progress'), operation('success')]);
  assert.deepEqual(await deleteYandexDiskBackup('/backup.tar.gz', 'test-token'), { success: true });
  assert.deepEqual(requests.map((r) => r.options.method), ['DELETE', 'GET', 'GET']);
  assert.equal(requests[1].url, operationUrl);
  assert.equal(requests[0].options.signal, requests[2].options.signal);
});

test('Yandex failed or malformed operation is not reported as deleted', async (t) => {
  stubFetch(t, [accepted(), operation('failed'), accepted(), operation('unknown')]);
  for (let i = 0; i < 2; i++) {
    assert.equal((await deleteYandexDiskBackup('/backup.tar.gz', 'test-token')).success, false);
  }
});

test('Yandex operation link cannot send OAuth to another origin or API path', async (t) => {
  const urls = ['https://evil.test/v1/disk/operations/a', operationUrl.replace('https:', 'http:'),
    `https://${BACKUP_HOSTS.YANDEX_DISK_API}/v1/disk/resources`,
    operationUrl.replace('https://', 'https://user:password@')];
  const requests = stubFetch(t, urls.map(accepted));
  for (const url of urls) {
    const result = await deleteYandexDiskBackup('/backup.tar.gz', 'test-token');
    assert.equal(result.success, false, url);
  }
  assert.equal(requests.length, urls.length);
  assert.ok(requests.every((r) => r.options.method === 'DELETE'));
});

test('Yandex timeout and authentication failure retain an unsuccessful result', async (t) => {
  const requests = stubFetch(t, [accepted(), new DOMException('Timed out', 'TimeoutError'), new Response(null, { status: 401 })]);
  assert.equal((await deleteYandexDiskBackup('/backup.tar.gz', 'test-token')).success, false);
  assert.match((await deleteYandexDiskBackup('/backup.tar.gz', 'test-token')).error, /401/);
  assert.deepEqual(requests.map((r) => r.options.method), ['DELETE', 'GET', 'DELETE']);
});

test('Yandex missing credentials make no network request', async (t) => {
  const requests = stubFetch(t, []);
  assert.equal((await deleteYandexDiskBackup('/backup.tar.gz', undefined)).success, false);
  assert.equal(requests.length, 0);
});
