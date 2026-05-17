"use client";

import useSWR from "swr";
import { jsonFetcher } from "@/lib/fetcher";
import type { BrandingPublic } from "@/lib/types";

/**
 * Cookie-authed read of the branding singleton. Used by AppShell to drive
 * the sidebar header (company name + logo). NOT safe to call from the
 * login page — /api/branding requires auth and would 401 before sign-in.
 */
export function useBranding() {
  return useSWR<BrandingPublic>("/api/branding", jsonFetcher);
}
