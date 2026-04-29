<?php
/**
 * Adminer-подкласс с поддержкой Meowbox SSO.
 *
 * ВНИМАНИЕ: этот файл должен подключаться ПОСЛЕ того, как `adminer.php` уже
 * объявил класс `Adminer` (то есть внутри `adminer_object()`, не на верхнем
 * уровне). Иначе PHP скажет "class Adminer not found".
 *
 * Логика входа без формы:
 *   - В loginForm() вместо стандартной формы рисуем СКРЫТУЮ форму с уже
 *     подставленными credentials и автоматическим submit'ом через JS.
 *   - Submit идёт POST'ом на тот же URL → Adminer вызывает credentials() и
 *     login() (наши, с проверкой совпадения с сессионной кукой) → ставит
 *     `adminer_sid_*` и редиректит на dashboard БД.
 *   - При F5 / повторных запросах adminer_sid_* живёт обычный adminer-сессион,
 *     наша кука нужна только для повторного автологина после истечения
 *     adminer-сессии или logout.
 *
 * Безопасность:
 *   - Пароль присутствует в HTML на доли секунды (между рендером и submit).
 *     Это компромисс. Альтернатива — server-side cURL — сильно сложнее.
 *   - login() жёстко сверяет переданные credentials с сохранёнными в куке.
 *     Это блокирует попытку POST'нуть форму с подменёнными username/password
 *     прямо в Adminer (cookie должна совпадать).
 *
 * @phpstan-ignore-next-line — class Adminer существует только после include adminer.php
 */
class MeowboxAdminer extends Adminer {
    /** @var array<string,mixed>|null */
    private $session;

    public function __construct(?array $session) {
        $this->session = $session;
    }

    /** Шапка: показываем имя БД (или сервиса) — чтобы понятно было, куда зашёл. */
    public function name() {
        if (($this->session['service'] ?? '') === 'manticore') {
            $site = htmlspecialchars((string)($this->session['site'] ?? '?'), ENT_QUOTES, 'UTF-8');
            return "Meowbox · Manticore [$site]";
        }
        $db = htmlspecialchars((string)($this->session['database'] ?? '?'), ENT_QUOTES, 'UTF-8');
        return "Meowbox · $db";
    }

    /** Adminer вызовет этот метод, чтобы достать creds для подключения к БД. */
    public function credentials() {
        if (!$this->session) {
            return [null, null, null];
        }
        $server = $this->session['host'];
        if (!empty($this->session['socket'])) {
            $server .= ':' . $this->session['socket'];
        } elseif (!empty($this->session['port'])) {
            $server .= ':' . (int)$this->session['port'];
        }
        return [$server, $this->session['user'], $this->session['pass']];
    }

    /** Авто-выбор БД на старте. Для Manticore БД нет — возвращаем null. */
    public function database() {
        $db = $this->session['database'] ?? null;
        if ($db === '' || $db === null) return null;
        return $db;
    }

    /** Список БД, доступных юзеру в Adminer'е — только своя. */
    public function databases($flush = true) {
        if (!$this->session) {
            return parent::databases($flush);
        }
        // Manticore: пусть Adminer сам спросит у демона (SHOW DATABASES вернёт
        // системные «Manticore» / пустой список — и пусть рендерит как есть).
        if (($this->session['service'] ?? '') === 'manticore') {
            return parent::databases($flush);
        }
        return [$this->session['database']];
    }

    /** Логин: кука обязана совпадать с тем, что пришло в POST'е. */
    public function login($login, $password) {
        if (!$this->session) {
            return 'Сессия Meowbox SSO отсутствует. Открой БД заново из панели.';
        }
        if ($login !== $this->session['user'] || $password !== $this->session['pass']) {
            return 'Credentials mismatch. Не пытайся подменить параметры — открой БД заново из панели.';
        }
        return true;
    }

    /**
     * Вместо стандартной формы — скрытая auto-submit форма.
     * Возвращаем false → Adminer не отрендерит свою стандартную форму ниже.
     */
    public function loginForm() {
        if (!$this->session) {
            $this->renderExpiredPage();
            return false;
        }

        $h = static fn($v) => htmlspecialchars((string)$v, ENT_QUOTES, 'UTF-8');
        $sess = $this->session;
        $server = $sess['host'];
        if (!empty($sess['socket'])) {
            $server .= ':' . $sess['socket'];
        } elseif (!empty($sess['port'])) {
            $server .= ':' . (int)$sess['port'];
        }

        // CSRF-токен Adminer'а: создаётся самим Adminer'ом в auth.inc.php перед
        // вызовом loginForm(). На свежей сессии $_SESSION["token"] уже есть.
        $token = (string)($_SESSION['token'] ?? '');

        echo '<div style="font-family:system-ui;color:#cbd5e1;background:#0a0a0f;padding:2rem;text-align:center">';
        echo '<p style="font-size:1.1em">⏳ Meowbox SSO авто-логин…</p>';
        echo '<p style="color:#64748b;font-size:0.85em">Если страница не обновится за пару секунд — включи JavaScript.</p>';
        echo '</div>';
        // ВАЖНО: Adminer уже обернул наш вывод в свой <form action='' method='post'>.
        // Свою <form> внутрь не вставляем — HTML5 запрещает nested form, браузер
        // молча выкинет внутреннюю и getElementById вернёт null.
        // Просто кладём hidden-инпуты — они принадлежат внешней Adminer-форме.
        echo '<div style="display:none">';
        echo '<input name="auth[driver]" value="' . $h($sess['driver']) . '">';
        echo '<input name="auth[server]" value="' . $h($server) . '">';
        echo '<input name="auth[username]" value="' . $h($sess['user']) . '">';
        echo '<input name="auth[password]" value="' . $h($sess['pass']) . '">';
        echo '<input name="auth[db]" value="' . $h($sess['database']) . '">';
        echo '<input name="auth[permanent]" value="1">';
        echo '<input name="token" value="' . $h($token) . '">';
        echo '</div>';
        // CSP в Adminer содержит nonce — без него inline-script будет заблокирован.
        $nonce = function_exists('get_nonce') ? get_nonce() : '';
        $nonceAttr = $nonce !== '' ? ' nonce="' . $h($nonce) . '"' : '';
        // Поднимаемся к ближайшему <form> (Adminer'овская внешняя) и сабмитим её.
        echo '<script' . $nonceAttr . '>(function(){var s=document.currentScript,p=s&&s.parentElement;while(p&&p.tagName!=="FORM")p=p.parentElement;if(p)p.submit();})();</script>';
        echo '<noscript><p style="margin:2rem;text-align:center">JavaScript отключён — нажми «Войти» вручную</p></noscript>';
        return false;
    }

    /** Кнопка «Назад в Meowbox» в боковой навигации. */
    public function navigation($missing) {
        parent::navigation($missing);
        if ($missing === 'auth') return;
        echo '<p style="margin-top:1rem;padding:0.5rem 0;border-top:1px solid #444">';
        echo '<a href="/" style="color:#60a5fa;text-decoration:none">← Назад в Meowbox</a>';
        echo ' · <a href="/adminer/sso.php?logout=1" style="color:#94a3b8;text-decoration:none">Выйти</a>';
        echo '</p>';
    }

    private function renderExpiredPage(): void {
        echo '<!doctype html><meta charset="utf-8"><title>Adminer · Meowbox</title>';
        echo '<body style="font-family:system-ui;background:#0a0a0f;color:#cbd5e1;margin:0">';
        echo '<div style="max-width:480px;margin:5rem auto;padding:2rem;background:#1a1a2e;border-radius:14px;border:1px solid #2a2a3a">';
        echo '<h2 style="color:#f87171;margin:0 0 0.5rem">Сессия Adminer истекла</h2>';
        echo '<p style="color:#94a3b8">Открой БД заново через Meowbox — там сгенерится новый одноразовый ticket.</p>';
        echo '<p style="margin-top:1.5rem"><a href="/" style="color:#60a5fa;background:linear-gradient(135deg,#fbbf24,#d97706);color:#0a0a0f;padding:0.5rem 1rem;border-radius:8px;text-decoration:none;font-weight:600">Открыть Meowbox</a></p>';
        echo '</div></body>';
    }
}
