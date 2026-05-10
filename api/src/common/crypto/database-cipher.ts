import { encryptWithDomain, decryptWithDomain } from './master-key';
import { loadLegacyKey, decryptWithLegacyKey } from './legacy-key-loader';

/**
 * Шифратор паролей пользовательских БД (`Database.dbPasswordEnc`).
 *
 * Domain: `meowbox:databases:v1`.
 *
 * До унификации использовался `credentials-cipher.ts` (общий ключ с DNS). После
 * унификации — отдельный домен. Decrypt пробует master:databases → master:dns
 * (legacy общий) → legacy .dns-key.
 */

export function encryptDbPassword(plain: string): string {
  return encryptWithDomain('databases', { password: plain });
}

export function decryptDbPassword(encoded: string): string {
  // 1) databases домен
  try {
    const obj = decryptWithDomain<{ password: string }>('databases', encoded);
    if (obj?.password) return obj.password;
  } catch {
    /* fallback */
  }
  // 2) dns домен (legacy общий шифратор писал с этим доменом)
  try {
    const obj = decryptWithDomain<{ password: string }>('dns', encoded);
    if (obj?.password) return obj.password;
  } catch {
    /* fallback */
  }
  // 3) legacy .dns-key
  const legacy = loadLegacyKey('databases');
  if (!legacy) {
    throw new Error(
      'DB password decrypt failed: ни master-key (databases/dns), ни legacy .dns-key.',
    );
  }
  const obj = decryptWithLegacyKey<{ password: string }>(legacy, encoded);
  if (!obj?.password) throw new Error('Decrypted DB password is empty');
  return obj.password;
}
