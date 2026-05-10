-- Site: переход с plain text паролей SSH/CMS-админки на зашифрованные.
-- См. docs/specs/2026-05-10-master-key-unification.md.
--
-- Шаги:
--   1. Добавляем enc-колонки.
--   2. Перенос plain → enc делает system-миграция 2026-05-10-002-rekey-secrets
--      (она запускается ПОСЛЕ prisma migrate deploy в make update).
--   3. После переноса system-миграция DROP'ает старые plain-колонки и делает
--      VACUUM для физической очистки страниц БД (защита от чтения plain паролей
--      из старых страниц при дампе/бэкапе .db файла).
--
-- Здесь только шаг 1: добавление колонок. Шаги 2-3 — в system-миграции,
-- т.к. требуют расшифровки/шифрования через master-key.
ALTER TABLE "sites" ADD COLUMN "ssh_password_enc" TEXT;
ALTER TABLE "sites" ADD COLUMN "cms_admin_password_enc" TEXT;
