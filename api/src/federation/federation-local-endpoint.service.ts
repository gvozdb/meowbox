import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FederationManifestEndpointSet,
  FederationManifestEndpointState,
} from '@meowbox/shared';
import { parseFederationOrigin } from './endpoint-normalizer';

const ORIGIN_KEYS = [
  'FEDERATION_API_ORIGIN',
  'FEDERATION_WS_ORIGIN',
  'FEDERATION_BROWSER_PUBLIC_ORIGIN',
  'FEDERATION_DIRECT_TRANSFER_ORIGIN',
] as const;

export type LocalFederationEndpointClaim =
  | Readonly<{
      state: 'UNCONFIGURED';
      endpoints: Readonly<Record<string, never>>;
    }>
  | Readonly<{
      state: 'READY';
      endpoints: FederationManifestEndpointSet;
    }>;

export function validateFederationSocketPath(value: string): string {
  if (
    !/^\/[A-Za-z0-9][A-Za-z0-9._/-]*\/?$/.test(value) ||
    value.includes('//') ||
    value.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error('FEDERATION_WS_PATH is invalid');
  }
  return value;
}

@Injectable()
export class FederationLocalEndpointService {
  constructor(private readonly config: ConfigService) {}

  getClaim(): LocalFederationEndpointClaim {
    const configured = Object.fromEntries(
      ORIGIN_KEYS.map((key) => [key, String(this.config.get(key, '')).trim()]),
    ) as Record<(typeof ORIGIN_KEYS)[number], string>;
    const present = ORIGIN_KEYS.filter((key) => configured[key].length > 0);
    if (present.length === 0) {
      return { state: 'UNCONFIGURED', endpoints: {} };
    }
    if (present.length !== ORIGIN_KEYS.length) {
      throw new Error('Federation endpoint origins are partially configured');
    }
    for (const key of ORIGIN_KEYS) parseFederationOrigin(configured[key]);
    const endpoints: FederationManifestEndpointSet = {
      apiOrigin: configured.FEDERATION_API_ORIGIN,
      apiPath: '/api',
      wsOrigin: configured.FEDERATION_WS_ORIGIN,
      socketPath: validateFederationSocketPath(
        String(this.config.get('FEDERATION_WS_PATH', '/socket.io')).trim(),
      ),
      browserPublicOrigin: configured.FEDERATION_BROWSER_PUBLIC_ORIGIN,
      directTransferOrigin: configured.FEDERATION_DIRECT_TRANSFER_ORIGIN,
    };
    return { state: 'READY', endpoints };
  }

  isReady(state: FederationManifestEndpointState): boolean {
    return state === 'READY';
  }
}
