-- User-selectable display timezone. NULL means "browser default" —
-- the client falls back to Intl.DateTimeFormat().resolvedOptions().timeZone.
-- Values are IANA tz database names (e.g. "Asia/Manila", "UTC").
ALTER TABLE "User" ADD COLUMN "timezone" TEXT;
