# 🐾 Meowbox

Лёгкая панель управления сайтами для Linux-серверов: nginx, php-fpm, базы, бэкапы, SSL, мониторинг — без лишнего жира.

---

## ⚡ Установка одной командой

```bash
curl -fsSL https://raw.githubusercontent.com/gvozdb/meowbox/main/bootstrap.sh | sudo PANEL_PORT=18443 bash
```

После установки панель будет на `https://<ваш-сервер>:18443`.

---

## 🧩 Стек

- **API** — NestJS + Prisma + SQLite
- **Web** — Nuxt 3 + Pinia
- **Agent** — Node.js + Socket.io
- **Proxy** — nginx (один порт наружу)
- **Process manager** — PM2

---

## 📁 Структура на сервере

```
/opt/meowbox/
├── current/          → симлинк на активный релиз
├── releases/<v>/     релизы (код, билды)
└── state/            persistent-данные
    ├── .env
    ├── data/         БД, снапшоты
    ├── logs/
    └── adminer/
```

---

## 🔧 Команды

```bash
make update      # обновить до последнего релиза
make snapshot    # бэкап БД + конфигов
make rollback    # откатиться на предыдущий релиз
make status      # статус всех сервисов
```

---

## 🛡️ Что умеет

- Сайты: nginx + php-fpm + изоляция по Linux-юзерам (SSH/SFTP)
- Базы: MariaDB / MySQL / PostgreSQL + Adminer SSO
- Бэкапы: Restic → Yandex Disk / Cloud Mail.ru / S3
- SSL: Let's Encrypt (auto-renew)
- Мониторинг: метрики, healthcheck, логи в реальном времени
- DNS: Cloudflare / Yandex 360 / VK Cloud / Yandex Cloud
- Файрвол, cron, деплой из git
- Telegram-уведомления

---

## 📦 Релизы

[GitHub Releases](https://github.com/gvozdb/meowbox/releases) — tarball + SHA256.

---

## 📜 Лицензия

MIT
