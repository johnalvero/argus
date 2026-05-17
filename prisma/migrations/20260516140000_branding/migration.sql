-- Admin-configurable branding (singleton).
--
-- One row, name="default", mirroring the CollectorConfig pattern.
-- Defaults match the hardcoded strings the sidebar currently shows
-- ("Converge ICT") so this migration is a true no-op for existing
-- installs — the UI looks identical until an admin uploads a logo or
-- renames the org from /settings/branding.
--
-- Logo is stored inline as BLOB so v1 has no extra moving parts. Bytes
-- are sanity-bounded at 500 KB in the upload handler; SQLite has no
-- size limit on a BLOB column itself.

CREATE TABLE "Branding" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "companyName" TEXT NOT NULL DEFAULT 'Converge ICT',
    "logoData" BLOB,
    "logoMimeType" TEXT,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "Branding_name_key" ON "Branding"("name");

-- Seed the singleton row so the public GET works immediately on a fresh
-- deploy. logoData + logoMimeType stay NULL; companyName takes the
-- column default.
INSERT INTO "Branding" ("name", "updatedAt")
VALUES ('default', CURRENT_TIMESTAMP);
