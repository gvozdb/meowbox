-- Догоняющая миграция: implicit many-to-many join-таблицы для
-- ServerPathBackupConfig ↔ StorageLocation и PanelDataBackupConfig ↔ StorageLocation.
-- Эти relations были объявлены в schema.prisma вместе с моделями (миграция 10),
-- но Prisma-таблицы _<ModelA>To<ModelB> для них не были созданы — отсюда падал
-- prisma.serverPathBackupConfig.create({ storageLocations: { connect: ... } }).
--
-- Поле storage_location_ids (JSON) остаётся для быстрого чтения списка id без JOIN,
-- relation-таблица используется Prisma'й для include/connect/disconnect.

-- ServerPathBackupConfig ↔ StorageLocation
CREATE TABLE IF NOT EXISTS "_ServerPathBackupConfigToStorageLocation" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    FOREIGN KEY ("A") REFERENCES "server_path_backup_configs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("B") REFERENCES "storage_locations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "_ServerPathBackupConfigToStorageLocation_AB_unique"
    ON "_ServerPathBackupConfigToStorageLocation"("A" ASC, "B" ASC);
CREATE INDEX IF NOT EXISTS "_ServerPathBackupConfigToStorageLocation_B_index"
    ON "_ServerPathBackupConfigToStorageLocation"("B" ASC);

-- PanelDataBackupConfig ↔ StorageLocation
CREATE TABLE IF NOT EXISTS "_PanelDataBackupConfigToStorageLocation" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    FOREIGN KEY ("A") REFERENCES "panel_data_backup_configs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("B") REFERENCES "storage_locations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "_PanelDataBackupConfigToStorageLocation_AB_unique"
    ON "_PanelDataBackupConfigToStorageLocation"("A" ASC, "B" ASC);
CREATE INDEX IF NOT EXISTS "_PanelDataBackupConfigToStorageLocation_B_index"
    ON "_PanelDataBackupConfigToStorageLocation"("B" ASC);
