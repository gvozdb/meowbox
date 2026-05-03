import * as crypto from 'crypto';

/**
 * AES-256-GCM шифратор для SSH/MySQL кредов источника, передаваемых через UI
 * для миграции сайтов со старой hostPanel. См. spec §3.3.
 *
 * Формат шифротекста (base64): iv(12) | tag(16) | ciphertext.
 *
 * Источник master-key:
 *   1. ENV `MIGRATION_SECRET` — обязателен, ставится system-миграцией
 *      `008-migration-secret-bootstrap.ts` при `make update`.
 *   2. Если переменной нет — encryptJson/decryptJson бросят ошибку.
 *      (В отличие от credentials-cipher, авто-генерация в файл НЕ делается:
 *       UI миграции не должна работать с не-инициализированным секретом.)
 *
 * Если ключ был перегенерён или потерян — все ранее зашифрованные креды
 * становятся нечитаемыми. Это не страшно: миграция всегда инициируется заново
 * (юзер вводит SSH/MySQL пароли каждый раз в UI), а старые незавершённые
 * миграции просто помечаются как FAILED.
 */

const ENV_VAR = 'MIGRATION_SECRET';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32; // AES-256

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env[ENV_VAR];
  if (!raw || !raw.trim()) {
    throw new Error(
      `${ENV_VAR} is not set. Run system migration ` +
        `'008-migration-secret-bootstrap' (через make update) или экспортни ` +
        `вручную: MIGRATION_SECRET=$(openssl rand -base64 32).`,
    );
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw.trim(), 'base64');
  } catch {
    throw new Error(`${ENV_VAR} is not valid base64`);
  }
  if (buf.length !== KEY_LEN) {
    throw new Error(
      `${ENV_VAR} must decode to exactly ${KEY_LEN} bytes (got ${buf.length})`,
    );
  }
  cachedKey = buf;
  return buf;
}

/** Шифрует произвольный JSON-сериализуемый объект, возвращает base64. */
export function encryptMigrationSecret(obj: unknown): string {
  const key = loadKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** Дешифрует base64-строку. */
export function decryptMigrationSecret<T = unknown>(encoded: string): T {
  const key = loadKey();
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('Encrypted payload too short');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}

/** Прогрев ключа — для onModuleInit. Поднимет понятную ошибку если переменной нет. */
export function assertMigrationSecretConfigured(): void {
  loadKey();
}
