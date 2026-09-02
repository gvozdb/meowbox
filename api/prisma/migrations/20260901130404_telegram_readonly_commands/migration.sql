/*
  Warnings:

  - A unique constraint covering the columns `[command_bot_token_hash]` on the table `notification_settings` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "notification_settings" ADD COLUMN "command_bot_token_hash" TEXT;
ALTER TABLE "notification_settings" ADD COLUMN "telegram_next_update_id" TEXT;
ALTER TABLE "notification_settings" ADD COLUMN "telegram_commands_enabled_at" DATETIME;
ALTER TABLE "notification_settings" ADD COLUMN "telegram_lease_owner" TEXT;
ALTER TABLE "notification_settings" ADD COLUMN "telegram_lease_expires_at" DATETIME;

-- CreateIndex
CREATE UNIQUE INDEX "notification_settings_command_bot_token_hash_key" ON "notification_settings"("command_bot_token_hash");
CREATE INDEX "notification_settings_telegram_lease_expires_at_idx" ON "notification_settings"("telegram_lease_expires_at");
