# Спецификация: миграция со старой hostPanel в meowbox

**Версия:** 1.0
**Дата:** 2026-05-01
**Статус:** Draft → Implementation
**Автор:** Pavel
**Целевые релизы:** v0.5.0 → v0.5.4 (5 фаз)

---

## 1. Цель

Реализовать в meowbox функционал миграции сайтов с устаревших серверов под управлением «hostPanel» (компонент MODX) на slave-серверы meowbox с минимальным простоем и максимальной точностью.

### 1.1. Что переносится

- Сайты (файлы + БД)
- Linux-пользователи (1:1 имя источника, без перегенерации паролей)
- Nginx-конфигурации (парсятся в AST и регенерятся в наш layered формат)
- PHP-FPM пулы (параметры с источника, та же major.minor версия PHP)
- SSL-сертификаты (копируются как есть, перевыпуск — после переключения DNS вручную)
- Cron-задачи (per-user + системные)
- Опционально: подключение сервиса Manticore (без переноса индексов)

### 1.2. Что НЕ переносится

- Manticore индексы (только детектим — баннер с предложением включить сервис)
- Исходные linux-пароли в виде `/etc/shadow` хешей (берём чистый SSH-пароль и пересоздаём хеш у нас)
- E-mail аккаунты (их нет на источниках)
- Любые сервисы, не запрошенные явно
- Локальная миграция на тот же VPS (только slave→slave)

---

## 2. Гарантии безопасности

### 2.1. Read-only к источнику

Любые операции на сервере-источнике — **только чтение**:
- `mysqldump --single-transaction --quick --no-tablespaces` (без блокировок)
- `rsync -aHAX --read-only-pull` (без `--delete`)
- `cat`, `ls`, `crontab -l`, `getent`
- `/etc/letsencrypt/{archive,live,renewal}/<domain>/` — только чтение

**Запрещено:** любые `INSERT/UPDATE/DELETE`, `DROP`, `TRUNCATE`, `rm`, `mv`, `chmod`, `service stop`, `apt`. Эта политика жёстко вшивается в `migrate:hostpanel:*` агент-handler-ы (allowlist команд + проверка SQL по AST).

### 2.2. Не повредить таргету

**Перед миграцией каждого сайта:**
1. Pre-check: `Site.name` + `Database.name` + `getent passwd <username>` — проверка несуществования. Конфликт → `MigrationItemStatus = CONFLICT`, требует ручного ремапа.
2. Транзакционная семантика: артефакты создаются с маркером `_migration:{migrationId}` в логах и в `Site.metadata`. На сбое — cleanup только по этому маркеру.
3. **Cleanup НЕ трогает существующие артефакты:** проверяем `Site.metadata.migrationId === currentMigrationId` перед удалением. Любое существующее (созданное до миграции) — никогда не удаляется.
4. На сбое: per-site rollback через `cleanupProvisioningArtifacts` (уже есть в `sites.service.ts`), статус item → `FAILED`. Остальные сайты в плане не затрагиваются.

### 2.3. SSL и DNS

DNS на момент миграции по-прежнему смотрит на старый сервер.
- **certbot НЕ запускается на slave** — если попытаться, ACME validation провалится (DNS не наш) или (хуже) угробит rate-limit.
- Сертификат копируется с источника как есть в `/etc/letsencrypt/live/<domain>/` целевого slave.
- После завершения миграции UI показывает баннер: *«После переключения DNS на новый IP перевыпусти сертификат: [Перевыпустить SSL для domain]»* со ссылкой на `/sites/<id>?tab=ssl`.
- Перевыпуск работает «как есть» — кнопка «Выпустить» в UI делает свежий `certbot certonly`, отзыв старого LE-серта не нужен (LE сам пометит старый как replaced).

---

## 3. Архитектура

### 3.1. Поток данных

```
[Источник: vm120]              [Master meowbox]               [Slave meowbox]
   MySQL :3306  ────────┐
   /var/www/<u>/        │
   /etc/letsencrypt/    │
   /etc/php/.../pool.d/ │       UI /admin/migrate-      ┌──── socket.io ───┐
   /etc/nginx/...       │      hostpanel ─────────────► API ────────────► Agent
   crontab -l           │       (3-step wizard)         │   migrate:*    │   ├─ ssh source
                        │                                │   events       │   ├─ rsync source
                        │  WebSocket прогресс            │                │   ├─ mysqldump source
                        └────────────────────────────────┘                │   ├─ certbot copy
                                                                          │   ├─ user create
                                                                          │   ├─ db import
                                                                          │   └─ nginx/php apply
                                                                          └──────────────────┘
```

**Ключевое:** агент на slave сам инициирует SSH+rsync+mysqldump к источнику. Master не проксирует трафик — только команды и прогресс.

### 3.2. Новые модели Prisma

```prisma
model HostpanelMigration {
  id            String                   @id @default(cuid())
  status        String                   @default("PLANNED") // PLANNED|DISCOVERING|READY|RUNNING|DONE|FAILED|CANCELLED|PARTIAL
  serverId      String                   @map("server_id")  // целевой slave из ServerService.servers
  source        String                   // JSON: {host, port, user, sshPasswordEnc, mysqlUser, mysqlPasswordEnc, hostpanelDb, hostpanelTablePrefix}
  discovery     String?                  // JSON: snapshot источника (sites, manticore, php-versions, ...)
  totalSites    Int                      @default(0)
  doneSites     Int                      @default(0)
  failedSites   Int                      @default(0)
  log           String                   @default("") // append-only лог-стрим (последние 500 KB)
  createdAt     DateTime                 @default(now())
  startedAt     DateTime?
  finishedAt    DateTime?
  createdBy     String                   @map("created_by")  // userId
  items         HostpanelMigrationItem[]

  @@map("hostpanel_migrations")
}

model HostpanelMigrationItem {
  id              String   @id @default(cuid())
  migrationId     String   @map("migration_id")
  sourceSiteId    Int      @map("source_site_id") // hostpanel modx_host_hostpanel_sites.id
  sourceData      String   @map("source_data")    // JSON: исходная строка из hostpanel (без паролей в открытом виде, креды в migration.source)
  plan            String                          // JSON: PlanItem (см. §6.3)
  status          String   @default("PLANNED")    // PLANNED|RUNNING|DONE|FAILED|SKIPPED|CONFLICT
  newSiteId       String?  @map("new_site_id")    // FK на Site после успеха
  errorMsg        String?  @map("error_msg")
  startedAt       DateTime?
  finishedAt      DateTime?
  progressPercent Int      @default(0)
  currentStage    String?  @map("current_stage")
  log             String   @default("")           // последние 200 KB лога этого item

  migration HostpanelMigration @relation(fields: [migrationId], references: [id], onDelete: Cascade)

  @@index([migrationId])
  @@map("hostpanel_migration_items")
}

model SystemCronJob {
  id           String    @id @default(cuid())
  name         String
  schedule     String                 // cron expression
  command      String
  status       String    @default("ACTIVE") // ACTIVE | DISABLED
  comment      String?                // # to mock crontab comment line
  source       String    @default("MANUAL") // MANUAL | IMPORTED_HOSTPANEL
  lastRunAt    DateTime?
  lastExitCode Int?
  lastOutput   String?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  @@map("system_cron_jobs")
}
```

**Расширение `Site`:**
```prisma
metadata  String?  // JSON: { migrationId?, importedFrom?, originalUid?, ... }
```

**Хранение кредов:**
- SSH/MySQL пароли источника — шифруем AES-256-GCM ключом `MIGRATION_SECRET` (новый env, генерится в `state/.env`)
- В UI пароли никогда не отображаются после ввода (поле type=password, redacted)

### 3.3. Шифрование MIGRATION_SECRET

Новый env-переменная `MIGRATION_SECRET` (32 random bytes, base64). Записывается в `state/.env` миграцией `008-migration-secret-bootstrap.ts`. Используется через существующий `crypto/aes-gcm.ts` хелпер (тот же, что для `ADMINER_SSO_KEY`).

---

## 4. Поддержка legacy PHP (фаза 1)

### 4.1. Расширение SUPPORTED_PHP_VERSIONS

Файл `agent/src/config.ts`:
```typescript
export const SUPPORTED_PHP_VERSIONS: string[] = (() => {
  const fromEnv = envList('SUPPORTED_PHP_VERSIONS');
  return fromEnv.length > 0 ? fromEnv
    : ['8.4','8.3','8.2','8.1','8.0','7.4','7.3','7.2','7.1'];
})();
```

### 4.2. System migration `007-install-legacy-php.ts`

Идемпотентная установка PPA `ppa:ondrej/php` (Ubuntu) или `packages.sury.org/php` (Debian). PHP версии 7.1/7.2/7.3 в пакеты НЕ устанавливаются автоматически — только проверяется доступность через `apt-cache madison php7.X-cli`. Если версия недоступна — логируется warning.

### 4.3. UI /php

Страница `/php`: в текущем списке версий добавить блок **Legacy** с версиями 7.1, 7.2, 7.3:
- Кнопка `Установить` запускает `apt-get install -y php{ver}-{cli,fpm,common,mysql,mbstring,xml,curl,gd,zip,opcache,imap,intl,bcmath,soap,readline,yaml}`
- Над секцией крупный warning: ⚠️ *«Эти версии PHP сняты с поддержки разработчиками PHP. Используй ТОЛЬКО для миграции старых сайтов. Не запускай новые проекты на legacy PHP — это уязвимость.»*

### 4.4. Поведение при недоступности версии (User answer 2d)

Если у источника сайт на версии, которой нет в `SUPPORTED_PHP_VERSIONS` или которая не установлена на slave — в Plan-таблице сайт получает статус `BLOCKED` с причиной:

> «PHP 5.6 не поддерживается. Установи 7.1+ на slave или принудительно используй ближайшую совместимую версию (риск: возможны фатальные ошибки).»

Кнопка `Force PHP X.Y` рядом — позволяет апгрейднуть. Но дефолт — блок.

---

## 5. UI: Wizard `/admin/migrate-hostpanel`

### 5.1. Шаг 1 — Source connection

**Форма:**
- IP/host источника (text)
- SSH порт (number, default 22)
- SSH user (text, default `root`)
- SSH password (password)
- MySQL host (text, default `127.0.0.1`) + port (default 3306)
- MySQL user (text, default `root`)
- MySQL password (password)
- Имя БД hostpanel (text, default `host`)
- Префикс таблиц hostpanel (text, default `modx_host_`)
- Целевой slave (select из активных slave-серверов meowbox)

**Кнопка `🔍 Discover`** → `POST /admin/migrate-hostpanel/discover`. На успехе → шаг 2.

**Валидации:**
- SSH-доступ работает (probe `whoami`)
- MySQL-доступ работает (probe `SELECT 1`)
- Таблица `<prefix>hostpanel_sites` существует
- Целевой slave online и имеет ServerService для нужных PHP-версий

### 5.2. Шаг 2 — Plan

**Верхняя панель (общая):**
- Сводка: «Найдено N сайтов, общий размер: X GB файлов + Y GB БД»
- Если на источнике найдена Manticore: **плашка** «На источнике обнаружены Manticore-индексы:» + список (`ags_brands`, `ags_categories`, `ags_products`, `aws_*`, ...). Без привязки к сайтам.
- Глобальная пометка: **«Этот сайт не нужно мигрировать»** дефолт ON для:
  - `cms === '' && (name === 'Adminer' || domain.startsWith('db.'))`
  - `user === 'host'` (сама старая hostpanel)

**Таблица сайтов** (одна строка = один сайт, expandable):

| ✓ | Source name | Source domain | Целевое имя | Главный домен | Алиасы | PHP | DB | Размер | Статус |
|---|-------------|---------------|-------------|---------------|--------|-----|-----|--------|--------|
| ✓ | allGifts.kz | allgifts.kz   | `allgifts` ✏ | `allgifts.kz` ✏ | `[+]` | 7.4 | 2.3GB | 38GB | `READY` |

- **Целевое имя** — inline-edit, валидация против существующих `Site.name` и `Database.name`. Конфликт → красная подсветка + текст «уже занято».
- **Главный домен** — inline-edit. Можно полностью заменить (allfini.allgifts.kz → allwear.kz).
- **Алиасы** — multi-tag input. Дефолт = `domains.nginx::server_name` минус главный.
- **Статус** = `READY | CONFLICT | BLOCKED` (BLOCKED = PHP-несовместимость).

**Expandable раскрытие сайта (детали):**

#### 5.2.1. Содержимое хомдиры
Source: `tree -L 1 /var/www/<user>/`. Чекбоксы. Default состояние:

**OFF (галочка снята):**
- `tmp`, `.ssh`, `.bash_logout`, `.bashrc`, `.profile`, `.DS_Store`, `pass.txt`, `chmod`, `access.nginx`, `domains.nginx`, `main.nginx`, `config.xml`, `dumper.yaml`

**ON (галочка стоит):**
- Всё остальное (включая `www`, `config.core.php`, `webhook.php`, `deploy.sh`, `.git`, `root_backup`, прочее)

> Логика: nginx-конфиги и dumper.yaml не нужны как файлы — мы парсим их в БД-структуру. Конфиденциальные/мусорные/SSH-ключи источника не нужны. Остальное оператор сам снимет, если нужно.

#### 5.2.2. Дополнительные exclude (rsync patterns)
Textarea, по строке на паттерн. Дефолт (предзаполняется из `dumper.yaml::exclude` + наши хардкод):
```
/www/core/cache/*
/www/core/logs/*
/www/_modxbackup/*
/www/assets/components/*/tmp/*
```

#### 5.2.3. Таблицы БД без данных (только структура)
Textarea, по строке. Auto-prefilled с учётом `mysql_table_prefix` из hostpanel:
```
{prefix}manager_log
{prefix}session
{prefix}smart_session
{prefix}register_messages
{prefix}register_queues
{prefix}register_topics
{prefix}active_users
```

Если `mysql_table_prefix` пуст — парсим `core/config/config.inc.php::$table_prefix`.

#### 5.2.4. Cron-задачи для импорта

Парсер crontab: `crontab -u root -l` + `crontab -u <user> -l`.

**Автофильтр (пропускаются полностью):**
- Любая строка содержащая `dumper`, `certbot`, `letsencrypt`, `apt-get autoremove`, `cron-renew`

**Маршрутизация:**
- Содержит `sudo -u<user>` → этот префикс зачищается, команда привязывается к сайту `<user>` как per-site cron
- Путь к скрипту/файлу содержит `/var/www/<user>/` → per-site cron этого сайта
- Иначе → попадает в «Системный (root) cron» (отдельная таблица в Plan, не привязана к сайту)

UI таблица в expandable: список задач с галочками + правое поле `target` (выпадашка: «Этот сайт» / «Системный (root)» / «Пропустить»).

#### 5.2.5. SSL
- Чекбокс `Перенести сертификат как есть` (default ON, если на источнике найден)
- Текст: «После переключения DNS перевыпусти сертификат через UI»

#### 5.2.6. Manticore
- Чекбокс `Включить сервис Manticore для сайта` (default OFF)
- Disabled + tooltip «Установи Manticore в /services», если `ServerService manticore.installed === false` на целевом slave.
- Подпись: «Индексы переносить НЕ будем — после миграции запусти переиндексацию вручную.»

#### 5.2.7. PHP-FPM настройки
Read-only превью: `pm.max_children`, `upload_max_filesize`, `post_max_size`, `memory_limit`, `open_basedir`, `disable_functions` — извлечённые из source pool. Кнопка `Edit` открывает форму поверх. Дефолт — копировать как есть с подгонкой путей под новый `homeDir`.

**Внизу шага 2 кнопки:**
- `← Назад`
- `Запустить миграцию →` (disabled пока есть `CONFLICT`/`BLOCKED` сайты с галочкой)

### 5.3. Шаг 3 — Execute (live progress)

**Layout:**
- Сверху: общий прогресс-бар (sites: X из N, percent)
- Список сайтов как карточки. Каждая карточка:
  - Имя сайта + домен
  - Текущий стейдж (с иконкой, как в `/admin/updates`)
  - Прогресс-бар (для rsync — реальный %, для остальных — пульсация)
  - Логи (collapsable `<details>`)
  - На успехе — зелёная плашка, на сбое — красная + кнопка «Показать ошибку»

**Управление:**
- `⏸ Пауза` — пауза между сайтами (текущий доделываем)
- `❌ Отменить` — текущий сайт rollback'ится, остальные — `SKIPPED`
- Запрос подтверждения при close страницы пока миграция идёт

**Финал:**
- Зелёная плашка: «Готово! M из N сайтов перенесены.»
- Список с зелёной/красной отметкой каждого
- Для каждого зелёного: ссылка `Открыть сайт →` + ссылка `Перевыпустить SSL после переключения DNS →` (на `/sites/<id>?tab=ssl`)
- Для красных: кнопка `Повторить` (создаёт новый migration item для одного сайта)

### 5.4. История миграций

Кнопка `История миграций` в шапке `/admin/migrate-hostpanel` → таблица последних 50 запусков с возможностью открыть детали (`/admin/migrate-hostpanel/<id>`).

---

## 6. Pipeline миграции одного сайта

### 6.1. Стейджи (с таймаутами)

| # | Stage | Описание | Timeout |
|---|-------|----------|---------|
| 1 | `pre-flight` | Проверка отсутствия конфликтов, свободного места, доступности PHP-версии | 30s |
| 2 | `create-user` | `useradd <name>` + setup `usermod -p`-хеш из source SSH-пароля (см. §6.2) | 30s |
| 3 | `rsync-files` | `rsync -aHAX --info=progress2 -e "ssh -p X" --exclude=...` источник → `/var/www/<name>/www/` + другие папки | до 12 ч |
| 4 | `db-create` | Создаём БД с именем `Site.name`, db-юзера с тем же `mysql_user`/`mysql_pass` | 30s |
| 5 | `db-dump-import` | На slave: `ssh root@source "mysqldump --single-transaction --quick --no-tablespaces --ignore-table=... <db>" \| pv \| mysql <newdb>`. Тяжёлые таблицы (без данных) — отдельным `mysqldump --no-data` дампом | до 6 ч |
| 6 | `patch-modx` | Перезаписать в `www/config.core.php`, `www/<connectors_dir>/config.core.php`, `www/<manager_dir>/config.core.php` константы `MODX_CORE_PATH`. В `www/core/config/config.inc.php` — db-креды (если поменялись) и `MODX_BASE_PATH`. Имена папок connectors/manager — из hostpanel-таблицы (`connectors_site`, `manager_site`). | 30s |
| 7 | `apply-nginx` | Парсим `domains/main/access.nginx` → строим Site.aliases, Site.nginxCustomConfig, Site.filesRelPath и пр. Запускаем стандартный flow `nginx:create-config` | 30s |
| 8 | `apply-php-fpm` | Создаём pool с параметрами из source pool.d (через `php:create-pool`) | 30s |
| 9 | `import-cron` | `cron:bulk-create` per-site + `system-cron:bulk-create` для root | 30s |
| 10 | `enable-services` | Если включена галочка Manticore — `services:site-enable` для manticore | 60s |
| 11 | `copy-ssl` | scp архива LE → `/etc/letsencrypt/{archive,live,renewal}/<domain>/` на slave + патч `renewal/*.conf` (заменить `webroot_path` на наш) + `chown -R root:root` + `nginx -t` | 60s |
| 12 | `verify` | `curl -k -I https://<domain>` через `--resolve <domain>:443:<slave_ip>` (минуя DNS) → HTTP 200/301/302. Лог HTTP-кода | 30s |
| 13 | `mark-running` | `Site.status = RUNNING`, `MigrationItem.status = DONE` | — |

### 6.2. Перенос паролей (User answer)

**SSH-пароль linux-юзера:**
- На источнике хранится в `/var/www/<user>/pass.txt` или (часто) НЕ хранится — известен только хеш в `/etc/shadow`. Хеш снять нельзя без рута + чтения `/etc/shadow`.
- В hostpanel-таблице есть `sftp_pass` (открытым текстом — это наш источник).
- На slave: `usermod --password "$(openssl passwd -6 '<sftp_pass>')" <username>` → тот же пароль для SSH/SFTP.
- В `Site.sshPassword` тоже сохраняем `<sftp_pass>`.

**MySQL-пароль:**
- Из hostpanel-таблицы `mysql_pass` (открытым текстом).
- На slave создаём БД-юзера с этим паролем: `CREATE USER '<mysql_user>'@'localhost' IDENTIFIED BY '<mysql_pass>'; GRANT ALL ON <name>.* TO ...`
- В `Database.dbPasswordEnc` шифруем тот же пароль.

**Manager-пароль MODX:** не трогаем (хранится внутри MODX базы, переезжает вместе с дампом).

### 6.3. PlanItem JSON-структура

```typescript
type PlanItem = {
  sourceSiteId: number;
  sourceUser: string;
  sourceDomain: string;
  // mapping
  newName: string;
  newDomain: string;
  newAliases: string[];
  phpVersion: string;
  cms: 'modx' | null;
  // sub-selections
  homeIncludes: { name: string; checked: boolean }[];  // имя файла/папки → переносить
  rsyncExtraExcludes: string[];
  dbExcludeDataTables: string[];   // полные имена таблиц (с префиксом)
  cronJobs: {
    raw: string;
    schedule: string;
    command: string;
    target: 'this-site' | 'system-root' | 'skip';
  }[];
  ssl: {
    transfer: boolean;
    sourceLiveDir: string;  // /etc/letsencrypt/live/<domain>
  };
  manticore: { enable: boolean };
  modxPaths: {
    connectorsDir: string;  // 'connectors' | 'connectors_xxx'
    managerDir: string;     // 'manager' | 'adminka'
  };
  phpFpm: {
    upload_max_filesize: string;
    post_max_size: string;
    memory_limit: string;
    pm: 'ondemand' | 'dynamic' | 'static';
    pm_max_children: number;
    custom: string;  // raw кастом-блок, добавляемый в конец пула
  };
};
```

---

## 7. Парсинг nginx (фаза 2)

### 7.1. Подход

Использовать пакет `crossplane` (NGINX Inc., Python — но есть JS-порт `crossplane-js`) или собственный AST-парсер на ~200 строк (директивы как `(name, args, block?)`). Предпочтительно собственный — меньше зависимостей.

### 7.2. Что извлекаем

**Из `domains.nginx`:**
- `server_name X Y Z` → `mainDomain = X`, `aliases = [Y, Z]`
- `if ($host != $main_host) return 301` → редиректы на main → формируем `Site.aliases` с `redirect=true`

**Из `main.nginx`:**
- `root /var/www/X/www` → `filesRelPath = 'www'`, `rootPath = /var/www/<newName>`
- `access_log`, `error_log` → игнорим (мы свои подставим)
- `ssl_certificate*` → игнорим (свои пути)
- `add_header Strict-Transport-Security` → `Site.nginxHsts = true`
- `add_header Content-Security-Policy` → переносим в `nginxCustomConfig`
- `if ($http_user_agent ~* (...)) return 444` → bot-блок → переносим в `nginxCustomConfig`
- `location ~* ^/(adminka|connectors_xxx|...)` → MODX-блок → распознаём шаблон, мапим в `modxPaths.connectorsDir/managerDir` (имена берём из hostpanel-таблицы как primary, из nginx как fallback)

**Из `access.nginx`:**
- `error_page 404 = @modx; location @modx { rewrite ^/(.*)$ /index.php?q=$1&$args last; }` → стандартный MODX SEO-routing → флаг `modxFriendlyUrls = true`
- `location ~* ^/core/ { return 404; }` → стандарт MODX → пропускаем (мы это сами генерим)
- `try_files $uri $uri/ @rewrite` → стандарт

**Что не распозналось:**
- Заворачиваем в комментарий и кладём в `Site.nginxCustomConfig`:
```
# === Imported from hostpanel (автоперенос, проверь!) ===
# original: /var/www/<user>/main.nginx, line 42
<директива>
# === end imported ===
```

### 7.3. Edge-cases

- Разный порядок директив → AST не зависит от порядка
- Комментарии → парсер игнорит
- Вложенные `if` → захватываем как блок
- Битый синтаксис → fallback: целиком кладём source в `nginxCustomConfig` + warning в лог миграции «парсинг не удался, проверь конфиг руками»

---

## 8. Парсинг crontab (фаза 2)

### 8.1. Что считается «системным мусором»

Skip pattern (case-insensitive regex):
```
/dumper|certbot|letsencrypt|apt-get\s+autoremove|cron-renew|fail2ban-cleanup/
```

### 8.2. Маршрутизация per-site

Для каждой строки crontab (после фильтра):

1. Извлекаем команду (5-е поле и далее)
2. Если содержит `^sudo\s+-u\s*(\w+)` — извлекаем `<user>`, удаляем префикс
3. Если `<user>` совпадает с `Site.name` мигрируемого сайта — этот сайт получает крон
4. Иначе если в команде встречается путь `/var/www/<known-user>/` — приписываем к этому сайту
5. Иначе → `system-root`

В UI: оператор может перенаправить вручную через выпадашку.

### 8.3. /cron page — добавление root

**Backend:**
- Новая модель `SystemCronJob` (см. §3.2)
- Endpoint `GET /cron/system`, `POST /cron/system`, `PUT /cron/system/:id`, `DELETE /cron/system/:id`
- Реализация: пишем напрямую в `crontab -u root` через `agent.execute('crontab', ['-u', 'root', '-'], { stdin })` — генерим целый crontab из БД на каждое изменение (атомарно)

**UI `/cron`:**
- В существующем dropdown «Сайт» добавить опцию **«Системный (root)»** в самом верху списка
- Дефолтная выбранная опция = root (раньше был первый сайт)
- Когда выбран root — таблица показывает `SystemCronJob[]` вместо `CronJob[]`
- Иконка/значок «root» (например, ✦) рядом с именем

---

## 9. SSL-перенос

### 9.1. Что копируем

```
source:/etc/letsencrypt/archive/<domain>/   → slave:/etc/letsencrypt/archive/<domain>/
source:/etc/letsencrypt/live/<domain>/      → slave:/etc/letsencrypt/live/<domain>/   (символические ссылки)
source:/etc/letsencrypt/renewal/<domain>.conf → slave:/etc/letsencrypt/renewal/<domain>.conf
```

### 9.2. Патчинг renewal/*.conf на slave

Заменяем:
- `webroot_path = /var/www/html, ` → `webroot_path = /var/www/<newName>/www`
- `account = ...` — оставляем (если будет ошибка при первом renew — certbot создаст новый)
- `post_hook = service nginx reload` → `post_hook = systemctl reload nginx` (наш стандарт)

### 9.3. Регистрация в БД

Создаём `SslCertificate` запись:
- `siteId = <newSiteId>`
- `domain = <newDomain>`
- `certPath = /etc/letsencrypt/live/<newDomain>/fullchain.pem` — НО! если `<newDomain> != <oldDomain>` (ремап), то надо либо переименовать папки LE, либо использовать `--cert-name` при renew. Решение: переименовываем папки на лету: `mv /etc/letsencrypt/live/<old>/ /etc/letsencrypt/live/<new>/` + правим симлинки + `mv archive/<old> archive/<new>` + правим renewal/*.conf.
- `expiresAt = <извлекаем из cert.pem через openssl>`
- `issuer = LETSENCRYPT`
- `meta = { migratedFrom: <source>, requiresRenewal: true }`

### 9.4. Post-migration баннер

В UI карточки сайта после миграции:

> ⚠️ Сертификат перенесён со старого сервера. После того как привяжешь новый IP к домену — **[Перевыпусти сертификат](/sites/{id}?tab=ssl)**

### 9.5. Перевыпуск (User question)

**Перевыпуск делается с нуля.** Отзывать (revoke) старый — НЕ нужно. Когда жмёшь «Выпустить» в UI:
1. `certbot certonly --webroot --cert-name <domain> --force-renewal -d <domain> -d <alias1> ...`
2. Старые файлы archive/ остаются (certbot их сам ротейтит, текущий symlink в `live/` укажет на новый `cert43.pem`)
3. ACME-сервер пометит старый serial как replaced (это нормально, не угроза)

**Когда нужно явно revoke:** только если ты подозреваешь компрометацию приватного ключа. Тогда `/sites/{id}?tab=ssl` → кнопка «Отозвать» → потом «Выпустить заново».

---

## 10. Manticore

### 10.1. Детект на источнике

Probe-step (Discovery):
```bash
ps -ef | grep -E "searchd|manticore" | grep -v grep
ls /var/lib/manticore/ 2>/dev/null
ls /etc/manticoresearch/ 2>/dev/null
mysql -h 127.0.0.1 -P 9306 -e "SHOW TABLES;" 2>/dev/null  # если 9306 открыт — список индексов
```

### 10.2. UI

- Если на источнике найден searchd → плашка над таблицей сайтов:

  > 🔍 **На источнике обнаружены Manticore-индексы:**
  > `ags_brands`, `ags_categories`, `ags_products`, `aws_brands`, `aws_categories`, `aws_products`, `test_products`
  >
  > Индексы НЕ переносятся — это надёжнее. После миграции запусти переиндексацию через свой скрипт.

- Per-site чекбокс «Включить сервис Manticore для сайта» (default OFF):
  - Disabled, если `ServerService.manticore.installed === false` на целевом slave → tooltip «Сначала установи Manticore в /services»

### 10.3. Включение

Если галочка стоит — на стейдже `enable-services` вызываем существующий `services:site-enable` с `serviceKey='manticore'`. Он создаст `SiteService` запись и через `manticore.executor.ts` подцепит к сайту.

---

## 11. Транзакционность и rollback

### 11.1. Per-site контракт

Каждый item — независимая «псевдо-транзакция»:

```
[create-user] → [rsync] → [db] → [patch] → [nginx] → [php] → [cron] → [services] → [ssl] → [verify]
       ↓ catch          ↓                                                                      ↓
       cleanup ←——————— cleanup ←——————————————————————————————————————————————————————————— ✓
```

### 11.2. Cleanup: что трогаем / что НЕ трогаем

**Трогаем (удаляем) ТОЛЬКО артефакты с маркером migration:**
- Linux user, созданный на стейдже 2 (проверка: `Site.metadata.migrationId === currentId`)
- `/var/www/<newName>/` — только если был создан этой миграцией (timestamp создания > startedAt)
- БД и БД-юзер — только если `Database.metadata.migrationId === currentId`
- nginx config + php-fpm pool — только если файла не было до миграции (проверяем mtime)
- SSL — только скопированные файлы LE (не трогаем существующие LE для других доменов)
- Cron — только записи с `source = 'IMPORTED_HOSTPANEL'` и тем же migrationId

**Никогда не трогаем:**
- Любой существующий до миграции `Site`/`Database`/`SystemCronJob`
- Чужие nginx-конфиги
- Чужие LE-сертификаты
- /etc/php/.../pool.d/ файлы других сайтов
- Существующих linux-юзеров

### 11.3. Сбой посередине

Если стейдж падает — текущий item помечается `FAILED`, цикл по сайтам продолжается. В конце миграции — статус `PARTIAL` (часть сайтов прошла, часть нет). Юзер может в UI нажать `Повторить` для одного сайта.

### 11.4. Атомарность переименований

Папки LE переименовываются `mv` (атомарно в пределах ФС). Перед `mv` — проверка отсутствия конфликта.

---

## 12. Конфликты при ремапе

### 12.1. Где валидируем

В Шаге 2 inline-валидация на каждое изменение `newName` / `newDomain`:

- `GET /admin/migrate-hostpanel/check-name?serverId=X&name=Y` → `{available: bool, reason?: string}`
  - Проверки: `Site.name` свободно + `Database.name` свободно + `getent passwd <name>` на slave не существует + `name` matches `^[a-z][a-z0-9_-]{0,31}$`
- `GET /admin/migrate-hostpanel/check-domain?serverId=X&domain=Y` → `{available: bool}`
  - `Site.domain` свободно + `SiteAlias` (если будет) свободно

### 12.2. UX

- Зелёная галочка справа от поля при доступности
- Красная плашка при конфликте + suggest: `<name>-2`, `<name>-imported`, `<name>-old`
- Кнопка `Запустить миграцию →` блокируется, пока есть `CONFLICT`

---

## 13. dumper.yaml (User answer)

### 13.1. Что в нём полезного

```yaml
enabled: true
database: { type, port, host, name, user, pass }
exclude: [ '/www/assets/...', '/www/core/cache/*', ... ]
```

### 13.2. Использование

- **Exclude paths** → авто-предзаполняют поле `Дополнительные exclude` в Plan-таблице
- **Database creds** → fallback к `mysql_pass` из hostpanel-таблицы (если в hostpanel пусто/битое)

Сам файл `dumper.yaml` НЕ переносится (default OFF в чекбоксах хомдиры) — у нас есть свой бэкап-механизм.

---

## 14. config.xml (User answer)

### 14.1. Где лежит

`/var/www/<user>/config.xml` — файл от MODX-инсталлера, где есть полный snapshot:

```xml
<modx>
  <database_type>mysql</database_type>
  <database_server>localhost</database_server>
  <database>allgifts</database>
  <database_user>allgifts</database_user>
  <database_password>...</database_password>
  <table_prefix>modx_Y5BY4atTeq_</table_prefix>
  <core_path>/var/www/allgifts/www/core/</core_path>
  <context_mgr_path>/var/www/allgifts/www/adminka/</context_mgr_path>
  <context_connectors_path>/var/www/allgifts/www/connectors_5r8goy9ej9/</context_connectors_path>
  <context_web_path>/var/www/allgifts/www/</context_web_path>
  <cmsadmin>...</cmsadmin>
  <cmspass>...</cmspass>
  <cmsadminemail>...</cmsadminemail>
  ...
</modx>
```

### 14.2. Стратегия использования

При Discovery парсим XML и используем как **3-й fallback** (после hostpanel-таблицы и `dumper.yaml`):
- table_prefix → если в hostpanel пусто
- core_path / context_mgr_path / context_connectors_path → имена директорий manager/connectors → если в hostpanel пустые `manager_site`/`connectors_site`
- database_password → если в hostpanel `mysql_pass` пусто

Сам `config.xml` НЕ переносим (default OFF).

---

## 15. Endpoints API (фазы 2-4)

### 15.1. Discovery

```
POST   /admin/migrate-hostpanel/discover
       body: { serverId, source: { host, port, sshUser, sshPass, mysql{...}, hostpanelDb, prefix } }
       resp: { migrationId, discovery: { sites: PlanItem[], manticore: {...}, summary: {...} } }
```

### 15.2. Подготовка плана

```
PATCH  /admin/migrate-hostpanel/:id/items/:itemId
       body: { plan: PlanItem }   // обновление PlanItem из UI
       resp: { item: HostpanelMigrationItem }

POST   /admin/migrate-hostpanel/:id/items/:itemId/skip
DELETE /admin/migrate-hostpanel/:id   // отмена в статусе PLANNED|READY
```

### 15.3. Запуск/контроль

```
POST   /admin/migrate-hostpanel/:id/start
POST   /admin/migrate-hostpanel/:id/pause
POST   /admin/migrate-hostpanel/:id/resume
POST   /admin/migrate-hostpanel/:id/cancel
POST   /admin/migrate-hostpanel/:id/items/:itemId/retry
```

### 15.4. Вспомогательные

```
GET    /admin/migrate-hostpanel/check-name?serverId=X&name=Y
GET    /admin/migrate-hostpanel/check-domain?serverId=X&domain=Y
GET    /admin/migrate-hostpanel              // список миграций
GET    /admin/migrate-hostpanel/:id          // детали
GET    /admin/migrate-hostpanel/:id/log      // полный лог (стрим)
```

### 15.5. Agent events (slave → master)

```
migrate:item:progress    { migrationId, itemId, stage, percent, log? }
migrate:item:status      { migrationId, itemId, status, errorMsg? }
migrate:item:log         { migrationId, itemId, line }
migrate:complete         { migrationId, totalDone, totalFailed }
```

### 15.6. Master → agent

```
migrate:hostpanel:probe        { source, hostpanelDb, prefix } → discovery
migrate:hostpanel:run-item     { migrationId, itemId, plan, source }
migrate:hostpanel:cancel-item  { migrationId, itemId }
```

---

## 16. Фазы реализации

### Фаза 1 — Подготовка инфраструктуры (релиз v0.5.0)
1. **Расширение PHP supported list** до `7.1, 7.2, 7.3` (`agent/src/config.ts`)
2. **System migration `007-install-legacy-php-prereqs.ts`**: добавление PPA, кэш madison
3. **UI /php**: блок «Legacy» с warning + кнопки установки
4. **System migration `008-system-cron-table.ts`**: создание `system_cron_jobs`
5. **`SystemCronJob` модель Prisma + endpoints**
6. **/cron page**: dropdown «Системный (root)»
7. **System migration `009-migration-secret-bootstrap.ts`**: генерация `MIGRATION_SECRET`
8. **`HostpanelMigration` + `HostpanelMigrationItem` Prisma модели**
9. **Расширение `Site.metadata`**

### Фаза 2 — Backend Discovery (релиз v0.5.1)
1. Agent handler `migrate:hostpanel:probe` (SSH + MySQL probing)
2. Парсер nginx-конфигов (AST, ~200 LOC)
3. Парсер crontab с фильтрами и маршрутизацией
4. Парсер `dumper.yaml`, `config.xml`, `core/config/config.inc.php`
5. API endpoint `POST /admin/migrate-hostpanel/discover`
6. Сборка `PlanItem[]` с auto-defaults

### Фаза 3 — UI Wizard (релиз v0.5.2)
1. Страница `/admin/migrate-hostpanel`
2. Step 1: source form
3. Step 2: plan table + expandable rows + inline-edit + валидация
4. Step 3: live progress (WebSocket)
5. Иконография в стиле панели (SVG, не текст), котик 🐱 на пустом state
6. История миграций `/admin/migrate-hostpanel/history`

### Фаза 4 — Backend Execution (релиз v0.5.3)
1. Agent handler `migrate:hostpanel:run-item` — оркестратор стейджей 1-13
2. Стейджи 1-13 (см. §6.1)
3. WebSocket-стрим прогресса
4. Per-item rollback с маркерной семантикой
5. Patch MODX configs (3 файла + config.inc.php)

### Фаза 5 — Polish & edge cases (релиз v0.5.4)
1. Manticore detect + UI
2. Cron «системные» management в UI
3. Cancel / Pause / Resume
4. Retry single failed item
5. Документация в README + краткий guide
6. End-to-end тест на vm120 → тестовый slave

---

## 17. Безопасность

### 17.1. SSH/MySQL credentials handling
- Шифрование AES-256-GCM ключом `MIGRATION_SECRET`
- Никогда не логируются (ни в API logs, ни в `migration.log`)
- В UI поля type=password, после ввода и сохранения — маскируются как `***`
- При просмотре существующей миграции — расшифровка только в момент запуска (не отображаются в response)

### 17.2. SQL injection
- Все имена БД/юзеров/таблиц проходят через `validateSqlIdentifier()` (whitelist `[a-zA-Z0-9_]`)
- Все пароли передаются через `mysql --defaults-extra-file=<tmp>` (не в командной строке)

### 17.3. SSH command injection
- Команды на источнике строятся через `execFile` (не `exec`/shell), параметры разделены массивом
- Источник работает только в read-only allowlist (см. §2.1)

### 17.4. Path traversal
- `Site.name` проходит regex `^[a-z][a-z0-9_-]{0,31}$`
- Все пути нормализуются через `path.normalize()` + проверка `startsWith('/var/www/')`

### 17.5. Rate-limit и abuse
- На master endpoint `/admin/migrate-hostpanel/discover` — лимит 5/мин
- На `migrate-hostpanel:probe` от агента — лимит 1 одновременная миграция на slave

---

## 18. Открытые вопросы / TODO

1. ✅ Решено: SSL переносим как есть, перевыпуск — после DNS-переключения вручную
2. ✅ Решено: пароли (SSH, MySQL) переносим без перегенерации
3. ✅ Решено: Manticore — баннер + чекбокс per-site (default OFF), индексы не тащим
4. ✅ Решено: PHP-несовместимость → блокировать с возможностью force (с warning'ом)
5. ✅ Решено: Adminer и host-сайт — default OFF в Plan
6. ✅ Решено: главный домен — inline-редактируемый
7. ✅ Решено: cleanup трогает только то, что создала текущая миграция
8. ⚠️ TODO Phase 4: тестирование на реальных данных — нужен временный slave для прогона vm120

---

## 19. Чек-лист готовности к старту реализации

- [x] Рекогносцировка источника (vm120) проведена
- [x] Архитектура meowbox (slave-протокол, DB, UI-компоненты) изучена
- [x] Все ответы оператора учтены (см. §18)
- [x] Спецификация согласована
- [ ] Фаза 1 запущена
- [ ] Фаза 2 запущена
- [ ] Фаза 3 запущена
- [ ] Фаза 4 запущена
- [ ] Фаза 5 запущена
- [ ] End-to-end прогон на vm120 → тестовый slave
- [ ] Production deploy v0.5.4

---

## 20. Glossary

| Термин | Описание |
|---|---|
| **Источник** | Старый сервер с hostPanel (vm120 для теста) |
| **Slave** | Целевой meowbox-сервер для миграции |
| **hostpanel** | MODX-компонент, хранит сайты в `<prefix>hostpanel_sites` |
| **PlanItem** | Описание миграции одного сайта (см. §6.3) |
| **MIGRATION_SECRET** | AES-ключ для шифрования source-кредов |
| **PARTIAL** | Статус миграции: часть сайтов прошла, часть упала |
| **CONFLICT** | Item-статус: имя/домен уже занят на таргете |
| **BLOCKED** | Item-статус: PHP несовместим, требуется force или установка |
