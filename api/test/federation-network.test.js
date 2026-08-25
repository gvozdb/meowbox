'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  FederationEndpointError,
  parseFederationOrigin,
  resolveFederationOrigin,
} = require('../src/federation/endpoint-normalizer');
const {
  getIpFamily,
  isPublicFederationAddress,
} = require('../src/federation/federation-network-policy');
const {
  createValidatedTlsDispatcher,
} = require('../src/federation/pinned-dispatcher');
const { createPinnedSocketAgent } = require('../src/federation/federation-socket-dialer');

test('public federation address policy rejects private and special ranges', () => {
  for (const address of [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.31.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
  ]) {
    assert.equal(isPublicFederationAddress(address), false, address);
  }
  assert.equal(isPublicFederationAddress('8.8.8.8'), true);
  assert.equal(isPublicFederationAddress('2606:4700:4700::1111'), true);
  assert.equal(getIpFamily('not-an-ip'), null);
});

test('origin parser accepts only exact canonical HTTPS origins', () => {
  assert.deepEqual(parseFederationOrigin('https://panel.example.com'), {
    origin: 'https://panel.example.com',
    hostname: 'panel.example.com',
    port: 443,
    literalFamily: null,
  });
  assert.equal(parseFederationOrigin('https://panel.example.com:8443').port, 8443);

  for (const input of [
    'http://panel.example.com',
    'https://panel.example.com/',
    'https://PANEL.example.com',
    'https://panel.example.com:443',
    'https://user@panel.example.com',
    'https://panel.example.com/api',
    'https://panel.example.com?x=1',
    'https://panel.example.com#x',
    'https://panel.example.com\\api',
    'https://panel.example.com.',
    'https://панель.example.com',
  ]) {
    assert.throws(() => parseFederationOrigin(input), FederationEndpointError, input);
  }
});

test('connection-time resolution validates every answer and pins one validated address', async () => {
  const origin = parseFederationOrigin('https://panel.example.com');
  const resolved = await resolveFederationOrigin(origin, async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ]);
  assert.equal(resolved.selectedAddress, '8.8.8.8');
  assert.equal(resolved.addresses.length, 2);

  await assert.rejects(
    () => resolveFederationOrigin(origin, async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
    (error) => error?.code === 'ADDRESS_POLICY_BLOCKED',
  );
  await assert.rejects(
    () => resolveFederationOrigin(origin, async () => []),
    (error) => error?.code === 'DNS_EMPTY',
  );
  await assert.rejects(
    () => resolveFederationOrigin(origin, async () => [
      { address: '8.8.8.8', family: 6 },
    ]),
    (error) => error?.code === 'DNS_INVALID_ANSWER',
  );
});

test('literal public IP skips DNS but still uses the same address policy', async () => {
  let lookups = 0;
  const resolved = await resolveFederationOrigin(
    parseFederationOrigin('https://8.8.8.8'),
    async () => {
      lookups += 1;
      return [];
    },
  );
  assert.equal(lookups, 0);
  assert.equal(resolved.selectedAddress, '8.8.8.8');

  await assert.rejects(
    () => resolveFederationOrigin(parseFederationOrigin('https://127.0.0.1')),
    (error) => error?.code === 'ADDRESS_POLICY_BLOCKED',
  );
});

test('legacy upgrade rail uses exact HTTPS origin with normal TLS validation', async () => {
  assert.throws(() => createValidatedTlsDispatcher('http://panel.example.com'));
  assert.throws(() => createValidatedTlsDispatcher('https://panel.example.com/path'));
  const validated = createValidatedTlsDispatcher('https://panel.example.com');
  assert.equal(validated.origin.origin, 'https://panel.example.com');
  await validated.close();

  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../src/proxy/proxy.service.ts'),
    'utf8',
  );
  assert.doesNotMatch(source, /rejectUnauthorized\s*:\s*false/);
  assert.doesNotMatch(source, /allowsInsecureTlsForIp/);
});

test('T-DIAL-002 Socket.IO uses the same all-answer public policy and pinned lookup', async () => {
  const pin = `sha256/${Buffer.alloc(32, 7).toString('base64')}`;
  const socket = createPinnedSocketAgent('https://panel.example.com', {
    spkiSha256: pin,
    lookup: async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ],
  });
  assert.equal(socket.agent.options.rejectUnauthorized, true);
  assert.equal(socket.agent.options.servername, 'panel.example.com');
  const selected = await new Promise((resolve, reject) => {
    socket.agent.options.lookup('panel.example.com', { family: 4 }, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
  assert.deepEqual(selected, { address: '8.8.8.8', family: 4 });
  socket.destroy();

  const blocked = createPinnedSocketAgent('https://panel.example.com', {
    spkiSha256: pin,
    lookup: async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ],
  });
  await assert.rejects(new Promise((resolve, reject) => {
    blocked.agent.options.lookup('panel.example.com', {}, (error, address) => {
      if (error) reject(error);
      else resolve(address);
    });
  }), /blocked address class/);
  blocked.destroy();
});
