import * as crypto from 'crypto';

/**
 * AES-256-GCM шифратор для Adminer SSO-токенов и сессионных кук.
 *
 * Используется для двустороннего обмена с PHP-кодом Adminer (`tools/adminer/`).
 * Формат: base64url(iv12 | tag16 | ciphertext), без padding — безопасен в URL и Cookie.
 *
 * Ключ:
 *   - ENV `ADMINER_SSO_KEY` (32 байта в base64).
 *   - Если переменная не задана — ошибка при первом обращении.
 *     Ключ генерится в `install.sh` и пишется в `/opt/meowbox/.env`.
 *
 * PHP-side совместимость:
 *   PHP читает тот же ключ из `.env`, использует
 *   `openssl_encrypt/openssl_decrypt('aes-256-gcm', ..., $tag, '', 16)` —
 *   с тем же расположением iv|tag|ct. См. `tools/adminer/lib/sso.php`.
 */

const ENV_VAR = 'ADMINER_SSO_KEY';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env[ENV_VAR];
  if (!raw || !raw.trim()) {
    throw new Error(
      `${ENV_VAR} is not set. Add it to .env (32 bytes, base64). ` +
        `Generate via: openssl rand -base64 32`,
    );
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw.trim(), 'base64');
  } catch {
    throw new Error(`${ENV_VAR} is not valid base64`);
  }
  if (buf.length !== KEY_LEN) {
    throw new Error(`${ENV_VAR} must decode to exactly ${KEY_LEN} bytes (got ${buf.length})`);
  }
  cachedKey = buf;
  return buf;
}

function toBase64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/** Шифрует JSON-объект. Возвращает компактную base64url-строку. */
export function encryptToken(payload: unknown): string {
  const key = loadKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return toBase64Url(Buffer.concat([iv, tag, ct]));
}

/** Дешифрует токен. Бросает при невалидной подписи или формате. */
export function decryptToken<T = unknown>(token: string): T {
  const key = loadKey();
  const buf = fromBase64Url(token);
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('Token too short');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}

/** Прогрев — лучше дёрнуть на старте, чтобы сразу упасть, если ключа нет. */
export function assertAdminerKeyConfigured(): void {
  loadKey();
}
