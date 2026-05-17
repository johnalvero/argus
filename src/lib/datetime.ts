"use client";

import { useMe } from "@/lib/useMe";

/**
 * Resolve the timezone we should render datetimes in:
 *   1. The user's explicit preference (User.timezone), if set
 *   2. Otherwise the browser's detected zone
 *   3. Otherwise UTC (server-rendered fallback before the browser API is
 *      available — only matters for the very first paint)
 */
export function useUserTimezone(): string {
  const { data: me } = useMe();
  if (me?.timezone) return me.timezone;
  if (typeof Intl !== "undefined") {
    try {
      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (detected) return detected;
    } catch {
      /* fall through */
    }
  }
  return "UTC";
}

/**
 * Format an ISO timestamp in the user's preferred timezone. Defaults to
 * a compact date+time. Pass `options` to override (e.g. for a
 * date-only or time-only render).
 */
export function formatInZone(
  iso: string | Date,
  zone: string,
  options?: Intl.DateTimeFormatOptions
): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    ...options,
  }).format(d);
}

/**
 * React-hook flavour — pulls the user's zone via context and formats.
 * Use in components that already render with the user session in scope.
 */
export function useFormatDateTime() {
  const zone = useUserTimezone();
  return (iso: string | Date, options?: Intl.DateTimeFormatOptions) =>
    formatInZone(iso, zone, options);
}
