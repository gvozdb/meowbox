import { resolveResticMaintenanceTimeouts } from '@meowbox/shared';

const maintenanceTimeouts = resolveResticMaintenanceTimeouts(process.env.MEOWBOX_TIMEOUT_RESTIC_MS);

export const RESTIC_RETENTION_TIMEOUT_MS = maintenanceTimeouts.rpcTimeoutMs;
export const RESTIC_RETENTION_LEASE_MS = maintenanceTimeouts.leaseTimeoutMs;
