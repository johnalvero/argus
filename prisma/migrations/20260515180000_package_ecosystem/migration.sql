-- Add ecosystem discriminator + provenance hint to HostPackage so we
-- can store language-level packages (pip/npm/gem/composer/cargo) next
-- to OS-native ones. Existing rows backfill to ecosystem='os'.

ALTER TABLE "HostPackage" ADD COLUMN "ecosystem" TEXT NOT NULL DEFAULT 'os';
ALTER TABLE "HostPackage" ADD COLUMN "location" TEXT;

-- Replace the old unique constraint with one that includes ecosystem,
-- so the same package name+version can appear under both "os" and "pip"
-- on the same host (e.g. python3-pip the OS package vs pip the
-- language).
DROP INDEX IF EXISTS "HostPackage_hostId_name_version_arch_key";
CREATE UNIQUE INDEX "HostPackage_hostId_ecosystem_name_version_arch_key"
  ON "HostPackage"("hostId", "ecosystem", "name", "version", "arch");

-- Cross-fleet ecosystem-filtered search ("which hosts run npm
-- express@4.x?") is the v1.1 motivation; the index keeps that hot.
CREATE INDEX "HostPackage_ecosystem_name_idx"
  ON "HostPackage"("ecosystem", "name");
