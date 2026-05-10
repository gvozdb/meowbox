# Master-Key Unification — спецификация

**Статус:** draft
**Дата:** 2026-05-10
**Автор:** Pavel
**Slug:** `master-key-unification`

---

## 1. Зачем

Сейчас в панели **4 независимых ключа** шифрования + **2 поля с паролями в открытом виде** в БД. Это:
- разрозненный bookkeeping (бэкапить надо несколько разных файлов и env-переменных);
- риск потери одного из ключей при ручных операциях;
- **критическая дыра**: `Site.sshPassword` и `Site.cmsAdminPassword` лежат в `meowbox.db` plain text. Доступ к БД (через бэкап без шифрования, дамп, кражу диска) = SSH-пароли всех сайтов и админки всех CMS уходят как есть.

### 1.1 Цели

- Единый **`.master-key`** (32 байта, AES-256, perms 600) — один файл бэкапить, одна env-переменная для override.
- **HKDF-SHA256** для доменных подключей (VPN, DNS, Migration, Adminer-SSO, SSH, CMS) — компрометация одного подключа не валит остальные семантически, ротация одного домена возможна (хотя в MVP не делаем).
- **Зашифровать** `sshPassword` и `cmsAdminPassword` в БД (новые поля `sshPasswordEnc`, `cmsAdminPasswordEnc`).
- Полная **идемпотентная миграция** существующих зашифрованных blob'ов на новые ключи.
- UI «показать пароль» продолжает работать через расшифровку на лету.

### 1.2 Не-цели

- **Ротация master-key** — отдельная задача, не в этой спеке (но архитектура должна позволять).
- **Внешний KMS** (Vault, AWS KMS) — env-override `MEOWBOX_MASTER_KEY` достаточно как первый шаг.
- **Шифрование `state/.env`** — он на диске perms 600, отдельная задача (не сейчас).
- **Шифрование `passwordHash` админа панели** — argon2 hash уже невосстановим, ничего шифровать не нужно.

---

## 2. Текущее состояние

### 2.1 Шифрующие модули (`api/src/common/crypto/`)

| Cipher | Источник ключа | Что шифрует |
|---|---|---|
| `vpn-cipher.ts` | env `VPN_SECRET_KEY` ИЛИ файл `${MEOWBOX_DATA_DIR}/.vpn-key` (autogen) | `VpnService.configBlob`, `VpnUser.credsBlob` |
| `credentials-cipher.ts` | env `DNS_CREDENTIAL_KEY` ИЛИ файл `${MEOWBOX_DATA_DIR}/.dns-key` (autogen) | `DnsProvider.credentialsEnc`, `Database.dbPasswordEnc` |
| `migration-cipher.ts` | **только** env `MIGRATION_SECRET` | Source-server credentials в `migration-hostpanel` |
| `adminer-cipher.ts` | **только** env `ADMINER_SSO_KEY` | Adminer SSO ticket (short-lived токен) |

### 2.2 Plain text в БД (КРИТИЧНО)

| Поле | Тип | Где пишется |
|---|---|---|
| `Site.sshPassword` | String? | `sites.service.ts:609`, `migration-hostpanel.service.ts` |
| `Site.cmsAdminPassword` | String? | `sites.service.ts:703`, `migration-hostpanel.service.ts` |

### 2.3 Argon2 hash в БД (норм, ничего не делаем)

| Поле | Использование |
|---|---|
| `User.passwordHash` | Login админа панели |
| `Database.dbPasswordHash` | Verify пароля БД (плейн пароль хранится в `dbPasswordEnc` для Adminer SSO) |

---

## 3. Целевая архитектура

### 3.1 Master-key

**Источник** (по приоритету):
1. env `MEOWBOX_MASTER_KEY` — 32 байта в base64 (override для prod / secret-manager).
2. файл `${MEOWBOX_STATE_DIR}/data/.master-key` — 32 байта бинарных, perms 600.
3. Автогенерация при первом старте, если файла нет (только если не запрещено флагом `MEOWBOX_NO_AUTOGEN_MASTER_KEY=1`).

**Имя файла:** `.master-key` (без `meowbox-` префикса — он и так в `state/data/`).

**Бэкап:** включается в backup scope `PANEL_DATA` (см. спеку `unified-backups`).

### 3.2 HKDF-SHA256 — доменные подключи

```ts
// api/src/common/crypto/master-key.ts (новый)
import * as crypto from 'crypto';

const MASTER = loadMasterKey(); // 32 bytes

function deriveSubKey(domainSeparator: string, keyLen = 32): Buffer {
  return crypto.hkdfSync('sha256', MASTER, /* salt */ Buffer.alloc(0), domainSeparator, keyLen) as Buffer;
}

export const KEYS = {
  vpn:        () => deriveSubKey('meowbox:vpn:v1'),
  dns:        () => deriveSubKey('meowbox:dns:v1'),       // ex-credentials-cipher (для DNS providers)
  databases:  () => deriveSubKey('meowbox:databases:v1'), // ex-credentials-cipher (для Database.dbPasswordEnc) — разделено явно
  migration:  () => deriveSubKey('meowbox:migration:v1'),
  adminerSso: () => deriveSubKey('meowbox:adminer-sso:v1'),
  ssh:        () => deriveSubKey('meowbox:ssh:v1'),       // NEW для Site.sshPasswordEnc
  cms:        () => deriveSubKey('meowbox:cms:v1'),       // NEW для Site.cmsAdminPasswordEnc
};
```

> **Замечание:** сейчас `credentials-cipher` шифрует и DNS и Database — одним ключом. После унификации разделяем на два разных domain separator'а, чтобы будущая ротация одного не задевала другое. При перешифровке оба blob'а проходят через `KEYS.dns()` (legacy) и сохраняются через новые `KEYS.dns()` / `KEYS.databases()`.

### 3.3 Формат шифротекста

Остаётся как сейчас — `AES-256-GCM`, payload `iv(12) | tag(16) | ciphertext`, base64. Меняем только источник ключа.

### 3.4 Новые поля в БД

```prisma
model Site {
  // ... существующие ...
  sshPassword           String?  @map("ssh_password")            // DEPRECATED — обнуляется миграцией
  sshPasswordEnc        String?  @map("ssh_password_enc")        // NEW
  cmsAdminPassword      String?  @map("cms_admin_password")      // DEPRECATED — обнуляется миграцией
  cmsAdminPasswordEnc   String?  @map("cms_admin_password_enc")  // NEW
}
```

**План удаления старых полей:**
- В этой спеке: добавляем `*Enc`, миграция переносит, **в коде читаем/пишем только `*Enc`**. Старые остаются в схеме `@deprecated` (комментарий), не используются.
- Через 30 дней после релиза (отдельная prisma миграция): `DROP COLUMN ssh_password`, `DROP COLUMN cms_admin_password`.

---

## 4. Миграции

### 4.1 Prisma миграция

`api/prisma/migrations/<ts>_add_encrypted_site_secrets/migration.sql`:

```sql
ALTER TABLE "sites" ADD COLUMN "ssh_password_enc" TEXT;
ALTER TABLE "sites" ADD COLUMN "cms_admin_password_enc" TEXT;
```

(SQLite — простая `ADD COLUMN`, без default → существующие строки получают NULL.)

### 4.2 Системная миграция 1 — bootstrap master-key

`migrations/system/2026-05-10-001-master-key-bootstrap.ts`:

**Что делает (идемпотентно):**
1. Проверяет, есть ли `state/data/.master-key`. Если есть → return.
2. Проверяет env `MEOWBOX_MASTER_KEY`. Если есть и валиден (32 байта base64) → ничего не делает (env имеет приоритет, файл не создаём, чтобы не дублировать).
3. Если ни файла, ни env → генерит `crypto.randomBytes(32)`, пишет в `state/data/.master-key` с perms 600 (atomic via tmp+rename), логирует warning «новый master-key сгенерирован, БЭКАПЬ ЕГО».

**Проверка перед изменением:** `if (await exists(KEY_PATH) || process.env.MEOWBOX_MASTER_KEY) return;`

### 4.3 Системная миграция 2 — rekey всех blob'ов

`migrations/system/2026-05-10-002-rekey-secrets.ts`:

**Pre-flight:**
- Снапшот: `bash tools/snapshot.sh` (обёртка, чтобы попало в `state/data/snapshots/pre-rekey-<ts>/`).
- Если флаг `done` уже стоит в `meowbox_migrations_meta` (или просто проверка «есть ли хоть один blob, расшифровываемый только новым ключом») → skip.

**Этапы (каждый — отдельная transaction-обёртка где SQLite позволяет, либо retry-safe):**

1. **Загрузка legacy-ключей**:
   - `legacyVpn`: env `VPN_SECRET_KEY` или файл `.vpn-key`.
   - `legacyDns`: env `DNS_CREDENTIAL_KEY` или файл `.dns-key`.
   - `legacyMigration`: env `MIGRATION_SECRET` (обязателен — если нет, миграции source-creds можно скипнуть, warning).
   - Adminer SSO ключ перешифровывать не нужно — ticket'ы одноразовые и короткоживущие, поэтому после смены ключа активные сессии просто инвалидируются (warning в UI).

2. **Перешифровка существующих enc-полей**:
   - `Database.dbPasswordEnc`: legacyDns → `KEYS.databases()`.
   - `DnsProvider.credentialsEnc`: legacyDns → `KEYS.dns()`.
   - `VpnService.configBlob`, `VpnUser.credsBlob`: legacyVpn → `KEYS.vpn()`.
   - `MigrationJob.encryptedCreds` (если есть таблица): legacyMigration → `KEYS.migration()`.

3. **Шифрование plain-полей `sshPassword`/`cmsAdminPassword`**:
   - Для каждой `Site` где `sshPassword IS NOT NULL`:
     - `sshPasswordEnc = encrypt(plain, KEYS.ssh())`
     - `sshPassword = NULL` (обнуляем!)
   - Аналогично для `cmsAdminPassword`.

4. **Финализация**:
   - Старые ключи на диске переименовываются: `.vpn-key` → `.vpn-key.legacy.<ts>`, `.dns-key` → `.dns-key.legacy.<ts>` (не удаляем — оставляем на месяц для отката).
   - Записываем флаг done в `meowbox_migrations_meta`.

**Идемпотентность:**
- Каждый этап проверяет, можно ли расшифровать новым ключом. Если уже зашифровано новым — skip.
- Перешифровка делается через `try { decrypt(legacy) } catch { try { decrypt(new); return /* already migrated */ } }`.

**Recovery после падения посреди миграции:**
- Если упало на этапе 2.x — повторный запуск увидит, что часть blob'ов уже на новом ключе, остальные — на старом, и доделает.
- Снапшот `pre-rekey-<ts>/` всё ещё есть.

### 4.4 Системная миграция 3 — cleanup legacy ключей (отложенная)

`migrations/system/2026-06-10-001-rekey-legacy-cleanup.ts` (примерно через месяц после релиза):

- Удаляет `.vpn-key.legacy.*`, `.dns-key.legacy.*` если они старше 30 дней.
- Только если миграция 2 успешно завершилась.

---

## 5. Изменения в коде (по файлам)

### 5.1 Новые файлы

| Файл | Что |
|---|---|
| `api/src/common/crypto/master-key.ts` | Загрузка master-key + HKDF-derive подключей |
| `api/src/common/crypto/ssh-cipher.ts` | `encryptSshPassword` / `decryptSshPassword` (через `KEYS.ssh()`) |
| `api/src/common/crypto/cms-cipher.ts` | `encryptCmsPassword` / `decryptCmsPassword` (через `KEYS.cms()`) |
| `migrations/system/2026-05-10-001-master-key-bootstrap.ts` | Bootstrap файла |
| `migrations/system/2026-05-10-002-rekey-secrets.ts` | Перешифровка всех blob'ов |
| `migrations/system/2026-06-10-001-rekey-legacy-cleanup.ts` | Удаление legacy-ключей (отложенная) |

### 5.2 Изменения существующих cipher'ов

| Файл | Что меняем |
|---|---|
| `vpn-cipher.ts` | `loadKey()` → `KEYS.vpn()`, удалить readFromEnv/readFromFile/generateAndPersist. Имя env `VPN_SECRET_KEY` оставить как **fallback** (если master-key недоступен, но legacy ключ есть — для smooth-upgrade). |
| `credentials-cipher.ts` | Разделить на `dns-cipher.ts` (для DNS) и `database-cipher.ts` (для БД). Старый `credentials-cipher.ts` оставить как re-export shim для обратной совместимости imports. |
| `migration-cipher.ts` | `loadKey()` → `KEYS.migration()`. env `MIGRATION_SECRET` остаётся как fallback. |
| `adminer-cipher.ts` | `loadKey()` → `KEYS.adminerSso()`. env `ADMINER_SSO_KEY` остаётся как fallback. |

### 5.3 Sites service / DTO / Web

| Файл | Что меняем |
|---|---|
| `api/prisma/schema.prisma` | + `sshPasswordEnc`, `cmsAdminPasswordEnc` (комментарий: старые поля deprecated). |
| `api/src/sites/sites.service.ts` | **Все** записи `sshPassword`/`cmsAdminPassword` заменяем на `sshPasswordEnc = encryptSshPassword(plain)` / `cmsAdminPasswordEnc = encryptCmsPassword(plain)`. **Все** чтения (метод `getCredentials`, ~590) — на `decryptSshPassword(site.sshPasswordEnc)`. Учесть: `omit: { sshPassword: true, cmsAdminPassword: true }` → теперь omit'им и `*Enc` тоже из обычных list/detail endpoint'ов. Расшифровка только в `getCredentials`. |
| `api/src/sites/sites.dto.ts` | Без изменений (DTO принимает plain пароль; шифруется в service). |
| `api/src/migration-hostpanel/migration-hostpanel.service.ts` | Те же замены — пишем `sshPasswordEnc`/`cmsAdminPasswordEnc`. |
| `agent/src/agent.service.ts`, `agent/src/migration/hostpanel/run-item.ts` | **Не меняем** — агент работает с plain паролем в RAM (для `usermod --password`). API расшифровывает перед отправкой агенту через socket (внутренний канал, AGENT_SECRET-аутентифицированный). |
| `web/pages/sites/[id].vue`, `sites/create.vue` | UI остаётся как есть — credentials endpoint отдаёт `password` plain текстом, юзер видит/копирует. |

### 5.4 Конфиг и docs

| Файл | Что |
|---|---|
| `.env.example` | + `MEOWBOX_MASTER_KEY=<32-bytes-base64-or-empty>` с комментарием. |
| `tools/snapshot.sh` | + `.master-key` рядом с `.vpn-key`. |
| `README.md` | Раздел про безопасность — упомянуть `.master-key` и важность бэкапа. |
| `docs/specs/2026-05-09-vpn-management.md` | Обновить §6 «Шифрование» — указать что master-key теперь единый. |

---

## 6. UI «показать пароль»

- **Что было:** `GET /sites/:id/credentials` возвращает `{ ssh: { password }, cms: { password } }` (plain из БД).
- **Что становится:** тот же endpoint, plain пароль = `decryptSshPassword(site.sshPasswordEnc)` на лету. Никаких изменений в API контракте.
- **UX без изменений:** кнопка «показать пароль» → копирование → audit log.

---

## 7. Безопасность

### 7.1 Угрозы и митигации

| Угроза | Митигация |
|---|---|
| Кража `meowbox.db` | Все секреты в БД зашифрованы. Атакующему нужен ещё `.master-key`. |
| Кража `.master-key` без БД | Бесполезен — нет шифротекстов. |
| Кража и БД и `.master-key` | Защита проиграна (как и в любой системе с локальным KMS). Митигация: env-override через secret-manager, тогда `.master-key` отсутствует на диске. |
| Потеря `.master-key` | Все секреты невосстановимы. **Бэкапить `state/data/.master-key` отдельно** (хотя он попадёт в backup `PANEL_DATA`). |
| Утечка plain пароля через лог | Не логируем расшифрованные пароли никогда. Lint check (TODO: добавить eslint rule на запрет `console.log(password)`). |

### 7.2 Аудит

- Каждое расшифровывание пароля в `getCredentials` → запись в `AuditLog` (event `CREDENTIAL_VIEWED`, kind=ssh|cms, siteId).
- Каждая запись/обновление пароля → запись в `AuditLog` (event `CREDENTIAL_CHANGED`).

---

## 8. Откат

Если миграция 2 (`rekey-secrets`) сломала что-то критическое:

1. Остановить панель: `pm2 stop meowbox-api meowbox-agent`.
2. Восстановить БД из снапшота: `cp state/data/snapshots/pre-rekey-<ts>/meowbox.db state/data/meowbox.db`.
3. Удалить новый `.master-key` (или сохранить, но переименовать).
4. Восстановить legacy ключи: `mv state/data/.vpn-key.legacy.<ts> state/data/.vpn-key` (и для `.dns-key`).
5. Откатить prisma миграцию: `psql/sqlite3 → ALTER TABLE sites DROP COLUMN ssh_password_enc; DROP COLUMN cms_admin_password_enc;` (SQLite — через `CREATE TABLE _new + COPY + DROP + RENAME`).
6. Откатить релиз: `make rollback`.

(В готовой реализации скрипт `tools/rollback-master-key.sh` собирает это в один шаг.)

---

## 9. Чек-лист реализации

- [ ] `master-key.ts` (loadMasterKey + HKDF + `KEYS`).
- [ ] `ssh-cipher.ts`, `cms-cipher.ts`.
- [ ] Переписать `vpn-cipher.ts`, `credentials-cipher.ts` (→ `dns-cipher.ts` + `database-cipher.ts`), `migration-cipher.ts`, `adminer-cipher.ts` на новые ключи (fallback на legacy env для smooth-upgrade).
- [ ] Prisma миграция `+sshPasswordEnc, +cmsAdminPasswordEnc`.
- [ ] System migration `master-key-bootstrap`.
- [ ] System migration `rekey-secrets` (идемпотентная, snapshot, retry-safe).
- [ ] Patch `sites.service.ts` (запись + чтение, omit).
- [ ] Patch `migration-hostpanel.service.ts`.
- [ ] Patch `tools/snapshot.sh` (+ `.master-key`).
- [ ] Update `.env.example`, `README.md`, `2026-05-09-vpn-management.md`.
- [ ] Тесты на cipher'ы (hkdf consistency, encrypt→decrypt roundtrip).
- [ ] Audit log events `CREDENTIAL_VIEWED` / `CREDENTIAL_CHANGED`.
- [ ] System migration `rekey-legacy-cleanup` (отложенная, через 30 дней).
- [ ] Релиз с changelog'ом.

---

## 10. Открытые вопросы

- [ ] Делать ли в этой же спеке поле `Site.adminerSsoSeen` (audit) — или это уже scope другой задачи? **Решение: scope другой.**
- [ ] Шифровать ли `User.totpSecret`? Сейчас он plain. **Решение: да, в отдельной задаче — расширение scope этой спеки опасно.**
- [ ] Реализация `MEOWBOX_NO_AUTOGEN_MASTER_KEY=1` для prod (явный отказ автогенерить) — **да, добавить flag.**
