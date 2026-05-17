/**
 * Validation for the JSON document emitted by `software-inventory.sh`.
 *
 * Kept narrow on the required fields (host_id, hostname, os, packages)
 * because the wire format will grow over time. Anything unrecognised is
 * preserved verbatim in the Report.payload blob.
 */

export interface ReportOs {
  id: string;
  name: string;
  version: string;
  version_codename?: string;
  id_like?: string;
}

export interface ReportPackage {
  name: string;
  version: string;
  arch: string;
}

export interface ReportLanguagePackage {
  ecosystem: string; // pip|npm|gem|composer|cargo|snap|flatpak|…
  name: string;
  version: string;
  location?: string; // free-form; "system" for globally-installed
  // arch only meaningful for snap ("all") / flatpak ("x86_64"), absent
  // for the classic language ecosystems (pip/npm/gem/composer/cargo).
  arch?: string;
}

export interface ReportService {
  unit: string;
}

export interface ReportListener {
  proto: string;
  addr: string;
  port: string;
}

export interface ReportContainer {
  id: string;
  image: string;
  name: string;
}

export interface ReportIp {
  iface: string;
  addr: string;
}

export interface ReportKernelMitigation {
  vuln: string;
  state: string;
}

export interface ReportLoadedModule {
  name: string;
  size_bytes: number;
}

export interface ReportPendingUpdateItem {
  name: string;
  available_version: string;
}

export interface ReportPendingUpdates {
  count: number;
  items: ReportPendingUpdateItem[];
}

export interface ReportContainerRuntime {
  name: string;
  version: string;
}

export interface ReportVirtualization {
  type: string;
  source: string;
}

export interface ReportUptime {
  seconds: number;
  boot_time: string;
}

export interface ReportPayload {
  agent_version?: string;
  collected_at?: string;
  host_id: string;
  hostname: string;
  os: ReportOs;
  kernel?: string;
  arch?: string;
  package_manager?: string;
  ip_addresses?: ReportIp[];
  packages: ReportPackage[];
  language_packages?: ReportLanguagePackage[];
  services?: ReportService[];
  listeners?: ReportListener[];
  containers?: ReportContainer[];
  kernel_mitigations?: ReportKernelMitigation[];
  loaded_modules?: ReportLoadedModule[];
  pending_updates?: ReportPendingUpdates;
  container_runtime?: ReportContainerRuntime[];
  virtualization?: ReportVirtualization;
  uptime?: ReportUptime;
}

export type ParseResult =
  | { ok: true; data: ReportPayload }
  | { ok: false; error: string };

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseOs(v: unknown): ReportOs | null {
  if (!isPlainObject(v)) return null;
  if (!isString(v.id) || !isString(v.name) || !isString(v.version)) {
    return null;
  }
  return {
    id: v.id,
    name: v.name,
    version: v.version,
    version_codename: isString(v.version_codename) ? v.version_codename : undefined,
    id_like: isString(v.id_like) ? v.id_like : undefined,
  };
}

function parsePackages(v: unknown): ReportPackage[] | null {
  if (!Array.isArray(v)) return null;
  const out: ReportPackage[] = [];
  for (const item of v) {
    if (!isPlainObject(item)) return null;
    if (!isString(item.name) || !isString(item.version)) return null;
    out.push({
      name: item.name,
      version: item.version,
      // Some package managers (apk) fall back to the host arch.
      arch: isString(item.arch) ? item.arch : "",
    });
  }
  return out;
}

/**
 * Best-effort parse. Strict on the required top-level fields and shape
 * of `os` / `packages`, lenient on optional inventories — a malformed
 * services array gets dropped, not the whole payload.
 */
export function parseReportPayload(raw: unknown): ParseResult {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "payload must be a JSON object" };
  }
  if (!isString(raw.host_id) || raw.host_id.length === 0) {
    return { ok: false, error: "host_id is required" };
  }
  if (!isString(raw.hostname) || raw.hostname.length === 0) {
    return { ok: false, error: "hostname is required" };
  }
  const os = parseOs(raw.os);
  if (!os) {
    return { ok: false, error: "os must include id, name, version" };
  }
  const packages = parsePackages(raw.packages);
  if (!packages) {
    return { ok: false, error: "packages must be an array of {name,version,arch}" };
  }

  const services = Array.isArray(raw.services)
    ? raw.services
        .filter(isPlainObject)
        .filter((s): s is { unit: string } => isString(s.unit))
        .map((s) => ({ unit: s.unit }))
    : undefined;

  const listeners = Array.isArray(raw.listeners)
    ? raw.listeners
        .filter(isPlainObject)
        .filter(
          (l): l is { proto: string; addr: string; port: string } =>
            isString(l.proto) && isString(l.addr) && isString(l.port)
        )
        .map((l) => ({ proto: l.proto, addr: l.addr, port: l.port }))
    : undefined;

  const containers = Array.isArray(raw.containers)
    ? raw.containers
        .filter(isPlainObject)
        .filter(
          (c): c is { id: string; image: string; name: string } =>
            isString(c.id) && isString(c.image) && isString(c.name)
        )
        .map((c) => ({ id: c.id, image: c.image, name: c.name }))
    : undefined;

  const ip_addresses = Array.isArray(raw.ip_addresses)
    ? raw.ip_addresses
        .filter(isPlainObject)
        .filter(
          (ip): ip is { iface: string; addr: string } =>
            isString(ip.iface) && isString(ip.addr)
        )
        .map((ip) => ({ iface: ip.iface, addr: ip.addr }))
    : undefined;

  // Language packages — lenient: missing/garbage entries are dropped,
  // not fatal. Required: ecosystem, name, version. Optional: location.
  const language_packages = Array.isArray(raw.language_packages)
    ? raw.language_packages
        .filter(isPlainObject)
        .filter(
          (p): p is {
            ecosystem: string;
            name: string;
            version: string;
            location?: string;
            arch?: string;
          } =>
            isString(p.ecosystem) &&
            isString(p.name) &&
            isString(p.version) &&
            p.ecosystem.length > 0 &&
            p.name.length > 0
        )
        .map((p) => ({
          ecosystem: p.ecosystem,
          name: p.name,
          version: p.version,
          location: isString(p.location) ? p.location : undefined,
          arch: isString(p.arch) ? p.arch : undefined,
        }))
    : undefined;

  // ── Security & posture (all optional, lenient parsing) ─────────────
  // Any malformed sub-field is silently dropped — never reject an
  // ingest because the agent shipped a weird mitigation string.
  const kernel_mitigations = Array.isArray(raw.kernel_mitigations)
    ? raw.kernel_mitigations
        .filter(isPlainObject)
        .filter(
          (m): m is { vuln: string; state: string } =>
            isString(m.vuln) && isString(m.state)
        )
        .map((m) => ({ vuln: m.vuln, state: m.state }))
    : undefined;

  const loaded_modules = Array.isArray(raw.loaded_modules)
    ? raw.loaded_modules
        .filter(isPlainObject)
        .map((m) => {
          if (!isString(m.name)) return null;
          // size_bytes may arrive as number OR numeric string (shell
          // emits it bare from /proc/modules, which JSON.parse keeps
          // as a number — but a future agent might quote it).
          let size = 0;
          if (isFiniteNumber(m.size_bytes)) {
            size = m.size_bytes;
          } else if (isString(m.size_bytes)) {
            const n = Number(m.size_bytes);
            size = Number.isFinite(n) ? n : 0;
          }
          return { name: m.name, size_bytes: size };
        })
        .filter((m): m is { name: string; size_bytes: number } => m !== null)
    : undefined;

  let pending_updates: ReportPendingUpdates | undefined;
  if (isPlainObject(raw.pending_updates)) {
    const pu = raw.pending_updates;
    const items = Array.isArray(pu.items)
      ? pu.items
          .filter(isPlainObject)
          .filter(
            (i): i is { name: string; available_version: string } =>
              isString(i.name) && isString(i.available_version)
          )
          .map((i) => ({ name: i.name, available_version: i.available_version }))
      : [];
    let count = items.length;
    if (isFiniteNumber(pu.count)) count = pu.count;
    pending_updates = { count, items };
  }

  const container_runtime = Array.isArray(raw.container_runtime)
    ? raw.container_runtime
        .filter(isPlainObject)
        .filter(
          (r): r is { name: string; version: string } =>
            isString(r.name) && isString(r.version)
        )
        .map((r) => ({ name: r.name, version: r.version }))
    : undefined;

  let virtualization: ReportVirtualization | undefined;
  if (isPlainObject(raw.virtualization)) {
    const v = raw.virtualization;
    if (isString(v.type) && isString(v.source)) {
      virtualization = { type: v.type, source: v.source };
    }
  }

  let uptime: ReportUptime | undefined;
  if (isPlainObject(raw.uptime)) {
    const u = raw.uptime;
    const seconds = isFiniteNumber(u.seconds)
      ? u.seconds
      : isString(u.seconds)
        ? Number(u.seconds)
        : NaN;
    if (Number.isFinite(seconds) && isString(u.boot_time)) {
      uptime = { seconds, boot_time: u.boot_time };
    }
  }

  return {
    ok: true,
    data: {
      agent_version: isString(raw.agent_version) ? raw.agent_version : undefined,
      collected_at: isString(raw.collected_at) ? raw.collected_at : undefined,
      host_id: raw.host_id,
      hostname: raw.hostname,
      os,
      kernel: isString(raw.kernel) ? raw.kernel : undefined,
      arch: isString(raw.arch) ? raw.arch : undefined,
      package_manager: isString(raw.package_manager) ? raw.package_manager : undefined,
      ip_addresses,
      packages,
      language_packages,
      services,
      listeners,
      containers,
      kernel_mitigations,
      loaded_modules,
      pending_updates,
      container_runtime,
      virtualization,
      uptime,
    },
  };
}
