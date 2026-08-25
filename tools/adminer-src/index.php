<?php
/**
 * Bootstrap для встроенного в Meowbox Adminer.
 *
 * Поток:
 *   1. Подключаем helpers (sso.php) — крипто + cookie helpers.
 *   2. Читаем сессионную куку → $session (или null).
 *   3. Безопасные хедеры.
 *   4. Определяем adminer_object() — её Adminer вызовет дважды:
 *      первый раз ДО объявления класса Adminer (мы возвращаем заглушку),
 *      второй раз ПОСЛЕ — там подгружаем наш `MeowboxAdminer extends Adminer`.
 *   5. require adminer.php — стандартный standalone-бинарь Adminer.
 */

declare(strict_types=1);

require_once __DIR__ . '/lib/sso.php';

header('X-Frame-Options: SAMEORIGIN');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header('X-Robots-Tag: noindex,nofollow');
header('Cache-Control: no-store');
header('Pragma: no-cache');

// Если нет ни сессии, ни POST-логина — Adminer покажет «Сессия истекла».
$session = meowbox_read_session();

if ($session === null) {
    $nonce = rtrim(strtr(base64_encode(random_bytes(18)), '+/', '-_'), '=');
    header(
        "Content-Security-Policy: default-src 'none'; script-src 'nonce-{$nonce}'; "
        . "connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; "
        . "base-uri 'none'; form-action 'self'",
    );
    $nonceHtml = htmlspecialchars($nonce, ENT_QUOTES, 'UTF-8');
    echo '<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer">';
    echo '<title>Adminer · Meowbox</title>';
    echo '<body style="font-family:system-ui;background:#0a0a0f;color:#cbd5e1;margin:0">';
    echo '<main style="max-width:520px;margin:5rem auto;padding:2rem;background:#1a1a2e;border-radius:14px;border:1px solid #2a2a3a">';
    echo '<h2 style="margin:0 0 .75rem">Adminer</h2><p id="status" style="color:#94a3b8">Проверяю одноразовый handoff…</p>';
    echo '</main>';
    echo '<script nonce="' . $nonceHtml . '">(async function(){';
    echo 'const status=document.getElementById("status");';
    echo 'const match=/^#handoff=([0-9a-f-]{36})\\.([A-Za-z0-9_-]{43})$/i.exec(location.hash);';
    echo 'history.replaceState(null,"",location.pathname+location.search);';
    echo 'if(!match){status.textContent="Сессия отсутствует или истекла. Открой базу заново из Meowbox.";return;}';
    echo 'try{const response=await fetch("/api/public/v1/adminer/handoffs/"+encodeURIComponent(match[1])+"/consume",{method:"POST",credentials:"same-origin",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify({secret:match[2]})});';
    echo 'if(!response.ok)throw new Error("handoff rejected");location.replace("/adminer/");}';
    echo 'catch(_){status.textContent="Handoff недействителен или уже использован. Вернись в Meowbox и попробуй снова.";}})();</script>';
    echo '</body>';
    exit;
}

function adminer_object() {
    global $session;
    // На первом вызове (до подключения adminer.php) класса Adminer ещё нет —
    // возвращаем минимальный stub, который Adminer пере-вызовет уже после
    // объявления своего родительского класса.
    if (!class_exists('Adminer', false)) {
        return new stdClass();
    }
    require_once __DIR__ . '/lib/meowbox-plugin.php';
    return new MeowboxAdminer($session);
}

// Сам Adminer.
require __DIR__ . '/adminer.php';
