import { createHash } from 'node:crypto';

export interface CurrentSystemMigrationRecord {
  id: string;
  checksum: string;
}

export interface AppliedSystemMigrationRecord {
  id: string;
  checksum: string;
  ok: boolean;
  errorLog: string | null;
}

export interface AcceptedLegacySystemMigration {
  id: string;
  kind: 'checksum-alias' | 'retired' | 'superseded-failure';
  reason: string;
}

interface ChecksumAliasCompatibility {
  id: string;
  currentChecksum: string;
  acceptedStoredChecksums: readonly string[];
  reason: string;
}

interface RetiredSuccessfulMigration {
  id: string;
  kind: 'retired';
  storedChecksum: string;
  reason: string;
}

interface RetiredSupersededFailure {
  id: string;
  kind: 'superseded-failure';
  storedChecksum: string;
  errorLogSha256: string;
  supersededBy: {
    id: string;
    storedChecksum: string;
  };
  reason: string;
}

type RetiredMigrationCompatibility =
  | RetiredSuccessfulMigration
  | RetiredSupersededFailure;

const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Historical releases calculated system-migration checksums from compiled JS.
 * A few applied rows therefore differ from the current, reviewed artifact
 * even though their source identity is known.  Every exception binds both
 * sides of the comparison: changing either artifact invalidates the contract.
 */
const CHECKSUM_ALIASES: readonly ChecksumAliasCompatibility[] = [
  {
    id: '2026-04-29-001-nginx-layered-rebuild',
    currentChecksum:
      '764e9a0da2aa8d0dd7ee7500422bb6d8103e32ea56b3eebbec367018e7ab7b1c',
    acceptedStoredChecksums: [
      '7177c0bc9ea47adf246db7585a8cc8ad260f447b0e76c325e89647a6647f4b44',
    ],
    reason: 'legacy SSL relation artifact',
  },
  {
    id: '2026-04-30-005-install-php-versions',
    currentChecksum:
      '10416b94f828545bc6e6cabc2056f586a6b557cc928f200ba60773e438dd3bfe',
    acceptedStoredChecksums: [
      '375374bc308157f6d72b7a2c9ac53b861c972ea6b19ca135c0b211a652a05de7',
    ],
    reason: 'legacy PHP repository artifact',
  },
  {
    id: '2026-05-01-007-legacy-php-repo-bootstrap',
    currentChecksum:
      '43916ea7c0a90449c2d92769ed287bbb6244b8d772ef9f0db9eacb340cfc73cd',
    acceptedStoredChecksums: [
      'b9d3de93c8d80a4e4962205f87c4b6991886f55ed7320b30b8ae7590887d3d04',
    ],
    reason: 'legacy compiler artifact',
  },
  {
    id: '2026-05-01-009-install-modx-php-extensions',
    currentChecksum:
      '8c3ca796849424fe97ba8d0ef931d1e0937f8185fe23399814e037c842bfba85',
    acceptedStoredChecksums: [
      '89b5075001fc0c14883041601566936a3218e4469c6525fa78e66d4818d73f98',
    ],
    reason: 'legacy compiler artifact',
  },
  {
    id: '2026-05-02-001-mariadb-tune-import',
    currentChecksum:
      'b24cfc9b3232dd86e29fdc09c543e9c72cfc7d882dbee01de080cfc64435ef2e',
    acceptedStoredChecksums: ['manual-ad-hoc'],
    reason: 'legacy manually recorded execution',
  },
  {
    id: '2026-05-10-002-rekey-secrets',
    currentChecksum:
      '01f82d569abe1d58372284c03f7c74057fd24d49b84ef18debafd56c33b2dfe1',
    acceptedStoredChecksums: [
      '27d636b8740abaf92a5fb7191886dd928535349c2a0e02b17d620fb7ed36072d',
    ],
    reason: 'legacy pre-idempotence artifact',
  },
];

/**
 * These two one-off VPN installers existed only in an early deployed build.
 * Runtime installation is now operator-driven.  The failed Xray bootstrap is
 * accepted only when its exact failure log and exact successful repair record
 * are both present.
 */
const RETIRED_MIGRATIONS: readonly RetiredMigrationCompatibility[] = [
  {
    id: '2026-05-09-002-install-xray',
    kind: 'superseded-failure',
    storedChecksum:
      '28ed606643c5944ceaf59a3011bbe5eca6b152c005f47a94dc4846a1d8d8a653',
    errorLogSha256:
      '2780823e78c182bbb0f1780057dfb83f0ae52353bcd34c906aae07e09ff6d6fa',
    supersededBy: {
      id: '2026-05-09-002-vpn-fix-paths-and-runtime-user',
      storedChecksum:
        '82d88b12a2b9d1de3072054946dee472be905a605962d048824d202bf63b15af',
    },
    reason: 'exact failed Xray bootstrap superseded by VPN runtime repair',
  },
  {
    id: '2026-05-09-003-install-amneziawg',
    kind: 'retired',
    storedChecksum:
      '45b3484a5f77776b84be797144eb297e43276205c086f9e97e13e8364e3368f4',
    reason: 'retired one-off AmneziaWG bootstrap',
  },
];

function assertUniqueIds(records: readonly { id: string }[], label: string): void {
  const seen = new Set<string>();
  for (const record of records) {
    if (!record.id || seen.has(record.id)) {
      throw new Error(`${label} contains an empty or duplicate migration id: ${record.id}`);
    }
    seen.add(record.id);
  }
}

function assertSha256(value: string, label: string): void {
  if (!SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
}

function validateCompatibilityContract(
  currentById: ReadonlyMap<string, CurrentSystemMigrationRecord>,
): void {
  assertUniqueIds(CHECKSUM_ALIASES, 'System migration checksum compatibility');
  assertUniqueIds(RETIRED_MIGRATIONS, 'Retired system migration compatibility');

  const aliasesById = new Set(CHECKSUM_ALIASES.map((entry) => entry.id));
  for (const retired of RETIRED_MIGRATIONS) {
    if (aliasesById.has(retired.id)) {
      throw new Error(`System migration compatibility overlaps for ${retired.id}`);
    }
  }

  for (const compatibility of CHECKSUM_ALIASES) {
    assertSha256(
      compatibility.currentChecksum,
      `Current checksum for ${compatibility.id}`,
    );
    if (compatibility.acceptedStoredChecksums.length === 0) {
      throw new Error(`No stored checksum aliases configured for ${compatibility.id}`);
    }
    if (new Set(compatibility.acceptedStoredChecksums).size
      !== compatibility.acceptedStoredChecksums.length) {
      throw new Error(`Duplicate stored checksum alias for ${compatibility.id}`);
    }
    const current = currentById.get(compatibility.id);
    if (!current) {
      throw new Error(
        `System migration compatibility references missing artifact ${compatibility.id}`,
      );
    }
    if (current.checksum !== compatibility.currentChecksum) {
      throw new Error(
        `System migration compatibility is stale for ${compatibility.id}: ` +
          `expected current=${compatibility.currentChecksum.slice(0, 12)}, ` +
          `actual=${current.checksum.slice(0, 12)}`,
      );
    }
  }

  for (const retired of RETIRED_MIGRATIONS) {
    assertSha256(retired.storedChecksum, `Retired checksum for ${retired.id}`);
    if (currentById.has(retired.id)) {
      throw new Error(
        `Retired system migration ${retired.id} unexpectedly has a current artifact`,
      );
    }
    if (retired.kind === 'superseded-failure') {
      assertSha256(
        retired.errorLogSha256,
        `Retired failure log checksum for ${retired.id}`,
      );
      assertSha256(
        retired.supersededBy.storedChecksum,
        `Superseding checksum for ${retired.supersededBy.id}`,
      );
      if (!currentById.has(retired.supersededBy.id)) {
        throw new Error(
          `Retired system migration ${retired.id} references missing superseder ` +
            retired.supersededBy.id,
        );
      }
    }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function assessSystemMigrationHistory(
  current: readonly CurrentSystemMigrationRecord[],
  applied: readonly AppliedSystemMigrationRecord[],
): { acceptedLegacy: AcceptedLegacySystemMigration[] } {
  assertUniqueIds(current, 'Current system migrations');
  assertUniqueIds(applied, 'Applied system migrations');

  const currentById = new Map(current.map((record) => [record.id, record]));
  const appliedById = new Map(applied.map((record) => [record.id, record]));
  const aliasesById = new Map(CHECKSUM_ALIASES.map((entry) => [entry.id, entry]));
  const retiredById = new Map(RETIRED_MIGRATIONS.map((entry) => [entry.id, entry]));
  validateCompatibilityContract(currentById);

  const acceptedLegacy: AcceptedLegacySystemMigration[] = [];
  for (const stored of applied) {
    const currentRecord = currentById.get(stored.id);
    if (currentRecord) {
      if (!stored.ok) {
        throw new Error(
          `Interrupted/failed system migration state blocks release update: ${stored.id}`,
        );
      }
      if (stored.errorLog !== null) {
        throw new Error(
          `Successful system migration ${stored.id} unexpectedly retains an error log`,
        );
      }
      if (stored.checksum === currentRecord.checksum) continue;

      const compatibility = aliasesById.get(stored.id);
      if (
        !compatibility
        || compatibility.currentChecksum !== currentRecord.checksum
        || !compatibility.acceptedStoredChecksums.includes(stored.checksum)
      ) {
        throw new Error(
          `Applied system migration ${stored.id} checksum drift: ` +
            `stored=${stored.checksum.slice(0, 12)}, ` +
            `current=${currentRecord.checksum.slice(0, 12)}. ` +
            'No exact compatibility contract exists.',
        );
      }
      acceptedLegacy.push({
        id: stored.id,
        kind: 'checksum-alias',
        reason: compatibility.reason,
      });
      continue;
    }

    const retired = retiredById.get(stored.id);
    if (!retired || stored.checksum !== retired.storedChecksum) {
      throw new Error(
        `Unknown or drifted applied system migration artifact: ${stored.id}`,
      );
    }

    if (retired.kind === 'retired') {
      if (!stored.ok || stored.errorLog !== null) {
        throw new Error(
          `Retired system migration ${stored.id} does not match its successful contract`,
        );
      }
      acceptedLegacy.push({
        id: stored.id,
        kind: retired.kind,
        reason: retired.reason,
      });
      continue;
    }

    const superseder = appliedById.get(retired.supersededBy.id);
    const exactFailure =
      !stored.ok
      && stored.errorLog !== null
      && sha256(stored.errorLog) === retired.errorLogSha256;
    const exactSuperseder =
      superseder?.ok === true
      && superseder.errorLog === null
      && superseder.checksum === retired.supersededBy.storedChecksum;
    if (!exactFailure || !exactSuperseder) {
      throw new Error(
        `Retired failed system migration ${stored.id} is not proven superseded by ` +
          retired.supersededBy.id,
      );
    }
    acceptedLegacy.push({
      id: stored.id,
      kind: retired.kind,
      reason: retired.reason,
    });
  }

  return { acceptedLegacy };
}
