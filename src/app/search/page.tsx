"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { Search } from "lucide-react";
import { jsonFetcher } from "@/lib/fetcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type { SearchHit } from "@/lib/types";

/**
 * /search?package=<name>&version=<optional>
 *
 * URL is the source of truth for the query so links are shareable.
 */
function SearchPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const initialPackage = params.get("package") ?? "";
  const initialVersion = params.get("version") ?? "";

  const [packageQ, setPackageQ] = useState(initialPackage);
  const [versionQ, setVersionQ] = useState(initialVersion);

  const swrKey =
    initialPackage.length >= 2
      ? `/api/search?package=${encodeURIComponent(initialPackage)}${
          initialVersion ? `&version=${encodeURIComponent(initialVersion)}` : ""
        }`
      : null;

  const { data, error, isLoading } = useSWR<SearchHit[]>(swrKey, jsonFetcher);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = packageQ.trim();
    if (q.length < 2) return;
    const next = new URLSearchParams();
    next.set("package", q);
    if (versionQ.trim()) next.set("version", versionQ.trim());
    router.push(`/search?${next.toString()}`);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">Search packages</h2>
        <p className="text-sm text-muted-foreground">
          Fuzzy match on package name. Add a version for an exact-match filter.
        </p>
      </div>

      <Card>
        <CardContent className="pt-5">
          <form onSubmit={submit} className="flex flex-col gap-2 md:flex-row">
            <Input
              value={packageQ}
              onChange={(e) => setPackageQ(e.target.value)}
              placeholder="package name (min 2 chars)"
              className="font-mono"
            />
            <Input
              value={versionQ}
              onChange={(e) => setVersionQ(e.target.value)}
              placeholder="version (optional, exact)"
              className="font-mono md:max-w-xs"
            />
            <Button type="submit" disabled={packageQ.trim().length < 2}>
              <Search className="h-4 w-4" /> Search
            </Button>
          </form>
        </CardContent>
      </Card>

      {initialPackage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              Results{" "}
              <span className="text-muted-foreground font-normal">
                ({data?.length ?? 0})
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error instanceof Error ? error.message : "failed to load"}
              </div>
            )}
            {!error && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Host</TableHead>
                    <TableHead>OS</TableHead>
                    <TableHead>Package</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Arch</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="text-center text-xs text-muted-foreground"
                      >
                        Loading…
                      </TableCell>
                    </TableRow>
                  )}
                  {!isLoading && (data?.length ?? 0) === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="text-center text-xs text-muted-foreground"
                      >
                        No matches.
                      </TableCell>
                    </TableRow>
                  )}
                  {data?.map((hit, i) => (
                    <TableRow key={`${hit.hostId}-${i}`}>
                      <TableCell>
                        <Link
                          href={`/hosts/${hit.hostId}`}
                          className="font-mono text-xs underline-offset-2 hover:underline"
                        >
                          {hit.hostname}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant="muted">
                          {hit.osName} {hit.osVersion}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {hit.package.name}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {hit.package.version}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {hit.package.arch || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={null}>
      <SearchPageInner />
    </Suspense>
  );
}
