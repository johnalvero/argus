"use client";

import useSWR from "swr";
import type { Me } from "@/lib/types";

async function fetchMe(url: string): Promise<Me | null> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as Me;
}

export function useMe() {
  return useSWR<Me | null>("/api/auth/me", fetchMe, {
    revalidateOnFocus: true,
    shouldRetryOnError: false,
  });
}
