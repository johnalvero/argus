-- Add configurable data retention to CollectorConfig.
--
-- Three fields:
--   • reportRetentionDays      — replaces the previously hardcoded 30-day
--                                per-host report prune in /api/v1/reports.
--   • inactiveHostRetentionDays — nullable; when set, hosts whose
--                                 lastReportAt is older than this are
--                                 deleted entirely (Reports + HostPackages
--                                 cascade via existing FK). Null = today's
--                                 behavior (hosts live forever).
--   • lastCleanupAt            — throttle marker for the auto-cleanup
--                                hook in the ingest path.
--
-- SQLite uses the column DEFAULT for existing rows on ADD COLUMN, so
-- no backfill is needed for the non-null int. The two nullable columns
-- pick up NULL.

ALTER TABLE "CollectorConfig" ADD COLUMN "reportRetentionDays" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "CollectorConfig" ADD COLUMN "inactiveHostRetentionDays" INTEGER;
ALTER TABLE "CollectorConfig" ADD COLUMN "lastCleanupAt" DATETIME;
