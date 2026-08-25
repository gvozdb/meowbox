'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('T-ADM-001 browser validates typed direct handoff and probes target reachability', () => {
  const helper = read('utils/public-delivery.ts');
  assert.match(helper, /validateAppHandoffDelivery\(rawDelivery\)/);
  assert.match(helper, /value\.kind !== 'AppHandoff'/);
  assert.match(helper, /delivery\.purpose !== expectedPurpose/);
  assert.match(helper, /browserReachabilityRequired/);
  assert.match(helper, /\/api\/public\/v1\/adminer\/probe/);
  assert.match(helper, /mode: 'no-cors'/);
  assert.match(helper, /referrerPolicy: 'no-referrer'/);
  assert.match(helper, /TARGET_BROWSER_UNREACHABLE/);
  assert.doesNotMatch(helper, /window\.location\.origin/);
});

test('T-ADM-005 all four Adminer/Manticore callers use one typed helper and idempotency', () => {
  const callers = [
    ['pages/databases.vue', 'ADMINER'],
    ['pages/sites/[id].vue', 'ADMINER'],
    ['components/SiteDatabasesTab.vue', 'ADMINER'],
    ['components/SiteServicesTab.vue', 'MANTICORE'],
  ];
  for (const [file, purpose] of callers) {
    const source = read(file);
    assert.match(source, /navigateAppHandoff/);
    assert.match(source, new RegExp(`publicDeliveryIdempotencyKey\\('${purpose}'\\)`));
    assert.match(source, new RegExp(`navigateAppHandoff\\(delivery, win, '${purpose}'\\)`));
    assert.doesNotMatch(source, /adminer\/sso\.php/);
  }
});

test('T-MODX-001 MODX login navigates a typed target-origin handoff without master document.write', () => {
  const helper = read('utils/public-delivery.ts');
  const page = read('pages/sites/[id].vue');
  assert.match(helper, /navigateModxHandoff/);
  assert.match(helper, /delivery\.purpose !== 'MODX_LOGIN'/);
  assert.match(helper, /\/api\/public\/v1\/modx\/login/);
  assert.match(helper, /method: 'HEAD'/);
  assert.match(helper, /TARGET_BROWSER_UNREACHABLE/);
  assert.match(page, /navigateModxHandoff\(handoff, target\)/);
  assert.match(page, /publicDeliveryIdempotencyKey\('MODX_LOGIN'\)/);
  assert.doesNotMatch(page, /document\.write/);
  assert.doesNotMatch(page, /\/domain-app-login\//);
});

test('T-XFER-001 browser validates generated versus staged delivery and probes direct target', () => {
  const helper = read('utils/public-delivery.ts');
  assert.match(helper, /validateTransferSessionDelivery/);
  assert.match(helper, /value\.transferMode === 'GENERATED_STREAM'/);
  assert.match(helper, /Сервер ложно объявил live stream возобновляемым/);
  assert.match(helper, /value\.transferMode === 'STAGED_ARTIFACT'/);
  assert.match(helper, /method: 'HEAD'/);
  assert.match(helper, /mode: 'no-cors'/);
  assert.match(helper, /TARGET_BROWSER_UNREACHABLE/);
  assert.doesNotMatch(helper, /window\.location\.origin/);
});

test('T-XFER-004 backup exports use typed native delivery without relay Blob fallback', () => {
  const page = read('pages/sites/[id].vue');
  assert.match(page, /\/backup-exports\/\$\{id\}\/delivery/);
  assert.match(page, /navigateDownloadDelivery\(delivery, popup, 'BACKUP_EXPORT'\)/);
  assert.match(page, /publicDeliveryIdempotencyKey\('DOWNLOAD'\)/);
  assert.match(page, /value="STAGED_ARTIFACT"/);
  assert.match(page, /'\/backup-exports\/staged'/);
  assert.match(page, /exportModeLabel\(ex\.mode\)/);
  assert.doesNotMatch(page, /backup-exports\/\$\{ex\.id\}\/issue-token/);
  assert.doesNotMatch(page, /res\.downloadUrl/);
  assert.doesNotMatch(page, /api\.download\(endpoint, filename\)/);
});

test('T-XFER-002 database import uses a typed one-shot direct PUT without auth or buffering', () => {
  const helper = read('utils/public-delivery.ts');
  const flow = read('composables/useDatabaseTransfer.ts');
  assert.match(helper, /validateTransferUploadDelivery/);
  assert.match(helper, /value\.purpose !== 'UPLOAD'/);
  assert.match(helper, /value\.method !== 'PUT'/);
  assert.match(helper, /value\.allowedHeaders\[0\] !== 'content-type'/);
  assert.equal(helper.includes('transfers\\/[0-9a-f-]{36}\\/upload$'), true);
  assert.match(helper, /method: 'PUT'/);
  assert.match(helper, /body: file/);
  assert.match(helper, /credentials: 'omit'/);
  assert.match(helper, /redirect: 'error'/);
  assert.match(helper, /referrerPolicy: 'no-referrer'/);
  assert.doesNotMatch(helper, /new FormData/);
  assert.doesNotMatch(helper, /new Blob/);
  assert.match(flow, /uploadTransferFile\([\s\S]*'DATABASE_IMPORT'/);
  assert.match(flow, /uploadSessionId: delivery\.leaseId/);
});

test('T-XFER-003 database export uses staged native delivery and both callers share the flow', () => {
  const flow = read('composables/useDatabaseTransfer.ts');
  assert.match(flow, /api\.post<AcceptedOperation>\(`\$\{databaseEndpoint\}\/export`/);
  assert.match(flow, /waitForOperation\(accepted\.operationId/);
  assert.match(flow, /\/exports\/\$\{accepted\.operationId\}\/delivery/);
  assert.match(flow, /navigateDownloadDelivery\(delivery, popup, 'DATABASE_EXPORT'\)/);
  assert.doesNotMatch(flow, /api\.download/);
  for (const file of ['components/SiteDatabasesTab.vue', 'pages/databases.vue']) {
    const source = read(file);
    assert.match(source, /useDatabaseTransfer\(\)/);
    assert.match(source, /await exportDatabase\(/);
    assert.match(source, /await importDatabase\(/);
    assert.doesNotMatch(source, /\/import-upload/);
    assert.doesNotMatch(source, /\/download\?filePath=/);
    assert.doesNotMatch(source, /api\.upload\(/);
  }
});

test('T-XFER-001/002 files use direct typed sessions and a durable atomic commit', () => {
  const flow = read('composables/useFileTransfer.ts');
  const page = read('pages/sites/[id].vue');
  assert.match(flow, /files\/download-session/);
  assert.match(flow, /navigateDownloadDelivery\(delivery, popup, 'SITE_FILE'\)/);
  assert.match(flow, /files\/upload-session/);
  assert.match(flow, /uploadTransferFile\([\s\S]*'SITE_FILE_UPLOAD'/);
  assert.match(flow, /files\/upload-commit/);
  assert.match(flow, /waitForOperation\(accepted\.operationId/);
  assert.match(flow, /captureSelectedTargetContext\(\)/);
  assert.match(page, /downloadSiteFile\(selectedDomainApi\.value, item\.path\)/);
  assert.match(page, /uploadSiteFile\(/);
  assert.doesNotMatch(page, /files\/download\?path=/);
  assert.doesNotMatch(page, /files\/upload\?path=/);
  assert.doesNotMatch(page, /api\.upload\(/);
});

test('T-XFER-001 site backup download uses native target delivery without Blob relay', () => {
  const flow = read('composables/useFileTransfer.ts');
  const page = read('pages/sites/[id].vue');
  assert.match(flow, /backups\/\$\{backupId\}\/download-session/);
  assert.match(flow, /navigateDownloadDelivery\(delivery, popup, 'BACKUP_FILE'\)/);
  assert.match(page, /downloadBackupFile\(b\.id/);
  assert.match(page, /downloadBackupFile\(b\.baseBackupId/);
  assert.doesNotMatch(page, /`\/backups\/\$\{b\.id\}\/download`/);
  assert.doesNotMatch(page, /api\.download\(/);
  assert.doesNotMatch(flow, /new Blob/);
});

test('T-VPN-001 VPN UI uses stable master-owned typed subscription URL', () => {
  const page = read('pages/vpn.vue');
  const helper = read('utils/public-delivery.ts');
  assert.match(page, /useMasterApi\(\)/);
  assert.match(page, /validateVpnSubscriptionDelivery\(value\)/);
  assert.match(helper, /value\.kind !== 'PublicEndpoint'/);
  assert.match(helper, /value\.purpose !== 'VPN_SUBSCRIPTION'/);
  assert.match(page, /\/servers\/\$\{encodeURIComponent\(serverId\)\}\/vpn-subscriptions/);
  assert.match(page, /\/servers\/vpn-subscriptions\/\$\{subscriptionDelivery\.value\.resource\.id\}\/rotate/);
  assert.doesNotMatch(page, /window\.location\.origin.*\/api\/vpn\/sub/);
  assert.doesNotMatch(page, /regenerate-sub-token/);
});
