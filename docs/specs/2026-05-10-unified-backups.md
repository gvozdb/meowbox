# Unified Backups — спецификация

**Статус:** draft
**Дата:** 2026-05-10
**Автор:** Pavel
**Slug:** `unified-backups`
**Связано с:** [`2026-05-10-master-key-unification`](./2026-05-10-master-key-unification.md)

---

## 1. Зачем

Сейчас в панели есть только **per-site бэкап**: бэкапятся файлы сайта (`rootPath`) и его БД. Что **не бэкапится** автоматически:

- БД самой панели (`state/data/meowbox.db`).
- Master-key и legacy ключи (`.master-key`, `.vpn-key`, `.dns-key`).
- `state/.env`, `state/data/servers.json`.
- VPN state (`state/vpn/`).
- Letsencrypt сертификаты (`/etc/letsencrypt/`).
- Произвольные системные папки (`/etc/`, `/opt/`, `/root/` и т.п.).

`tools/snapshot.sh` снимает только локально, **никуда не отправляется**, и работает только перед `make update`.

### 1.1 Цели

- **Единый движок** для всех бэкапов — никаких отдельных passphrase'ов или параллельных систем. Используется существующий `BackupsService` + Restic/TAR + `StorageLocation` с `resticPassword`.
- **Произвольные пути на сервере** (`/etc/`, `/opt/`, `/root/`, что угодно) — каждый путь = отдельный backup-config со своим расписанием, retention, движком и хранилищем.
- **Бэкап данных панели** как отдельный пресет (один клик настроить, нельзя случайно выбрать неправильный набор путей).
- **Один UI** — `/backups` получает 3 таба.

### 1.2 Не-цели

- Полный disk-image / bare-metal backup — отдельная задача (если вообще нужна; обычно достаточно слоёв выше).
- Backup в S3 без `StorageLocation` (ad-hoc CLI) — не надо, всё через сущности панели.
- Cross-region replication самих `StorageLocation` — нет, юзер если хочет — добавляет второй location и второй config.

---

## 2. Архитектура

### 2.1 Расширение `BackupConfig`

```prisma
model BackupConfig {
  id        String  @id @default(uuid())

  // NEW: scope конфига
  scope     String  @default("SITE")   // SITE | SERVER_PATH | PANEL_DATA

  // Optional name (для UI и логов) — обязателен для SERVER_PATH и PANEL_DATA
  name      String?

  // SITE-specific
  siteId    String?                    // ← теперь nullable
  site      Site?   @relation(fields: [siteId], references: [id], onDelete: Cascade)

  // SERVER_PATH-specific: ОДИН путь на конфиг (каждый /etc, /opt, /root — отдельный config)
  path      String?                    // абсолютный путь, validate в DTO

  // PANEL_DATA-specific: ничего дополнительного — список путей зашит в коде

  // Общие настройки (как сейчас)
  type                  String         // BackupType: FULL/DIFFERENTIAL/DB_ONLY/FILES_ONLY
  engine                String         // TAR | RESTIC
  schedule              String?        // cron expression
  retention             Int            @default(7)
  keepDaily             Int            @default(7)
  keepWeekly            Int            @default(4)
  keepMonthly           Int            @default(6)
  keepYearly            Int            @default(1)
  excludePaths          String         @default("[]")   // JSON string[]
  excludeTableData      String         @default("[]")
  storageLocationIds    String         @default("[]")
  storageType           String?
  storageConfig         String         @default("{}")
  keepLocalCopy         Boolean        @default(false)
  enabled               Boolean        @default(true)

  // NEW: для SERVER_PATH — флаг что warn (опасный путь) был подтверждён
  warningAcknowledged   Boolean?       @map("warning_acknowledged")

  createdAt             DateTime       @default(now())
  updatedAt             DateTime       @updatedAt
}
```

**Constraints (в коде, не в SQLite):**
- `scope=SITE` → `siteId NOT NULL`, `path NULL`, `name NULL` (или дефолт).
- `scope=SERVER_PATH` → `siteId NULL`, `path NOT NULL`, `name NOT NULL`.
- `scope=PANEL_DATA` → `siteId NULL`, `path NULL`, `name NOT NULL`.

### 2.2 `Backup` (результат запуска)

Минимальные изменения — добавляем колонку `configScope` (избыточно, но удобно для list-запросов без join'а):

```prisma
model Backup {
  // ... как сейчас ...
  scope    String  @default("SITE")  // SITE | SERVER_PATH | PANEL_DATA
  siteId   String?                   // ← nullable для не-SITE бэкапов
}
```

---

## 3. Три типа бэкапа

### 3.1 SITE (как сейчас)

Без изменений по семантике. Бэкапим `rootPath` сайта + БД сайта. Доступ — юзер сайта или ADMIN.

### 3.2 SERVER_PATH

**Один путь = один config.** Юзер хочет бэкапить `/etc`, `/opt`, `/root` — создаёт три конфига с тремя расписаниями/хранилищами.

**DTO:**

```ts
class CreateServerPathBackupDto {
  @IsString() @IsNotEmpty()
  name: string;                    // "etc daily to S3"

  @IsString() @Matches(/^\/[^\0]+$/)
  path: string;                    // абсолютный путь, без \0

  @IsEnum(BackupEngine)
  engine: 'TAR' | 'RESTIC';

  @IsArray() @IsString({ each: true })
  storageLocationIds: string[];

  @IsString() @IsOptional()
  schedule?: string;               // cron expression

  retention/keepDaily/Weekly/Monthly/Yearly: number;

  @IsArray() @IsString({ each: true })
  excludePaths: string[];          // относительные паттерны для restic --exclude

  @IsBoolean() @IsOptional()
  warningAcknowledged?: boolean;   // обязателен если path попадает в warnlist
}
```

**Backend валидация:**
- Путь должен начинаться с `/`, не содержать `..`, `\0`, `\n`, `\r`.
- Путь не должен заканчиваться на `/` (нормализация).
- Если путь в warnlist → требуем `warningAcknowledged=true`.

**Warnlist** (массив regex'ов в коде):
```ts
const DANGEROUS_PATHS: RegExp[] = [
  /^\/$/,                                     // корень
  /^\/proc(\/|$)/,                            // pseudo-fs
  /^\/sys(\/|$)/,
  /^\/dev(\/|$)/,
  /^\/run(\/|$)/,
  /^\/tmp(\/|$)/,
  /^\/var\/cache(\/|$)/,
  /^\/var\/log(\/|$)/,                        // обычно ротируется, бэкап не нужен
  /^\/var\/lib\/mysql(\/|$)/,                 // если есть per-site DB backup — дубликат
  /^\/opt\/meowbox\/state\/data\/snapshots/,  // бэкапить снапшоты внутри бэкапа — рекурсия здравого смысла
];
```

API возвращает `409 BackupPathWarning` с массивом причин (`['DANGEROUS_PATH', 'POSSIBLY_DUPLICATE_WITH_PANEL_DATA']`), UI показывает confirm, юзер ставит `warningAcknowledged=true`, повторяет.

**Доступ:** только ADMIN. Юзер сайта не может создавать server-path конфиги.

### 3.3 PANEL_DATA

**Жёстко заданный набор путей в коде:**

```ts
const PANEL_DATA_PATHS = (stateDir: string) => [
  `${stateDir}/data/.master-key`,
  `${stateDir}/data/.vpn-key`,             // legacy, если ещё есть
  `${stateDir}/data/.dns-key`,             // legacy
  `${stateDir}/data/servers.json`,
  `${stateDir}/.env`,
  `${stateDir}/vpn/`,
  '/etc/letsencrypt/',                     // SSL сертификаты
];

// + динамически добавляется meowbox.db.snapshot из VACUUM INTO (см. §4)
```

**DTO:**

```ts
class CreatePanelDataBackupDto {
  @IsString() name: string;            // "panel-data hourly"
  @IsEnum(BackupEngine) engine: 'TAR' | 'RESTIC';
  @IsArray() storageLocationIds: string[];
  @IsString() @IsOptional() schedule?: string;
  retention/keep* : number;
}
```

**Никакого выбора путей в UI** — пресет защищает от ошибки «забыл `.master-key` в backup».

**Доступ:** только ADMIN.

---

## 4. Изменения в агенте

### 4.1 Расширение протокола

Сейчас `restic:backup` принимает `rootPath: string`. Расширяем:

```ts
// shared/src/ws.ts
interface ResticBackupPayload {
  backupId: string;
  scope: 'SITE' | 'SERVER_PATH' | 'PANEL_DATA';
  siteName?: string;                  // optional; для SERVER_PATH/PANEL_DATA = `panel` или конфиг.name slugified
  paths: string[];                    // ← заменяет rootPath; для SITE = [rootPath]
  excludePaths: string[];
  excludeTableData?: string[];
  databases?: { name: string; type: string }[];   // только SITE | PANEL_DATA (но в PANEL_DATA нет user-DBs)
  storage: { type: StorageType; config: Record<string, string>; password: string };
}
```

Аналогично `backup:execute` (TAR) — добавляем `paths[]` вместо одного `rootPath`.

### 4.2 PANEL_DATA — VACUUM INTO снапшот

API **перед** дёргом агента:

```ts
// api/src/backups/panel-data.service.ts
const snapshotPath = `${STATE_DIR}/data/snapshots/panel-backup-${backupId}.db`;
await execFile('sqlite3', [DB_FILE, `VACUUM INTO '${snapshotPath}';`]);

// добавляем в payload
const paths = [...PANEL_DATA_PATHS(STATE_DIR), snapshotPath];
```

После бэкапа (success или fail) — удаляем `snapshotPath`. Cleanup гарантирован через `finally`.

### 4.3 SERVER_PATH

Без VACUUM, без БД-дампов. Просто `paths: [config.path]`, всё остальное берётся из excludePaths.

### 4.4 Restic-репозиторий

**Важно:** у каждого `StorageLocation` свой restic-репозиторий. Если юзер хочет бэкапить **и** сайты, **и** SERVER_PATH в одну S3-бакет — они дедуплицируются между собой (restic dedup'ит по хешам блоков). Это плюс.

Имя репозитория в S3 = из `StorageLocation.config.repoPath` (как сейчас для per-site).

Subdir в репе **per-config**:
- SITE: `sites/<siteName>/`
- SERVER_PATH: `server-paths/<configId>/`
- PANEL_DATA: `panel-data/`

(Restic поддерживает один tag per snapshot — будем тегать `scope:SITE|SERVER_PATH|PANEL_DATA` для фильтрации в UI.)

---

## 5. UI

Раздел `/backups` получает 3 таба:

### 5.1 Tab «Сайты»

То что сейчас (`/backups` с группировкой по сайтам). Никаких изменений.

### 5.2 Tab «Сервер»

**Список конфигов:**

| Имя | Путь | Cron | Движок | Хранилище | Последний backup | Действия |
|---|---|---|---|---|---|---|
| etc daily | `/etc` | `0 3 * * *` | RESTIC | s3-main | 2 hours ago ✓ | run/edit/delete |
| opt weekly | `/opt` | `0 4 * * 0` | RESTIC | s3-main | 5 days ago ✓ | run/edit/delete |
| root daily | `/root` | `0 5 * * *` | TAR | yandex-disk | 1 hour ago ✓ | run/edit/delete |

**Кнопка «Создать»:** modal с DTO выше. Если введён путь из warnlist — показывается confirm: «Этот путь обычно не нужно бэкапить (`/var/log` — лог-файлы много места и не несут ценности). Подтвердить?». Юзер подтверждает → `warningAcknowledged=true` улетает в API.

**История запусков** — таблица как для SITE, но фильтруется по `scope=SERVER_PATH`.

### 5.3 Tab «Данные панели»

**Один-два конфига обычно** (минимум один: hourly в S3).

| Имя | Cron | Движок | Хранилище | Последний | Размер | Действия |
|---|---|---|---|---|---|---|
| panel hourly | `0 * * * *` | RESTIC | s3-main | 12 min ago ✓ | 14 MB | run/edit/delete |

**При создании** — нет выбора путей. Показывается превью того, что попадёт в backup:
- `state/data/.master-key`, legacy keys (если есть).
- `state/.env`, `state/data/servers.json`.
- `state/vpn/`.
- `/etc/letsencrypt/`.
- Snapshot БД (`meowbox.db` через VACUUM INTO).

---

## 6. Restore

### 6.1 SITE

Как сейчас.

### 6.2 SERVER_PATH

**UI кнопка «Restore»** на запись `Backup` → modal:
- Target path (по умолчанию = `config.path`, можно сменить на другой каталог).
- Cleanup checkbox (стереть target перед extract'ом).

API отправляет агенту `restic:restore` с новой семантикой `paths[]`.

### 6.3 PANEL_DATA

**В UI кнопка «Restore» отсутствует** (или ведёт на док с инструкцией).

Восстановление — через CLI скрипт `tools/restore-panel-data.sh`:

```bash
# Использование:
bash tools/restore-panel-data.sh <backup-id> [--target-state-dir=/opt/meowbox/state]
```

Что делает:
1. Скачивает snapshot из StorageLocation (через restic как агент бы делал, но локально).
2. Останавливает API: `pm2 stop meowbox-api meowbox-agent`.
3. Делает текущий снапшот «just in case» в `state/data/snapshots/pre-restore-<ts>/`.
4. Восстанавливает файлы: `.master-key`, `.env`, `servers.json`, `state/vpn/`, `/etc/letsencrypt/`.
5. Восстанавливает `meowbox.db` из VACUUM-снапшота.
6. Стартует API: `pm2 start ecosystem.config.js`.

**Почему через CLI:** API в момент restore не должен трогать БД (race). И юзер обычно восстанавливает PANEL_DATA на новой машине, где UI ещё не настроен.

---

## 7. Изменения в коде (по файлам)

### 7.1 Новые файлы

| Файл | Что |
|---|---|
| `api/src/backups/server-path.service.ts` | CRUD + trigger для SERVER_PATH конфигов |
| `api/src/backups/panel-data.service.ts` | Trigger для PANEL_DATA (VACUUM + paths preset) |
| `api/src/backups/warnlist.ts` | Список опасных путей + matcher |
| `api/src/backups/server-path.controller.ts` | REST endpoints `/backups/server-paths/*` |
| `api/src/backups/panel-data.controller.ts` | REST endpoints `/backups/panel-data/*` |
| `web/pages/backups/server.vue` | UI таба «Сервер» |
| `web/pages/backups/panel-data.vue` | UI таба «Данные панели» |
| `tools/restore-panel-data.sh` | CLI восстановление PANEL_DATA |
| `migrations/system/2026-05-10-003-backup-config-scope.ts` | Default `scope=SITE` для существующих BackupConfig (миграция данных, не схемы) |

### 7.2 Изменения существующих

| Файл | Что меняем |
|---|---|
| `api/prisma/schema.prisma` | + `BackupConfig.scope/name/path/warningAcknowledged`, `siteId → optional`. `Backup.scope/siteId → optional`. |
| `api/src/backups/backups.service.ts` | `triggerBackup` теперь диспатчит на `dispatchSite`/`dispatchServerPath`/`dispatchPanelData` в зависимости от scope. Объединение dispatch'а. |
| `api/src/backups/backups.module.ts` | + новые сервисы и контроллеры. |
| `api/src/scheduler/scheduler.service.ts` | Cron-loop теперь триггерит все enabled BackupConfig независимо от scope (как сейчас, но без фильтра на siteId). |
| `agent/src/backup/backup.manager.ts`, `agent/src/restic/restic.manager.ts` | `rootPath: string` → `paths: string[]`. Цикл бэкапит каждый path как часть одной restic snapshot (restic поддерживает множественные paths в одной команде). |
| `shared/src/ws.ts`, `shared/src/api.ts` | Обновить контракты payload'ов. |
| `shared/src/enums.ts` | + `BackupScope = 'SITE' | 'SERVER_PATH' | 'PANEL_DATA'`. |
| `web/pages/backups/index.vue` | Превратить в layout с табами; вынести текущий контент в `backups/sites.vue`. |
| `Makefile` | + `make backup-panel-data` (одноразовый ручной запуск). |

### 7.3 Миграция данных

`migrations/system/2026-05-10-003-backup-config-scope.ts`:
- Идёт по всем `BackupConfig`, проставляет `scope='SITE'` (default, но явно записываем).
- Аналогично `Backup.scope='SITE'`.
- Идемпотентно через `WHERE scope IS NULL`.

---

## 8. Безопасность

### 8.1 Кто может что

| Действие | Юзер сайта | ADMIN |
|---|---|---|
| Создать/редактировать SITE config своего сайта | ✓ | ✓ |
| Создать/редактировать SERVER_PATH config | ✗ | ✓ |
| Создать/редактировать PANEL_DATA config | ✗ | ✓ |
| Восстановить SITE | ✓ (свой) | ✓ |
| Восстановить SERVER_PATH | ✗ | ✓ |
| Восстановить PANEL_DATA | — (только CLI) | — (только CLI с root SSH) |

### 8.2 Шифрование данных в storage

- **Restic**: `resticPassword` из `StorageLocation` (как сейчас). Один пароль на репу → весь блочный storage зашифрован.
- **TAR**: данные не шифруются на агенте. Если storage S3 — полагаемся на server-side encryption (SSE-S3 / SSE-KMS). Документируем это в UI: при выборе TAR + S3/WebDAV предупреждаем, что данные не шифруются клиентом.

### 8.3 Что не попадает в логи

- Содержимое `state/.env` (никогда не логировать).
- Содержимое `.master-key` / прочих ключей.
- Тело restic snapshot'а.

---

## 9. Тестирование

### 9.1 Unit

- `warnlist.ts`: для каждого dangerous path возвращается true; нормальные пути — false.
- `panel-data.service.ts`: VACUUM INTO создаёт consistent snapshot (smoke test).

### 9.2 E2E (на dev-сервере)

- Создать `PANEL_DATA` конфиг → запустить вручную → проверить наличие snapshot'а в S3.
- Удалить `state/data/.master-key` → запустить `tools/restore-panel-data.sh <backupId>` → убедиться, что ключ восстановлен и `pm2 start` поднимает API.
- Создать `SERVER_PATH` конфиг на `/etc` → запустить → проверить snapshot.
- Попробовать создать `SERVER_PATH` на `/` без `warningAcknowledged` → 409.

---

## 10. Открытые вопросы

- [ ] Глобальный лимит на количество SERVER_PATH конфигов? **Решение: 32 (хардкод, в коде).**
- [ ] Запретить совпадающие пути между SERVER_PATH конфигами (`/etc` два раза)? **Решение: warning в UI, но разрешаем (мог быть умысел — разные расписания в разные хранилища).**
- [ ] Включать ли `/var/www/` в PANEL_DATA по умолчанию? **Решение: нет, для этого есть SITE backup'ы.**
- [ ] Что делать если `restic:backup` упал с OOM на больших путях (`/var/www`)? **Решение: документируем рекомендуемый минимум RAM, лимиты restic — отдельная задача.**

---

## 11. Чек-лист реализации

- [ ] Prisma миграция `+BackupConfig.scope/name/path/warningAcknowledged, siteId nullable`.
- [ ] System migration `2026-05-10-003-backup-config-scope` (проставить scope=SITE на старые).
- [ ] `warnlist.ts` + matcher.
- [ ] `server-path.service.ts` + controller + DTO.
- [ ] `panel-data.service.ts` + controller + DTO + VACUUM INTO логика.
- [ ] Patch `backups.service.ts` — диспатч по scope.
- [ ] Patch `scheduler.service.ts` — без фильтра siteId.
- [ ] Agent: `restic.manager.ts`, `backup.manager.ts` — `paths: string[]`.
- [ ] Shared: `BackupScope` enum, обновлённые payload'ы.
- [ ] Web: layout `/backups` с табами; `backups/sites.vue`, `backups/server.vue`, `backups/panel-data.vue`.
- [ ] CLI: `tools/restore-panel-data.sh`.
- [ ] Доки: README раздел «Бэкап панели», обновить `2026-04-22-sqlite-migration.md` если есть.
- [ ] Audit log events: `BACKUP_CONFIG_CREATED`, `BACKUP_CONFIG_DELETED`, `PANEL_RESTORE_INITIATED`.
- [ ] Тесты warnlist + VACUUM smoke.
- [ ] Релиз с changelog'ом.
