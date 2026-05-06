<?php
/**
 * Точка входа SSO. Вызывается так:
 *   /adminer/sso.php?ticket=<base64url-encrypted>
 *
 * Логика:
 *   1. Расшифровать ticket (60-секундный одноразовый), убедиться что kind=sso и не expired.
 *   2. Поставить сессионную куку meowbox_adminer_session с теми же credentials (TTL 30 мин, sliding).
 *   3. 302 → /adminer/?<adminer-style query без пароля>.
 *      Adminer увидит server/username/db в query, наш плагин подставит пароль из куки.
 */

declare(strict_types=1);

require_once __DIR__ . '/lib/sso.php';

header('Cache-Control: no-store');
header('Pragma: no-cache');
header('X-Robots-Tag: noindex,nofollow');

function fail(int $code, string $msg): void {
    http_response_code($code);
    header('Content-Type: text/html; charset=utf-8');
    echo '<!doctype html><meta charset="utf-8"><title>Adminer SSO</title>';
    echo '<body style="font-family:system-ui;margin:3rem;color:#cbd5e1;background:#0a0a0f">';
    echo '<h2 style="color:#f87171">Adminer SSO ошибка</h2>';
    echo '<p>' . htmlspecialchars($msg, ENT_QUOTES, 'UTF-8') . '</p>';
    echo '<p style="color:#64748b;font-size:0.85em">Вернись в Meowbox и попробуй открыть БД заново.</p>';
    echo '</body>';
    exit;
}

// Logout: удаляем сессионную куку и возвращаемся в Meowbox.
if (!empty($_GET['logout'])) {
    meowbox_clear_session_cookie();
    // Adminer хранит свою сессию отдельно — её сбрасывать не наша
    // ответственность, но удалим cookie adminer_sid_*, чтобы при следующем
    // открытии Adminer не пытался залогиниться по своей сессии.
    foreach ($_COOKIE as $name => $_) {
        if (str_starts_with($name, 'adminer_')) {
            setcookie($name, '', ['expires' => time() - 3600, 'path' => '/adminer']);
        }
    }
    header('Location: /', true, 302);
    exit;
}

$ticket = $_GET['ticket'] ?? '';
if (!is_string($ticket) || $ticket === '' || strlen($ticket) > 4096) {
    fail(400, 'Не передан или невалидный ticket.');
}

try {
    $payload = meowbox_decrypt($ticket);
} catch (Throwable $e) {
    fail(403, 'Ticket невалиден или подпись не сошлась.');
}

if (($payload['kind'] ?? '') !== 'sso') {
    fail(403, 'Ticket не является SSO-токеном.');
}
if (!isset($payload['exp']) || $payload['exp'] < time()) {
    fail(403, 'Ticket просрочен. Получи новый из панели.');
}

// `socket` — альтернатива `port` для unix-socket подключений (Manticore, локальный
// MySQL без TCP). Если передан socket, port игнорируется и в server-строку идёт
// host:socket — Adminer-овский MySQL-драйвер парсит non-numeric хвост как
// `socket` параметр для mysqli_real_connect (см. adminer.php Min_DB::connect).
$required = ['driver', 'host', 'user', 'pass', 'database'];
foreach ($required as $k) {
    if (!isset($payload[$k])) {
        fail(400, "В ticket отсутствует поле $k.");
    }
}
if (empty($payload['port']) && empty($payload['socket'])) {
    fail(400, 'В ticket отсутствует port или socket.');
}

// Ставим session cookie на /adminer
meowbox_set_session_cookie($payload);

// Adminer-совместимая query-строка (без пароля!).
// driver=server (для MySQL/MariaDB) или pgsql, server=host:port|socket, username=user, db=database
$server = $payload['host'];
if (!empty($payload['socket'])) {
    $server .= ':' . $payload['socket'];
} elseif (!empty($payload['port'])) {
    $server .= ':' . (int)$payload['port'];
}
$qs = http_build_query([
    'meowbox' => '1',
    $payload['driver'] => '',  // Adminer ожидает либо ?server, либо ?pgsql=...
    'server' => $server,
    'username' => $payload['user'],
    'db' => $payload['database'],
]);

// Adminer cookie `adminer_key` для CSRF — если её ещё нет, выставим заранее,
// чтобы Adminer не сорил «Session expired» на первой странице.
if (empty($_COOKIE['adminer_key'])) {
    $key = bin2hex(random_bytes(16));
    setcookie('adminer_key', $key, [
        'expires' => 0, // session cookie
        'path' => '/adminer',
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

header('Location: /adminer/?' . $qs, true, 302);
echo 'OK';
