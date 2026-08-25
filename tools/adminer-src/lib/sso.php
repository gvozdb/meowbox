<?php
/** Meowbox Adminer v2 fixed-lifetime session cookie consumer. */

declare(strict_types=1);

const MEOWBOX_COOKIE_NAME = '__Secure-meowbox_adminer_session';
const MEOWBOX_COOKIE_PATH = '/adminer';
const MEOWBOX_COOKIE_MAX_BYTES = 3800;
const MEOWBOX_SESSION_MAX_MS = 900000;

function meowbox_load_keys(): array {
    $candidates = [];
    $fromPool = getenv('ADMINER_SSO_KEY');
    if (is_string($fromPool) && $fromPool !== '') $candidates[] = $fromPool;
    $envFile = '/opt/meowbox/state/.env';
    if (@is_readable($envFile)) {
        $contents = @file_get_contents($envFile);
        if ($contents !== false
            && preg_match('/^\s*ADMINER_SSO_KEY\s*=\s*"?([A-Za-z0-9+\/=]+)"?\s*$/m', $contents, $match)) {
            $candidates[] = $match[1];
        }
    }
    $keys = [];
    $seen = [];
    foreach ($candidates as $encoded) {
        $raw = base64_decode($encoded, true);
        if ($raw === false || strlen($raw) !== 32) continue;
        $fingerprint = hash('sha256', $raw);
        if (isset($seen[$fingerprint])) continue;
        $seen[$fingerprint] = true;
        $keys[] = $raw;
    }
    if (!$keys) throw new RuntimeException('ADMINER_SSO_KEY is not configured');
    return $keys;
}

function meowbox_diag_log(string $message): void {
    @error_log('[meowbox-adminer] ' . $message);
}

function meowbox_b64url_decode(string $value): string {
    if ($value === '' || !preg_match('/^[A-Za-z0-9_-]+$/D', $value)) {
        throw new RuntimeException('Invalid base64url');
    }
    $encoded = strtr($value, '-_', '+/');
    $remainder = strlen($encoded) % 4;
    if ($remainder) $encoded .= str_repeat('=', 4 - $remainder);
    $decoded = base64_decode($encoded, true);
    if ($decoded === false) throw new RuntimeException('Invalid base64url');
    $canonical = rtrim(strtr(base64_encode($decoded), '+/', '-_'), '=');
    if (!hash_equals($canonical, $value)) throw new RuntimeException('Non-canonical base64url');
    return $decoded;
}

function meowbox_session_aad(string $targetInstallationId): string {
    return "MEOWBOX-ADMINER-SESSION-V2\n{$targetInstallationId}\nadminer";
}

function meowbox_decrypt_session(string $token): array {
    if (strlen($token) > MEOWBOX_COOKIE_MAX_BYTES) {
        throw new RuntimeException('Session cookie is too large');
    }
    $parts = explode('.', $token);
    if (count($parts) !== 3 || $parts[0] !== 'v2') {
        throw new RuntimeException('Session cookie version is invalid');
    }
    $target = $parts[1];
    if (!preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/Di', $target)) {
        throw new RuntimeException('Session target is invalid');
    }
    $binary = meowbox_b64url_decode($parts[2]);
    if (strlen($binary) < 29 || strlen($binary) > 2076) {
        throw new RuntimeException('Session ciphertext length is invalid');
    }
    $iv = substr($binary, 0, 12);
    $tag = substr($binary, 12, 16);
    $ciphertext = substr($binary, 28);
    $aad = meowbox_session_aad($target);
    $fingerprints = [];
    foreach (meowbox_load_keys() as $key) {
        $plaintext = openssl_decrypt(
            $ciphertext,
            'aes-256-gcm',
            $key,
            OPENSSL_RAW_DATA,
            $iv,
            $tag,
            $aad,
        );
        if ($plaintext !== false) {
            if (strlen($plaintext) < 1 || strlen($plaintext) > 2048) {
                throw new RuntimeException('Session plaintext length is invalid');
            }
            $payload = json_decode($plaintext, true, 32, JSON_THROW_ON_ERROR);
            if (!is_array($payload)) throw new RuntimeException('Session payload is invalid');
            meowbox_validate_session($payload, $target);
            return $payload;
        }
        $fingerprints[] = substr(hash('sha256', $key), 0, 8);
    }
    meowbox_diag_log('session decrypt failed; key_fingerprints=' . implode(',', $fingerprints));
    throw new RuntimeException('Session authentication failed');
}

function meowbox_validate_session(array $payload, string $target): void {
    $now = (int)floor(microtime(true) * 1000);
    $issuedAt = $payload['issuedAt'] ?? null;
    $expiresAt = $payload['expiresAt'] ?? null;
    if (($payload['v'] ?? null) !== 2
        || ($payload['kind'] ?? null) !== 'session'
        || ($payload['audience'] ?? null) !== 'adminer'
        || ($payload['targetInstallationId'] ?? null) !== $target
        || !in_array($payload['purpose'] ?? null, ['ADMINER', 'MANTICORE'], true)
        || !is_string($payload['resourceKind'] ?? null)
        || !preg_match('/^[A-Z][A-Z0-9_]{1,63}$/D', $payload['resourceKind'])
        || !is_string($payload['resourceId'] ?? null)
        || !preg_match('/^[A-Za-z0-9._:-]{1,256}$/D', $payload['resourceId'])
        || !is_int($issuedAt)
        || !is_int($expiresAt)
        || $issuedAt > $now + 30000
        || $expiresAt <= $now
        || $expiresAt - $issuedAt > MEOWBOX_SESSION_MAX_MS
        || !in_array($payload['driver'] ?? null, ['server', 'pgsql'], true)
        || !is_string($payload['host'] ?? null)
        || strlen($payload['host']) < 1
        || strlen($payload['host']) > 255
        || !is_string($payload['user'] ?? null)
        || strlen($payload['user']) > 256
        || !is_string($payload['pass'] ?? null)
        || strlen($payload['pass']) > 1024
        || !is_string($payload['database'] ?? null)
        || strlen($payload['database']) > 256) {
        throw new RuntimeException('Session payload validation failed');
    }
    $port = $payload['port'] ?? null;
    $socket = $payload['socket'] ?? null;
    $hasPort = is_int($port) && $port >= 1 && $port <= 65535;
    $hasSocket = is_string($socket) && strlen($socket) >= 1 && strlen($socket) <= 512;
    if ($hasPort === $hasSocket) throw new RuntimeException('Session endpoint is invalid');
}

function meowbox_clear_session_cookie(): void {
    setcookie(MEOWBOX_COOKIE_NAME, '', [
        'expires' => time() - 3600,
        'path' => MEOWBOX_COOKIE_PATH,
        'domain' => '',
        'secure' => true,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

/** No renewal: absolute expiry from the Node-issued v2 payload is binding. */
function meowbox_read_session(): ?array {
    $token = $_COOKIE[MEOWBOX_COOKIE_NAME] ?? null;
    if (!is_string($token) || $token === '') return null;
    try {
        return meowbox_decrypt_session($token);
    } catch (Throwable $error) {
        meowbox_diag_log('session rejected: ' . get_class($error));
        meowbox_clear_session_cookie();
        return null;
    }
}
