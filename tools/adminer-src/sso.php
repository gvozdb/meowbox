<?php
/** Legacy query-ticket endpoint. Protocol v2 consumes handoffs through Nest. */

declare(strict_types=1);

require_once __DIR__ . '/lib/sso.php';

header('Cache-Control: no-store');
header('Pragma: no-cache');
header('Referrer-Policy: no-referrer');
header('Content-Security-Policy: default-src \'none\'; style-src \'unsafe-inline\'; frame-ancestors \'none\'; base-uri \'none\'');
header('X-Content-Type-Options: nosniff');
header('X-Robots-Tag: noindex,nofollow');

if (!empty($_GET['logout'])) {
    meowbox_clear_session_cookie();
    foreach ($_COOKIE as $name => $_) {
        if (str_starts_with($name, 'adminer_')) {
            setcookie($name, '', [
                'expires' => time() - 3600,
                'path' => '/adminer',
                'secure' => true,
                'httponly' => true,
                'samesite' => 'Lax',
            ]);
        }
    }
    header('Location: /', true, 302);
    exit;
}

http_response_code(410);
header('Content-Type: text/html; charset=utf-8');
echo '<!doctype html><meta charset="utf-8"><title>Adminer handoff expired</title>';
echo '<body style="font-family:system-ui;margin:3rem;color:#cbd5e1;background:#0a0a0f">';
echo '<h2 style="color:#f87171">Legacy Adminer ticket отключён</h2>';
echo '<p>Вернись в Meowbox и открой базу заново.</p></body>';
