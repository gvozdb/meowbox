const SITE_DOMAIN_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Hostpanel used to stage PHP before persisting SiteDomain and marked the
 * temporary owner as `migrated-<runtimeKey>`. Only the matching authoritative
 * SiteDomain may adopt that pool; unrelated ownership remains a hard conflict.
 */
export function canWritePhpPoolForDomain(
  previousDomainId: string,
  nextDomainId: string,
  runtimeKey: string,
): boolean {
  if (previousDomainId === nextDomainId) return true;
  return (
    SITE_DOMAIN_UUID_RE.test(nextDomainId) &&
    previousDomainId === `migrated-${runtimeKey}`
  );
}
