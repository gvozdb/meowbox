export interface FederationLegacyRetirementEvidence {
  registeredLegacyPeers: number;
  fallbackUses: number;
  zeroUseSince: string;
  releasesWithZeroUse: number;
  rollbackDrillPassed: boolean;
  keyDrillPassed: boolean;
  operatorApproved: boolean;
}

export interface FederationLegacyRetirementDecision {
  eligible: boolean;
  blockers: readonly string[];
  observedZeroUseDays: number;
}

const DAY_MS = 86_400_000;

export function evaluateFederationLegacyRetirement(
  evidence: FederationLegacyRetirementEvidence,
  now = new Date(),
): FederationLegacyRetirementDecision {
  const blockers: string[] = [];
  const zeroUseSince = Date.parse(evidence.zeroUseSince);
  if (
    !Number.isSafeInteger(evidence.registeredLegacyPeers) ||
    evidence.registeredLegacyPeers < 0 ||
    !Number.isSafeInteger(evidence.fallbackUses) ||
    evidence.fallbackUses < 0 ||
    !Number.isSafeInteger(evidence.releasesWithZeroUse) ||
    evidence.releasesWithZeroUse < 0 ||
    !Number.isFinite(zeroUseSince) ||
    zeroUseSince > now.getTime()
  ) throw new Error('Legacy retirement evidence is invalid');

  const observedZeroUseDays = Math.floor((now.getTime() - zeroUseSince) / DAY_MS);
  if (evidence.registeredLegacyPeers !== 0) blockers.push('REGISTERED_LEGACY_PEERS');
  if (evidence.fallbackUses !== 0) blockers.push('LEGACY_FALLBACK_USE');
  if (observedZeroUseDays < 30) blockers.push('ZERO_USE_WINDOW_LT_30_DAYS');
  if (evidence.releasesWithZeroUse < 2) blockers.push('ZERO_USE_RELEASES_LT_2');
  if (!evidence.rollbackDrillPassed) blockers.push('ROLLBACK_DRILL_UNVERIFIED');
  if (!evidence.keyDrillPassed) blockers.push('KEY_DRILL_UNVERIFIED');
  if (!evidence.operatorApproved) blockers.push('OPERATOR_APPROVAL_REQUIRED');
  return { eligible: blockers.length === 0, blockers, observedZeroUseDays };
}

