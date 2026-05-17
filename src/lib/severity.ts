import type { SeverityBucket, SeverityCounts } from "@/lib/types";

/**
 * Shared severity palette + helpers. Keep this in one place so the
 * vulnerability list strip, the badges, and the host-list dots all
 * agree byte-for-byte on what "CRITICAL" looks like.
 *
 * Colors are literal hex on purpose — Tailwind can't generate
 * arbitrary palette utilities at build time and we want the chip /
 * badge / dot to render identically whether we paint with bg, ring, or
 * border. Match the spec:
 *   CRITICAL → red-500
 *   HIGH     → orange-500
 *   MEDIUM   → amber-500
 *   LOW      → blue-500
 *   UNKNOWN  → slate-500
 */
export const SEVERITY_COLORS: Record<SeverityBucket, string> = {
  CRITICAL: "#ef4444",
  HIGH: "#f97316",
  MEDIUM: "#f59e0b",
  LOW: "#3b82f6",
  UNKNOWN: "#64748b",
};

export const SEVERITY_BUCKETS: SeverityBucket[] = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "UNKNOWN",
];

/** Numeric weight for sort-by-severity. Higher = worse. */
const SEVERITY_RANK: Record<SeverityBucket, number> = {
  CRITICAL: 5,
  HIGH: 4,
  MEDIUM: 3,
  LOW: 2,
  UNKNOWN: 1,
};

/**
 * Coerce a free-form DB string (or null) to a canonical bucket.
 * Tolerant of casing and the case where the sync stored null —
 * everything unknown rounds up to "UNKNOWN" rather than crashing.
 */
export function toSeverityBucket(s: string | null | undefined): SeverityBucket {
  if (!s) return "UNKNOWN";
  const upper = s.toUpperCase();
  if (
    upper === "CRITICAL" ||
    upper === "HIGH" ||
    upper === "MEDIUM" ||
    upper === "LOW"
  ) {
    return upper;
  }
  return "UNKNOWN";
}

export function severityRank(s: string | null | undefined): number {
  return SEVERITY_RANK[toSeverityBucket(s)];
}

export function emptySeverityCounts(): SeverityCounts {
  return { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
}
