"use client";

import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import {
  SEVERITY_BUCKETS,
  SEVERITY_COLORS,
} from "@/lib/severity";
import type { SeverityBucket, SeverityCounts } from "@/lib/types";

/**
 * Five-card severity strip used at the top of the vulnerability list and
 * the per-host vulnerability section. When `onToggle` is provided each
 * card is interactive — clicking toggles that bucket in the parent's
 * filter set (additive, like the existing tag filter chips). When
 * omitted (host detail), the cards render as static read-only stats.
 *
 * Active cards get a solid color ring + colored title; inactive cards
 * tone down to a neutral surface so the active selection pops.
 */
export function SeverityStrip({
  counts,
  active,
  onToggle,
  className,
}: {
  counts: SeverityCounts;
  active?: Set<SeverityBucket>;
  onToggle?: (bucket: SeverityBucket) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5",
        className
      )}
    >
      {SEVERITY_BUCKETS.map((bucket) => (
        <SeverityCard
          key={bucket}
          bucket={bucket}
          count={counts[bucket]}
          active={active?.has(bucket) ?? false}
          interactive={Boolean(onToggle)}
          onClick={onToggle ? () => onToggle(bucket) : undefined}
        />
      ))}
    </div>
  );
}

function SeverityCard({
  bucket,
  count,
  active,
  interactive,
  onClick,
}: {
  bucket: SeverityBucket;
  count: number;
  active: boolean;
  interactive: boolean;
  onClick?: () => void;
}) {
  const color = SEVERITY_COLORS[bucket];
  // Active uses a colored ring + colored title; inactive sits flat with
  // the muted border so the row reads as a filter strip not a chart.
  const style: CSSProperties = active
    ? {
        // 2px colored ring via box-shadow for sharp corners + no layout
        // shift when toggling.
        boxShadow: `inset 0 0 0 2px ${color}`,
        borderColor: "transparent",
      }
    : {};

  const content = (
    <>
      <div
        className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: active ? color : undefined }}
      >
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: color }}
        />
        {bucket}
      </div>
      <div className="mt-1 font-mono text-2xl tabular-nums">{count}</div>
    </>
  );

  const cls = cn(
    "flex flex-col items-start rounded-md border bg-card px-3 py-2 text-left transition-shadow",
    interactive &&
      "cursor-pointer hover:shadow-sm focus-visible:outline-none focus-visible:shadow-md",
    !active && !interactive && "text-muted-foreground/90"
  );

  if (interactive) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className={cls}
        style={style}
      >
        {content}
      </button>
    );
  }
  return (
    <div className={cls} style={style}>
      {content}
    </div>
  );
}
