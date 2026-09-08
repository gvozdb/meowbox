'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { PanelAccessManager } = require('../src/panel-access/panel-access.manager');

const root = path.resolve(__dirname, '..');
const source = () => fs.readFileSync(path.join(root, 'src/panel-access/panel-access.manager.ts'), 'utf8');
const agentSource = () => fs.readFileSync(path.join(root, 'src/agent.service.ts'), 'utf8');

const settings = {
  domain: 'new.target.test',
  certMode: 'LE',
  certPath: '/fixture/new/fullchain.pem',
  keyPath: '/fixture/new/privkey.pem',
  httpsRedirect: true,
  denyIpAccess: true,
};
const env = {
  PANEL_PORT: '11862',
  API_PORT: '11860',
  WEB_PORT: '11861',
  ADMINER_DIR: '/opt/meowbox/state/adminer',
  TRANSFER_RATE_LIMIT: '20m',
};

test('T-PA-001 candidate listener coexists without replacing primary upstreams', () => {
  const manager = new PanelAccessManager();
  const candidate = manager.buildPanelNginxConf(settings, env, {
    includeUpstreams: false,
    candidateOnly: true,
    cutoverId: '11111111-2222-4333-8444-555555555555',
  });
  assert.match(candidate, /federation-cutover: 11111111-2222-4333-8444-555555555555/);
  assert.match(candidate, /server_name new\.target\.test/);
  assert.match(candidate, /listen 443 ssl/);
  assert.doesNotMatch(candidate, /listen 11862/);
  assert.match(candidate, /proxy_pass http:\/\/meowbox_api/);
  assert.match(candidate, /location \/socket\.io\//);
  assert.doesNotMatch(candidate, /upstream meowbox_api/);
  assert.doesNotMatch(candidate, /default_server/);

  const primary = manager.buildPanelNginxConf({ ...settings, denyIpAccess: false }, env);
  assert.match(primary, /upstream meowbox_api/);
  assert.doesNotMatch(primary, /default_server/);
  assert.match(primary, /listen 443 ssl/);
  assert.match(primary, /listen 11862 ssl/);
  assert.match(primary, /ssl_certificate \/fixture\/new\/fullchain\.pem/);
});

test('T-PA-002 denyIpAccess keeps domain on 443 and closes the recovery port', () => {
  const manager = new PanelAccessManager();
  const config = manager.buildPanelNginxConf({ ...settings, denyIpAccess: true }, env);
  const primaryHeader = config.slice(
    config.lastIndexOf('\nserver {', config.indexOf('    # Security headers')),
    config.indexOf('    # Security headers'),
  );
  assert.match(primaryHeader, /listen 443 ssl/);
  assert.doesNotMatch(primaryHeader, /11862/);
  assert.match(config, /listen 11862 ssl default_server/);
  assert.match(config, /return 444/);
  assert.doesNotMatch(config, /https:\/\/\$host:11862/);
});

test('T-PA-003 cutover writes durable journals and validates Nginx before reload', () => {
  const body = source();
  assert.match(body, /CUTOVER_STATE_DIR = '\/opt\/meowbox\/state\/data\/panel-access-cutovers'/);
  assert.match(body, /writeAtomicFile\([\s\S]*0o600/);
  assert.match(body, /execute\('nginx', \['-t'\]/);
  assert.match(body, /execute\('systemctl', \['reload', 'nginx'\]/);
  assert.match(body, /writeFederationEndpoints\(envBefore, nextEndpoints\)/);
  assert.match(body, /state: 'FINALIZED'/);
  assert.match(body, /state: 'ROLLED_BACK'/);
  assert.match(body, /PANEL_ACME_PATH/);
  assert.match(body, /buildAcmeChallengeConf\('local-issuance', params\.domain\)/);
  assert.match(body, /removeManagedNginxConfig\(PANEL_ACME_PATH, PANEL_ACME_ENABLED, true\)/);
  assert.match(agentSource(), /panel-access:cutover-status/);
  assert.doesNotMatch(body, /rejectUnauthorized\s*:\s*false/);
});
