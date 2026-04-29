import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * AES-256-GCM шифратор для секретов внешних сервисов (DNS-провайдеры, OAuth-токены и т.п.).
 *
 * Формат шифротекста (base64): iv(12) | tag(16) | ciphertext.
 *
 * Источник master-key (порядок поиска):
 *   1. ENV `DNS_CREDENTIAL_KEY` (32 байта в base64) — опциональный override
 *      для прод-секрет-менеджеров.
 *   2. Файл `${MEOWBOX_DATA_DIR}/.dns-key` (32 байта бинарных, perms 600).
 *   3. Если ничего нет — ключ автогенерится при первом обращении и сохраняется
 *      в файл `.dns-key` (юзеру ничего делать не нужно).
 *
 * DATA_DIR:
 *   - ENV `MEOWBOX_DATA_DIR` если задан;
 *   - иначе `/opt/meowbox/data` (стандартное место БД meowbox.db).
 *
 * При смене ключа все ранее зашифрованные секреты становятся нечитаемы — об
 * этом выводится stderr-warning при первой генерации.
 */

const ENV_VAR = 'DNS_CREDENTIAL_KEY';
const KEY_FILENAME = '.dns-key';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32; // AES-256

let cachedKey: Buffer | null = null;

function resolveKeyFilePath(): string {
  const dataDir = process.env.MEOWBOX_DATA_DIR?.trim() || '/opt/meowbox/data';
  return path.join(dataDir, KEY_FILENAME);
}

function readFromEnv(): Buffer | null {
  const raw = process.env[ENV_VAR];
  if (!raw || !raw.trim()) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(raw.trim(), 'base64');
  } catch {
    throw new Error(`${ENV_VAR} is not valid base64`);
  }
  if (buf.length !== KEY_LEN) {
    throw new Error(`${ENV_VAR} must decode to exactly ${KEY_LEN} bytes (got ${buf.length})`);
  }
  return buf;
}

function readFromFile(filePath: string): Buffer | null {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length !== KEY_LEN) {
      throw new Error(
        `Key file ${filePath} has ${buf.length} bytes, expected ${KEY_LEN}. ` +
          `Delete the file to regenerate (existing encrypted DNS credentials will be unrecoverable).`,
      );
    }
    return buf;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function generateAndPersist(filePath: string): Buffer {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.randomBytes(KEY_LEN);
  // Атомарная запись: сначала во временный файл, потом rename. Защита от
  // полузаписанного файла при kill -9 в момент создания.
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, key, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* umask может перебить mode у некоторых FS — игнорим */
  }
  fs.renameSync(tmp, filePath);
  // eslint-disable-next-line no-console
  console.warn(
    `[credentials-cipher] Generated new master key at ${filePath}. ` +
      `Back this file up — losing it makes all encrypted DNS provider credentials unrecoverable.`,
  );
  return key;
}

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;

  // 1) ENV override
  const fromEnv = readFromEnv();
  if (fromEnv) {
    cachedKey = fromEnv;
    return fromEnv;
  }

  // 2) Файл
  const filePath = resolveKeyFilePath();
  const fromFile = readFromFile(filePath);
  if (fromFile) {
    cachedKey = fromFile;
    return fromFile;
  }

  // 3) Авто-генерация
  const generated = generateAndPersist(filePath);
  cachedKey = generated;
  return generated;
}

/** Шифрует произвольный JSON-сериализуемый объект и возвращает base64-строку. */
export function encryptJson(obj: unknown): string {
  const key = loadKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** Дешифрует base64-строку, возвращает распарсенный объект (типизация на стороне вызывающего). */
export function decryptJson<T = unknown>(encoded: string): T {
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
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}

/**
 * Прогревает ключ — вызывается лениво при первом encrypt/decrypt. Полезно
 * также один раз вызвать на старте сервиса, чтобы автогенерация прошла до
 * первого запроса юзера и не «висла» на крайне редком race-condition.
 */
export function assertCredentialKeyConfigured(): void {
  loadKey();
}
