<?php
/**
 * Meowbox Adminer SSO — общая библиотека для:
 *   - sso.php (обмен ticket → cookie)
 *   - index.php (загрузка credentials из cookie перед стартом Adminer)
 *
 * Криптография: AES-256-GCM, формат токена/куки = base64url(iv12 | tag16 | ct).
 * Полностью совместимо с Node-эквивалентом `api/src/common/crypto/adminer-cipher.ts`.
 *
 * Источники секретов:
 *   1. ENV `ADMINER_SSO_KEY` (передаётся через php-fpm pool env);
 *   2. Файл `state/.env` (`/opt/meowbox/state/.env`, парсим `ADMINER_SSO_KEY=...`).
 *
 * Куки: `meowbox_adminer_session`, HttpOnly, SameSite=Lax, Path=/adminer.
 * Secure ставится автоматически, если запрос пришёл по HTTPS.
 */

const MEOWBOX_COOKIE_NAME = 'meowbox_adminer_session';
const MEOWBOX_COOKIE_PATH = '/adminer';
const MEOWBOX_COOKIE_TTL = 1800; // 30 мин (sliding)

/**
 * Считывает ADMINER_SSO_KEY из ENV и /opt/meowbox/.env.
 * Возвращает массив 32-байтных raw-ключей (уникальных), чтобы decrypt мог
 * перебрать все доступные источники.
 *
 * Зачем массив, а не один ключ:
 *   - PHP-FPM pool хранит свой `env[ADMINER_SSO_KEY] = "..."`, .env — свой.
 *   - При апгрейде через master-key bootstrap эти два источника могут
 *     временно разъехаться (sync-pool-sso-key миграция не достучалась
 *     до старого pool без env[]-строки, php-fpm не успели перезапустить и т.д.).
 *   - Тикеты от API шифруются ОДНИМ из этих ключей — если попробуем оба,
 *     decrypt не упадёт молча с "tag mismatch".
 */
function meowbox_load_keys(): array {
    $candidates = [];
    $b64Env = getenv('ADMINER_SSO_KEY');
    if (is_string($b64Env) && $b64Env !== '') {
        $candidates[] = $b64Env;
    }
    // Читаем только state/.env (legacy /opt/meowbox/.env удалён в v0.6.x, не пытаемся
    // даже is_readable — open_basedir всё равно даст warning).
    $envFile = '/opt/meowbox/state/.env';
    if (@is_readable($envFile)) {
        $contents = @file_get_contents($envFile);
        if ($contents !== false
            && preg_match('/^\s*ADMINER_SSO_KEY\s*=\s*"?([A-Za-z0-9+\/=]+)"?\s*$/m', $contents, $m)) {
            $candidates[] = $m[1];
        }
    }
    $keys = [];
    $seen = [];
    foreach ($candidates as $b64) {
        $raw = base64_decode($b64, true);
        if ($raw === false || strlen($raw) !== 32) continue;
        $h = sha1($raw, true);
        if (isset($seen[$h])) continue;
        $seen[$h] = true;
        $keys[] = $raw;
    }
    if (!$keys) {
        throw new RuntimeException('ADMINER_SSO_KEY is not configured (нет ни в php-fpm pool env, ни в state/.env)');
    }
    return $keys;
}

/** Backwards-compat: первый валидный ключ (для encrypt). */
function meowbox_load_key(): string {
    $keys = meowbox_load_keys();
    return $keys[0];
}

/** Лог diagnostic'а в php error_log (попадает в /var/log/meowbox-adminer.error.log по pool conf). */
function meowbox_diag_log(string $msg): void {
    @error_log('[meowbox-sso] ' . $msg);
}

function meowbox_b64url_encode(string $bin): string {
    return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
}

function meowbox_b64url_decode(string $s): string {
    $padded = strtr($s, '-_', '+/');
    $pad = strlen($padded) % 4;
    if ($pad) $padded .= str_repeat('=', 4 - $pad);
    $raw = base64_decode($padded, true);
    if ($raw === false) {
        throw new RuntimeException('Invalid base64url');
    }
    return $raw;
}

/** Шифрует JSON-сериализуемое значение → base64url-токен. */
function meowbox_encrypt(array $payload): string {
    $key = meowbox_load_key();
    $iv = random_bytes(12);
    $tag = '';
    $plaintext = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    $ct = openssl_encrypt($plaintext, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag, '', 16);
    if ($ct === false) {
        throw new RuntimeException('Encryption failed');
    }
    return meowbox_b64url_encode($iv . $tag . $ct);
}

/**
 * Расшифровывает токен. Пробует ВСЕ доступные ключи (pool env + .env),
 * возвращает первый успешный decrypt. На fail логирует в error.log
 * диагностику (количество ключей, fingerprints — без раскрытия ключа).
 */
function meowbox_decrypt(string $token): array {
    $keys = meowbox_load_keys();
    $bin = meowbox_b64url_decode($token);
    if (strlen($bin) < 12 + 16 + 1) {
        throw new RuntimeException('Token too short');
    }
    $iv = substr($bin, 0, 12);
    $tag = substr($bin, 12, 16);
    $ct = substr($bin, 28);

    $tried = [];
    foreach ($keys as $key) {
        $plaintext = openssl_decrypt($ct, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
        if ($plaintext !== false) {
            $obj = json_decode($plaintext, true);
            if (!is_array($obj)) {
                throw new RuntimeException('Token payload is not JSON object');
            }
            return $obj;
        }
        $tried[] = substr(sha1($key), 0, 8);
    }
    // Все ключи мимо — пишем диагностику.
    meowbox_diag_log(sprintf(
        'decrypt fail: tried %d key(s) with fingerprints [%s]; token_len=%d. '
        . 'Проверь, что ADMINER_SSO_KEY в php-fpm pool совпадает с state/.env '
        . '(см. tools/adminer-diag.sh).',
        count($keys), implode(',', $tried), strlen($token),
    ));
    throw new RuntimeException('Decryption failed (bad key or tampered token)');
}

/** Ставит сессионную куку с зашифрованными credentials. TTL = MEOWBOX_COOKIE_TTL. */
function meowbox_set_session_cookie(array $creds): void {
    $now = time();
    $session = meowbox_encrypt([
        'v' => 1,
        'kind' => 'session',
        'driver' => $creds['driver'],
        'host' => $creds['host'],
        'port' => $creds['port'] ?? null,
        'socket' => $creds['socket'] ?? null,
        'user' => $creds['user'],
        'pass' => $creds['pass'],
        'database' => $creds['database'],
        'service' => $creds['service'] ?? null,
        'site' => $creds['site'] ?? null,
        'uid' => $creds['uid'] ?? null,
        'dbId' => $creds['dbId'] ?? null,
        'iat' => $now,
        'exp' => $now + MEOWBOX_COOKIE_TTL,
    ]);

    $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');

    setcookie(MEOWBOX_COOKIE_NAME, $session, [
        'expires' => $now + MEOWBOX_COOKIE_TTL,
        'path' => MEOWBOX_COOKIE_PATH,
        'domain' => '',
        'secure' => $secure,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

/** Удаляет сессионную куку. */
function meowbox_clear_session_cookie(): void {
    setcookie(MEOWBOX_COOKIE_NAME, '', [
        'expires' => time() - 3600,
        'path' => MEOWBOX_COOKIE_PATH,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

/**
 * Читает credentials из сессионной куки. Возвращает массив или null (нет/просрочка/ломаная).
 * Также продлевает TTL (sliding session) при успешном чтении, кроме случая, когда осталось
 * меньше 60 секунд — там продлевать смысла нет, юзер сейчас всё равно вылетит.
 */
function meowbox_read_session(): ?array {
    if (empty($_COOKIE[MEOWBOX_COOKIE_NAME])) return null;
    try {
        $obj = meowbox_decrypt($_COOKIE[MEOWBOX_COOKIE_NAME]);
    } catch (Throwable $e) {
        return null;
    }
    if (($obj['kind'] ?? '') !== 'session') return null;
    if (!isset($obj['exp']) || $obj['exp'] < time()) return null;

    // Sliding TTL: если осталось < половины TTL — пересохраняем куку.
    $remaining = $obj['exp'] - time();
    if ($remaining < MEOWBOX_COOKIE_TTL / 2) {
        meowbox_set_session_cookie($obj);
    }
    return $obj;
}
