'use strict';

const fs = require('node:fs');
const path = require('node:path');

const apiRoot = path.resolve(__dirname, '..');
const marker = path.join(apiRoot, 'prisma', 'legacy-panel-update-bridge.json');

// Source/dev installs keep the ordinary Prisma CLI. The marker exists only in
// signed release artifacts that must remain consumable by approved legacy updaters.
if (!fs.existsSync(marker)) process.exit(0);

const realCli = path.join(apiRoot, 'node_modules', 'prisma', 'build', 'index.js');
const wrapperSource = path.join(__dirname, 'prisma-legacy-bridge.cjs');
const installedBin = path.join(apiRoot, 'node_modules', '.bin', 'prisma');

for (const required of [realCli, wrapperSource]) {
  if (!fs.statSync(required, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Legacy panel update bridge is missing ${required}`);
  }
}

fs.rmSync(installedBin, { force: true });
fs.copyFileSync(wrapperSource, installedBin, fs.constants.COPYFILE_EXCL);
fs.chmodSync(installedBin, 0o755);
