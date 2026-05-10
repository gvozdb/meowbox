import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Единый master-key для всех шифраторов панели.
 *
 * См. docs/specs/2026-05-10-master-key-unification.md
 *
 * Источник master-key (порядок):
 *   1. ENV `MEOWBOX_MASTER_KEY` — 32 байта в base64 (override для secret-managers).
 *   2. Файл `${STATE_DIR}/data/.master-key` — 32 байта бинарных, perms 600.
 *   3. Автогенерация при первом обращении (если не запрещено
 *      `MEOWBOX_NO_AUTOGEN_MASTER_KEY=1`).
 *
 * STATE_DIR (по приоритету):
 *   - ENV `MEOWBOX_STATE_DIR` (release-режим: `/opt/meowbox/state`)
 *   - ENV `MEOWBOX_DATA_DIR` (legacy: `/opt/meowbox/data`) → файл будет
 *     `${MEOWBOX_DATA_DIR}/.master-key`
 *   - Дефолт `/opt/meowbox/state`
 *
 * HKDF-SHA256 domain separation:
 *   - `meowbox:vpn:v1`         — VPN configBlob/credsBlob (vpn-cipher)
 *   - `meowbox:dns:v1`         — DNS provider credentials (dns-cipher)
 *   - `meowbox:databases:v1`   — User DB passwords (database-cipher)
 *   - `meowbox:migration:v1`   — Hostpanel source creds (migration-cipher)
 *   - `meowbox:adminer-sso:v1` — Adminer SSO tickets (adminer-cipher; derived
 *                                ключ записывается в .env при bootstrap'е,
 *                                чтобы PHP-плагин читал готовое значение)
 *   - `meowbox:ssh:v1`         — Site.sshPasswordEnc (ssh-cipher)
 *   - `meowbox:cms:v1`         — Site.cmsAdminPasswordEnc (cms-cipher)
 *
 * При смене master-key все шифротексты неотменяемо теряются.
 * Бэкапить файл `.master-key` ВМЕСТЕ С БД.
 */

const ENV_VAR = 'MEOWBOX_MASTER_KEY';
const NO_AUTOGEN_ENV = 'MEOWBOX_NO_AUTOGEN_MASTER_KEY';
const KEY_FILENAME = '.master-key';
const KEY_LEN = 32; // AES-256

export type KeyDomain =
  | 'vpn'
  | 'dns'
  | 'databases'
  | 'migration'
  | 'adminer-sso'
  | 'ssh'
  | 'cms';

let cachedMaster: Buffer | null = null;
const cachedDerived: Map<string, Buffer> = new Map();

function resolveKeyFilePath(): string {
  // STATE_DIR в release-раскладке имеет priority
  const stateDir = process.env.MEOWBOX_STATE_DIR?.trim();
  if (stateDir) return path.join(stateDir, 'data', KEY_FILENAME);

  // Legacy: MEOWBOX_DATA_DIR (см. vpn-cipher / credentials-cipher)
  const dataDir = process.env.MEOWBOX_DATA_DIR?.trim();
  if (dataDir) return path.join(dataDir, KEY_FILENAME);

  // Дефолт — state-раскладка
  return '/opt/meowbox/state/data/' + KEY_FILENAME;
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
    throw new Error(
      `${ENV_VAR} must decode to exactly ${KEY_LEN} bytes (got ${buf.length})`,
    );
  }
  return buf;
}

function readFromFile(filePath: string): Buffer | null {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length !== KEY_LEN) {
      throw new Error(
        `Master-key file ${filePath} has ${buf.length} bytes, expected ${KEY_LEN}. ` +
          `Восстанови валидный ключ из бэкапа или удали файл (всё зашифрованное в БД станет нечитаемо).`,
      );
    }
    return buf;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function generateAndPersist(filePath: string): Buffer {
  if (process.env[NO_AUTOGEN_ENV]?.trim() === '1') {
    throw new Error(
      `${NO_AUTOGEN_ENV}=1 запрещает автогенерацию master-key, ` +
        `но файла ${filePath} нет и ${ENV_VAR} не задан. ` +
        `Запусти миграцию 2026-05-10-001-master-key-bootstrap или восстанови ключ из бэкапа.`,
    );
  }
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.randomBytes(KEY_LEN);
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, key, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* umask может перебить mode — игнорим */
  }
  fs.renameSync(tmp, filePath);
  // eslint-disable-next-line no-console
  console.warn(
    `[master-key] Generated new master key at ${filePath}. ` +
      `БЭКАПЬ ЭТОТ ФАЙЛ. Без него все секреты в БД (SSH-пароли, БД-пароли, ` +
      `VPN-конфиги, DNS-креды) станут невосстановимыми.`,
  );
  return key;
}

/** Загружает master-key (с кешированием). Бросает на инвалидном состоянии. */
export function loadMasterKey(): Buffer {
  if (cachedMaster) return cachedMaster;

  const fromEnv = readFromEnv();
  if (fromEnv) {
    cachedMaster = fromEnv;
    return fromEnv;
  }

  const filePath = resolveKeyFilePath();
  const fromFile = readFromFile(filePath);
  if (fromFile) {
    cachedMaster = fromFile;
    return fromFile;
  }

  const generated = generateAndPersist(filePath);
  cachedMaster = generated;
  return generated;
}

/**
 * Деривация домен-специфичного 32-байтного ключа через HKDF-SHA256.
 * Кешируется — повторные вызовы дешёвые.
 */
export function deriveKey(domain: KeyDomain): Buffer {
  const cacheKey = `v1:${domain}`;
  const hit = cachedDerived.get(cacheKey);
  if (hit) return hit;

  const master = loadMasterKey();
  const info = Buffer.from(`meowbox:${domain}:v1`, 'utf8');
  // hkdfSync(digest, ikm, salt, info, length) → ArrayBuffer
  const ab = crypto.hkdfSync('sha256', master, Buffer.alloc(0), info, KEY_LEN);
  const buf = Buffer.from(ab);
  cachedDerived.set(cacheKey, buf);
  return buf;
}

/** Прогрев — для onModuleInit. Поднимет ошибку если что-то не так. */
export function assertMasterKeyConfigured(): void {
  loadMasterKey();
}

/** Утилита для тестов и миграций — сброс кеша. НЕ для рантайма. */
export function _resetMasterKeyCacheForTests(): void {
  cachedMaster = null;
  cachedDerived.clear();
}

/**
 * AES-256-GCM шифрование произвольного объекта через derived key.
 * Формат шифротекста (base64): iv(12) | tag(16) | ciphertext.
 *
 * Универсальная реализация — используется ssh/cms/dns/database/migration/vpn
 * cipher'ами через тонкие обёртки.
 */
export function encryptWithDomain(domain: KeyDomain, obj: unknown): string {
  const key = deriveKey(domain);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptWithDomain<T = unknown>(
  domain: KeyDomain,
  encoded: string,
): T {
  const key = deriveKey(domain);
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < 12 + 16 + 1) {
    throw new Error('Encrypted payload too short');
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 12 + 16);
  const ciphertext = buf.subarray(12 + 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}
