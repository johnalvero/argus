import type { Branding } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { BrandingPublic } from "@/lib/types";

/**
 * Singleton helper for the Branding row. Same self-heal pattern as
 * `getCollectorConfig()`: read the named row, create it from Prisma
 * defaults if absent. The seed migration already inserts it on a fresh
 * deploy — this is the safety net for environments where the seed was
 * skipped (e.g. manually pointed at a pre-existing DB).
 */

const DEFAULT_NAME = "default";

export async function getBranding(): Promise<Branding> {
  const existing = await prisma.branding.findUnique({
    where: { name: DEFAULT_NAME },
  });
  if (existing) return existing;
  return prisma.branding.create({
    data: { name: DEFAULT_NAME },
  });
}

/**
 * Project the public DTO. Never includes the binary — callers fetch
 * the bytes lazily via GET /api/branding/logo, which gives the browser
 * its own caching story (ETag + Cache-Control).
 */
export function toBrandingPublic(row: Branding): BrandingPublic {
  return {
    companyName: row.companyName,
    hasLogo: row.logoData != null && row.logoMimeType != null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * MIME whitelist for uploaded logos. SVG is intentionally excluded —
 * inline scripts in SVG are an XSS vector if the image is ever rendered
 * via <object>/<iframe> or served with the wrong CSP.
 */
export const ALLOWED_LOGO_MIME_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

/** Max upload size in bytes. Matches the validation message shown in the UI. */
export const MAX_LOGO_BYTES = 500 * 1024;
