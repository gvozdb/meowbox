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
 *   2. Файл `/opt/meowbox/.env` (fallback — парсим строку `ADMINER_SSO_KEY=...`).
 *
 * Куки: `meowbox_adminer_session`, HttpOnly, SameSite=Lax, Path=/adminer.
 * Secure ставится автоматически, если запрос пришёл по HTTPS.
 */

const MEOWBOX_COOKIE_NAME = 'meowbox_adminer_session';
const MEOWBOX_COOKIE_PATH = '/adminer';
const MEOWBOX_COOKIE_TTL = 1800; // 30 мин (sliding)

/** Считывает ADMINER_SSO_KEY из ENV или /opt/meowbox/.env. Возвращает 32-байтный raw-key. */
function meowbox_load_key(): string {
    $b64 = getenv('ADMINER_SSO_KEY');
    if (!$b64) {
        $envFile = '/opt/meowbox/.env';
        if (is_readable($envFile)) {
            $contents = file_get_contents($envFile);
            // Простой парсер: ищем строку KEY=VALUE, без поддержки многострочных значений
            // (нашему ключу это не нужно — он в одну строку).
            if (preg_match('/^\s*ADMINER_SSO_KEY\s*=\s*"?([A-Za-z0-9+\/=]+)"?\s*$/m', $contents, $m)) {
                $b64 = $m[1];
            }
        }
    }
    if (!$b64) {
        throw new RuntimeException('ADMINER_SSO_KEY is not configured');
    }
    $key = base64_decode($b64, true);
    if ($key === false || strlen($key) !== 32) {
        throw new RuntimeException('ADMINER_SSO_KEY must be valid base64 of 32 bytes');
    }
    return $key;
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

/** Расшифровывает токен. Бросает на любую невалидность. */
function meowbox_decrypt(string $token): array {
    $key = meowbox_load_key();
    $bin = meowbox_b64url_decode($token);
    if (strlen($bin) < 12 + 16 + 1) {
        throw new RuntimeException('Token too short');
    }
    $iv = substr($bin, 0, 12);
    $tag = substr($bin, 12, 16);
    $ct = substr($bin, 28);
    $plaintext = openssl_decrypt($ct, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
    if ($plaintext === false) {
        throw new RuntimeException('Decryption failed (bad key or tampered token)');
    }
    $obj = json_decode($plaintext, true);
    if (!is_array($obj)) {
        throw new RuntimeException('Token payload is not JSON object');
    }
    return $obj;
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
