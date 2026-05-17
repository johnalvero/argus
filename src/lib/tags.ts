/**
 * Shared helpers for the tag CRUD + host-tag association endpoints.
 *
 * Lives outside the route files so the validation rules (name slug
 * shape, color hex shape, description length) have one source of truth
 * — the POST handler, the PATCH handler, and any future bulk-import or
 * audit-log surface all hit the same predicates.
 *
 * Audit hook note: tag mutations and host-tag changes will need audit
 * events in Phase A round 2. Each mutation route is structured so the
 * `await auditLog(...)` call is a one-liner per route — no business
 * logic detangling required.
 */

// Slug-ish: 1-32 chars, starts with [a-z0-9], rest [a-z0-9-]. Case-
// insensitive on input, but we store lowercase canonical names so
// uniqueness is meaningful at the DB level. The unique index on
// Tag.name catches concurrent insert races; we still pre-check for the
// nicer 409 message.
const TAG_NAME_RE = /^[a-z0-9][a-z0-9-]*$/i;
export const TAG_NAME_MAX = 32;
export const TAG_DESCRIPTION_MAX = 200;

// #RGB, #RRGGBB, or #RRGGBBAA. Reject everything else — the curated
// palette is hex, custom hex input is hex, no rgb()/hsl() bypass.
const TAG_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export interface TagValidationError {
  /** Stable machine-readable code for the route to flip to a 400. */
  field: "name" | "color" | "description";
  message: string;
}

/**
 * Normalise + validate a candidate tag name. Returns the canonical
 * (lowercased, trimmed) name on success, or an error describing what
 * went wrong on the input. Callers turn the error into a 400.
 */
export function normalizeTagName(
  input: unknown
): { ok: true; value: string } | { ok: false; error: TagValidationError } {
  if (typeof input !== "string") {
    return {
      ok: false,
      error: { field: "name", message: "name must be a string" },
    };
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: { field: "name", message: "name is required" },
    };
  }
  if (trimmed.length > TAG_NAME_MAX) {
    return {
      ok: false,
      error: {
        field: "name",
        message: `name must be ${TAG_NAME_MAX} characters or fewer`,
      },
    };
  }
  if (!TAG_NAME_RE.test(trimmed)) {
    return {
      ok: false,
      error: {
        field: "name",
        message:
          "name must start with a letter or digit and contain only letters, digits, or hyphens",
      },
    };
  }
  return { ok: true, value: trimmed.toLowerCase() };
}

/**
 * Validate a tag color. Accepts #RGB, #RRGGBB, or #RRGGBBAA. Returns
 * the canonical lowercased form so two equivalent inputs (#3B82F6 and
 * #3b82f6) compare equal downstream.
 */
export function normalizeTagColor(
  input: unknown
): { ok: true; value: string } | { ok: false; error: TagValidationError } {
  if (typeof input !== "string") {
    return {
      ok: false,
      error: { field: "color", message: "color must be a string" },
    };
  }
  const trimmed = input.trim();
  if (!TAG_COLOR_RE.test(trimmed)) {
    return {
      ok: false,
      error: {
        field: "color",
        message:
          "color must be a hex string like #3b82f6 (#RGB, #RRGGBB, or #RRGGBBAA)",
      },
    };
  }
  return { ok: true, value: trimmed.toLowerCase() };
}

/**
 * Validate the optional description. `null` and `""` both mean "no
 * description"; we canonicalise to `null` for storage.
 */
export function normalizeTagDescription(
  input: unknown
):
  | { ok: true; value: string | null }
  | { ok: false; error: TagValidationError } {
  if (input == null) return { ok: true, value: null };
  if (typeof input !== "string") {
    return {
      ok: false,
      error: { field: "description", message: "description must be a string" },
    };
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > TAG_DESCRIPTION_MAX) {
    return {
      ok: false,
      error: {
        field: "description",
        message: `description must be ${TAG_DESCRIPTION_MAX} characters or fewer`,
      },
    };
  }
  return { ok: true, value: trimmed };
}
