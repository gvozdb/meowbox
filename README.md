# 🐾 Meowbox

Лёгкая панель управления Linux-сервером: nginx, php-fpm, базы, бэкапы, SSL, мониторинг — без лишнего жира. В первую очередь заточена под **MODX 3** и **MODX Revolution**, но умеет и обычные сайты на любом PHP-стеке.

---

## ⚡ Установка одной командой

```bash
curl -fsSL https://raw.githubusercontent.com/gvozdb/meowbox/main/bootstrap.sh \
  | sudo PANEL_PORT=18443 bash
```

После установки панель будет на `https://<ваш-сервер>:18443`.

> **Поддерживается только Ubuntu 22.04+**. На Debian/CentOS/RHEL/Rocky/AlmaLinux установщик откажется ставиться. Это сознательное ограничение: пакетная база (`ondrej/php` PPA, нейминг `php-fpm`-юнитов, размещение nginx-конфигов) синхронизирована именно с Ubuntu, и тратить силы на «универсальность» в ущерб надёжности — не вариант.

---

## 🧩 Стек

- **API** — NestJS + Prisma + **SQLite** (один файл, без PostgreSQL/Redis)
- **Web** — Nuxt 3 + Pinia
- **Agent** — Node.js + Socket.io (выполняет команды на хосте)
- **Proxy** — nginx (один порт наружу, по умолчанию `11862`)
- **Process manager** — PM2

API слушает только loopback. Всё, что наружу — идёт через nginx с TLS и rate-limit-зонами per-site.

---

## 📦 Поддержка CMS

- **MODX 3** — основной таргет. Скаффолд (распаковка, БД, `core/config`), MODX Doctor (диагностика и автофикс типовых проблем: права, кеш, setup, пути), вход в админку MODX одной кнопкой через SSO-ticket (без ввода пароля).
- **MODX Revolution (Revo)** — для legacy-проектов. Тот же тулинг: scaffold, Doctor, SSO. Учитывает кастомные имена директорий (`config.core.php` находит и обновляет даже если папки переименованы).
- **Custom** — пустой шаблон. Любая CMS / любой PHP-проект: панель просто даёт сайт + nginx + PHP-FPM + БД + SSL, остальное на твоей совести.

---

## 🔐 Безопасность из коробки

- **Per-site Linux-пользователь**: каждый сайт изолирован собственным юзером (SSH/SFTP, PHP-FPM-пул, файлы 750/640). www-data добавлен в группу сайта только на чтение.
- **2FA (TOTP)** + **Basic Auth** перед формой логина (опционально) + **IP allowlist** (whitelist по IP/CIDR на уровне приложения, защищает в т.ч. `/auth/login` и `/auth/refresh`).
- **CommandExecutor allowlist** + `execFile` без `sh -c` — никаких shell-инъекций в системных вызовах.
- Constant-time password compare, HMAC-подпись для slave-вебхуков.

---

## 📁 Структура на сервере

```
/opt/meowbox/
├── current/          → симлинк на активный релиз
├── releases/<v>/     релизы (код, билды)
└── state/            persistent-данные (НЕ перетираются при update)
    ├── .env
    ├── data/         БД, снапшоты, servers.json
    ├── logs/
    └── adminer/
```

Сайты живут в `/var/www/<site>/{www,tmp,logs}` (путь настраивается в `/settings → Дефолты сайтов`).

---

## 🔧 Команды

```bash
make update         # обновить до последнего релиза
make snapshot       # бэкап БД + конфигов панели
make rollback       # откатиться на предыдущий релиз
make status         # статус всех сервисов (PM2)
make healthcheck    # smoke-тест API + Web + Agent

# IP allowlist из терминала (escape-hatch если заперся снаружи):
make ip-allow IP=1.2.3.4 LABEL=home
make ip-allow IP=10.0.0.0/24
make ip-allow-list
make ip-allow-clear        # выключить allowlist
```

Loopback (`127.0.0.0/8`, `::1`) разрешён всегда — даже при включённом allowlist можно зайти по SSH-туннелю и через `make ip-allow` починить себе доступ.

---

## 🛡️ Что умеет

- **Сайты**: nginx (слоистые конфиги: server / SSL / PHP / static / security / custom — кастомный блок переживает регенерацию) + php-fpm + изоляция по Linux-юзерам (SSH/SFTP).
- **PHP**: 7.4, 8.0, 8.1, 8.2 (default), 8.3, 8.4 — ставится через `ondrej/php` PPA (+ Yandex-зеркало как fallback).
- **Базы**: MariaDB / MySQL / PostgreSQL + Adminer SSO (одноразовый тикет, никаких паролей в браузере).
- **Бэкапы**: Restic → Yandex Disk / Cloud Mail.ru / S3 (дедупликация, retention `keep-daily/weekly/monthly/yearly`, опциональный `restic check`).
- **SSL**: Let's Encrypt (auto-renew через cron) или собственные сертификаты.
- **Мониторинг**: метрики CPU/RAM/диска, healthcheck, логи в реальном времени, алерты по порогам.
- **DNS**: Cloudflare / Yandex 360 / VK Cloud / Yandex Cloud (управление зонами/записями).
- **Файрвол** (UFW), cron (per-site), деплой из git, Telegram-уведомления.
- **Multi-server**: панель умеет управлять не одним хостом, а пулом (master + slaves через PROXY_TOKEN). Можно деплоить апдейт сразу на несколько серверов.

---

## 📦 Релизы

[GitHub Releases](https://github.com/gvozdb/meowbox/releases) — tarball + SHA256. Обновление через `make update` атомарное (новая версия в `releases/<v>/`, симлинк `current` переключается одним движением).

---

## 📜 Лицензия

MIT
