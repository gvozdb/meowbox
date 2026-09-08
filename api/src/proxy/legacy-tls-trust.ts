import { isIP } from 'node:net';
import {
  connect as connectTls,
  type PeerCertificate,
  type TLSSocket,
} from 'node:tls';
import {
  type FederationLookup,
  parseFederationOrigin,
  resolveFederationOrigin,
} from '../federation/endpoint-normalizer';
import {
  caFromPinnedSelfSignedCertificate,
  spkiSha256FromCertificate,
} from '../federation/pinned-dispatcher';

const MAX_CERTIFICATE_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface LegacyTlsTrust {
  caCertificatePem: string;
  spkiSha256: string;
}

export function legacyTlsTrustFromPeerCertificate(
  inputOrigin: string,
  certificate: PeerCertificate,
  now = new Date(),
): LegacyTlsTrust {
  const origin = parseFederationOrigin(inputOrigin);
  if (!certificate.raw || certificate.raw.length > MAX_CERTIFICATE_BYTES) {
    throw new Error('Peer certificate is unavailable or too large');
  }
  const spkiSha256 = spkiSha256FromCertificate(certificate.raw);
  const caCertificatePem = caFromPinnedSelfSignedCertificate(
    origin.hostname,
    spkiSha256,
    certificate,
    now,
  );
  return { caCertificatePem, spkiSha256 };
}

/**
 * Certificate-only TOFU probe for legacy panels. No HTTP request, token, cookie,
 * or application payload is sent before the observed self-signed leaf is stored.
 */
export async function discoverLegacySelfSignedCertificate(
  inputOrigin: string,
  options: Readonly<{
    lookup?: FederationLookup;
    timeoutMs?: number;
  }> = {},
): Promise<LegacyTlsTrust> {
  const origin = parseFederationOrigin(inputOrigin);
  const resolved = await resolveFederationOrigin(origin, options.lookup);
  const servername = isIP(origin.hostname) === 0 ? origin.hostname : undefined;

  return new Promise((resolve, reject) => {
    let socket: TLSSocket | null = null;
    let settled = false;
    const finish = (error?: Error, trust?: LegacyTlsTrust) => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      if (error) reject(error);
      else if (trust) resolve(trust);
      else reject(new Error('Legacy TLS trust probe failed'));
    };

    socket = connectTls({
      host: resolved.selectedAddress,
      port: origin.port,
      servername,
      minVersion: 'TLSv1.2',
      rejectUnauthorized: false,
    });
    socket.setTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    socket.once('timeout', () => finish(new Error('Legacy TLS trust probe timed out')));
    socket.once('error', (error) => finish(error));
    socket.once('secureConnect', () => {
      try {
        finish(
          undefined,
          legacyTlsTrustFromPeerCertificate(
            origin.origin,
            socket!.getPeerCertificate(true),
          ),
        );
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Legacy TLS certificate is invalid'));
      }
    });
  });
}
