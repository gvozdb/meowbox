-- CreateTable
CREATE TABLE "country_blocks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "country" TEXT NOT NULL,
    "ports" TEXT,
    "protocol" TEXT NOT NULL DEFAULT 'BOTH',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "comment" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "country_blocks_country_ports_protocol_key" ON "country_blocks"("country", "ports", "protocol");
