const SYSTEM_MIGRATION_ID = /^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{3}-[a-z0-9-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface FailedSystemMigrationRecord {
  id: string;
  checksum: string;
  ok: boolean;
  errorLog: string | null;
}

/**
 * A failed migration may only be retried as the exact artifact that failed.
 * Requiring the existing ledger row prevents an operator from deleting
 * history, skipping migration ordering, or silently accepting drift.
 */
export function assertFailedSystemMigrationRetry(
  id: string,
  currentChecksum: string,
  records: readonly FailedSystemMigrationRecord[],
): FailedSystemMigrationRecord {
  if (!SYSTEM_MIGRATION_ID.test(id)) {
    throw new Error(`Unsafe system migration retry id: ${id}`);
  }
  if (!SHA256.test(currentChecksum)) {
    throw new Error(`Current checksum for ${id} must be a lowercase SHA-256`);
  }

  const matching = records.filter((record) => record.id === id);
  if (matching.length !== 1) {
    throw new Error(
      matching.length === 0
        ? `Failed system migration is not recorded: ${id}`
        : `System migration history contains duplicate records for ${id}`,
    );
  }

  const record = matching[0];
  if (record.ok) {
    throw new Error(`System migration already succeeded: ${id}`);
  }
  if (!record.errorLog) {
    throw new Error(`Failed system migration has no recorded error: ${id}`);
  }
  if (record.checksum !== currentChecksum) {
    throw new Error(
      `Failed system migration checksum drift for ${id}: ` +
        `stored=${record.checksum.slice(0, 12)}, current=${currentChecksum.slice(0, 12)}`,
    );
  }

  const later = records.find((candidate) => candidate.id.localeCompare(id) > 0);
  if (later) {
    throw new Error(
      `Cannot retry ${id} after later migration history exists: ${later.id}`,
    );
  }

  return record;
}
