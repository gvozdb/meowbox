import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  sign,
  verify,
} from 'node:crypto';
import {
  decryptWithDomain,
  encryptWithDomain,
} from '../common/crypto/master-key';

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID = /^ed25519-[A-Za-z0-9_-]{22}$/;

interface StoredPrivateKeyV1 {
  version: 1;
  kind: 'RELATIONSHIP';
  issuerInstallationId: string;
  targetInstallationId: string;
  kid: string;
  privateKeyPkcs8: string;
}

interface StoredManifestPrivateKeyV1 {
  version: 1;
  kind: 'MANIFEST';
  installationId: string;
  kid: string;
  privateKeyPkcs8: string;
}

export interface FederationRelationshipKey {
  issuerInstallationId: string;
  targetInstallationId: string;
  kid: string;
  publicKeySpki: string;
  encryptedPrivateKey: string;
}

export interface FederationManifestKey {
  installationId: string;
  kid: string;
  publicKeySpki: string;
  encryptedPrivateKey: string;
}

function assertInstallationId(value: string, field: string): void {
  if (!CANONICAL_UUID.test(value)) {
    throw new Error(`${field} must be a canonical UUID`);
  }
}

function exportPublicSpki(publicKey: KeyObject): Buffer {
  return publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
}

function keyId(publicKeySpki: Buffer): string {
  return `ed25519-${createHash('sha256')
    .update(publicKeySpki)
    .digest('base64url')
    .slice(0, 22)}`;
}

export function federationKeyIdFromPublicKeySpki(publicKeySpki: string): string {
  const encoded = decodeCanonicalBase64(publicKeySpki, 'public key');
  const publicKey = createPublicKey({ key: encoded, type: 'spki', format: 'der' });
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Federation public key must be Ed25519');
  }
  const canonical = exportPublicSpki(publicKey);
  if (!canonical.equals(encoded)) {
    throw new Error('Federation public key is not canonical SPKI');
  }
  return keyId(canonical);
}

function generateRawEd25519Key(): Readonly<{
  kid: string;
  publicKeySpki: string;
  privateKeyPkcs8: string;
}> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyDer = exportPublicSpki(publicKey);
  const privateKeyDer = privateKey.export({
    type: 'pkcs8',
    format: 'der',
  }) as Buffer;
  return {
    kid: keyId(publicKeyDer),
    publicKeySpki: publicKeyDer.toString('base64'),
    privateKeyPkcs8: privateKeyDer.toString('base64'),
  };
}

function decodeCanonicalBase64(value: string, label: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} is not canonical base64`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
  return decoded;
}

export function generateFederationRelationshipKey(
  issuerInstallationId: string,
  targetInstallationId: string,
): FederationRelationshipKey {
  assertInstallationId(issuerInstallationId, 'issuerInstallationId');
  assertInstallationId(targetInstallationId, 'targetInstallationId');
  if (issuerInstallationId === targetInstallationId) {
    throw new Error('Federation relationship must connect distinct installations');
  }

  const generated = generateRawEd25519Key();
  const encryptedPrivateKey = encryptWithDomain('federation', {
    version: 1,
    kind: 'RELATIONSHIP',
    issuerInstallationId,
    targetInstallationId,
    kid: generated.kid,
    privateKeyPkcs8: generated.privateKeyPkcs8,
  } satisfies StoredPrivateKeyV1);

  return {
    issuerInstallationId,
    targetInstallationId,
    kid: generated.kid,
    publicKeySpki: generated.publicKeySpki,
    encryptedPrivateKey,
  };
}

export function openFederationPrivateKey(
  encryptedPrivateKey: string,
  expected: Pick<
    FederationRelationshipKey,
    'issuerInstallationId' | 'targetInstallationId' | 'kid'
  >,
): KeyObject {
  const stored = decryptWithDomain<StoredPrivateKeyV1>(
    'federation',
    encryptedPrivateKey,
  );
  if (
    stored.version !== 1 ||
    stored.kind !== 'RELATIONSHIP' ||
    stored.issuerInstallationId !== expected.issuerInstallationId ||
    stored.targetInstallationId !== expected.targetInstallationId ||
    stored.kid !== expected.kid ||
    !KEY_ID.test(stored.kid)
  ) {
    throw new Error('Encrypted federation key binding mismatch');
  }
  const privateKey = createPrivateKey({
    key: decodeCanonicalBase64(stored.privateKeyPkcs8, 'private key'),
    type: 'pkcs8',
    format: 'der',
  });
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Federation private key must be Ed25519');
  }
  return privateKey;
}

export function generateFederationManifestKey(
  installationId: string,
): FederationManifestKey {
  assertInstallationId(installationId, 'installationId');
  const generated = generateRawEd25519Key();
  return {
    installationId,
    kid: generated.kid,
    publicKeySpki: generated.publicKeySpki,
    encryptedPrivateKey: encryptWithDomain('federation', {
      version: 1,
      kind: 'MANIFEST',
      installationId,
      kid: generated.kid,
      privateKeyPkcs8: generated.privateKeyPkcs8,
    } satisfies StoredManifestPrivateKeyV1),
  };
}

export function openFederationManifestPrivateKey(
  encryptedPrivateKey: string,
  expected: Pick<FederationManifestKey, 'installationId' | 'kid'>,
): KeyObject {
  const stored = decryptWithDomain<StoredManifestPrivateKeyV1>(
    'federation',
    encryptedPrivateKey,
  );
  if (
    stored.version !== 1 ||
    stored.kind !== 'MANIFEST' ||
    stored.installationId !== expected.installationId ||
    stored.kid !== expected.kid ||
    !KEY_ID.test(stored.kid)
  ) {
    throw new Error('Encrypted manifest key binding mismatch');
  }
  const privateKey = createPrivateKey({
    key: decodeCanonicalBase64(stored.privateKeyPkcs8, 'manifest private key'),
    type: 'pkcs8',
    format: 'der',
  });
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Federation manifest key must be Ed25519');
  }
  return privateKey;
}

export function signFederationManifestPayload(
  payload: Buffer,
  key: FederationManifestKey,
): string {
  return sign(
    null,
    payload,
    openFederationManifestPrivateKey(key.encryptedPrivateKey, key),
  ).toString('base64url');
}

export function signFederationPayload(
  payload: Buffer,
  relationship: FederationRelationshipKey,
): string {
  const privateKey = openFederationPrivateKey(
    relationship.encryptedPrivateKey,
    relationship,
  );
  return sign(null, payload, privateKey).toString('base64url');
}

export function verifyFederationPayload(
  payload: Buffer,
  signature: string,
  publicKeySpki: string,
): boolean {
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try {
    const signatureBytes = Buffer.from(signature, 'base64url');
    if (
      signatureBytes.length !== 64 ||
      signatureBytes.toString('base64url') !== signature
    ) return false;
    const publicKey = createPublicKey({
      key: decodeCanonicalBase64(publicKeySpki, 'public key'),
      type: 'spki',
      format: 'der',
    });
    if (publicKey.asymmetricKeyType !== 'ed25519') return false;
    return verify(
      null,
      payload,
      publicKey,
      signatureBytes,
    );
  } catch {
    return false;
  }
}
