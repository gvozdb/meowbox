const DEFAULT_MAINTENANCE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const RPC_EXTRA_MS = 5 * 60 * 1000;
const LEASE_EXTRA_MS = 5 * 60 * 1000;
// Node timers must stay within the signed 32-bit range, including both margins.
const MAX_PROCESS_TIMEOUT_MS = 2_147_483_647 - RPC_EXTRA_MS - LEASE_EXTRA_MS;

/** Resolve maintenance timings from the caller's existing Restic timeout env value. */
export function resolveResticMaintenanceTimeouts(rawResticTimeoutMs: string | undefined) {
  const parsed = Number(rawResticTimeoutMs);
  const processTimeoutMs = rawResticTimeoutMs && Number.isFinite(parsed) &&
    parsed > 0 && parsed <= MAX_PROCESS_TIMEOUT_MS
    ? parsed
    : DEFAULT_MAINTENANCE_TIMEOUT_MS;

  const rpcTimeoutMs = processTimeoutMs + RPC_EXTRA_MS;
  return {
    processTimeoutMs,
    rpcTimeoutMs,
    leaseTimeoutMs: rpcTimeoutMs + LEASE_EXTRA_MS,
  };
}
