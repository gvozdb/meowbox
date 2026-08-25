import * as crypto from 'crypto';
import * as fs from 'fs';

/**
 * AES-256-GCM шифратор для Adminer SSO-токенов и сессионных кук.
 *
 * Используется для двустороннего обмена с PHP-кодом Adminer (`tools/adminer/`).
 * Формат: base64url(iv12 | tag16 | ciphertext), без padding — безопасен в URL и Cookie.
 *
 * Загрузка ключа (приоритет):
 *   1. Файл `state/.env` (путь = `process.env.DOTENV_PATH` либо `/opt/meowbox/state/.env`).
 *      Перечитывается ПРИ КАЖДОМ обращении, если изменилось mtime файла — это
 *      гарантирует, что после bootstrap-миграции (которая может перегенерировать
 *      ADMINER_SSO_KEY в state/.env) API сразу начнёт шифровать новым ключом,
 *      без перезапуска процесса.
 *   2. Fallback: `process.env.ADMINER_SSO_KEY` — на случай если файла нет
 *      (dev-окружение, нестандартный путь).
 *
 * Почему не process.env: PM2 кэширует env в памяти в момент `pm2 start`,
 * `pm2 restart --update-env` подхватывает только из cached config, а не из
 * актуального state/.env на диске. Любой рассинхрон ключа → SSO молча падает.
 *
 * PHP-side совместимость:
 *   PHP читает тот же ключ из `state/.env`, использует
 *   `openssl_encrypt/openssl_decrypt('aes-256-gcm', ..., $tag, '', 16)` —
 *   с тем же расположением iv|tag|ct. См. `tools/adminer-src/lib/sso.php`.
 */

const ENV_VAR = 'ADMINER_SSO_KEY';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const V2_PREFIX = 'v2';
const SESSION_AUDIENCE = 'adminer';

const DEFAULT_ENV_PATH = '/opt/meowbox/state/.env';
const KEY_LINE_RE = /^\s*ADMINER_SSO_KEY\s*=\s*"?([A-Za-z0-9+/=]+)"?\s*$/m;

type KeyCache = {
  key: Buffer;
  source: 'file' | 'env';
  mtimeMs: number;
};

let cache: KeyCache | null = null;

function envFilePath(): string {
  return process.env.DOTENV_PATH || DEFAULT_ENV_PATH;
}

function parseKey(b64: string): Buffer {
  const buf = Buffer.from(b64.trim(), 'base64');
  if (buf.length !== KEY_LEN) {
    throw new Error(`${ENV_VAR} must decode to exactly ${KEY_LEN} bytes (got ${buf.length})`);
  }
  return buf;
}

function readKeyFromFile(path: string): { key: Buffer; mtimeMs: number } | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(path);
  } catch {
    return null;
  }
  let contents: string;
  try {
    contents = fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const m = KEY_LINE_RE.exec(contents);
  if (!m) return null;
  return { key: parseKey(m[1]), mtimeMs: stat.mtimeMs };
}

function loadKey(): Buffer {
  const path = envFilePath();

  // 1. Сначала проверяем файл (источник правды).
  try {
    const stat = fs.statSync(path);
    if (cache && cache.source === 'file' && cache.mtimeMs === stat.mtimeMs) {
      return cache.key;
    }
    const fromFile = readKeyFromFile(path);
    if (fromFile) {
      cache = { key: fromFile.key, source: 'file', mtimeMs: fromFile.mtimeMs };
      return cache.key;
    }
  } catch {
    // Файла нет — падаем в env fallback.
  }

  // 2. Fallback: process.env (dev / нестандартный путь).
  if (cache && cache.source === 'env') return cache.key;
  const raw = process.env[ENV_VAR];
  if (!raw || !raw.trim()) {
    throw new Error(
      `${ENV_VAR} is not set. Add it to state/.env (32 bytes, base64). ` +
        `Generate via: openssl rand -base64 32`,
    );
  }
  const key = parseKey(raw);
  cache = { key, source: 'env', mtimeMs: 0 };
  return key;
}

function toBase64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function fromStrictBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url');
  const decoded = fromBase64Url(value);
  if (toBase64Url(decoded) !== value) throw new Error('Non-canonical base64url');
  return decoded;
}

function encryptV2(payload: unknown, aad: string, maxPlaintextBytes: number): string {
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  if (plaintext.length === 0 || plaintext.length > maxPlaintextBytes) {
    throw new Error(`Adminer payload must be 1..${maxPlaintextBytes} bytes`);
  }
  const key = loadKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return toBase64Url(Buffer.concat([iv, tag, ct]));
}

function decryptV2<T>(token: string, aad: string, maxPlaintextBytes: number): T {
  const key = loadKey();
  const buf = fromStrictBase64Url(token);
  if (buf.length < IV_LEN + TAG_LEN + 1 || buf.length > IV_LEN + TAG_LEN + maxPlaintextBytes) {
    throw new Error('Adminer payload has invalid length');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  if (plaintext.length === 0 || plaintext.length > maxPlaintextBytes) {
    throw new Error('Adminer plaintext has invalid length');
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as T;
}

export function adminerHandoffAad(input: {
  targetInstallationId: string;
  handoffId: string;
  resourceKind: string;
  resourceId: string;
}): string {
  return [
    'MEOWBOX-ADMINER-HANDOFF-V2',
    input.targetInstallationId,
    input.handoffId,
    input.resourceKind,
    input.resourceId,
  ].join('\n');
}

export function encryptAdminerHandoffPayload(
  payload: unknown,
  aad: string,
): string {
  return `${V2_PREFIX}.${encryptV2(payload, aad, 2048)}`;
}

export function decryptAdminerHandoffPayload<T>(
  token: string,
  aad: string,
): T {
  const [version, ciphertext, ...extra] = token.split('.');
  if (version !== V2_PREFIX || !ciphertext || extra.length > 0) {
    throw new Error('Adminer handoff payload version is invalid');
  }
  return decryptV2<T>(ciphertext, aad, 2048);
}

export function adminerSessionAad(targetInstallationId: string): string {
  return [
    'MEOWBOX-ADMINER-SESSION-V2',
    targetInstallationId,
    SESSION_AUDIENCE,
  ].join('\n');
}

export function encryptAdminerSessionCookie(
  payload: unknown,
  targetInstallationId: string,
): string {
  return [
    V2_PREFIX,
    targetInstallationId,
    encryptV2(payload, adminerSessionAad(targetInstallationId), 2048),
  ].join('.');
}

/** Test/diagnostic counterpart for the PHP v2 cookie consumer. */
export function decryptAdminerSessionCookie<T>(token: string): T {
  const [version, targetInstallationId, ciphertext, ...extra] = token.split('.');
  if (
    version !== V2_PREFIX ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetInstallationId || '') ||
    !ciphertext ||
    extra.length > 0
  ) {
    throw new Error('Adminer session cookie format is invalid');
  }
  return decryptV2<T>(ciphertext, adminerSessionAad(targetInstallationId), 2048);
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

/** Для диагностики: fingerprint (первые 8 hex от sha1) текущего ключа + источник. */
export function adminerKeyFingerprint(): { fingerprint: string; source: 'file' | 'env' } {
  const key = loadKey();
  const fp = crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
  return { fingerprint: fp, source: cache?.source ?? 'env' };
}
