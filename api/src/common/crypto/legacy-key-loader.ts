import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Загрузчик legacy-ключей (до унификации в master-key).
 *
 * Используется cipher'ами для **transparent decrypt fallback**: если шифротекст
 * был сделан старым ключом, мы можем его расшифровать пока миграция
 * `2026-05-10-002-rekey-secrets` не перешифрует все blob'ы в БД.
 *
 * Encrypt всегда идёт через новый master-key (см. master-key.ts).
 */

const KEY_LEN = 32;

/**
 * Возвращает ВСЕ возможные директории, где могут лежать legacy-ключи.
 * Порядок: state/data (release-раскладка), MEOWBOX_DATA_DIR override, legacy
 * `/opt/meowbox/data`, далее fallback дефолты. Старые установки имеют
 * `.vpn-key`/`.dns-key` в `/opt/meowbox/data/`, новые — в `state/data/`.
 */
function resolveLegacyDirs(): string[] {
  const dirs: string[] = [];
  const stateDir = process.env.MEOWBOX_STATE_DIR?.trim();
  if (stateDir) dirs.push(path.join(stateDir, 'data'));
  const dataDir = process.env.MEOWBOX_DATA_DIR?.trim();
  if (dataDir && !dirs.includes(dataDir)) dirs.push(dataDir);
  // Hardcoded fallbacks
  for (const candidate of ['/opt/meowbox/state/data', '/opt/meowbox/data']) {
    if (!dirs.includes(candidate)) dirs.push(candidate);
  }
  return dirs;
}

function tryReadFile(filePath: string): Buffer | null {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length !== KEY_LEN) return null;
    return buf;
  } catch {
    return null;
  }
}

function tryReadEnv(envVar: string): Buffer | null {
  const raw = process.env[envVar]?.trim();
  if (!raw) return null;
  try {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== KEY_LEN) return null;
    return buf;
  } catch {
    return null;
  }
}

interface LegacyKeySource {
  envVar?: string;
  files: string[];
}

const SOURCES: Record<string, LegacyKeySource> = {
  vpn: { envVar: 'VPN_SECRET_KEY', files: ['.vpn-key'] },
  dns: { envVar: 'DNS_CREDENTIAL_KEY', files: ['.dns-key'] },
  // database старая схема — тот же ключ что у DNS (credentials-cipher одной шифрашкой)
  databases: { envVar: 'DNS_CREDENTIAL_KEY', files: ['.dns-key'] },
  migration: { envVar: 'MIGRATION_SECRET', files: [] },
  'adminer-sso': { envVar: 'ADMINER_SSO_KEY', files: [] },
};

const cached: Map<string, Buffer | null> = new Map();

/**
 * Возвращает legacy-ключ для домена, или null если не найден.
 * Также проверяет legacy.<ts> файлы — на случай если миграция переименовала
 * `.vpn-key` → `.vpn-key.legacy.<ts>`.
 */
export function loadLegacyKey(domain: keyof typeof SOURCES): Buffer | null {
  if (cached.has(domain)) return cached.get(domain) ?? null;

  const src = SOURCES[domain];
  if (!src) {
    cached.set(domain, null);
    return null;
  }

  // 1) env
  if (src.envVar) {
    const fromEnv = tryReadEnv(src.envVar);
    if (fromEnv) {
      cached.set(domain, fromEnv);
      return fromEnv;
    }
  }

  // 2) файлы (текущие + legacy.*) во всех возможных директориях
  const dirs = resolveLegacyDirs();
  for (const dir of dirs) {
    for (const f of src.files) {
      const full = path.join(dir, f);
      const direct = tryReadFile(full);
      if (direct) {
        cached.set(domain, direct);
        return direct;
      }
      // legacy.<ts> файлы (после миграции переименованы)
      try {
        for (const entry of fs.readdirSync(dir)) {
          if (entry.startsWith(`${f}.legacy.`)) {
            const key = tryReadFile(path.join(dir, entry));
            if (key) {
              cached.set(domain, key);
              return key;
            }
          }
        }
      } catch {
        /* dir не существует — игнорим */
      }
    }
  }

  cached.set(domain, null);
  return null;
}

/**
 * Расшифровка AES-256-GCM legacy-blob'а указанным ключом.
 * Возвращает распарсенный JSON-объект.
 *
 * Бросает на любой ошибке (включая GCM tag mismatch — значит, blob не от этого
 * ключа, пробуй другой).
 */
export function decryptWithLegacyKey<T = unknown>(
  key: Buffer,
  encoded: string,
): T {
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

/** Утилита для тестов и rekey-миграции — сброс кеша. */
export function _resetLegacyKeyCacheForTests(): void {
  cached.clear();
}
