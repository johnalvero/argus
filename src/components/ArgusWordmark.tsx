/**
 * "ARGUS" rendered as 7×9 pixel-art letters, each in its own color.
 *
 * Hand-laid pixel grid via SVG <rect>s. SVG `shape-rendering="crispEdges"`
 * keeps the squares sharp at any scale instead of letting the browser
 * antialias them into mush.
 *
 * Strokes are 2px thick on a 7×9 grid for a chunky, arcade-cabinet feel.
 * Width per glyph: 7 px + 1 px gap → 5 glyphs × 7 + 4 gaps = 39 px.
 * Aspect ratio is locked, so callers pick height and the width follows.
 */

type Pixels = readonly string[]; // each string is 7 chars long ("X" = on)

const A: Pixels = [
  "..XXX..",
  ".XX.XX.",
  "XX...XX",
  "XX...XX",
  "XXXXXXX",
  "XXXXXXX",
  "XX...XX",
  "XX...XX",
  "XX...XX",
];
const R: Pixels = [
  "XXXXXX.",
  "XX...XX",
  "XX...XX",
  "XX...XX",
  "XXXXXX.",
  "XX.XX..",
  "XX..XX.",
  "XX...XX",
  "XX...XX",
];
const G: Pixels = [
  ".XXXXX.",
  "XX...XX",
  "XX.....",
  "XX.....",
  "XX.XXXX",
  "XX...XX",
  "XX...XX",
  "XX...XX",
  ".XXXXX.",
];
const U: Pixels = [
  "XX...XX",
  "XX...XX",
  "XX...XX",
  "XX...XX",
  "XX...XX",
  "XX...XX",
  "XX...XX",
  "XX...XX",
  ".XXXXX.",
];
const S: Pixels = [
  ".XXXXX.",
  "XX...XX",
  "XX.....",
  "XX.....",
  ".XXXX..",
  "....XX.",
  ".....XX",
  "XX...XX",
  ".XXXXX.",
];

const LETTERS: Array<{ glyph: Pixels; color: string }> = [
  { glyph: A, color: "#ef4444" }, // red-500
  { glyph: R, color: "#f59e0b" }, // amber-500
  { glyph: G, color: "#10b981" }, // emerald-500
  { glyph: U, color: "#3b82f6" }, // blue-500
  { glyph: S, color: "#a855f7" }, // purple-500
];

const GLYPH_W = 7;
const GLYPH_H = 9;
const GAP = 1;
const TOTAL_W = LETTERS.length * GLYPH_W + (LETTERS.length - 1) * GAP;

export function ArgusWordmark({ className }: { className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${TOTAL_W} ${GLYPH_H}`}
      width={TOTAL_W * 4}
      height={GLYPH_H * 4}
      shapeRendering="crispEdges"
      aria-label="Argus"
      role="img"
      className={className}
    >
      {LETTERS.map(({ glyph, color }, letterIdx) => {
        const offsetX = letterIdx * (GLYPH_W + GAP);
        return glyph.flatMap((row, y) =>
          row.split("").map((ch, x) =>
            ch === "X" ? (
              <rect
                key={`${letterIdx}-${x}-${y}`}
                x={offsetX + x}
                y={y}
                width={1}
                height={1}
                fill={color}
              />
            ) : null
          )
        );
      })}
    </svg>
  );
}
