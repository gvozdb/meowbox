import { Agent as HttpsAgent } from 'node:https';
import { PeerCertificate } from 'node:tls';
import {
  FederationLookup,
  parseFederationOrigin,
  resolveFederationOrigin,
} from './endpoint-normalizer';
import {
  validateFederationSpkiPin,
  verifyPinnedCertificate,
} from './pinned-dispatcher';

export interface PinnedSocketAgentOptions {
  spkiSha256: string;
  caCertificatePem?: string | null;
  lookup?: FederationLookup;
  connectTimeoutMs?: number;
}

export interface PinnedSocketAgent {
  agent: HttpsAgent;
  destroy(): void;
}

export function createPinnedSocketAgent(
  inputOrigin: string,
  options: PinnedSocketAgentOptions,
): PinnedSocketAgent {
  const origin = parseFederationOrigin(inputOrigin);
  const expectedPin = validateFederationSpkiPin(options.spkiSha256);
  const agent = new HttpsAgent({
    keepAlive: true,
    maxSockets: 1,
    maxFreeSockets: 1,
    timeout: options.connectTimeoutMs ?? 5_000,
    rejectUnauthorized: true,
    servername: origin.hostname,
    ca: options.caCertificatePem ?? undefined,
    lookup: (hostname, lookupOptions, callback) => {
      const normalizedHostname = hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (normalizedHostname !== origin.hostname.toLowerCase()) {
        callback(new Error('Pinned Socket.IO hostname mismatch'), '', 4);
        return;
      }
      void resolveFederationOrigin(origin, options.lookup)
        .then((resolved) => {
          const requestedFamily = typeof lookupOptions === 'object'
            ? Number(lookupOptions.family || 0)
            : 0;
          const selected = requestedFamily === 4 || requestedFamily === 6
            ? resolved.addresses.find((address) => address.family === requestedFamily)
            : resolved.addresses[0];
          if (!selected) {
            callback(new Error('Pinned Socket.IO DNS family is unavailable'), '', 4);
            return;
          }
          callback(null, selected.address, selected.family);
        })
        .catch((error: unknown) => {
          callback(error instanceof Error ? error : new Error('Pinned Socket.IO DNS failed'), '', 4);
        });
    },
    checkServerIdentity: (hostname, certificate) =>
      verifyPinnedCertificate(hostname, expectedPin, certificate as PeerCertificate),
  });
  return {
    agent,
    destroy: () => agent.destroy(),
  };
}
