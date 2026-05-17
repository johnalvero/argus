"use client";

/**
 * Standard JSON fetcher for SWR. Returns parsed JSON; throws an Error
 * with the server's `error` field on non-2xx (or status text fallback).
 */
export async function jsonFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}
