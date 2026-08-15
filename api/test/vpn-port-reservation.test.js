'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { BadRequestException } = require('@nestjs/common');
const {
  DEFAULT_VPN_PORTS,
  isVpnPortReserved,
  VpnProtocol,
} = require('@meowbox/shared');
const { VpnService } = require('../src/vpn/vpn.service');

function makeService(prisma = {}) {
  return new VpnService(
    prisma,
    { isAgentConnected: () => true },
    { get: () => { throw new Error('provider lookup must not happen'); } },
    {},
    {},
    {},
  );
}

test('VLESS Reality reserves web TCP ports and defaults to 8443', () => {
  assert.equal(DEFAULT_VPN_PORTS.VLESS_REALITY, 8443);
  assert.equal(isVpnPortReserved(VpnProtocol.VLESS_REALITY, 80), true);
  assert.equal(isVpnPortReserved(VpnProtocol.VLESS_REALITY, 443), true);
  assert.equal(isVpnPortReserved(VpnProtocol.VLESS_REALITY, 8443), false);
  assert.equal(isVpnPortReserved(VpnProtocol.AMNEZIA_WG, 443), false);
});

test('VPN service creation rejects VLESS Reality on a web TCP port before side effects', async () => {
  const service = makeService();

  await assert.rejects(
    service.createService({ protocol: VpnProtocol.VLESS_REALITY, port: 443 }),
    (error) => error instanceof BadRequestException && /зарезервирован/.test(error.message),
  );
});

test('a migrated VLESS Reality service on port 443 cannot be started again', async () => {
  const service = makeService({
    vpnService: {
      findUnique: async () => ({
        id: '11111111-1111-4111-8111-111111111111',
        protocol: VpnProtocol.VLESS_REALITY,
        port: 443,
      }),
    },
  });

  await assert.rejects(
    service.startService('11111111-1111-4111-8111-111111111111'),
    (error) => error instanceof BadRequestException && /зарезервирован/.test(error.message),
  );
});
