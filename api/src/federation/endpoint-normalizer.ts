import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { getIpFamily, isPublicFederationAddress, IpFamily } from './federation-network-policy';

const MAX_ORIGIN_LENGTH = 512;

export type FederationLookup = (
  hostname: string,
) => Promise<readonly LookupAddress[]>;

export interface FederationOrigin {
  origin: string;
  hostname: string;
  port: number;
  literalFamily: IpFamily | null;
}

export interface ResolvedFederationOrigin extends FederationOrigin {
  addresses: readonly Readonly<{ address: string; family: IpFamily }>[];
  selectedAddress: string;
}

export interface ResolvedFederationHost {
  hostname: string;
  addresses: readonly Readonly<{ address: string; family: IpFamily }>[];
  selectedAddress: string;
}

export class FederationEndpointError extends Error {
  constructor(
    readonly code:
      | 'INVALID_ORIGIN'
      | 'ORIGIN_SERIALIZATION_CHANGED'
      | 'DNS_RESOLUTION_FAILED'
      | 'DNS_EMPTY'
      | 'DNS_INVALID_ANSWER'
      | 'ADDRESS_POLICY_BLOCKED',
    message: string,
  ) {
    super(message);
    this.name = 'FederationEndpointError';
  }
}

const defaultLookup: FederationLookup = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

function invalidOrigin(message: string): never {
  throw new FederationEndpointError('INVALID_ORIGIN', message);
}

export function parseFederationOrigin(input: string): FederationOrigin {
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    input.length > MAX_ORIGIN_LENGTH ||
    !/^[\x21-\x7e]+$/.test(input) ||
    input.includes('\\')
  ) {
    invalidOrigin('Federation origin must be bounded printable ASCII');
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    invalidOrigin('Federation origin is not a valid URL');
  }

  if (parsed.protocol !== 'https:') {
    invalidOrigin('Federation origin must use HTTPS');
  }
  if (parsed.username || parsed.password) {
    invalidOrigin('Federation origin cannot contain credentials');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    invalidOrigin('Federation origin cannot contain a path, query, or fragment');
  }
  if (!parsed.hostname || parsed.hostname.endsWith('.')) {
    invalidOrigin('Federation origin requires an unambiguous hostname');
  }
  if (parsed.origin !== input) {
    throw new FederationEndpointError(
      'ORIGIN_SERIALIZATION_CHANGED',
      'Federation origin must already be in canonical origin form',
    );
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  return {
    origin: parsed.origin,
    hostname,
    port: parsed.port ? Number(parsed.port) : 443,
    literalFamily: getIpFamily(hostname),
  };
}

export async function resolveFederationOrigin(
  origin: FederationOrigin,
  lookup: FederationLookup = defaultLookup,
): Promise<ResolvedFederationOrigin> {
  const resolved = await resolveFederationHost(origin.hostname, lookup);
  return {
    ...origin,
    addresses: resolved.addresses,
    selectedAddress: resolved.selectedAddress,
  };
}

export async function resolveFederationHost(
  inputHostname: string,
  lookup: FederationLookup = defaultLookup,
): Promise<ResolvedFederationHost> {
  const hostname = inputHostname.trim().replace(/^\[|\]$/g, '').toLowerCase();
  const literalFamily = getIpFamily(hostname);
  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    hostname.endsWith('.') ||
    (!literalFamily && (
      !/^[a-z0-9.-]+$/.test(hostname) ||
      hostname.split('.').some((label) =>
        label.length === 0 ||
        label.length > 63 ||
        label.startsWith('-') ||
        label.endsWith('-'))
    ))
  ) {
    throw new FederationEndpointError('INVALID_ORIGIN', 'Federation hostname is invalid');
  }
  let answers: readonly LookupAddress[];
  if (literalFamily) {
    answers = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      answers = await lookup(hostname);
    } catch {
      throw new FederationEndpointError(
        'DNS_RESOLUTION_FAILED',
        'Federation origin DNS resolution failed',
      );
    }
  }

  if (answers.length === 0) {
    throw new FederationEndpointError(
      'DNS_EMPTY',
      'Federation origin DNS returned no addresses',
    );
  }

  const unique = new Map<string, Readonly<{ address: string; family: IpFamily }>>();
  for (const answer of answers) {
    const actualFamily = getIpFamily(answer.address);
    if (!actualFamily || actualFamily !== answer.family) {
      throw new FederationEndpointError(
        'DNS_INVALID_ANSWER',
        'Federation origin DNS returned an invalid address',
      );
    }
    if (!isPublicFederationAddress(answer.address)) {
      throw new FederationEndpointError(
        'ADDRESS_POLICY_BLOCKED',
        'Federation origin resolved to a blocked address class',
      );
    }
    unique.set(`${actualFamily}:${answer.address}`, {
      address: answer.address,
      family: actualFamily,
    });
  }

  const addresses = [...unique.values()];
  if (addresses.length === 0) {
    throw new FederationEndpointError(
      'DNS_EMPTY',
      'Federation origin DNS returned no usable addresses',
    );
  }

  return {
    hostname,
    addresses,
    selectedAddress: addresses[0].address,
  };
}
