-- Site: добавляем поля для зашифрованных паролей SSH/CMS-админки.
-- См. docs/specs/2026-05-10-master-key-unification.md.
--
-- Старые поля `ssh_password` и `cms_admin_password` (plain text!) остаются на
-- время миграции — system-миграция `2026-05-10-002-rekey-secrets` переносит
-- значения plain → enc и обнуляет старые. Сами колонки будут дропнуты
-- отдельной prisma-миграцией через 30 дней.
ALTER TABLE "sites" ADD COLUMN "ssh_password_enc" TEXT;
ALTER TABLE "sites" ADD COLUMN "cms_admin_password_enc" TEXT;
