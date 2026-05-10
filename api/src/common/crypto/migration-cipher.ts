import { encryptWithDomain, decryptWithDomain } from './master-key';
import { loadLegacyKey, decryptWithLegacyKey } from './legacy-key-loader';

/**
 * AES-256-GCM шифратор для SSH/MySQL кредов источника, передаваемых через UI
 * для миграции сайтов со старой hostPanel.
 *
 * После унификации (2026-05-10):
 *   - Encrypt: master-key + HKDF domain `meowbox:migration:v1`.
 *   - Decrypt: master → legacy env `MIGRATION_SECRET`.
 *
 * См. docs/specs/2026-05-10-master-key-unification.md.
 */

/** Шифрует произвольный JSON-сериализуемый объект, возвращает base64. */
export function encryptMigrationSecret(obj: unknown): string {
  return encryptWithDomain('migration', obj);
}

/** Дешифрует base64-строку. */
export function decryptMigrationSecret<T = unknown>(encoded: string): T {
  try {
    return decryptWithDomain<T>('migration', encoded);
  } catch {
    /* fallback */
  }
  const legacy = loadLegacyKey('migration');
  if (!legacy) {
    throw new Error(
      'Migration credentials decrypt failed: ни master-key, ни legacy MIGRATION_SECRET. ' +
        'Незавершённые миграции hostpanel помечайте как FAILED, начинайте заново.',
    );
  }
  return decryptWithLegacyKey<T>(legacy, encoded);
}

/** Прогрев — для onModuleInit. */
export function assertMigrationSecretConfigured(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  require('./master-key').assertMasterKeyConfigured();
}
