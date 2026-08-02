
## Migration rules (HARD)

Перед коммитом фичи отвечай на вопросы. Хоть один «да» — миграция обязательна, без неё фича не готова.

1. Менял `api/prisma/schema.prisma`? → `npx prisma migrate dev --name <slug>`. **НИКОГДА `db push`.**
2. Менял шаблоны nginx / php-fpm / logrotate / cron / systemd? → системная миграция, regenerate всех существующих сайтов.
3. Переименовывал/двигал файлы или директории на диске сервера? → системная миграция.
4. Добавил новую env-переменную? → миграция дописывает дефолт в `state/.env`.
5. Менял состояние ОС (`useradd`, `pm2 delete`, `systemctl enable`)? → системная миграция.

Создание заготовки: `bash tools/new-migration.sh <slug>` → `migrations/system/<date>-<slug>.ts`.

**Идемпотентность обязательна.** Миграция должна корректно работать при повторном запуске после падения в середине. Проверяй состояние перед изменением (`if (await exists(...)) return;`).


## Release rules

1. Код не правится напрямую на сервере. Изменения идут через релиз: `git tag vX.Y.Z` → workflow собирает tarball → `make update`.
2. Persistent данные — в `/opt/meowbox/state/` (data, .env, logs). Никогда не пиши их внутри `releases/` или `current/`.
3. Перед любой опасной операцией — `make snapshot` (бэкап БД + конфигов панели в `state/data/snapshots/`).
4. Перед commit + tag + release сначала подними версию в файле VERSION (лежит в корне).


## Current VPS: dev-mode (HARD)

Текущий VPS — production: на нём работают важные сайты и хранятся реальные данные. Одновременно в `/opt/meowbox` ведётся разработка исходника Meowbox, поэтому текущая установка намеренно работает в `.dev-mode`.

Это ожидаемый режим. **Никогда не удаляй и не перемещай `/opt/meowbox/.dev-mode`, не переводи этот VPS в release-mode и не запускай здесь `make update`.** Для обновления используй dev workflow с сохранением `.dev-mode`.
