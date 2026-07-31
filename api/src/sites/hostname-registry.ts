import { Prisma } from '@prisma/client';
import { ConflictException } from '@nestjs/common';

import { parseSiteAliases } from '../common/json-array';
import { canonicalizeHostname } from './domain-validation';

export const HOSTNAME_REGISTRY_LOCK = 'hostname-registry';

type HostnameRegistryTransaction = Pick<
  Prisma.TransactionClient,
  'hostnameClaim'
>;

interface HostnameClaimInput {
  siteDomainId: string;
  domain: string;
  aliases: string | null | undefined;
}

function hostnameClaims(input: HostnameClaimInput) {
  const domain = canonicalizeHostname(input.domain);
  const claims = new Map<string, 'CANONICAL' | 'ALIAS'>([
    [domain, 'CANONICAL'],
  ]);

  for (const alias of parseSiteAliases(input.aliases)) {
    const hostname = canonicalizeHostname(alias.domain);
    if (hostname === domain) {
      throw new ConflictException(
        `Hostname "${hostname}" cannot be both a canonical domain and an alias`,
      );
    }
    if (claims.has(hostname)) {
      throw new ConflictException(`Duplicate hostname "${hostname}"`);
    }
    claims.set(hostname, 'ALIAS');
  }

  return [...claims].map(([hostname, kind]) => ({
    hostname,
    siteDomainId: input.siteDomainId,
    kind,
  }));
}

export async function createHostnameClaims(
  tx: HostnameRegistryTransaction,
  input: HostnameClaimInput,
): Promise<void> {
  await tx.hostnameClaim.createMany({
    data: hostnameClaims(input),
  });
}

export async function replaceHostnameClaims(
  tx: HostnameRegistryTransaction,
  input: HostnameClaimInput,
): Promise<void> {
  await tx.hostnameClaim.deleteMany({
    where: { siteDomainId: input.siteDomainId },
  });
  await createHostnameClaims(tx, input);
}

export function rethrowHostnameClaimConflict(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    (() => {
      const target = error.meta?.target;
      return (
        (Array.isArray(target) && target.includes('hostname')) ||
        (typeof target === 'string' && target.includes('hostname')) ||
        error.message.includes('hostname_claims.hostname')
      );
    })()
  ) {
    throw new ConflictException('Hostname is already reserved by another site');
  }
  throw error;
}
