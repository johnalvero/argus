// Shared response shapes between API routes and client components.

// ─── Host tags ─────────────────────────────────────────────────────────
/**
 * Compact tag shape. Used everywhere a host carries its tag list — host
 * list, host detail, host search — and as the public read of /api/tags
 * for the filter chips. Keep this lean: id for keying, name for display,
 * color for the chip styling.
 */
export interface TagSummary {
  id: number;
  name: string;
  color: string;
}

/**
 * Admin DTO. Adds description + the denormalised hostCount aggregate the
 * admin table renders, plus the audit timestamps. hostCount is admin-
 * only — non-admin read at /api/tags does not include it.
 */
export interface TagAdmin extends TagSummary {
  description: string | null;
  hostCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Me {
  id: number;
  email: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
  /** IANA zone name (e.g. "Asia/Manila") or null for browser default. */
  timezone: string | null;
}

export interface HostRow {
  id: number;
  hostId: string;
  hostname: string;
  osId: string;
  osName: string;
  osVersion: string;
  osVersionCodename: string | null;
  kernel: string | null;
  arch: string | null;
  packageManager: string | null;
  agentVersion: string | null;
  privateIp: string | null;
  firstSeenAt: string;
  lastReportAt: string;
  packageCount: number;
  /** Empty array when the host has no tags assigned. */
  tags: TagSummary[];
  /**
   * Per-host CRITICAL/HIGH vuln counts. Only those two — anything below
   * HIGH doesn't earn a dashboard indicator, and including all five
   * would bloat this list payload. Zero for both when no sync has run
   * yet or the host has no matched vulns.
   */
  vulnSeverityCounts: { CRITICAL: number; HIGH: number };
}

export interface IpAddress {
  iface: string;
  addr: string;
}

export interface PackageEntry {
  /** "os" for native packages, an ecosystem name (pip/npm/gem/composer/cargo) for language packages. */
  ecosystem: string;
  /** Provenance hint for language packages (e.g. "system"). Empty for OS rows. */
  location: string | null;
  name: string;
  version: string;
  arch: string;
}

export interface ServiceEntry {
  unit: string;
}

export interface ListenerEntry {
  proto: string;
  addr: string;
  port: string;
}

export interface ContainerEntry {
  id: string;
  image: string;
  name: string;
}

export interface KernelMitigationEntry {
  vuln: string;
  state: string;
}

export interface LoadedModuleEntry {
  name: string;
  size_bytes: number;
}

export interface PendingUpdateItem {
  name: string;
  available_version: string;
}

export interface PendingUpdates {
  count: number;
  items: PendingUpdateItem[];
}

export interface ContainerRuntimeEntry {
  name: string;
  version: string;
}

export interface VirtualizationInfo {
  type: string;
  source: string;
}

export interface UptimeInfo {
  seconds: number;
  boot_time: string;
}

export interface ReportHistoryEntry {
  id: number;
  collectedAt: string;
  receivedAt: string;
  hash: string;
  payloadSize: number;
}

export interface HostDetail extends HostRow {
  ipAddresses: IpAddress[];
  packages: PackageEntry[];
  services: ServiceEntry[];
  listeners: ListenerEntry[];
  containers: ContainerEntry[];
  reports: ReportHistoryEntry[];
  // Security & posture — each optional; only present when the latest
  // report carried the field (server toggle on AND agent collected).
  kernelMitigations?: KernelMitigationEntry[];
  loadedModules?: LoadedModuleEntry[];
  pendingUpdates?: PendingUpdates;
  containerRuntime?: ContainerRuntimeEntry[];
  virtualization?: VirtualizationInfo;
  uptime?: UptimeInfo;
  /** Per-host vuln rows joined from HostVulnerability. Severity-then-id sorted. */
  vulnerabilities: HostVulnerabilitySummary[];
}

export interface SearchHit {
  hostId: number;
  hostExternalId: string;
  hostname: string;
  osName: string;
  osVersion: string;
  package: PackageEntry;
}

export interface IngestTokenRow {
  id: number;
  name: string;
  prefix: string;
  createdAt: string;
  createdByEmail: string;
  lastUsedAt: string | null;
  enabled: boolean;
}

export interface UserRow {
  id: number;
  email: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
  createdAt: string;
}

// ─── Collector config ──────────────────────────────────────────────────
// Single source of truth for the snake-case feature keys used by:
//   • the wire shape returned by GET /api/v1/config
//   • the admin UI's section grouping
//   • the agent's read_bool_from_config() lookups in
//     agent/software-inventory.sh
//
// Add a new key here, give it a matching `collect*` column in the
// schema, and both the admin UI and the agent line up automatically.
export const AGENT_FEATURE_KEYS = [
  "os_packages",
  "language_packages",
  "ip_addresses",
  "services",
  "listeners",
  "containers",
  "kernel_mitigations",
  "loaded_modules",
  "pending_updates",
  "container_runtime",
  "virtualization",
  "uptime",
  "snap_packages",
  "flatpak_packages",
] as const;

export type AgentFeatureKey = (typeof AGENT_FEATURE_KEYS)[number];

/** Wire shape returned by GET /api/v1/config. */
export interface CollectorConfigPublic {
  version: number;
  updated_at: string;
  enabled: Record<AgentFeatureKey, boolean>;
}

/**
 * Admin DTO. camelCase here mirrors the Prisma column names so the
 * admin page can PUT a partial directly. The wire endpoint at
 * /api/v1/config translates this into the snake-case shape above.
 */
export interface CollectorConfigAdmin {
  version: number;
  updatedAt: string;
  collectOsPackages: boolean;
  collectLanguagePackages: boolean;
  collectIpAddresses: boolean;
  collectServices: boolean;
  collectListeners: boolean;
  collectContainers: boolean;
  collectKernelMitigations: boolean;
  collectLoadedModules: boolean;
  collectPendingUpdates: boolean;
  collectContainerRuntime: boolean;
  collectVirtualization: boolean;
  collectUptime: boolean;
  collectSnapPackages: boolean;
  collectFlatpakPackages: boolean;
  // UI display thresholds — see CollectorConfig schema comment.
  staleHostAmberDays: number;
  staleHostRedDays: number;
  // Data retention — see CollectorConfig schema comment.
  reportRetentionDays: number;
  /** Null = host expiry disabled (today's behavior). */
  inactiveHostRetentionDays: number | null;
  /**
   * Read-only from the client perspective — bumped server-side by the
   * cleanup helper. Never accepted in PUT bodies.
   */
  lastCleanupAt: string | null;
}

/** Non-null integer fields (always-present, positive). */
export type CollectorConfigInts = Pick<
  CollectorConfigAdmin,
  "staleHostAmberDays" | "staleHostRedDays" | "reportRetentionDays"
>;

/**
 * Nullable integer fields. Null means "feature disabled" — kept
 * separate from `CollectorConfigInts` so the PUT validator can permit
 * `null` here without weakening the positive-int check on the rest.
 */
export type CollectorConfigNullableInts = Pick<
  CollectorConfigAdmin,
  "inactiveHostRetentionDays"
>;

/** Bool-only Pick used by the PUT body and the admin form state. */
export type CollectorConfigBools = Omit<
  CollectorConfigAdmin,
  | "version"
  | "updatedAt"
  | "lastCleanupAt"
  | keyof CollectorConfigInts
  | keyof CollectorConfigNullableInts
>;

/** Cleanup endpoint response shape. */
export interface CleanupResult {
  reportsDeleted: number;
  hostsDeleted: number;
  ranAt: string;
}

/**
 * Wire shape for GET /api/display-prefs. Cookie-authed (any logged-in
 * user). The host list calls this so non-admins can render the right
 * staleness colors without needing the full admin config. Intentionally
 * a narrow Pick — retention fields are admin-only.
 */
export type DisplayPrefs = Pick<
  CollectorConfigAdmin,
  "staleHostAmberDays" | "staleHostRedDays"
>;

// ─── Audit log ──────────────────────────────────────────────────────────
/**
 * Public wire shape of one audit row. `diff` is the structured
 * before/after; null when the route didn't supply one (e.g. simple
 * triggers like a manual cleanup). `actorEmail` is a snapshot taken at
 * write time, so it survives the user being deleted (in which case the
 * underlying FK is nulled but this string remains).
 */
export interface AuditEventRow {
  id: number;
  actorEmail: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  diff: { before: unknown; after: unknown } | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

/** Response shape for GET /api/admin/audit. */
export interface AuditListResponse {
  events: AuditEventRow[];
  hasMore: boolean;
  nextBefore?: number;
}

// ─── CVE sync ───────────────────────────────────────────────────────────
/**
 * One row of CveSyncRun. The header polls this shape from
 * GET /api/admin/cve/sync to drive the "Sync CVEs" button's status +
 * "last: 3h ago" caption.
 *
 * `triggeredByEmail` is denormalised at read time from the FK — null
 * for future scheduled runs (no User) or when the triggering user has
 * since been deleted.
 */
export interface CveSyncRunRow {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "failed";
  packagesQueried: number;
  vulnsDiscovered: number;
  hostsAffected: number;
  newVulns: number;
  error: string | null;
  triggeredByEmail: string | null;
}

// ─── Vulnerabilities ───────────────────────────────────────────────────
/**
 * Canonical severity bucket. Mirrors the strings written by `cveSync`
 * via `severityFromCvss`. `UNKNOWN` covers vulns OSV publishes without
 * a CVSS v3 vector — we surface them rather than hide them.
 */
export type SeverityBucket =
  | "CRITICAL"
  | "HIGH"
  | "MEDIUM"
  | "LOW"
  | "UNKNOWN";

export const SEVERITY_ORDER: SeverityBucket[] = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "UNKNOWN",
];

/** Counts keyed by severity bucket. Always has all five keys. */
export type SeverityCounts = Record<SeverityBucket, number>;

/** OSV reference entry, mirrors osv.dev's shape. */
export interface VulnReferenceEntry {
  type: string;
  url: string;
}

/**
 * One row of GET /api/vulnerabilities. Aggregates `hostCount` and
 * `ecosystems` server-side so the list table doesn't have to re-query
 * per row to render its summary.
 */
export interface VulnerabilityRow {
  id: number;
  osvId: string;
  summary: string;
  severity: string | null;
  cvssScore: number | null;
  publishedAt: string | null;
  modifiedAt: string | null;
  /** Distinct hosts affected by this vuln. */
  hostCount: number;
  /** Distinct ecosystems among affected (host, package) rows. */
  ecosystems: string[];
}

/** Response shape for GET /api/vulnerabilities. */
export interface VulnerabilityListResponse {
  items: VulnerabilityRow[];
  /** Total matching the filter set (not limited by limit/offset). */
  total: number;
  /** Bucketed counts over the FILTERED set — drives the strip cards. */
  severityCounts: SeverityCounts;
}

/**
 * Per-host shape attached to GET /api/vulnerabilities/[id]. Hostname +
 * OS so the table can render without a second hosts call; the full
 * tag list so admins can scan blast radius (prod/dmz/pci) at a glance.
 */
export interface VulnerabilityAffectedHost {
  hostId: number;
  hostname: string;
  osName: string;
  osVersion: string;
  tags: TagSummary[];
  packageName: string;
  packageVersion: string;
  ecosystem: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Response shape for GET /api/vulnerabilities/[id]. */
export interface VulnerabilityDetail {
  id: number;
  osvId: string;
  summary: string;
  details: string | null;
  severity: string | null;
  cvssScore: number | null;
  aliases: string[];
  references: VulnReferenceEntry[];
  publishedAt: string | null;
  modifiedAt: string | null;
  fetchedAt: string;
  affectedHosts: VulnerabilityAffectedHost[];
}

/**
 * Per-host vuln summary embedded in HostDetail. Lean: no `details`, no
 * `references` — the host page just lists vulns and links to the full
 * vuln detail page.
 */
export interface HostVulnerabilitySummary {
  id: number;
  osvId: string;
  severity: string | null;
  summary: string;
  packageName: string;
  packageVersion: string;
  ecosystem: string;
}

// ─── Watchlists & notifications ────────────────────────────────────────
/**
 * Watchlist kind discriminator. Drives the spec union below.
 */
export type WatchlistKind = "vulnerability" | "package" | "host_drift";

/** Notification + Watchlist channel discriminator. */
export type NotificationChannel = "inapp" | "email";

/** Notification severity bucket — distinct from CVE severity. */
export type NotificationSeverity = "info" | "warning" | "critical";

/**
 * Discriminated union over watchlist specs. The DB stores this as a
 * JSON-stringified blob in `Watchlist.spec`; we round-trip it through
 * JSON.parse + a runtime narrow in the eval engine.
 */
export type WatchlistSpec =
  | {
      kind: "vulnerability";
      minSeverity?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
      ecosystem?: string[];
      tagIds?: number[];
    }
  | {
      kind: "package";
      name: string;
      version?: string;
      ecosystem?: string;
    }
  | {
      kind: "host_drift";
      inactiveDays: number;
      tagIds?: number[];
    };

/**
 * Admin DTO returned by GET /api/admin/watchlists. `spec` and
 * `channels` are pre-parsed for the client so the table can render
 * without a second JSON.parse pass per row.
 */
export interface WatchlistRow {
  id: number;
  name: string;
  description: string | null;
  enabled: boolean;
  kind: WatchlistKind;
  spec: WatchlistSpec;
  channels: NotificationChannel[];
  recipients: string[] | null;
  createdByEmail: string;
  createdAt: string;
  updatedAt: string;
  lastEvaluatedAt: string | null;
  matchCount: number;
  /** Notifications created in the last 7 days — drives the "recent" cell. */
  recentNotificationCount: number;
}

/**
 * One notification row plus the current user's read-state. The
 * /api/notifications endpoint joins NotificationRead per request so
 * the bell badge can render unread count without a second call.
 */
export interface NotificationRow {
  id: number;
  watchlistId: number;
  watchlistName: string;
  title: string;
  body: string;
  href: string | null;
  severity: NotificationSeverity;
  emailedAt: string | null;
  emailError: string | null;
  isRead: boolean;
  createdAt: string;
}

/** Response shape for GET /api/notifications. */
export interface NotificationListResponse {
  items: NotificationRow[];
  unreadCount: number;
}

/**
 * Public SES config — what GET /api/admin/ses returns. Never includes
 * the plaintext secret; `hasSecret` tells the UI whether to render the
 * "secret set" badge.
 */
export interface SesConfigPublic {
  enabled: boolean;
  region: string | null;
  accessKeyId: string | null;
  fromAddress: string | null;
  replyTo: string | null;
  hasSecret: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  updatedAt: string;
}

// ─── Compliance scorecard ──────────────────────────────────────────────
/**
 * Letter grade derived from a 0–100 score. ≥95 A, ≥85 B, ≥70 C, ≥50 D,
 * <50 F. Same scale across every section and the composite.
 */
export type ComplianceGrade = "A" | "B" | "C" | "D" | "F";

/** Tone token for metric coloring on the scorecard. */
export type ComplianceTone = "good" | "warn" | "bad" | "neutral";

export interface ComplianceMetric {
  label: string;
  value: number | string;
  tone: ComplianceTone;
}

export interface ComplianceSectionBase {
  title: string;
  /** 0–100, integer. */
  score: number;
  grade: ComplianceGrade;
  /** 0–1, sums to 1.0 across the four sections. */
  weight: number;
  /** One-line headline for the section card. */
  summary: string;
  metrics: ComplianceMetric[];
}

export interface ComplianceVulnSection extends ComplianceSectionBase {
  hostsWithCritical: number;
  hostsWithHigh: number;
  hostsClean: number;
  /** Top 5 by affected host count. */
  topVulns: Array<{
    id: number;
    osvId: string;
    severity: string;
    hostCount: number;
  }>;
}

export interface ComplianceReportingSection extends ComplianceSectionBase {
  hostsActive: number;
  hostsStale: number;
  hostsDead: number;
  hostsRunningOldAgent: number;
  agentVersionDistribution: Array<{ version: string; count: number }>;
}

export interface CompliancePostureSection extends ComplianceSectionBase {
  hostsWithKernelMitigationsArmed: number;
  hostsWithoutKernelMitigations: number;
  virtCoverage: number;
  uptimeCoverage: number;
  containerHostCount: number;
}

export interface CompliancePatchSection extends ComplianceSectionBase {
  hostsWithPendingUpdates: number;
  hostsCleanPatches: number;
  hostsUnknownPatchStatus: number;
  totalPendingUpdates: number;
}

/** Response shape for GET /api/compliance. */
export interface ComplianceResponse {
  scope: { hostCount: number; tagIds: number[] };
  generatedAt: string;
  composite: { score: number; grade: ComplianceGrade };
  sections: {
    vulnerabilities: ComplianceVulnSection;
    reporting: ComplianceReportingSection;
    posture: CompliancePostureSection;
    patches: CompliancePatchSection;
  };
}

// ─── Dashboard ──────────────────────────────────────────────────────────
/**
 * One row of the dashboard's "top hosts needing attention" list. Lean —
 * just enough to render the row + link through to /hosts/[id]. Counts
 * are distinct CRITICAL / HIGH vulnerabilities for the host.
 */
export interface DashboardTopHost {
  id: number;
  hostname: string;
  lastReportAt: string;
  criticalCount: number;
  highCount: number;
  tags: TagSummary[];
}

/**
 * Unified activity-stream row. Discriminated union so the renderer can
 * branch on `kind` without optional-prop gymnastics. Non-admins only
 * receive `notification` items — `audit` and `cve_sync` are admin-only.
 */
export type DashboardActivity =
  | {
      kind: "notification";
      at: string;
      severity: string;
      title: string;
      href: string | null;
      watchlistName: string;
    }
  | {
      kind: "audit";
      at: string;
      actorEmail: string;
      action: string;
      entityType: string;
      summary: string;
    }
  | {
      kind: "cve_sync";
      at: string;
      status: string;
      vulnsDiscovered: number;
      newVulns: number;
      hostsAffected: number;
    };

/**
 * Response shape for GET /api/dashboard. Single round-trip for the home
 * page — every card on the dashboard reads from this payload.
 *
 * `recentSyncs` is admin-only; the field is omitted entirely (not null)
 * for non-admins so the type narrows correctly on the client.
 */
export interface DashboardResponse {
  scope: { hostCount: number };
  compliance: {
    score: number;
    grade: ComplianceGrade;
  };
  hosts: {
    total: number;
    /** Within amber threshold (operator-configurable). */
    active: number;
    /** Amber–red band. */
    stale: number;
    /** Beyond red threshold. */
    dead: number;
  };
  vulnerabilities: {
    openCritical: number;
    openHigh: number;
    /** Distinct CRITICAL vulnerabilities first fetched in the last 24h. */
    newCriticalLast24h: number;
  };
  notifications: {
    /** Current user's unread count — drives the inbox card. */
    unreadCount: number;
  };
  /** Top 5 hosts by (critical desc, high desc, lastReportAt asc). */
  topHosts: DashboardTopHost[];
  /** Unified stream, reverse-chrono, max 20, last 24h. */
  activity: DashboardActivity[];
  /** Last 3 CVE sync runs. Admin-only — omitted for non-admins. */
  recentSyncs?: CveSyncRunRow[];
}

// ─── Branding ───────────────────────────────────────────────────────────
/**
 * Public DTO for the cookie-authed GET /api/branding. Deliberately omits
 * the binary — the logo is fetched separately from
 * GET /api/branding/logo so the browser can cache it on its own ETag.
 * `updatedAt` doubles as the cache-buster for the logo <img src>.
 */
export interface BrandingPublic {
  companyName: string;
  hasLogo: boolean;
  updatedAt: string;
}
