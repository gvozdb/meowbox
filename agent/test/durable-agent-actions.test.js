'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DURABLE_AGENT_ACTIONS } = require('../src/agent.service');

test('T-OPS-004 every dedicated durable AgentJob action has an exact RPC handler binding', () => {
  assert.deepEqual(DURABLE_AGENT_ACTIONS, {
    'agent.php.install': 'php:install',
    'agent.php.uninstall': 'php:uninstall',
    'agent.php.extension.install': 'php:extension-install',
    'agent.system.updates.check': 'updates:check',
    'agent.system.updates.install': 'updates:install',
    'agent.system.updates.upgrade_all': 'updates:upgrade-all',
    'agent.ssl.issue': 'ssl:issue',
    'agent.ssl.revoke': 'ssl:revoke',
    'agent.country_block.apply': 'country-block:apply',
    'agent.country_block.refresh_db': 'country-block:refresh-db',
    'agent.storage.restic_test': 'restic:test',
    'agent.storage.top_files': 'site:top-files',
    'agent.node.quick_command': 'node:command-run',
    'agent.application.snapshot': 'application:snapshot',
    'agent.application.restore_snapshot': 'application:restore-snapshot',
    'agent.modx.update': 'site:update-modx',
    'agent.site.health_check': 'site:health-check',
    'agent.vpn.runtime.install_xray': 'vpn:installer:install-xray',
    'agent.vpn.runtime.install_amnezia': 'vpn:installer:install-amnezia',
    'agent.vpn.runtime.uninstall_xray': 'vpn:installer:uninstall-xray',
    'agent.vpn.runtime.uninstall_amnezia': 'vpn:installer:uninstall-amnezia',
    'agent.restic.snapshots': 'restic:snapshots',
    'agent.restic.list_tree': 'restic:list-tree',
    'agent.restic.diff_snapshots': 'restic:diff-snapshots',
    'agent.restic.diff_live': 'restic:diff-live',
    'agent.restic.diff_file': 'restic:diff-file',
    'agent.restic.diff_file_live': 'restic:diff-file-live',
    'agent.hostpanel.force_cleanup_name': 'migrate:hostpanel:force-cleanup-name',
    'agent.database.export': 'db:export',
    'agent.database.drop': 'db:drop',
    'agent.database.create': 'db:create',
    'agent.database.reset_password': 'db:reset-password',
    'agent.database.import': 'db:import',
    'agent.modx.doctor': 'site:modx-doctor',
    'agent.modx.cleanup_setup': 'site:cleanup-setup-dir',
    'agent.domain.permissions_normalize': 'site:normalize-permissions',
    'agent.panel_access.cutover_stage': 'panel-access:stage-cutover',
  });
});
