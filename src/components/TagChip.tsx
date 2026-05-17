"use client";

import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import type { TagSummary } from "@/lib/types";

/**
 * Compact tag chip. Renders the tag at the prescribed visual: tiny
 * text, sharp corners, color-tinted background + border + foreground.
 *
 * Why inline style: Tailwind can't generate arbitrary hex utilities at
 * build time, and the tag color is user-defined. We compose the alpha
 * variants with rgba() against the parsed hex so the chip looks the
 * same whether the operator picked from the curated palette or
 * dropped in a custom #rrggbb.
 *
 * `interactive` flips the cursor/focus affordances on. Used by the
 * filter-row chips (clickable) and the host-detail picker (toggle).
 * Static list chips (host list, host header) leave it off.
 */

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  // Defensive: server validates, but a stale row from before the
  // validator landed could still be malformed. Fall back to a neutral
  // slate rather than throw, so the UI degrades gracefully.
  const normalized = hex.trim().replace(/^#/, "");
  const expand = (s: string): string =>
    s.length === 3
      ? s
          .split("")
          .map((c) => c + c)
          .join("")
      : s.slice(0, 6);
  const full = expand(normalized);
  const num = Number.parseInt(full, 16);
  if (Number.isNaN(num)) return { r: 100, g: 116, b: 139 }; // slate-500
  return {
    r: (num >> 16) & 0xff,
    g: (num >> 8) & 0xff,
    b: num & 0xff,
  };
}

export function tagChipStyle(color: string): CSSProperties {
  const { r, g, b } = hexToRgb(color);
  return {
    backgroundColor: `rgba(${r}, ${g}, ${b}, 0.15)`,
    borderColor: `rgba(${r}, ${g}, ${b}, 0.40)`,
    color,
  };
}

interface TagChipProps {
  tag: TagSummary;
  /** Click handler — when set, the chip becomes a button. */
  onClick?: () => void;
  /** Selected state for toggle/filter contexts. Adds a stronger ring. */
  active?: boolean;
  /** Optional trailing count (e.g. "prod 7" in the filter row). */
  count?: number;
  /** Extra classes (e.g. truncation in tight table cells). */
  className?: string;
  /** Render as a static span (default) or interactive <button>. */
  interactive?: boolean;
}

export function TagChip({
  tag,
  onClick,
  active,
  count,
  className,
  interactive,
}: TagChipProps) {
  const style = tagChipStyle(tag.color);
  const base = cn(
    "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] leading-none transition-shadow",
    active && "shadow-[0_0_0_1px_currentColor]",
    className
  );

  if (interactive || onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active ? true : undefined}
        className={cn(
          base,
          "cursor-pointer hover:shadow-[0_0_0_1px_currentColor] focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_currentColor]"
        )}
        style={style}
      >
        <span>{tag.name}</span>
        {typeof count === "number" && (
          <span className="opacity-70">{count}</span>
        )}
      </button>
    );
  }
  return (
    <span className={base} style={style}>
      <span>{tag.name}</span>
      {typeof count === "number" && (
        <span className="opacity-70">{count}</span>
      )}
    </span>
  );
}
