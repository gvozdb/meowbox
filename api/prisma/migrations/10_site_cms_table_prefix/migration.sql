-- Site.cmsTablePrefix — префикс таблиц БД для CMS (MODX).
-- Задаётся при создании сайта (рандомный `[a-z]{7}_` или кастомный), дальше
-- read-only — менять смысла нет, иначе пришлось бы переименовывать таблицы.
-- NULL = legacy сайты до этой миграции → fallback на MODX_DB_DEFAULTS.TABLE_PREFIX ("modx_").
ALTER TABLE "sites" ADD COLUMN "cms_table_prefix" TEXT;
