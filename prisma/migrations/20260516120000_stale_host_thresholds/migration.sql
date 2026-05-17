-- Add operator-facing UI thresholds for the host list's staleness dot.
--
-- These are NOT agent toggles. They co-locate on CollectorConfig only
-- to avoid a second singleton model for two integer fields. See the
-- schema comment on CollectorConfig for the rationale.
--
-- SQLite uses the column DEFAULT for existing rows on ADD COLUMN, so
-- no backfill is needed — the singleton row picks up 1 / 3 days.

ALTER TABLE "CollectorConfig" ADD COLUMN "staleHostAmberDays" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "CollectorConfig" ADD COLUMN "staleHostRedDays" INTEGER NOT NULL DEFAULT 3;
