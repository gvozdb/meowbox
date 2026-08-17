'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const vpnPage = readFileSync(resolve(__dirname, '../pages/vpn.vue'), 'utf8');
const constants = readFileSync(resolve(__dirname, '../utils/shared-constants.ts'), 'utf8');

test('VPN SSR uses browser-safe constants instead of the CommonJS shared package', () => {
  assert.match(
    vpnPage,
    /import \{ DEFAULT_SNI_MASKS, DEFAULT_VPN_PORTS \} from '~\/utils\/shared-constants';/,
  );
  assert.doesNotMatch(vpnPage, /@meowbox\/shared/);
  assert.match(constants, /VLESS_REALITY:\s*8443/);
  assert.match(constants, /AMNEZIA_WG:\s*51820/);
});
