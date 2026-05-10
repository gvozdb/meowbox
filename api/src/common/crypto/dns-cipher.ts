import { encryptWithDomain, decryptWithDomain } from './master-key';
import { loadLegacyKey, decryptWithLegacyKey } from './legacy-key-loader';

/**
 * Шифратор DNS-провайдер credentials.
 * Domain: `meowbox:dns:v1`.
 *
 * Новый код должен использовать этот модуль (а не `credentials-cipher.ts`).
 */

export function encryptDnsCredentials(obj: unknown): string {
  return encryptWithDomain('dns', obj);
}

export function decryptDnsCredentials<T = unknown>(encoded: string): T {
  try {
    return decryptWithDomain<T>('dns', encoded);
  } catch {
    /* fallback */
  }
  const legacy = loadLegacyKey('dns');
  if (!legacy) {
    throw new Error(
      'DNS credentials decrypt failed: ни master-key, ни legacy .dns-key.',
    );
  }
  return decryptWithLegacyKey<T>(legacy, encoded);
}
