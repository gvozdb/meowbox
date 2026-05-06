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
header('Referrer-Policy: strict-origin-when-cross-origin');
header('X-Robots-Tag: noindex,nofollow');

// Если нет ни сессии, ни POST-логина — Adminer покажет «Сессия истекла».
$session = meowbox_read_session();

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
