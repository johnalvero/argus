"use client";

import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { SEVERITY_COLORS, toSeverityBucket } from "@/lib/severity";

/**
 * Single source of truth for the severity pill. Solid-tint background +
 * white text matches the spec ("small Badge-style pills with the colors
 * above, white text"). Color comes from the shared severity palette.
 *
 * Renders the bucket label in uppercase. Pass a non-canonical string and
 * it gets coerced via `toSeverityBucket` — defensive against the DB
 * occasionally having "Unknown" / lowercase strings on older rows.
 */
export function SeverityBadge({
  severity,
  className,
}: {
  severity: string | null | undefined;
  className?: string;
}) {
  const bucket = toSeverityBucket(severity);
  const color = SEVERITY_COLORS[bucket];
  const style: CSSProperties = {
    backgroundColor: color,
    color: "#ffffff",
    // Tone the border so the pill reads as a single block at small
    // sizes — solid bg + transparent border keeps the size identical
    // to the regular Badge.
    borderColor: "transparent",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wide",
        className
      )}
      style={style}
    >
      {bucket}
    </span>
  );
}
