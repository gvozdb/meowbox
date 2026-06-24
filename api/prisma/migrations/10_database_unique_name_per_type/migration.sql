-- Databases: имя БД больше не глобально-уникально. Уникальность теперь
-- composite (name, type) — на сервере MariaDB и PostgreSQL это разные
-- namespace, и запрет на повтор имени между движками блокировал создание
-- pg-БД, если такое имя уже занято под MariaDB.
--
-- Шаги:
--   1. Сносим прежний UNIQUE(name).
--   2. Создаём UNIQUE(name, type).
--
-- Идемпотентно: оба DROP/CREATE используют IF NOT EXISTS / IF EXISTS,
-- чтобы повторный запуск не падал. Существующие записи не трогаем —
-- дубликаты по (name, type) теоретически невозможны (старый UNIQUE
-- запрещал даже одиночное повторение name).
DROP INDEX IF EXISTS "databases_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "databases_name_type_key" ON "databases"("name", "type");
