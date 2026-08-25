#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

npm --prefix "$ROOT_DIR/shared" run test:federation
npm --prefix "$ROOT_DIR/api" run build
npm --prefix "$ROOT_DIR/api" run test:site-deletion-options
npm --prefix "$ROOT_DIR/api" run test:database-catalog
npm --prefix "$ROOT_DIR/api" run test:restic-retention
npm --prefix "$ROOT_DIR/api" run test:panel-update-runner
npm --prefix "$ROOT_DIR/api" run test:domain-mutation-rollback
npm --prefix "$ROOT_DIR/api" run test:vpn-port-reservation
npm --prefix "$ROOT_DIR/api" run test:prisma-logging
npm --prefix "$ROOT_DIR/api" run test:dashboard
npm --prefix "$ROOT_DIR/api" run test:federation
npm --prefix "$ROOT_DIR/agent" run test:restic-retention
npm --prefix "$ROOT_DIR/agent" run test:redis-executor
npm --prefix "$ROOT_DIR/agent" run test:application-root-preflight
npm --prefix "$ROOT_DIR/agent" run test:xray-port-reservation
npm --prefix "$ROOT_DIR/agent" run test:federation
node --test "$ROOT_DIR"/e2e/remote-panel-parity/test/*.test.mjs
npm --prefix "$ROOT_DIR/web" run test:contracts
npm --prefix "$ROOT_DIR/web" run typecheck
npm --prefix "$ROOT_DIR/web" run build
npm --prefix "$ROOT_DIR/migrations" run test:release
node "$ROOT_DIR/tools/remote-panel-release-gate.mjs" --root "$ROOT_DIR" --mode implementation
