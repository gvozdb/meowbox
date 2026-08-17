'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { MINIO_API_ENDPOINT } = require('@meowbox/shared');
const { MinioServiceHandler } = require('../src/services/handlers/minio.handler');

const site = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'demo',
  systemUser: 'demo',
  rootPath: '/var/www/demo',
};

test('MinIO handler provisions tenant credentials through agent without exposing secrets to API', async () => {
  const calls = [];
  const handler = new MinioServiceHandler({
    emitToAgent: async (event, payload) => {
      calls.push({ event, payload });
      return { success: true, data: undefined };
    },
  });

  await handler.enableForSite(site, {});

  assert.deepEqual(calls, [{
    event: 'minio:site-enable',
    payload: {
      siteId: site.id,
      siteName: site.name,
      systemUser: site.systemUser,
      rootPath: site.rootPath,
    },
  }]);
  const connection = handler.connectionInfoForSite(site);
  assert.ok(connection.items.some((item) => item.value === MINIO_API_ENDPOINT));
  assert.ok(connection.items.some((item) => item.copyable === false));
  assert.equal(JSON.stringify(connection).includes('MINIO_ROOT_PASSWORD'), false);
  assert.equal(JSON.stringify(connection).includes('MEOWBOX_MINIO_SECRET_KEY='), false);
});
