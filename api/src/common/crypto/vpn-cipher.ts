import { encryptWithDomain, decryptWithDomain } from './master-key';
import { loadLegacyKey, decryptWithLegacyKey } from './legacy-key-loader';

/**
 * AES-256-GCM шифратор для приватных ключей VPN-сервисов и юзеров.
 *
 * См. docs/specs/2026-05-09-vpn-management.md §6 и
 * docs/specs/2026-05-10-master-key-unification.md.
 *
 * После унификации (2026-05-10):
 *   - Encrypt всегда через `master-key` + HKDF domain `meowbox:vpn:v1`.
 *   - Decrypt сначала пробует новый ключ, при провале — legacy `.vpn-key`
 *     (env `VPN_SECRET_KEY` или файл). Это позволяет читать старые blob'ы до
 *     прохода `rekey-secrets` миграции.
 *   - После миграции legacy-ключ переименован в `.vpn-key.legacy.<ts>`, всё
 *     ещё используется как fallback (на случай если миграция пропустила
 *     какую-то запись или новый blob записан до завершения).
 */

/** Шифрует произвольный JSON-сериализуемый объект и возвращает base64-строку. */
export function encryptVpnJson(obj: unknown): string {
  return encryptWithDomain('vpn', obj);
}

/** Дешифрует base64-строку, возвращает распарсенный объект. */
export function decryptVpnJson<T = unknown>(encoded: string): T {
  // 1) Новый master-key
  try {
    return decryptWithDomain<T>('vpn', encoded);
  } catch {
    // ignore — пробуем legacy
  }
  // 2) Legacy fallback
  const legacy = loadLegacyKey('vpn');
  if (!legacy) {
    throw new Error(
      'Не удалось расшифровать VPN-секрет: master-key не подошёл, legacy ключ не найден. ' +
        'Запустите миграцию 2026-05-10-002-rekey-secrets или восстановите ключи из бэкапа.',
    );
  }
  return decryptWithLegacyKey<T>(legacy, encoded);
}

/** Прогрев — для onModuleInit. */
export function assertVpnSecretConfigured(): void {
  // master-key должен быть доступен. Legacy опционален.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  require('./master-key').assertMasterKeyConfigured();
}
