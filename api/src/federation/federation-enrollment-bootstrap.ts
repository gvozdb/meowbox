import { createHash } from 'node:crypto';

export const ENROLLMENT_PROOF_HEADER = 'x-meowbox-enrollment-proof';

export function decodeEnrollmentProof(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error('Federation enrollment proof is invalid');
  }
  const proof = Buffer.from(value, 'base64url');
  if (
    proof.length !== 32 ||
    proof.toString('base64url') !== value
  ) throw new Error('Federation enrollment proof is invalid');
  return proof;
}

export function enrollmentProofHash(proof: Buffer): string {
  if (proof.length !== 32) throw new Error('Federation enrollment proof must be 32 bytes');
  return createHash('sha256').update(proof).digest('hex');
}
