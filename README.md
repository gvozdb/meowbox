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

## 🛠️ Разработка (dev-сервер)

Dev-сервер — отдельная установка, где сайты настоящие, а **код панели живёт прямо в git workspace** (без `releases/`/tarball'ов). Правишь код, делаешь `make dev` — пересобирается только то, что задел, и `pm2 reload`.

### Установка dev-сервера одной командой

```bash
curl -fsSL https://raw.githubusercontent.com/gvozdb/meowbox/main/bootstrap.sh \
  | sudo PANEL_PORT=18443 MEOWBOX_DEV=1 bash
```

`MEOWBOX_DEV=1` отличается от прод-установки тремя вещами:
- ставит маркер `/opt/meowbox/.dev-mode` (блокирует `make update` / `rollback`),
- создаёт симлинк `current → .` (раскладка как у прода, но указывает на git workspace),
- не качает tarball, а делает `git clone` в `/opt/meowbox/`.

Структура **идентична проду** (`current/`, `state/`, тот же путь к БД, тот же `.env`), но `releases/` отсутствует, а `current` указывает на сам корень.

### Workflow

```bash
make dev          # git pull + пересборка задетых пакетов + pm2 reload + healthcheck (~10-30 сек)
make dev-pull     # синоним make dev (для тех, кто привык к 'pull')
make dev-build    # БЕЗ git pull — собрать только то, что задели локально, и reload
make dev-force    # пересобрать ВСЁ (shared+api+agent+web), независимо от диффа
```

Под капотом — `tools/dev.sh` со стейджами `guard → pull → deps → shared → prisma → migrate → api → agent → web → reload → healthcheck`. Дополнительные флаги: `--no-pull`, `--force`, `--skip-migrate` (можно вызывать напрямую: `bash tools/dev.sh --skip-migrate`).

Скрипт (`tools/dev.sh`) сам определяет, что задето:
- `shared/` → пересобирает `shared` + всё что от него зависит
- `api/prisma/schema.prisma` → `prisma generate`
- `api/prisma/migrations/` или `migrations/system/` → `prisma migrate deploy` + system migrations
- `api/`, `agent/`, `web/` → пересборка только своего пакета
- `package*.json` → `npm install` + перелинковка `@meowbox/shared`

### Что **нельзя** делать на dev-сервере

- `make update` / `bash tools/update.sh` — заблокировано флагом `.dev-mode` (поломает git workspace)
- `make rollback` — то же самое
- `git tag vX.Y.Z && git push --tags` — запустит GitHub Action, прод подхватит непротестированный коммит. **Релизы только с локальной машины** (или с отдельного «release-runner»-сервера, где нет `.dev-mode`).
- `npx prisma migrate dev` — сбрасывает БД при дрейфе схемы. На dev-сервере с продакшн-БД использовать только `prisma migrate deploy`.

### Снять флаг dev-режима (если когда-то нужно превратить dev в прод)

```bash
rm /opt/meowbox/.dev-mode
unlink /opt/meowbox/current   # потом make update создаст нормальный current → releases/<v>/
make update
```

---

## 📜 Лицензия

MIT
