import type { CollectorConfig } from "@prisma/client";
import { prisma } from "@/lib/db";
import type {
  AgentFeatureKey,
  CollectorConfigAdmin,
  CollectorConfigBools,
  CollectorConfigInts,
  CollectorConfigNullableInts,
  CollectorConfigPublic,
  DisplayPrefs,
} from "@/lib/types";

/**
 * Singleton row name. The whole config is one row — there is no
 * per-host / per-fleet split in v1. If multi-tenant lands, this is the
 * key that grows a discriminator.
 */
const DEFAULT_NAME = "default";

/**
 * Idempotent self-heal: read the singleton row, creating it from
 * Prisma defaults if absent. Mirrors the `getOrCreateDefault()` pattern
 * in neko-orchestrator's `src/app/api/converge-config/route.ts`. The
 * seed migration already inserts this row on a fresh deploy; this is
 * the safety net for environments where the seed was skipped.
 */
export async function getCollectorConfig(): Promise<CollectorConfig> {
  const existing = await prisma.collectorConfig.findUnique({
    where: { name: DEFAULT_NAME },
  });
  if (existing) return existing;
  return prisma.collectorConfig.create({
    data: { name: DEFAULT_NAME },
  });
}

/**
 * Project the snake-case wire shape sent to agents. Keys here are the
 * source of truth for the agent's `read_bool_from_config()` lookups —
 * keep them aligned with `AGENT_FEATURE_KEYS` in `src/lib/types.ts`.
 */
export function toPublicShape(row: CollectorConfig): CollectorConfigPublic {
  const enabled: Record<AgentFeatureKey, boolean> = {
    os_packages: row.collectOsPackages,
    language_packages: row.collectLanguagePackages,
    ip_addresses: row.collectIpAddresses,
    services: row.collectServices,
    listeners: row.collectListeners,
    containers: row.collectContainers,
    kernel_mitigations: row.collectKernelMitigations,
    loaded_modules: row.collectLoadedModules,
    pending_updates: row.collectPendingUpdates,
    container_runtime: row.collectContainerRuntime,
    virtualization: row.collectVirtualization,
    uptime: row.collectUptime,
    snap_packages: row.collectSnapPackages,
    flatpak_packages: row.collectFlatpakPackages,
  };
  return {
    version: row.version,
    updated_at: row.updatedAt.toISOString(),
    enabled,
  };
}

/** Admin-side DTO. camelCase, mirrors the Prisma columns 1:1. */
export function toAdminShape(row: CollectorConfig): CollectorConfigAdmin {
  return {
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
    collectOsPackages: row.collectOsPackages,
    collectLanguagePackages: row.collectLanguagePackages,
    collectIpAddresses: row.collectIpAddresses,
    collectServices: row.collectServices,
    collectListeners: row.collectListeners,
    collectContainers: row.collectContainers,
    collectKernelMitigations: row.collectKernelMitigations,
    collectLoadedModules: row.collectLoadedModules,
    collectPendingUpdates: row.collectPendingUpdates,
    collectContainerRuntime: row.collectContainerRuntime,
    collectVirtualization: row.collectVirtualization,
    collectUptime: row.collectUptime,
    collectSnapPackages: row.collectSnapPackages,
    collectFlatpakPackages: row.collectFlatpakPackages,
    staleHostAmberDays: row.staleHostAmberDays,
    staleHostRedDays: row.staleHostRedDays,
    reportRetentionDays: row.reportRetentionDays,
    inactiveHostRetentionDays: row.inactiveHostRetentionDays,
    lastCleanupAt: row.lastCleanupAt ? row.lastCleanupAt.toISOString() : null,
  };
}

/** Display-only projection for the cookie-authed /api/display-prefs. */
export function toDisplayPrefs(row: CollectorConfig): DisplayPrefs {
  return {
    staleHostAmberDays: row.staleHostAmberDays,
    staleHostRedDays: row.staleHostRedDays,
  };
}

/**
 * The fields the admin PUT is allowed to touch. Used for both
 * validation and the diff loop in `applyConfigUpdate`.
 */
export const BOOL_FIELDS: ReadonlyArray<keyof CollectorConfigBools> = [
  "collectOsPackages",
  "collectLanguagePackages",
  "collectIpAddresses",
  "collectServices",
  "collectListeners",
  "collectContainers",
  "collectKernelMitigations",
  "collectLoadedModules",
  "collectPendingUpdates",
  "collectContainerRuntime",
  "collectVirtualization",
  "collectUptime",
  "collectSnapPackages",
  "collectFlatpakPackages",
];

/** Integer fields the admin PUT is allowed to touch. */
export const INT_FIELDS: ReadonlyArray<keyof CollectorConfigInts> = [
  "staleHostAmberDays",
  "staleHostRedDays",
  "reportRetentionDays",
];

/**
 * Nullable-int fields the admin PUT is allowed to touch. Distinct from
 * INT_FIELDS so the whitelist can permit `null` (= disable feature) on
 * exactly these keys without weakening the non-null int validation.
 */
export const NULLABLE_INT_FIELDS: ReadonlyArray<
  keyof CollectorConfigNullableInts
> = ["inactiveHostRetentionDays"];

export interface ApplyUpdateResult {
  row: CollectorConfig;
  /** True iff any field actually changed (and version was bumped). */
  changed: boolean;
}

/**
 * Apply a partial bool + int update. Bumps `version` iff at least one
 * field differs from the current value — a no-op PUT does not advance
 * the version, so the agent's version-short-circuit stays meaningful.
 *
 * Caller is responsible for shape validation (booleans / positive ints
 * / amber < red); this just applies whatever passed the gate.
 */
export async function applyConfigUpdate(
  partial: Partial<CollectorConfigBools> &
    Partial<CollectorConfigInts> &
    Partial<CollectorConfigNullableInts>
): Promise<ApplyUpdateResult> {
  const current = await getCollectorConfig();
  const data: Partial<
    Record<keyof CollectorConfigBools, boolean> &
      Record<keyof CollectorConfigInts, number> &
      Record<keyof CollectorConfigNullableInts, number | null>
  > = {};
  let changed = false;
  for (const key of BOOL_FIELDS) {
    const next = partial[key];
    if (typeof next !== "boolean") continue;
    if (current[key] !== next) {
      data[key] = next;
      changed = true;
    }
  }
  for (const key of INT_FIELDS) {
    const next = partial[key];
    if (typeof next !== "number") continue;
    if (current[key] !== next) {
      data[key] = next;
      changed = true;
    }
  }
  for (const key of NULLABLE_INT_FIELDS) {
    if (!(key in partial)) continue;
    const next = partial[key];
    // Accept `null` (= clear) or a positive integer; the route layer
    // already validated the shape, so we just check for an actual diff.
    if (next !== null && typeof next !== "number") continue;
    if (current[key] !== next) {
      data[key] = next;
      changed = true;
    }
  }
  if (!changed) return { row: current, changed: false };
  const updated = await prisma.collectorConfig.update({
    where: { id: current.id },
    data: { ...data, version: current.version + 1 },
  });
  return { row: updated, changed: true };
}
