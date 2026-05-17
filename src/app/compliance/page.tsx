"use client";

import { Suspense, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { jsonFetcher } from "@/lib/fetcher";
import { useFormatDateTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TagChip } from "@/components/TagChip";
import { SeverityBadge } from "@/components/SeverityBadge";
import type {
  ComplianceGrade,
  ComplianceMetric,
  ComplianceResponse,
  ComplianceSectionBase,
  ComplianceTone,
  TagSummary,
} from "@/lib/types";

/**
 * /compliance — fleet-wide scorecard.
 *
 * URL is the source of truth for the tag filter (?tag=1,2,3) so views
 * are shareable. SWR with no refresh interval — operator hits the page
 * when they want a fresh look.
 */

// Mirror the established severity palette per the spec: A=emerald,
// B=blue, C=amber, D=orange, F=red. Kept as literal classes so Tailwind
// can statically detect them at build time.
const GRADE_TEXT: Record<ComplianceGrade, string> = {
  A: "text-emerald-500",
  B: "text-blue-500",
  C: "text-amber-500",
  D: "text-orange-500",
  F: "text-red-500",
};
const GRADE_BG: Record<ComplianceGrade, string> = {
  A: "bg-emerald-500/10 text-emerald-500 ring-emerald-500/30",
  B: "bg-blue-500/10 text-blue-500 ring-blue-500/30",
  C: "bg-amber-500/10 text-amber-500 ring-amber-500/30",
  D: "bg-orange-500/10 text-orange-500 ring-orange-500/30",
  F: "bg-red-500/10 text-red-500 ring-red-500/30",
};

const TONE_TEXT: Record<ComplianceTone, string> = {
  good: "text-emerald-500",
  warn: "text-amber-500",
  bad: "text-red-500",
  neutral: "text-muted-foreground",
};

function parseTagIds(raw: string | null): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function GradeChip({ grade }: { grade: ComplianceGrade }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-sm px-1.5 font-mono text-[11px] font-semibold ring-1",
        GRADE_BG[grade]
      )}
    >
      {grade}
    </span>
  );
}

function ComplianceInner() {
  const router = useRouter();
  const params = useSearchParams();
  const formatDt = useFormatDateTime();

  const tagIds = useMemo(
    () => new Set(parseTagIds(params.get("tag"))),
    [params]
  );

  const apiQs = new URLSearchParams();
  if (tagIds.size > 0) apiQs.set("tag", Array.from(tagIds).join(","));
  const swrKey = `/api/compliance${apiQs.toString() ? `?${apiQs.toString()}` : ""}`;
  const { data, isLoading, error } = useSWR<ComplianceResponse>(
    swrKey,
    jsonFetcher,
    { keepPreviousData: true }
  );
  const { data: tags } = useSWR<TagSummary[]>("/api/tags", jsonFetcher);

  const pushTags = useCallback(
    (next: Set<number>) => {
      const qs = new URLSearchParams();
      if (next.size > 0) qs.set("tag", Array.from(next).join(","));
      const s = qs.toString();
      router.replace(s ? `/compliance?${s}` : "/compliance", { scroll: false });
    },
    [router]
  );
  const toggleTag = (id: number) => {
    const next = new Set(tagIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    pushTags(next);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">
          Compliance scorecard
        </h2>
        <p className="text-sm text-muted-foreground">
          Snapshot of fleet health, computed on demand.
        </p>
      </div>

      {tags && tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Tag
          </span>
          {tags.map((t) => (
            <TagChip
              key={t.id}
              tag={t}
              active={tagIds.has(t.id)}
              onClick={() => toggleTag(t.id)}
            />
          ))}
          {tagIds.size > 0 && (
            <button
              type="button"
              onClick={() => pushTags(new Set())}
              className="text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error instanceof Error ? error.message : "failed to load"}
        </div>
      )}

      {!data && isLoading && (
        <div className="rounded-md border bg-card p-6 text-center text-sm text-muted-foreground">
          Computing scorecard…
        </div>
      )}

      {data && <Scorecard data={data} formatDt={formatDt} />}
    </div>
  );
}

function Scorecard({
  data,
  formatDt,
}: {
  data: ComplianceResponse;
  formatDt: (iso: string) => string;
}) {
  const { composite, sections, scope, generatedAt } = data;
  const sectionList = [
    sections.vulnerabilities,
    sections.reporting,
    sections.posture,
    sections.patches,
  ];

  return (
    <>
      {/* Hero */}
      <Card>
        <CardContent className="flex flex-col items-start gap-6 p-6 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-6">
            <div className="flex flex-col">
              <span
                className={cn(
                  "font-mono text-5xl font-bold leading-none tabular-nums",
                  GRADE_TEXT[composite.grade]
                )}
              >
                {composite.score}
              </span>
              <span className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                Composite score
              </span>
            </div>
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "font-mono text-5xl font-bold leading-none",
                  GRADE_TEXT[composite.grade]
                )}
              >
                {composite.grade}
              </span>
              <span className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                Grade
              </span>
            </div>
            <div className="flex flex-col">
              <span className="font-mono text-2xl font-semibold tabular-nums">
                {scope.hostCount}
              </span>
              <span className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                Hosts in scope
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {sectionList.map((s) => (
              <div
                key={s.title}
                className="flex items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5"
              >
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {s.title}
                </span>
                <span className="font-mono text-xs tabular-nums">
                  {s.score}
                </span>
                <GradeChip grade={s.grade} />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Section cards grid */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SectionCard section={sections.vulnerabilities}>
          <TopVulnsList vulns={sections.vulnerabilities.topVulns} />
        </SectionCard>
        <SectionCard section={sections.reporting}>
          <AgentVersionChips
            distribution={sections.reporting.agentVersionDistribution}
          />
        </SectionCard>
        <SectionCard section={sections.posture} />
        <SectionCard section={sections.patches} />
      </div>

      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Last generated · {formatDt(generatedAt)} · weight{" "}
        <span className="font-mono">
          vulns 0.4 / reporting 0.2 / posture 0.2 / patches 0.2
        </span>
      </p>
    </>
  );
}

function SectionCard({
  section,
  children,
}: {
  section: ComplianceSectionBase;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">{section.title}</CardTitle>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "font-mono text-sm font-semibold tabular-nums",
                GRADE_TEXT[section.grade]
              )}
            >
              {section.score}
            </span>
            <GradeChip grade={section.grade} />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{section.summary}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          {section.metrics.map((m) => (
            <MetricRow key={m.label} metric={m} />
          ))}
        </dl>
        {children}
      </CardContent>
    </Card>
  );
}

function MetricRow({ metric }: { metric: ComplianceMetric }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{metric.label}</dt>
      <dd
        className={cn(
          "font-mono tabular-nums",
          TONE_TEXT[metric.tone]
        )}
      >
        {metric.value}
      </dd>
    </div>
  );
}

function TopVulnsList({
  vulns,
}: {
  vulns: Array<{ id: number; osvId: string; severity: string; hostCount: number }>;
}) {
  if (vulns.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 border-t pt-3">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Top vulnerabilities by host count
      </span>
      <ul className="flex flex-col gap-1">
        {vulns.map((v) => (
          <li key={v.id} className="flex items-center justify-between gap-2 text-xs">
            <div className="flex min-w-0 items-center gap-2">
              <SeverityBadge severity={v.severity} />
              <Link
                href={`/vulnerabilities/${v.id}`}
                className="truncate font-mono text-xs underline-offset-2 hover:underline"
              >
                {v.osvId}
              </Link>
            </div>
            <span className="font-mono tabular-nums text-muted-foreground">
              {v.hostCount} host{v.hostCount === 1 ? "" : "s"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AgentVersionChips({
  distribution,
}: {
  distribution: Array<{ version: string; count: number }>;
}) {
  if (distribution.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 border-t pt-3">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Agent version distribution
      </span>
      <div className="flex flex-wrap gap-1.5">
        {distribution.map((d) => (
          <span
            key={d.version}
            className="inline-flex items-center gap-1.5 rounded-sm bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
          >
            <span>{d.version}</span>
            <span className="tabular-nums text-foreground">{d.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export default function CompliancePage() {
  return (
    <Suspense fallback={null}>
      <ComplianceInner />
    </Suspense>
  );
}
