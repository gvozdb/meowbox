import {
  createDisposableFleet,
  removeDisposableFixtureRoot,
} from './index.mjs';

const root = process.env.MEOWBOX_RPP_ROOT;
if (!root) {
  throw new Error('MEOWBOX_RPP_ROOT is required for the RPP-020 fixture check');
}

const fleet = await createDisposableFleet({
  root,
  environment: process.env,
});

try {
  process.stdout.write(`${JSON.stringify({
    mode: fleet.mode,
    networked: fleet.networked,
    profiles: fleet.targets.map(({ name }) => name),
    root: fleet.root,
  })}\n`);
} finally {
  // The caller supplied the root, so fleet.cleanup intentionally does not
  // remove it. The marker-checked removal below is the only cleanup path.
  await removeDisposableFixtureRoot(fleet.root);
}

