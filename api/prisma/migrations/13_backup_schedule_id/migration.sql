-- Backup.scheduleId — связь per-site бэкапа с SiteBackupSchedule,
-- по которому он запущен. Используется в completeBackup() для
-- маршрутизации уведомления через NotificationDigestQueue
-- (notificationMode шедуля = DIGEST → пачка вместо отдельных сообщений).

ALTER TABLE "backups" ADD COLUMN "schedule_id" TEXT REFERENCES "site_backup_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "backups_schedule_id_idx" ON "backups"("schedule_id");
