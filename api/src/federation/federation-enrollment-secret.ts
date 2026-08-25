import { decryptWithDomain, encryptWithDomain } from '../common/crypto/master-key';
import { decodeEnrollmentProof } from './federation-enrollment-bootstrap';

interface StoredEnrollmentSecretV1 {
  version: 1;
  kind: 'ENROLLMENT_BOOTSTRAP';
  enrollmentId: string;
  proof: string;
}

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function sealEnrollmentProof(enrollmentId: string, proof: Buffer): string {
  if (!CANONICAL_UUID.test(enrollmentId) || proof.length !== 32) {
    throw new Error('Enrollment secret binding is invalid');
  }
  return encryptWithDomain('federation', {
    version: 1,
    kind: 'ENROLLMENT_BOOTSTRAP',
    enrollmentId,
    proof: proof.toString('base64url'),
  } satisfies StoredEnrollmentSecretV1);
}

export function openEnrollmentProof(
  enrollmentId: string,
  encrypted: string,
): Buffer {
  const stored = decryptWithDomain<StoredEnrollmentSecretV1>('federation', encrypted);
  if (
    stored.version !== 1 ||
    stored.kind !== 'ENROLLMENT_BOOTSTRAP' ||
    stored.enrollmentId !== enrollmentId
  ) {
    throw new Error('Encrypted enrollment secret binding mismatch');
  }
  return decodeEnrollmentProof(stored.proof);
}
