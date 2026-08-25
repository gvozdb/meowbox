import { createHash, timingSafeEqual, X509Certificate } from 'node:crypto';
import { checkServerIdentity, PeerCertificate, SecureContextOptions } from 'node:tls';
import {
  Agent,
  buildConnector,
  Dispatcher,
} from 'undici';
import {
  FederationLookup,
  FederationOrigin,
  parseFederationOrigin,
  resolveFederationOrigin,
} from './endpoint-normalizer';

export interface PinnedDispatcherOptions {
  spkiSha256: string;
  lookup?: FederationLookup;
  connectTimeoutMs?: number;
  ca?: SecureContextOptions['ca'];
}

export type ValidatedTlsDispatcherOptions = Omit<PinnedDispatcherOptions, 'spkiSha256'>;

export interface PinnedFederationDispatcher {
  origin: FederationOrigin;
  dispatcher: Dispatcher;
  close(): Promise<void>;
}

function createValidatedConnector(
  origin: FederationOrigin,
  options: ValidatedTlsDispatcherOptions,
  expectedPin: Buffer | null,
): buildConnector.connector {
  const expectedPort = String(origin.port);

  return (connectOptions, callback) => {
    const requestedHostname = connectOptions.hostname.replace(/^\[|\]$/g, '');
    const requestedPort = connectOptions.port || '443';
    if (
      connectOptions.protocol !== 'https:' ||
      requestedHostname !== origin.hostname ||
      requestedPort !== expectedPort
    ) {
      callback(new Error('Validated dispatcher origin mismatch'), null);
      return;
    }

    void resolveFederationOrigin(origin, options.lookup)
      .then((resolved) => {
        const connector = buildConnector({
          ca: options.ca,
          rejectUnauthorized: true,
          servername: origin.hostname,
          timeout: options.connectTimeoutMs ?? 5_000,
          checkServerIdentity: (hostname, certificate) => {
            const hostnameError = checkServerIdentity(hostname, certificate);
            if (hostnameError || expectedPin === null) return hostnameError;
            if (!certificate.raw) return new Error('Peer certificate is unavailable');

            let actual: Buffer;
            try {
              actual = decodeSpkiPin(spkiSha256FromCertificate(certificate.raw));
            } catch {
              return new Error('Unable to derive peer SPKI pin');
            }
            return timingSafeEqual(actual, expectedPin)
              ? undefined
              : new Error('Peer SPKI pin mismatch');
          },
        });
        connector(
          {
            ...connectOptions,
            hostname: resolved.selectedAddress,
            servername: origin.hostname,
          },
          callback,
        );
      })
      .catch((error: unknown) => {
        callback(error instanceof Error ? error : new Error('Validated DNS resolution failed'), null);
      });
  };
}

function decodeSpkiPin(pin: string): Buffer {
  const match = /^sha256\/([A-Za-z0-9+/]{43}=)$/.exec(pin);
  if (!match) throw new Error('SPKI pin must use sha256/<base64> format');
  const digest = Buffer.from(match[1], 'base64');
  if (digest.length !== 32 || digest.toString('base64') !== match[1]) {
    throw new Error('SPKI pin is not a canonical SHA-256 digest');
  }
  return digest;
}

export function validateFederationSpkiPin(pin: string): string {
  decodeSpkiPin(pin);
  return pin;
}

export function spkiSha256FromCertificate(rawCertificate: Buffer): string {
  const certificate = new X509Certificate(rawCertificate);
  const spki = certificate.publicKey.export({ type: 'spki', format: 'der' });
  const digest = createHash('sha256').update(spki).digest('base64');
  return `sha256/${digest}`;
}

export function verifyPinnedCertificate(
  hostname: string,
  expectedPin: string,
  certificate: PeerCertificate,
): Error | undefined {
  const hostnameError = checkServerIdentity(hostname, certificate);
  if (hostnameError) return hostnameError;
  if (!certificate.raw) return new Error('Peer certificate is unavailable');

  let actual: Buffer;
  try {
    const actualPin = spkiSha256FromCertificate(certificate.raw);
    actual = decodeSpkiPin(actualPin);
  } catch {
    return new Error('Unable to derive peer SPKI pin');
  }

  const expected = decodeSpkiPin(expectedPin);
  if (!timingSafeEqual(actual, expected)) {
    return new Error('Peer SPKI pin mismatch');
  }
  return undefined;
}

export function createPinnedConnector(
  origin: FederationOrigin,
  options: PinnedDispatcherOptions,
): buildConnector.connector {
  return createValidatedConnector(origin, options, decodeSpkiPin(options.spkiSha256));
}

export function createPinnedFederationDispatcher(
  inputOrigin: string,
  options: PinnedDispatcherOptions,
): PinnedFederationDispatcher {
  const origin = parseFederationOrigin(inputOrigin);
  const agent = new Agent({
    connect: createPinnedConnector(origin, options),
    pipelining: 1,
  });
  return {
    origin,
    dispatcher: agent,
    close: () => agent.close(),
  };
}

export function createValidatedTlsDispatcher(
  inputOrigin: string,
  options: ValidatedTlsDispatcherOptions = {},
): PinnedFederationDispatcher {
  const origin = parseFederationOrigin(inputOrigin);
  const agent = new Agent({
    connect: createValidatedConnector(origin, options, null),
    pipelining: 1,
  });
  return {
    origin,
    dispatcher: agent,
    close: () => agent.close(),
  };
}
