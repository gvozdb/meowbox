import { encryptWithDomain, decryptWithDomain } from './master-key';
import { loadLegacyKey, decryptWithLegacyKey } from './legacy-key-loader';

/**
 * АES-256-GCM шифратор — re-export shim для обратной совместимости.
 *
 * До унификации (2026-05-10) этот модуль шифровал ВСЕ external-credentials
 * одним ключом `.dns-key`: и DNS-провайдеры, и пароли пользовательских БД,
 * и прочее. После унификации:
 *   - Encrypt всегда через `master-key` + HKDF domain `meowbox:dns:v1`.
 *   - Decrypt пробует master:dns → master:databases → legacy .dns-key.
 *   - Новый код должен использовать `dns-cipher.ts` или `database-cipher.ts`
 *     напрямую (с правильным доменом). Этот файл оставлен как fallback.
 *
 * См. docs/specs/2026-05-10-master-key-unification.md §5.2.
 */

/** Шифрует JSON-объект через DNS-домен (для обратной совместимости). */
export function encryptJson(obj: unknown): string {
  return encryptWithDomain('dns', obj);
}

/**
 * Дешифрует через DNS-домен, с fallback на databases-домен и legacy ключ.
 * Это позволяет читать blob'ы, сделанные ДО разделения dns/databases.
 */
export function decryptJson<T = unknown>(encoded: string): T {
  // 1) Новый ключ — dns домен
  try {
    return decryptWithDomain<T>('dns', encoded);
  } catch {
    /* пробуем databases */
  }
  // 2) Новый ключ — databases домен
  try {
    return decryptWithDomain<T>('databases', encoded);
  } catch {
    /* пробуем legacy */
  }
  // 3) Legacy .dns-key
  const legacy = loadLegacyKey('dns');
  if (!legacy) {
    throw new Error(
      'Не удалось расшифровать credentials: ни master-key (dns/databases), ни legacy .dns-key. ' +
        'Запустите миграцию 2026-05-10-002-rekey-secrets или восстановите ключ.',
    );
  }
  return decryptWithLegacyKey<T>(legacy, encoded);
}

/** Прогрев master-key. */
export function assertCredentialKeyConfigured(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  require('./master-key').assertMasterKeyConfigured();
}
