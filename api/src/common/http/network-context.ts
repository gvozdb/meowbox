import { isIP } from 'node:net';
import { extractClientIp } from './client-ip';
import {
  FederationRequestState,
  isVerifiedFederationRequest,
} from '../../federation/federation-request-context';

export interface VerifiedNetworkContext {
  peerIp: string;
  browserIp: string;
  provenance: 'DIRECT' | 'LOCAL_REVERSE_PROXY' | 'FEDERATION_SIGNED';
}

export interface NetworkContextRequest extends FederationRequestState {
  headers: Record<string, string | string[] | undefined>;
  networkContext?: VerifiedNetworkContext;
}

function normalizedAddress(value: string | undefined): string {
  const mapped = value?.match(/^::ffff:([0-9.]+)$/)?.[1] ?? value ?? '';
  return isIP(mapped) === 0 ? '0.0.0.0' : mapped;
}

export function buildNetworkContext(request: NetworkContextRequest): VerifiedNetworkContext {
  const peerIp = normalizedAddress(extractClientIp(request));
  const directIp = normalizedAddress(request.socket?.remoteAddress);
  if (isVerifiedFederationRequest(request)) {
    return {
      peerIp,
      browserIp: normalizedAddress(request.federationContext.browserIp),
      provenance: 'FEDERATION_SIGNED',
    };
  }
  return {
    peerIp,
    browserIp: peerIp,
    provenance: directIp !== peerIp ? 'LOCAL_REVERSE_PROXY' : 'DIRECT',
  };
}

export function getOrCreateNetworkContext(
  request: NetworkContextRequest,
): VerifiedNetworkContext {
  request.networkContext ??= buildNetworkContext(request);
  return request.networkContext;
}
