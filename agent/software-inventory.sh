#!/usr/bin/env bash
#
# software-inventory.sh — Linux software inventory reporter
#
# Collects OS metadata, kernel, installed packages, optionally services,
# listening ports, and Docker images. Emits one JSON document per run.
# Designed to be dropped onto a host and scheduled via cron with NO
# additional dependencies beyond what every Linux distro ships.
#
# Supported distros (auto-detected):
#   - Debian / Ubuntu / Debian-derivatives           → dpkg-query
#   - RHEL / Rocky / Amazon Linux / Fedora / SUSE    → rpm
#   - Alpine                                         → apk
#   - Arch                                           → pacman
#
# Output: JSON written to stdout in DRY_RUN mode, otherwise POSTed to
# ${COLLECTOR_URL} via curl with retry. On any shipment failure the
# payload is written to ${BUFFER_DIR} and replayed on the next run.
#
# Author: JH's PKA team
# License: internal use
#
set -uo pipefail

# Cron strips PATH on some distros — set our own so package-manager
# binaries are always reachable.
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# ─── Config (overridable via environment) ──────────────────────────────
AGENT_VERSION="1.3.0"
COLLECTOR_URL="${COLLECTOR_URL:-}"
COLLECTOR_TOKEN="${COLLECTOR_TOKEN:-}"
STATE_DIR="${STATE_DIR:-/var/lib/inventory-agent}"
BUFFER_DIR="${BUFFER_DIR:-${STATE_DIR}/buffer}"
HOST_ID_FILE="${HOST_ID_FILE:-${STATE_DIR}/host-id}"
LOG_FILE="${LOG_FILE:-/var/log/inventory-agent.log}"
HTTP_TIMEOUT="${HTTP_TIMEOUT:-30}"
HTTP_RETRIES="${HTTP_RETRIES:-3}"
INCLUDE_SERVICES="${INCLUDE_SERVICES:-1}"
INCLUDE_LISTENERS="${INCLUDE_LISTENERS:-1}"
INCLUDE_CONTAINERS="${INCLUDE_CONTAINERS:-1}"
INCLUDE_LANGUAGE_PACKAGES="${INCLUDE_LANGUAGE_PACKAGES:-1}"
INCLUDE_IP_ADDRESSES="${INCLUDE_IP_ADDRESSES:-1}"
INCLUDE_KERNEL_MITIGATIONS="${INCLUDE_KERNEL_MITIGATIONS:-1}"
INCLUDE_LOADED_MODULES="${INCLUDE_LOADED_MODULES:-1}"
INCLUDE_PENDING_UPDATES="${INCLUDE_PENDING_UPDATES:-1}"
INCLUDE_CONTAINER_RUNTIME="${INCLUDE_CONTAINER_RUNTIME:-1}"
INCLUDE_VIRTUALIZATION="${INCLUDE_VIRTUALIZATION:-1}"
INCLUDE_UPTIME="${INCLUDE_UPTIME:-1}"
INCLUDE_SNAP_PACKAGES="${INCLUDE_SNAP_PACKAGES:-1}"
INCLUDE_FLATPAK_PACKAGES="${INCLUDE_FLATPAK_PACKAGES:-1}"
DRY_RUN="${DRY_RUN:-0}"
PRETTY="${PRETTY:-auto}"   # auto | 1 | 0

# ─── Server-driven config (boot-time handshake) ────────────────────────
# The agent asks the collector "what should I gather?" at the top of
# every run. The answer caches to ${SERVER_CONFIG_FILE}; if a future run
# can't reach the collector we re-use the cache. The cache is stale
# after $INVENTORY_CONFIG_TTL_DAYS, after which we fall back to the
# compiled-in defaults (current single-host behavior).
#
# Override rule: for each feature, take the server value, then if a
# local `--no-X` flag is set, force off. The server can't force-on what
# the local operator has explicitly disabled — local --no-X is always
# an emergency escape hatch.
INVENTORY_CONFIG_TTL_DAYS="${INVENTORY_CONFIG_TTL_DAYS:-7}"
# Set to 1 to skip the config fetch entirely and use compiled-in
# defaults (for testing or single-host installs without a collector).
INVENTORY_FORCE_DEFAULTS="${INVENTORY_FORCE_DEFAULTS:-0}"
SERVER_CONFIG_FILE="${SERVER_CONFIG_FILE:-${STATE_DIR}/server-config.json}"
LAST_CONFIG_VERSION_FILE="${LAST_CONFIG_VERSION_FILE:-${STATE_DIR}/last-config-version}"

# ─── Self-update ───────────────────────────────────────────────────────
# The collector's /api/v1/config response carries the sha256 of the
# canonical agent script. On every run, AFTER resolve_config but BEFORE
# any inventory collection, the agent compares the local sha against
# the server sha; mismatch triggers a download to a temp file, a hash
# verification, and an exec(2) re-launch with the same args.
#
# SECURITY: default OFF. Self-update is convenient but means a
# compromised (or MitM'd) collector can ship arbitrary root code to the
# fleet on the next cron tick — the integrity check is server-asserted.
# Operators opt in per-host with INVENTORY_AUTO_UPDATE=1 once they're
# comfortable with the collector's trust posture. Future: signed agent
# scripts (ed25519) will let us safely default this on again.
#
# Additional defense: even when enabled, the agent refuses to follow a
# `download_url` whose host differs from $COLLECTOR_URL — so a hostile
# collector config can't redirect updates to an attacker-controlled host.
INVENTORY_AUTO_UPDATE="${INVENTORY_AUTO_UPDATE:-0}"
# Default: where the running script actually lives on disk. Used both
# to read the local sha and (on success) to overwrite with the new
# version. Override only if you keep the agent in a non-canonical
# place — e.g. a read-only image where the install path differs from
# the executable path.
INVENTORY_SCRIPT_PATH="${INVENTORY_SCRIPT_PATH:-}"

# Tracks where each per-feature decision came from. Local force-off
# flags from CLI/env have to win over the server, so we record them
# before fetching and re-apply them after.
FORCE_OFF_SERVICES="${FORCE_OFF_SERVICES:-0}"
FORCE_OFF_LISTENERS="${FORCE_OFF_LISTENERS:-0}"
FORCE_OFF_CONTAINERS="${FORCE_OFF_CONTAINERS:-0}"
FORCE_OFF_LANGUAGE_PACKAGES="${FORCE_OFF_LANGUAGE_PACKAGES:-0}"
FORCE_OFF_IP_ADDRESSES="${FORCE_OFF_IP_ADDRESSES:-0}"
FORCE_OFF_KERNEL_MITIGATIONS="${FORCE_OFF_KERNEL_MITIGATIONS:-0}"
FORCE_OFF_LOADED_MODULES="${FORCE_OFF_LOADED_MODULES:-0}"
FORCE_OFF_PENDING_UPDATES="${FORCE_OFF_PENDING_UPDATES:-0}"
FORCE_OFF_CONTAINER_RUNTIME="${FORCE_OFF_CONTAINER_RUNTIME:-0}"
FORCE_OFF_VIRTUALIZATION="${FORCE_OFF_VIRTUALIZATION:-0}"
FORCE_OFF_UPTIME="${FORCE_OFF_UPTIME:-0}"
FORCE_OFF_SNAP_PACKAGES="${FORCE_OFF_SNAP_PACKAGES:-0}"
FORCE_OFF_FLATPAK_PACKAGES="${FORCE_OFF_FLATPAK_PACKAGES:-0}"

TMPDIR="${TMPDIR:-/tmp}"

# ─── CLI ───────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
software-inventory.sh — collect installed software and ship to a collector

USAGE
  software-inventory.sh [OPTIONS]

OPTIONS
  -n, --dry-run        Print the JSON payload to stdout instead of shipping
      --pretty         Force pretty-printed JSON output (default when --dry-run)
      --compact        Force compact JSON output (default when shipping)
      --no-services           Skip running-services inventory (force-off)
      --no-listeners          Skip listening-ports inventory (force-off)
      --no-containers         Skip Docker containers inventory (force-off)
      --no-language-packages  Skip pip/npm/gem/composer/cargo inventory (force-off)
      --no-ip-addresses       Skip IP-addresses inventory (force-off)
      --no-kernel-mitigations Skip CPU vulnerability/mitigation status (force-off)
      --no-loaded-modules     Skip loaded-kernel-modules inventory (force-off)
      --no-pending-updates    Skip pending OS updates inventory (force-off)
      --no-container-runtime  Skip container runtime detection (force-off)
      --no-virtualization     Skip virtualization/hypervisor detection (force-off)
      --no-uptime             Skip uptime/boot-time collection (force-off)
      --no-snap-packages      Skip snap package inventory (force-off)
      --no-flatpak-packages   Skip flatpak package inventory (force-off)
      --no-auto-update        Skip the collector-driven self-update check
                              (equivalent to INVENTORY_AUTO_UPDATE=0)
  -h, --help           Show this help

  All --no-X flags are LOCAL FORCE-OFF overrides — they win even when
  the collector says the feature is on for the rest of the fleet.
  Local --no-X can never force-ON a feature the collector has disabled.

ENVIRONMENT
  COLLECTOR_URL        HTTPS endpoint that accepts POST /reports
  COLLECTOR_TOKEN      Bearer token sent as Authorization header
  STATE_DIR            Where the host-id + buffered reports live
                       (default: /var/lib/inventory-agent)
  LOG_FILE             Append-mode log file
                       (default: /var/log/inventory-agent.log)
  HTTP_TIMEOUT         Per-attempt curl timeout, seconds (default: 30)
  HTTP_RETRIES         Number of POST attempts before buffering (default: 3)
  INVENTORY_CONFIG_TTL_DAYS
                       How long a cached server config is considered
                       fresh before we fall back to defaults (default: 7)
  INVENTORY_FORCE_DEFAULTS=1
                       Skip the config fetch entirely; use compiled-in
                       defaults. For testing without server contact.
  INVENTORY_AUTO_UPDATE=0
                       Skip the collector-driven self-update check
                       (default 1; --no-auto-update mirrors this).
  INVENTORY_SCRIPT_PATH
                       Path the self-updater should overwrite on a
                       successful update. Defaults to readlink -f "\$0".
  INCLUDE_KERNEL_MITIGATIONS / FORCE_OFF_KERNEL_MITIGATIONS
                       Toggle /sys/devices/system/cpu/vulnerabilities/* scrape.
  INCLUDE_LOADED_MODULES / FORCE_OFF_LOADED_MODULES
                       Toggle /proc/modules inventory.
  INCLUDE_PENDING_UPDATES / FORCE_OFF_PENDING_UPDATES
                       Toggle distro-specific local-cache pending-update count.
  INCLUDE_CONTAINER_RUNTIME / FORCE_OFF_CONTAINER_RUNTIME
                       Toggle docker/podman/containerd/crio binary detection.
  INCLUDE_VIRTUALIZATION / FORCE_OFF_VIRTUALIZATION
                       Toggle systemd-detect-virt (or /sys/class/dmi/id fallback).
  INCLUDE_UPTIME / FORCE_OFF_UPTIME
                       Toggle /proc/uptime + derived boot_time.
  INCLUDE_SNAP_PACKAGES / FORCE_OFF_SNAP_PACKAGES
                       Toggle `snap list` inventory (folded into language_packages[]).
  INCLUDE_FLATPAK_PACKAGES / FORCE_OFF_FLATPAK_PACKAGES
                       Toggle `flatpak list --app` inventory (folded into language_packages[]).

EXAMPLES
  # See what would be shipped, pretty-printed:
  software-inventory.sh --dry-run

  # Ship to a collector, with services skipped:
  COLLECTOR_URL=https://inventory.example/api/v1/reports \\
  COLLECTOR_TOKEN=hunter2 \\
  software-inventory.sh --no-services
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      -n|--dry-run)    DRY_RUN=1 ;;
      --pretty)        PRETTY=1 ;;
      --compact)       PRETTY=0 ;;
      --no-services)         INCLUDE_SERVICES=0;          FORCE_OFF_SERVICES=1 ;;
      --no-listeners)        INCLUDE_LISTENERS=0;         FORCE_OFF_LISTENERS=1 ;;
      --no-containers)       INCLUDE_CONTAINERS=0;        FORCE_OFF_CONTAINERS=1 ;;
      --no-language-packages) INCLUDE_LANGUAGE_PACKAGES=0; FORCE_OFF_LANGUAGE_PACKAGES=1 ;;
      --no-ip-addresses)     INCLUDE_IP_ADDRESSES=0;      FORCE_OFF_IP_ADDRESSES=1 ;;
      --no-kernel-mitigations) INCLUDE_KERNEL_MITIGATIONS=0; FORCE_OFF_KERNEL_MITIGATIONS=1 ;;
      --no-loaded-modules)     INCLUDE_LOADED_MODULES=0;     FORCE_OFF_LOADED_MODULES=1 ;;
      --no-pending-updates)    INCLUDE_PENDING_UPDATES=0;    FORCE_OFF_PENDING_UPDATES=1 ;;
      --no-container-runtime)  INCLUDE_CONTAINER_RUNTIME=0;  FORCE_OFF_CONTAINER_RUNTIME=1 ;;
      --no-virtualization)     INCLUDE_VIRTUALIZATION=0;     FORCE_OFF_VIRTUALIZATION=1 ;;
      --no-uptime)             INCLUDE_UPTIME=0;             FORCE_OFF_UPTIME=1 ;;
      --no-snap-packages)      INCLUDE_SNAP_PACKAGES=0;      FORCE_OFF_SNAP_PACKAGES=1 ;;
      --no-flatpak-packages)   INCLUDE_FLATPAK_PACKAGES=0;   FORCE_OFF_FLATPAK_PACKAGES=1 ;;
      --no-auto-update)        INVENTORY_AUTO_UPDATE=0 ;;
      -h|--help)       usage; exit 0 ;;
      --) shift; break ;;
      *)
        echo "Unknown option: $1" >&2
        echo "Run with --help for usage." >&2
        exit 2
        ;;
    esac
    shift
  done

  # Resolve auto-pretty: pretty if dry-run, compact otherwise.
  if [ "$PRETTY" = "auto" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      PRETTY=1
    else
      PRETTY=0
    fi
  fi
}

# ─── Logging ───────────────────────────────────────────────────────────
log() {
  local ts msg
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  msg="$ts $*"
  echo "$msg" >&2
  if [ -n "${LOG_FILE:-}" ]; then
    local log_dir
    log_dir="$(dirname "$LOG_FILE")"
    if [ ! -d "$log_dir" ]; then
      mkdir -p "$log_dir" 2>/dev/null || true
    fi
    echo "$msg" >> "$LOG_FILE" 2>/dev/null || true
  fi
}

# Init state dirs (best effort — fall back to TMPDIR on read-only roots)
init_dirs() {
  for d in "$STATE_DIR" "$BUFFER_DIR"; do
    if ! mkdir -p "$d" 2>/dev/null; then
      log "WARN cannot create $d, falling back to $TMPDIR"
      STATE_DIR="$TMPDIR/inventory-agent"
      BUFFER_DIR="$TMPDIR/inventory-agent/buffer"
      HOST_ID_FILE="$STATE_DIR/host-id"
      mkdir -p "$STATE_DIR" "$BUFFER_DIR" 2>/dev/null || true
      break
    fi
  done
  chmod 700 "$STATE_DIR" 2>/dev/null || true
}

# ─── JSON helpers ──────────────────────────────────────────────────────
# Escape a string for embedding inside JSON quotes. Strips control chars
# (which would otherwise produce invalid JSON) and escapes the few
# characters that matter for shell-derived strings.
json_escape() {
  printf '%s' "$1" \
    | tr -d '\000-\037' \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Emit a JSON string literal (quoted + escaped).
js() {
  printf '"%s"' "$(json_escape "${1-}")"
}

# Pretty-print compact JSON from stdin. Pure awk, no jq required.
# Handles balanced {/}, [/], strings with embedded delimiters, and
# escape sequences inside strings. Empty objects/arrays are collapsed
# onto a single line ([] / {}) for readability.
pretty_print_json() {
  awk '
    BEGIN { depth = 0; in_string = 0; escape = 0; INDENT = "  " }
    function indent(n,   i, s) {
      s = ""
      for (i = 0; i < n; i++) s = s INDENT
      return s
    }
    {
      line = $0
      n = length(line)
      for (i = 1; i <= n; i++) {
        c = substr(line, i, 1)
        if (escape) {
          printf "%s", c
          escape = 0
          continue
        }
        if (in_string) {
          if (c == "\\") {
            printf "%s", c
            escape = 1
          } else if (c == "\"") {
            printf "%s", c
            in_string = 0
          } else {
            printf "%s", c
          }
          continue
        }
        if (c == "\"") {
          printf "%s", c
          in_string = 1
          continue
        }
        if (c == "{" || c == "[") {
          # Collapse empty {} and [] onto one line.
          nxt = substr(line, i + 1, 1)
          if ((c == "{" && nxt == "}") || (c == "[" && nxt == "]")) {
            printf "%s%s", c, nxt
            i++
            continue
          }
          printf "%s\n%s", c, indent(++depth)
          continue
        }
        if (c == "}" || c == "]") {
          printf "\n%s%s", indent(--depth), c
          continue
        }
        if (c == ",") {
          printf ",\n%s", indent(depth)
          continue
        }
        if (c == ":") {
          printf ": "
          continue
        }
        printf "%s", c
      }
    }
    END { printf "\n" }
  '
}

# Build a JSON array from a temp file containing one JSON value per
# non-empty line.
emit_json_array_from_file() {
  local f="$1"
  if [ ! -s "$f" ]; then
    printf '[]'
    return
  fi
  printf '['
  # paste -s -d ',' joins lines with commas.
  paste -s -d ',' "$f"
  printf ']'
}

# ─── Server-driven config ──────────────────────────────────────────────
# Extract a snake_case feature key from the cached server JSON and echo
# "1" or "0". Same awk technique as the language-packages parser — pure
# awk, no jq dependency, robust to whitespace and key ordering.
#
# Looks ONLY inside the "enabled" object so it can't be tricked by a
# matching key at the top level (e.g. "version":true would otherwise
# poison `read_bool_from_config version`).
read_bool_from_config() {
  local key="$1" file="$2" default="$3"
  if [ ! -s "$file" ]; then
    echo "$default"
    return
  fi
  awk -v key="$key" -v default_val="$default" '
    BEGIN { in_enabled = 0; depth_in_enabled = 0; found = 0; out = default_val }
    {
      line = $0
      n = length(line)
      in_str = 0; esc = 0; buf = ""
      for (i = 1; i <= n; i++) {
        c = substr(line, i, 1)
        if (esc) { buf = buf c; esc = 0; continue }
        if (in_str) {
          if (c == "\\") { buf = buf c; esc = 1; continue }
          if (c == "\"") { buf = buf c; in_str = 0; continue }
          buf = buf c; continue
        }
        if (c == "\"") { buf = buf c; in_str = 1; continue }
        if (c == "{") {
          if (in_enabled) depth_in_enabled++
          # Detect "enabled": { — check the last quoted token in buf.
          if (buf ~ /"enabled"[ \t]*:[ \t]*$/) {
            in_enabled = 1
            depth_in_enabled = 1
          }
          buf = ""
          continue
        }
        if (c == "}") {
          if (in_enabled) {
            depth_in_enabled--
            if (depth_in_enabled <= 0) in_enabled = 0
          }
          buf = ""
          continue
        }
        if (c == ":" && in_enabled) {
          # Look for our key just before the colon.
          k = buf
          sub(/^[^"]*"/, "", k); sub(/".*$/, "", k)
          if (k == key) {
            # Read the next non-whitespace token: true|false (or 1|0).
            rest = substr(line, i + 1)
            sub(/^[ \t]*/, "", rest)
            if (rest ~ /^true/)  { out = "1"; found = 1 }
            else if (rest ~ /^false/) { out = "0"; found = 1 }
            else if (rest ~ /^1/) { out = "1"; found = 1 }
            else if (rest ~ /^0/) { out = "0"; found = 1 }
          }
          buf = ""
          continue
        }
        if (c == ",") { buf = ""; continue }
        buf = buf c
      }
    }
    END { print out }
  ' "$file"
}

# Extract the top-level integer "version" field. Same pattern, simpler
# scope (we only care about the top object).
read_version_from_config() {
  local file="$1"
  [ ! -s "$file" ] && { echo "0"; return; }
  awk '
    /"version"[ \t]*:[ \t]*[0-9]+/ {
      line = $0
      sub(/.*"version"[ \t]*:[ \t]*/, "", line)
      v = line
      sub(/[^0-9].*$/, "", v)
      if (v != "") { print v; exit }
    }
    END { if (NR == 0) print "0" }
  ' "$file"
}

# Derive the config URL from COLLECTOR_URL. The collector serves the
# ingest endpoint at .../api/v1/reports and the config at
# .../api/v1/config, so we strip the trailing path segment and append.
derive_config_url() {
  local base="$COLLECTOR_URL"
  # Strip trailing slash(es), strip the last path segment.
  base="${base%/}"
  base="${base%/*}"
  printf '%s/config' "$base"
}

# Returns 0 if $1 exists AND its mtime is younger than
# $INVENTORY_CONFIG_TTL_DAYS. Used to decide whether the cache is still
# trustworthy after a fetch failure.
config_cache_fresh() {
  local file="$1"
  [ -s "$file" ] || return 1
  local ttl_seconds now mtime
  ttl_seconds=$((INVENTORY_CONFIG_TTL_DAYS * 86400))
  now="$(date -u +%s)"
  if mtime="$(stat -c %Y "$file" 2>/dev/null)"; then :
  elif mtime="$(stat -f %m "$file" 2>/dev/null)"; then :  # BSD/macOS
  else mtime=0
  fi
  [ $((now - mtime)) -lt "$ttl_seconds" ]
}

# Fetch the server config into ${SERVER_CONFIG_FILE}. Best-effort.
# Returns 0 on success, non-zero on any HTTP / network failure.
fetch_server_config() {
  if [ -z "$COLLECTOR_URL" ] || [ -z "$COLLECTOR_TOKEN" ]; then
    return 1
  fi
  local url tmp status
  url="$(derive_config_url)"
  tmp="$(mktemp -t inv-cfg.XXXXXX)"
  status="$(curl -sS -o "$tmp" -w '%{http_code}' \
      --max-time 10 \
      -H "Authorization: Bearer ${COLLECTOR_TOKEN}" \
      "$url" 2>/dev/null)"
  # curl writes "000" to %{http_code} on connection failure AND exits
  # non-zero. Guard against an unparseable status (empty string).
  [ -z "$status" ] && status="000"
  if [ "$status" -ge 200 ] && [ "$status" -lt 300 ] && [ -s "$tmp" ]; then
    mv -f "$tmp" "$SERVER_CONFIG_FILE" 2>/dev/null || {
      rm -f "$tmp"
      return 1
    }
    chmod 600 "$SERVER_CONFIG_FILE" 2>/dev/null || true
    return 0
  fi
  rm -f "$tmp"
  log "WARN config fetch failed (HTTP $status)"
  return 1
}

# ─── Self-update helpers ───────────────────────────────────────────────
# Extract a top-level string field from the agent block of the cached
# server config. Looks ONLY inside the "agent" object so it can't be
# tricked by a same-named key at the document root.
#
# Echoes the value verbatim (without surrounding quotes), or empty
# string when the key is absent — older collectors that pre-date the
# self-update field land in that branch and the agent silently skips
# the check.
read_agent_string_from_config() {
  local key="$1" file="$2"
  [ ! -s "$file" ] && { echo ""; return; }
  awk -v key="$key" '
    BEGIN { in_agent = 0; depth_in_agent = 0; out = "" }
    {
      line = $0
      n = length(line)
      in_str = 0; esc = 0; buf = ""
      for (i = 1; i <= n; i++) {
        c = substr(line, i, 1)
        if (esc) { buf = buf c; esc = 0; continue }
        if (in_str) {
          if (c == "\\") { buf = buf c; esc = 1; continue }
          if (c == "\"") { buf = buf c; in_str = 0; continue }
          buf = buf c; continue
        }
        if (c == "\"") { buf = buf c; in_str = 1; continue }
        if (c == "{") {
          if (in_agent) depth_in_agent++
          if (buf ~ /"agent"[ \t]*:[ \t]*$/) {
            in_agent = 1
            depth_in_agent = 1
          }
          buf = ""
          continue
        }
        if (c == "}") {
          if (in_agent) {
            depth_in_agent--
            if (depth_in_agent <= 0) in_agent = 0
          }
          buf = ""
          continue
        }
        if (c == ":" && in_agent) {
          k = buf
          sub(/^[^"]*"/, "", k); sub(/".*$/, "", k)
          if (k == key) {
            rest = substr(line, i + 1)
            sub(/^[ \t]*"/, "", rest)
            sub(/".*$/, "", rest)
            if (rest != "") { out = rest }
          }
          buf = ""
          continue
        }
        if (c == ",") { buf = ""; continue }
        buf = buf c
      }
    }
    END { print out }
  ' "$file"
}

# Compute the sha256 of a file using whatever the host has. sha256sum
# is ubiquitous on Linux (coreutils + busybox); shasum is the macOS
# dev-box fallback. Echoes only the hex digest, or empty on failure.
compute_local_sha256() {
  local file="$1"
  [ -r "$file" ] || { echo ""; return; }
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" 2>/dev/null | awk '{print $1; exit}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" 2>/dev/null | awk '{print $1; exit}'
  else
    echo ""
  fi
}

# Collector-driven self-update.
#
# Runs AFTER resolve_config (so we have a fresh cached config to read
# the server hash from) and BEFORE any inventory collection (so a
# successful update re-execs with the same args and runs the *new*
# inventory logic on this same tick).
#
# Returns 0 always — an update failure must not abort the run.
# Outcomes, each with a distinct log line:
#
#   (a) skipped               INFO agent auto-update disabled
#   (b) no agent block        (silent — older collector)
#   (c) matches               INFO agent sha256 matches server, no update
#   (d) updated + re-exec     INFO agent update available (...); downloading
#                             INFO agent updated to <new-prefix>; re-executing
#   (e) hash mismatch         WARN downloaded agent hash mismatch — aborting update
#   (f) download failed       WARN agent update download failed (HTTP NNN); continuing
self_update() {
  if [ "$INVENTORY_AUTO_UPDATE" = "0" ]; then
    log "INFO agent auto-update disabled"
    return 0
  fi
  local server_sha download_url script_path local_sha
  server_sha="$(read_agent_string_from_config current_sha256 "$SERVER_CONFIG_FILE")"
  download_url="$(read_agent_string_from_config download_url "$SERVER_CONFIG_FILE")"
  if [ -z "$server_sha" ] || [ -z "$download_url" ]; then
    # Older collector that hasn't deployed the self-update block.
    return 0
  fi

  # SECURITY: pin download_url's host to the collector we were
  # installed with. Prevents a hostile collector config from
  # redirecting agents to attacker-controlled hosts.
  local collector_host download_host
  collector_host="$(printf '%s' "$COLLECTOR_URL" | awk -F/ 'NF>=3{print $3}')"
  download_host="$(printf '%s' "$download_url" | awk -F/ 'NF>=3{print $3}')"
  if [ -z "$collector_host" ] || [ -z "$download_host" ]; then
    log "WARN cannot parse host from COLLECTOR_URL or download_url; skipping self-update"
    return 0
  fi
  if [ "$collector_host" != "$download_host" ]; then
    log "WARN server-advertised download_url host '$download_host' does not match collector host '$collector_host'; refusing to self-update"
    return 0
  fi

  script_path="$INVENTORY_SCRIPT_PATH"
  if [ -z "$script_path" ]; then
    if command -v readlink >/dev/null 2>&1; then
      script_path="$(readlink -f "$0" 2>/dev/null || echo "$0")"
    else
      script_path="$0"
    fi
  fi

  local_sha="$(compute_local_sha256 "$script_path")"
  if [ -z "$local_sha" ]; then
    log "WARN cannot compute local agent sha256 (no sha256sum/shasum); skipping self-update"
    return 0
  fi

  if [ "$local_sha" = "$server_sha" ]; then
    log "INFO agent sha256 matches server, no update"
    return 0
  fi

  local local_prefix server_prefix
  local_prefix="${local_sha:0:12}"
  server_prefix="${server_sha:0:12}"
  log "INFO agent update available (local ${local_prefix}... → server ${server_prefix}...); downloading"

  local tmp status
  tmp="$(mktemp -t inv-agent.XXXXXX)"
  status="$(curl -sS -o "$tmp" -w '%{http_code}' \
      --max-time 60 \
      "$download_url" 2>/dev/null)"
  [ -z "$status" ] && status="000"
  if ! { [ "$status" -ge 200 ] && [ "$status" -lt 300 ] && [ -s "$tmp" ]; }; then
    log "WARN agent update download failed (HTTP $status); continuing with current version"
    rm -f "$tmp"
    return 0
  fi

  local downloaded_sha
  downloaded_sha="$(compute_local_sha256 "$tmp")"
  if [ "$downloaded_sha" != "$server_sha" ]; then
    log "WARN downloaded agent hash mismatch — aborting update"
    rm -f "$tmp"
    return 0
  fi

  if ! chmod 755 "$tmp" 2>/dev/null; then
    log "WARN cannot chmod downloaded agent; continuing with current version"
    rm -f "$tmp"
    return 0
  fi
  if ! mv -f "$tmp" "$script_path" 2>/dev/null; then
    log "WARN cannot overwrite ${script_path}; continuing with current version"
    rm -f "$tmp"
    return 0
  fi

  log "INFO agent updated to ${server_prefix}...; re-executing"
  # exec(2) replaces this process with the new script — no zombie, and
  # the new agent's exit code becomes our exit code. The trap from main
  # is still pristine here (we run BEFORE the payload tempfile trap is
  # installed) so there's nothing to clean up.
  exec "$script_path" "$@"
}

# Apply one feature's server+local rule. Local force-off always wins.
# Arguments: <variable-name> <feature-key> <force-off-flag>
apply_feature_rule() {
  local var_name="$1" key="$2" force_off="$3"
  if [ "$force_off" = "1" ]; then
    eval "$var_name=0"
    return
  fi
  local val
  val="$(read_bool_from_config "$key" "$SERVER_CONFIG_FILE" "1")"
  eval "$var_name=$val"
}

# Resolve the effective plan for this run. Sets INCLUDE_* in place. Has
# four outcomes, each with a distinct log line so an operator tailing
# /var/log/inventory-agent.log can see where the plan came from:
#
#   (a) success           INFO server config v$V applied
#   (b) fetch failed,
#       cache usable      WARN config fetch failed; using cached v$V
#   (c) fetch failed,
#       no usable cache   WARN no usable cached config; falling back to compiled defaults
#   (d) version unchanged INFO server config v$V unchanged
#
# Returns 0 always — config resolution must never abort the run.
resolve_config() {
  if [ "$INVENTORY_FORCE_DEFAULTS" = "1" ]; then
    log "INFO INVENTORY_FORCE_DEFAULTS=1; using compiled defaults"
    return 0
  fi
  local fetched=0 use_cache=0
  if fetch_server_config; then
    fetched=1
  elif config_cache_fresh "$SERVER_CONFIG_FILE"; then
    use_cache=1
  fi

  if [ "$fetched" = "0" ] && [ "$use_cache" = "0" ]; then
    log "WARN no usable cached config; falling back to compiled defaults"
    # Even with no server input we still honour local force-off flags.
    [ "$FORCE_OFF_SERVICES" = "1" ]          && INCLUDE_SERVICES=0
    [ "$FORCE_OFF_LISTENERS" = "1" ]         && INCLUDE_LISTENERS=0
    [ "$FORCE_OFF_CONTAINERS" = "1" ]        && INCLUDE_CONTAINERS=0
    [ "$FORCE_OFF_LANGUAGE_PACKAGES" = "1" ] && INCLUDE_LANGUAGE_PACKAGES=0
    [ "$FORCE_OFF_IP_ADDRESSES" = "1" ]      && INCLUDE_IP_ADDRESSES=0
    [ "$FORCE_OFF_KERNEL_MITIGATIONS" = "1" ] && INCLUDE_KERNEL_MITIGATIONS=0
    [ "$FORCE_OFF_LOADED_MODULES" = "1" ]    && INCLUDE_LOADED_MODULES=0
    [ "$FORCE_OFF_PENDING_UPDATES" = "1" ]   && INCLUDE_PENDING_UPDATES=0
    [ "$FORCE_OFF_CONTAINER_RUNTIME" = "1" ] && INCLUDE_CONTAINER_RUNTIME=0
    [ "$FORCE_OFF_VIRTUALIZATION" = "1" ]    && INCLUDE_VIRTUALIZATION=0
    [ "$FORCE_OFF_UPTIME" = "1" ]            && INCLUDE_UPTIME=0
    [ "$FORCE_OFF_SNAP_PACKAGES" = "1" ]     && INCLUDE_SNAP_PACKAGES=0
    [ "$FORCE_OFF_FLATPAK_PACKAGES" = "1" ]  && INCLUDE_FLATPAK_PACKAGES=0
    return 0
  fi

  local version last_version
  version="$(read_version_from_config "$SERVER_CONFIG_FILE")"
  last_version=""
  [ -r "$LAST_CONFIG_VERSION_FILE" ] && last_version="$(tr -d '[:space:]' < "$LAST_CONFIG_VERSION_FILE")"

  if [ "$fetched" = "1" ] && [ -n "$last_version" ] && [ "$version" = "$last_version" ]; then
    log "INFO server config v${version} unchanged"
  elif [ "$fetched" = "1" ]; then
    log "INFO server config v${version} applied"
  else
    log "WARN config fetch failed; using cached v${version}"
  fi

  # Apply the rules. read_bool_from_config defaults to "1" (on) for any
  # key the cached config doesn't carry — newer agent + older server
  # JSON should keep doing what they used to.
  apply_feature_rule INCLUDE_SERVICES          services          "$FORCE_OFF_SERVICES"
  apply_feature_rule INCLUDE_LISTENERS         listeners         "$FORCE_OFF_LISTENERS"
  apply_feature_rule INCLUDE_CONTAINERS        containers        "$FORCE_OFF_CONTAINERS"
  apply_feature_rule INCLUDE_LANGUAGE_PACKAGES language_packages "$FORCE_OFF_LANGUAGE_PACKAGES"
  apply_feature_rule INCLUDE_IP_ADDRESSES      ip_addresses      "$FORCE_OFF_IP_ADDRESSES"
  apply_feature_rule INCLUDE_KERNEL_MITIGATIONS kernel_mitigations "$FORCE_OFF_KERNEL_MITIGATIONS"
  apply_feature_rule INCLUDE_LOADED_MODULES    loaded_modules    "$FORCE_OFF_LOADED_MODULES"
  apply_feature_rule INCLUDE_PENDING_UPDATES   pending_updates   "$FORCE_OFF_PENDING_UPDATES"
  apply_feature_rule INCLUDE_CONTAINER_RUNTIME container_runtime "$FORCE_OFF_CONTAINER_RUNTIME"
  apply_feature_rule INCLUDE_VIRTUALIZATION    virtualization    "$FORCE_OFF_VIRTUALIZATION"
  apply_feature_rule INCLUDE_UPTIME            uptime            "$FORCE_OFF_UPTIME"
  apply_feature_rule INCLUDE_SNAP_PACKAGES     snap_packages     "$FORCE_OFF_SNAP_PACKAGES"
  apply_feature_rule INCLUDE_FLATPAK_PACKAGES  flatpak_packages  "$FORCE_OFF_FLATPAK_PACKAGES"

  # Persist the version so the next run can short-circuit logging.
  if [ -n "$version" ] && [ "$version" != "0" ]; then
    printf '%s\n' "$version" > "$LAST_CONFIG_VERSION_FILE" 2>/dev/null || true
  fi
}

# ─── OS identification ─────────────────────────────────────────────────
OS_ID="unknown"
OS_NAME="unknown"
OS_VERSION="unknown"
OS_VERSION_CODENAME=""
OS_LIKE=""
KERNEL="unknown"
ARCH="unknown"
HOSTNAME_FQDN="unknown"

read_os_release() {
  if [ -r /etc/os-release ]; then
    # /etc/os-release uses shell-quotable assignments. Read line-by-line
    # so we don't accidentally source arbitrary values into our shell.
    while IFS='=' read -r key val; do
      val="${val%\"}"; val="${val#\"}"
      case "$key" in
        ID)              OS_ID="$val" ;;
        NAME)            OS_NAME="$val" ;;
        VERSION_ID)      OS_VERSION="$val" ;;
        VERSION_CODENAME) OS_VERSION_CODENAME="$val" ;;
        ID_LIKE)         OS_LIKE="$val" ;;
      esac
    done < /etc/os-release
  fi
  KERNEL="$(uname -r 2>/dev/null || echo unknown)"
  ARCH="$(uname -m 2>/dev/null || echo unknown)"
  HOSTNAME_FQDN="$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo unknown)"
}

# ─── Stable host ID ────────────────────────────────────────────────────
HOST_ID=""

load_or_create_host_id() {
  if [ -r "$HOST_ID_FILE" ]; then
    HOST_ID="$(tr -d '[:space:]' < "$HOST_ID_FILE" 2>/dev/null || true)"
  fi
  if [ -z "$HOST_ID" ]; then
    if [ -r /etc/machine-id ]; then
      HOST_ID="$(tr -d '[:space:]' < /etc/machine-id)"
    elif [ -r /var/lib/dbus/machine-id ]; then
      HOST_ID="$(tr -d '[:space:]' < /var/lib/dbus/machine-id)"
    else
      # MAC address (stable on the same physical/virtual NIC).
      local mac=""
      if command -v ip >/dev/null 2>&1; then
        mac="$(ip -o link 2>/dev/null | awk '/link\/ether/ && !/loopback/ {print $(NF-2); exit}')"
      fi
      if [ -z "$mac" ] && command -v ifconfig >/dev/null 2>&1; then
        mac="$(ifconfig 2>/dev/null | awk '/ether/ {print $2; exit}')"
      fi
      if [ -n "$mac" ]; then
        HOST_ID="$(printf '%s' "$mac" | tr -d ':' | tr '[:upper:]' '[:lower:]')"
      else
        # Last resort: hostname + first-boot timestamp.
        HOST_ID="${HOSTNAME_FQDN}-$(date +%s)"
      fi
    fi
    printf '%s\n' "$HOST_ID" > "$HOST_ID_FILE" 2>/dev/null || true
    chmod 600 "$HOST_ID_FILE" 2>/dev/null || true
  fi
}

# ─── Package manager detection + inventory ─────────────────────────────
PKG_MGR="unknown"

detect_pkg_mgr() {
  if command -v dpkg-query >/dev/null 2>&1; then
    PKG_MGR="dpkg"
  elif command -v rpm >/dev/null 2>&1; then
    PKG_MGR="rpm"
  elif command -v apk >/dev/null 2>&1; then
    PKG_MGR="apk"
  elif command -v pacman >/dev/null 2>&1; then
    PKG_MGR="pacman"
  fi
}

# Write one JSON object per line into ${tmp}, then the array is built
# downstream by `emit_json_array_from_file`.
inventory_packages_to() {
  local tmp="$1"
  : > "$tmp"
  case "$PKG_MGR" in
    dpkg)
      # Status-Abbrev "ii" means installed-installed. Anything else
      # (rc=remove-config-only, un=unknown, etc.) is excluded.
      dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\t${db:Status-Abbrev}\n' 2>/dev/null \
        | awk -F'\t' '$4 ~ /^ii/' \
        | while IFS=$'\t' read -r name version arch _; do
            printf '{"name":%s,"version":%s,"arch":%s}\n' \
              "$(js "$name")" "$(js "$version")" "$(js "$arch")"
          done >> "$tmp"
      ;;
    rpm)
      rpm -qa --qf '%{NAME}\t%{VERSION}-%{RELEASE}\t%{ARCH}\n' 2>/dev/null \
        | while IFS=$'\t' read -r name version arch; do
            [ -z "$name" ] && continue
            printf '{"name":%s,"version":%s,"arch":%s}\n' \
              "$(js "$name")" "$(js "$version")" "$(js "$arch")"
          done >> "$tmp"
      ;;
    apk)
      # apk info -v emits "<name>-<version>". The version always starts
      # with a digit, so we split on the last "-<digit>...".
      apk info -v 2>/dev/null \
        | while IFS= read -r line; do
            [ -z "$line" ] && continue
            local name version
            name="$(printf '%s' "$line" | sed -E 's/-[0-9].*$//')"
            version="${line#${name}-}"
            printf '{"name":%s,"version":%s,"arch":%s}\n' \
              "$(js "$name")" "$(js "$version")" "$(js "$ARCH")"
          done >> "$tmp"
      ;;
    pacman)
      pacman -Q 2>/dev/null \
        | while IFS=' ' read -r name version; do
            [ -z "$name" ] && continue
            printf '{"name":%s,"version":%s,"arch":%s}\n' \
              "$(js "$name")" "$(js "$version")" "$(js "$ARCH")"
          done >> "$tmp"
      ;;
    *)
      log "WARN no supported package manager found"
      ;;
  esac
}

# ─── Optional inventories ──────────────────────────────────────────────
inventory_services_to() {
  local tmp="$1"
  : > "$tmp"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl list-units --type=service --state=running --no-legend --no-pager 2>/dev/null \
      | awk '{print $1}' \
      | while IFS= read -r unit; do
          [ -z "$unit" ] && continue
          printf '{"unit":%s}\n' "$(js "$unit")"
        done >> "$tmp"
  fi
}

inventory_listeners_to() {
  local tmp="$1"
  : > "$tmp"
  if command -v ss >/dev/null 2>&1; then
    # ss -tulnH: TCP+UDP listening, numeric, no header.
    ss -tulnH 2>/dev/null \
      | awk '{print $1"\t"$5}' \
      | while IFS=$'\t' read -r proto bind; do
          # bind looks like 0.0.0.0:22 or [::]:80
          local port="${bind##*:}"
          local addr="${bind%:*}"
          [ -z "$port" ] && continue
          printf '{"proto":%s,"addr":%s,"port":%s}\n' \
            "$(js "$proto")" "$(js "$addr")" "$(js "$port")"
        done >> "$tmp"
  elif command -v netstat >/dev/null 2>&1; then
    netstat -tuln 2>/dev/null \
      | awk 'NR>2 {print $1"\t"$4}' \
      | while IFS=$'\t' read -r proto bind; do
          local port="${bind##*:}"
          local addr="${bind%:*}"
          [ -z "$port" ] && continue
          printf '{"proto":%s,"addr":%s,"port":%s}\n' \
            "$(js "$proto")" "$(js "$addr")" "$(js "$port")"
        done >> "$tmp"
  fi
}

inventory_containers_to() {
  local tmp="$1"
  : > "$tmp"
  if command -v docker >/dev/null 2>&1; then
    docker ps --format '{{.ID}}\t{{.Image}}\t{{.Names}}' 2>/dev/null \
      | while IFS=$'\t' read -r cid image name; do
          [ -z "$cid" ] && continue
          printf '{"id":%s,"image":%s,"name":%s}\n' \
            "$(js "$cid")" "$(js "$image")" "$(js "$name")"
        done >> "$tmp"
  fi
}

# Emit one {ecosystem,name,version,location} object per line for every
# globally-installed package from supported language ecosystems. Each
# helper is a no-op when its tool isn't on PATH, so this is safe to run
# on minimal hosts. "Globally installed" is the intentional scope —
# project-local node_modules / virtualenvs etc. would multiply noise
# by 100× on a typical dev box; servers tend to have a small,
# server-administered set of system-wide language packages.
inventory_language_packages_to() {
  local tmp="$1"
  : > "$tmp"

  # pip (try pip3 then pip; never pip2). Use the JSON format — it's
  # stable across pip 9.x+ and avoids parsing the human-readable table.
  local pip_bin=""
  if command -v pip3 >/dev/null 2>&1; then pip_bin="pip3"
  elif command -v pip >/dev/null 2>&1; then pip_bin="pip"
  fi
  if [ -n "$pip_bin" ]; then
    "$pip_bin" list --format=json --disable-pip-version-check 2>/dev/null \
      | awk '
          # Tiny JSON-array streaming parser. The pip output is
          #   [{"name": "...", "version": "..."}, ...]
          # We extract name+version per element without jq.
          {
            line = $0
            n = length(line)
            depth = 0; in_str = 0; esc = 0; buf = ""; name = ""; ver = ""
            for (i = 1; i <= n; i++) {
              c = substr(line, i, 1)
              if (esc) { buf = buf c; esc = 0; continue }
              if (c == "\\" && in_str) { buf = buf c; esc = 1; continue }
              if (c == "\"") { in_str = !in_str; buf = buf c; continue }
              if (in_str) { buf = buf c; continue }
              if (c == "{") { depth++; buf = ""; name=""; ver=""; continue }
              if (c == "}") {
                # Object closed — emit if we have both fields.
                if (name != "" && ver != "") {
                  print "pip\t" name "\t" ver
                }
                depth--; buf=""; name=""; ver=""; continue
              }
              if (c == ",") {
                buf=""; continue
              }
              if (c == ":") {
                # buf holds the just-seen key in quotes. Strip them.
                key = buf
                gsub(/^[ \t]*"|"[ \t]*$/, "", key)
                # Read the value: rest of this segment up to comma or }.
                j = i + 1; v = ""; inv_str = 0; inv_esc = 0
                # Skip whitespace
                while (j <= n && (substr(line,j,1) == " " || substr(line,j,1) == "\t")) j++
                if (substr(line, j, 1) == "\"") {
                  inv_str = 1; j++
                  while (j <= n) {
                    cc = substr(line, j, 1)
                    if (inv_esc) { v = v cc; inv_esc = 0; j++; continue }
                    if (cc == "\\") { inv_esc = 1; j++; continue }
                    if (cc == "\"") { j++; break }
                    v = v cc; j++
                  }
                }
                if (key == "name") name = v
                if (key == "version") ver = v
                i = j - 1
                buf = ""
                continue
              }
              buf = buf c
            }
          }
        ' \
      | while IFS=$'\t' read -r eco name version; do
          [ -z "$name" ] && continue
          printf '{"ecosystem":%s,"name":%s,"version":%s,"location":%s}\n' \
            "$(js "$eco")" "$(js "$name")" "$(js "$version")" "$(js "system")"
        done >> "$tmp"
  fi

  # npm -g — `npm ls -g --depth=0 --json` is the standard.
  if command -v npm >/dev/null 2>&1; then
    npm ls -g --depth=0 --json 2>/dev/null \
      | awk '
          # Parse the .dependencies object: each key is a package name,
          # its value is {version: "x.y.z", ...}. Same one-pass approach
          # as pip above. Simpler because we only need name + version.
          /"dependencies"[ ]*:[ ]*\{/ { in_deps = 1 }
          in_deps && /"version"[ ]*:/ {
            # Find the most recent package name above.
            # Approach: emit when we see a version, paired with the
            # name we cached.
            ver = $0
            sub(/.*"version"[ ]*:[ ]*"/, "", ver)
            sub(/".*$/, "", ver)
            if (cached_name != "") {
              print "npm\t" cached_name "\t" ver
              cached_name = ""
            }
          }
          in_deps && /^[ ]+"[^"]+": \{/ {
            line = $0
            sub(/^[ ]+"/, "", line)
            sub(/": \{.*$/, "", line)
            cached_name = line
          }
        ' \
      | while IFS=$'\t' read -r eco name version; do
          [ -z "$name" ] && continue
          printf '{"ecosystem":%s,"name":%s,"version":%s,"location":%s}\n' \
            "$(js "$eco")" "$(js "$name")" "$(js "$version")" "$(js "system")"
        done >> "$tmp"
  fi

  # gem — `gem list --no-versions` and `gem list` show different forms.
  # `gem list` emits "rake (13.1.0, 13.0.6, …)" — take the first version
  # per gem (newest installed). Headless `--no-installed` filters out
  # default gems we can't uninstall (more accurate to keep them).
  if command -v gem >/dev/null 2>&1; then
    gem list --no-verbose 2>/dev/null \
      | awk '
          /^[a-zA-Z0-9_-]+ \(/ {
            name = $1
            sub(/.*\(/, "", $0)
            sub(/,.*$|\).*$/, "", $0)
            ver = $0
            print "gem\t" name "\t" ver
          }
        ' \
      | while IFS=$'\t' read -r eco name version; do
          [ -z "$name" ] && continue
          printf '{"ecosystem":%s,"name":%s,"version":%s,"location":%s}\n' \
            "$(js "$eco")" "$(js "$name")" "$(js "$version")" "$(js "system")"
        done >> "$tmp"
  fi

  # composer global show — Composer's globally-installed packages live
  # in ~/.composer or ~/.config/composer. JSON form gives us the
  # stable shape.
  if command -v composer >/dev/null 2>&1; then
    composer global show --format=json --no-ansi 2>/dev/null \
      | awk '
          /"name"[ ]*:/ {
            name = $0
            sub(/.*"name"[ ]*:[ ]*"/, "", name)
            sub(/".*$/, "", name)
            cached_name = name
          }
          /"version"[ ]*:/ && cached_name != "" {
            ver = $0
            sub(/.*"version"[ ]*:[ ]*"/, "", ver)
            sub(/".*$/, "", ver)
            print "composer\t" cached_name "\t" ver
            cached_name = ""
          }
        ' \
      | while IFS=$'\t' read -r eco name version; do
          [ -z "$name" ] && continue
          printf '{"ecosystem":%s,"name":%s,"version":%s,"location":%s}\n' \
            "$(js "$eco")" "$(js "$name")" "$(js "$version")" "$(js "system")"
        done >> "$tmp"
  fi

  # cargo install --list emits lines like:
  #   foo v1.2.3:
  #       <bin1>
  #       <bin2>
  # We want just the "foo v1.2.3" header lines.
  if command -v cargo >/dev/null 2>&1; then
    cargo install --list 2>/dev/null \
      | awk '
          /^[a-zA-Z0-9][^ ]* v[0-9]/ {
            name = $1
            ver = $2
            sub(/^v/, "", ver)
            sub(/:$/, "", ver)
            print "cargo\t" name "\t" ver
          }
        ' \
      | while IFS=$'\t' read -r eco name version; do
          [ -z "$name" ] && continue
          printf '{"ecosystem":%s,"name":%s,"version":%s,"location":%s}\n' \
            "$(js "$eco")" "$(js "$name")" "$(js "$version")" "$(js "system")"
        done >> "$tmp"
  fi
}

# Snap packages. `snap list` columns: Name Version Rev Tracking Publisher Notes.
# Header row is "Name Version Rev …" — skip it via NR>1. Snaps are
# arch-agnostic at the install level so we tag arch="all" rather than
# inspecting the underlying snap file. Silent zero rows on non-snap
# hosts (no snap binary → if-guard skips).
inventory_snap_packages_to() {
  local tmp="$1"
  # NOTE: appends, does NOT truncate — snap/flatpak share the lang_tmp
  # file with inventory_language_packages_to so all three end up in the
  # same language_packages[] wire array.
  command -v snap >/dev/null 2>&1 || return 0
  snap list 2>/dev/null \
    | awk 'NR > 1 && NF >= 2 { print $1 "\t" $2 }' \
    | while IFS=$'\t' read -r name version; do
        [ -z "$name" ] && continue
        printf '{"ecosystem":%s,"location":%s,"name":%s,"version":%s,"arch":%s}\n' \
          "$(js "snap")" "$(js "system")" "$(js "$name")" \
          "$(js "$version")" "$(js "all")" >> "$tmp"
      done
}

# Flatpak apps (NOT runtimes — `--app` filters those out; runtimes would
# otherwise dominate the list with dozens of platform / locale entries).
# `--columns=application,version,arch` keeps the output script-friendly
# (tab-delimited) regardless of the user's locale settings. Silent zero
# rows on non-flatpak hosts.
inventory_flatpak_packages_to() {
  local tmp="$1"
  # NOTE: appends, does NOT truncate — see inventory_snap_packages_to.
  command -v flatpak >/dev/null 2>&1 || return 0
  flatpak list --app --columns=application,version,arch 2>/dev/null \
    | awk -F'\t' 'NF >= 1 && $1 != "" { print $1 "\t" $2 "\t" $3 }' \
    | while IFS=$'\t' read -r appid version arch; do
        [ -z "$appid" ] && continue
        [ -z "$arch" ] && arch=""
        printf '{"ecosystem":%s,"location":%s,"name":%s,"version":%s,"arch":%s}\n' \
          "$(js "flatpak")" "$(js "system")" "$(js "$appid")" \
          "$(js "$version")" "$(js "$arch")" >> "$tmp"
      done
}

# Capture all global-scope IPv4 addresses + their interface names.
# `scope global` excludes loopback (127.0.0.0/8) and link-local
# (169.254.0.0/16) automatically. On hosts with multiple NICs (docker
# bridges, VPN tun, secondary NICs) we emit them all; the collector
# picks the primary for display.
inventory_ips_to() {
  local tmp="$1"
  : > "$tmp"
  if command -v ip >/dev/null 2>&1; then
    # ip -4 -o addr show scope global → one address per line:
    #   "2: eth0    inet 10.0.1.5/24 brd 10.0.1.255 scope global eth0..."
    ip -4 -o addr show scope global 2>/dev/null \
      | awk '{print $2 "\t" $4}' \
      | while IFS=$'\t' read -r iface cidr; do
          [ -z "$cidr" ] && continue
          local addr="${cidr%%/*}"
          printf '{"iface":%s,"addr":%s}\n' \
            "$(js "$iface")" "$(js "$addr")"
        done >> "$tmp"
  elif command -v ifconfig >/dev/null 2>&1; then
    # Mac / BSD fallback. Best-effort.
    ifconfig 2>/dev/null \
      | awk '
          /^[a-z]/ { iface = $1; sub(":", "", iface) }
          /inet / && $2 !~ /^127\./ && $2 !~ /^169\.254\./ {
            print iface "\t" $2
          }
        ' \
      | while IFS=$'\t' read -r iface addr; do
          [ -z "$addr" ] && continue
          printf '{"iface":%s,"addr":%s}\n' \
            "$(js "$iface")" "$(js "$addr")"
        done >> "$tmp"
  fi
}

# Each file under /sys/devices/system/cpu/vulnerabilities/ is one line of
# free text (e.g. "Mitigation: PTI", "Vulnerable", "Not affected"). The
# basename is the vuln name. Skip the dir silently on non-x86 / locked-
# down kernels where it's absent.
inventory_kernel_mitigations_to() {
  local tmp="$1"
  : > "$tmp"
  local dir="/sys/devices/system/cpu/vulnerabilities"
  [ -d "$dir" ] || return 0
  local f vuln state
  for f in "$dir"/*; do
    [ -r "$f" ] || continue
    vuln="$(basename "$f")"
    state="$(head -n 1 "$f" 2>/dev/null)"
    [ -z "$state" ] && continue
    printf '{"vuln":%s,"state":%s}\n' \
      "$(js "$vuln")" "$(js "$state")" >> "$tmp"
  done
}

# /proc/modules columns: name size_bytes refcount used_by state offset.
# We keep only name + size_bytes — refcount is volatile, used_by is a
# CSV list that bloats the payload, and state/offset are operational.
inventory_loaded_modules_to() {
  local tmp="$1"
  : > "$tmp"
  [ -r /proc/modules ] || return 0
  awk '{print $1 "\t" $2}' /proc/modules \
    | while IFS=$'\t' read -r name size; do
        [ -z "$name" ] && continue
        printf '{"name":%s,"size_bytes":%s}\n' \
          "$(js "$name")" "${size:-0}"
      done >> "$tmp"
}

# Pending OS updates from the local package-manager cache. Strictly no
# network — we never call `apt update`, `dnf makecache`, etc. The
# operator is responsible for keeping the cache fresh (typically via the
# distro's stock periodic refresh). Output: {count, items: [{name,
# available_version}]}.
inventory_pending_updates_to() {
  local tmp="$1"
  : > "$tmp"
  local items_tmp count=0
  items_tmp="$(mktemp -t inv-pu.XXXXXX)"

  case "$PKG_MGR" in
    dpkg)
      if command -v apt-get >/dev/null 2>&1; then
        # `Inst <pkg> [old] (new repo arch)` — we want pkg + new version.
        # awk: take $2 (pkg) and $3 (next-version), strip leading "(".
        apt-get -s upgrade 2>/dev/null \
          | awk '/^Inst /{
              ver=$3; sub(/^\(/, "", ver);
              print $2 "\t" ver
            }' \
          | while IFS=$'\t' read -r name ver; do
              [ -z "$name" ] && continue
              printf '{"name":%s,"available_version":%s}\n' \
                "$(js "$name")" "$(js "$ver")" >> "$items_tmp"
            done
      fi
      ;;
    rpm)
      if command -v dnf >/dev/null 2>&1; then
        # `dnf check-update` exits 100 when updates are available, 0
        # when none, anything else is an error. We don't `set -e`, so
        # the 100 just slips by. Skip headers, repo summaries, and
        # "Obsoleting Packages" footer with a tab/awk filter on
        # NF>=3 && $1 !~ /^Last|^Obsoleting/.
        dnf -q check-update 2>/dev/null \
          | awk 'NF >= 3 && $1 !~ /^(Last|Obsoleting|Security)/ {
              # cols: name.arch  version  repo
              n = $1; sub(/\.[^.]*$/, "", n);
              print n "\t" $2
            }' \
          | while IFS=$'\t' read -r name ver; do
              [ -z "$name" ] && continue
              printf '{"name":%s,"available_version":%s}\n' \
                "$(js "$name")" "$(js "$ver")" >> "$items_tmp"
            done
      elif command -v yum >/dev/null 2>&1; then
        yum -q check-update 2>/dev/null \
          | awk 'NF >= 3 && $1 !~ /^(Last|Obsoleting|Security)/ {
              n = $1; sub(/\.[^.]*$/, "", n);
              print n "\t" $2
            }' \
          | while IFS=$'\t' read -r name ver; do
              [ -z "$name" ] && continue
              printf '{"name":%s,"available_version":%s}\n' \
                "$(js "$name")" "$(js "$ver")" >> "$items_tmp"
            done
      fi
      ;;
    apk)
      # `apk version -l '<'` lists installed pkgs whose version is older
      # than the index. Output lines look like:
      #   busybox-1.36.0-r9  <  1.36.1-r0
      apk version -l '<' 2>/dev/null \
        | awk 'NF >= 3 && $2 == "<" {
            # $1 = pkg-installed_version (we want just pkg name).
            n = $1; sub(/-[0-9].*$/, "", n);
            print n "\t" $3
          }' \
        | while IFS=$'\t' read -r name ver; do
            [ -z "$name" ] && continue
            printf '{"name":%s,"available_version":%s}\n' \
              "$(js "$name")" "$(js "$ver")" >> "$items_tmp"
          done
      ;;
    pacman)
      # checkupdates (from pacman-contrib) uses a tmp DB so it doesn't
      # hammer the live one — still pure local once the user has synced.
      # Output: "pkg cur_ver -> new_ver".
      if command -v checkupdates >/dev/null 2>&1; then
        checkupdates 2>/dev/null \
          | awk 'NF >= 4 {print $1 "\t" $4}' \
          | while IFS=$'\t' read -r name ver; do
              [ -z "$name" ] && continue
              printf '{"name":%s,"available_version":%s}\n' \
                "$(js "$name")" "$(js "$ver")" >> "$items_tmp"
            done
      fi
      ;;
  esac

  if [ -s "$items_tmp" ]; then
    count="$(wc -l < "$items_tmp" | tr -d ' ')"
  fi

  {
    printf '{"count":%s,"items":' "${count:-0}"
    emit_json_array_from_file "$items_tmp"
    printf '}'
  } > "$tmp"
  rm -f "$items_tmp"
}

# Probe known container-runtime binaries. One entry per runtime found.
# We deliberately call `--version` rather than parsing a daemon socket
# — the runtime may be installed but not running, and we still want
# inventory visibility.
inventory_container_runtime_to() {
  local tmp="$1"
  : > "$tmp"
  local rt v
  for rt in docker podman containerd crio; do
    if command -v "$rt" >/dev/null 2>&1; then
      v="$("$rt" --version 2>/dev/null | head -n 1)"
      [ -z "$v" ] && v="unknown"
      printf '{"name":%s,"version":%s}\n' \
        "$(js "$rt")" "$(js "$v")" >> "$tmp"
    fi
  done
}

# Virtualization/hypervisor detection. Prefer systemd-detect-virt
# (always-correct on systemd hosts). Fallback to DMI sys_vendor +
# product_name on minimal/non-systemd images. Emit {type, source} so
# downstream UI can distinguish "high-confidence systemd answer" from
# "best-effort DMI guess".
inventory_virtualization_to() {
  local tmp="$1"
  : > "$tmp"
  local vtype="" vsource=""
  if command -v systemd-detect-virt >/dev/null 2>&1; then
    vtype="$(systemd-detect-virt 2>/dev/null || echo none)"
    [ -z "$vtype" ] && vtype="none"
    vsource="systemd-detect-virt"
  else
    local vendor="" product=""
    [ -r /sys/class/dmi/id/sys_vendor ]   && vendor="$(tr -d '\n' < /sys/class/dmi/id/sys_vendor 2>/dev/null)"
    [ -r /sys/class/dmi/id/product_name ] && product="$(tr -d '\n' < /sys/class/dmi/id/product_name 2>/dev/null)"
    # Map common vendor/product combos to systemd-style types.
    case "${vendor} ${product}" in
      *"QEMU"*|*"Bochs"*)         vtype="kvm" ;;
      *"VMware"*)                 vtype="vmware" ;;
      *"VirtualBox"*)             vtype="oracle" ;;
      *"Xen"*)                    vtype="xen" ;;
      *"Microsoft"*"Virtual"*)    vtype="microsoft" ;;
      *"Google"*)                 vtype="google" ;;
      *"Amazon"*)                 vtype="amazon" ;;
      *)                          vtype="none" ;;
    esac
    vsource="dmi"
  fi
  printf '{"type":%s,"source":%s}' \
    "$(js "$vtype")" "$(js "$vsource")" > "$tmp"
}

# Uptime from /proc/uptime. First field is seconds-since-boot as a
# float. boot_time = now - uptime, rendered ISO-8601 UTC.
inventory_uptime_to() {
  local tmp="$1"
  : > "$tmp"
  [ -r /proc/uptime ] || return 0
  local secs_float secs_int now boot
  secs_float="$(awk '{print $1}' /proc/uptime 2>/dev/null)"
  [ -z "$secs_float" ] && return 0
  # Truncate to integer (we don't need fractional uptime).
  secs_int="${secs_float%%.*}"
  [ -z "$secs_int" ] && secs_int=0
  now="$(date -u +%s)"
  boot=$((now - secs_int))
  local boot_iso
  boot_iso="$(date -u -d "@${boot}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
              || date -u -r "${boot}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
              || echo "")"
  printf '{"seconds":%s,"boot_time":%s}' \
    "${secs_int}" "$(js "$boot_iso")" > "$tmp"
}

# ─── Payload assembly ──────────────────────────────────────────────────
build_payload() {
  local pkg_tmp svc_tmp lis_tmp ctr_tmp ips_tmp lang_tmp
  local km_tmp lm_tmp pu_tmp cr_tmp virt_tmp up_tmp
  pkg_tmp="$(mktemp -t inv-pkg.XXXXXX)"
  svc_tmp="$(mktemp -t inv-svc.XXXXXX)"
  lis_tmp="$(mktemp -t inv-lis.XXXXXX)"
  ctr_tmp="$(mktemp -t inv-ctr.XXXXXX)"
  ips_tmp="$(mktemp -t inv-ips.XXXXXX)"
  lang_tmp="$(mktemp -t inv-lang.XXXXXX)"
  km_tmp="$(mktemp -t inv-km.XXXXXX)"
  lm_tmp="$(mktemp -t inv-lm.XXXXXX)"
  pu_tmp="$(mktemp -t inv-pu.XXXXXX)"
  cr_tmp="$(mktemp -t inv-cr.XXXXXX)"
  virt_tmp="$(mktemp -t inv-virt.XXXXXX)"
  up_tmp="$(mktemp -t inv-up.XXXXXX)"
  # shellcheck disable=SC2064
  trap "rm -f '$pkg_tmp' '$svc_tmp' '$lis_tmp' '$ctr_tmp' '$ips_tmp' '$lang_tmp' '$km_tmp' '$lm_tmp' '$pu_tmp' '$cr_tmp' '$virt_tmp' '$up_tmp'" RETURN

  inventory_packages_to "$pkg_tmp"
  [ "${INCLUDE_IP_ADDRESSES}"        = "1" ] && inventory_ips_to                 "$ips_tmp"
  [ "${INCLUDE_SERVICES}"            = "1" ] && inventory_services_to            "$svc_tmp"
  [ "${INCLUDE_LISTENERS}"           = "1" ] && inventory_listeners_to           "$lis_tmp"
  [ "${INCLUDE_CONTAINERS}"          = "1" ] && inventory_containers_to          "$ctr_tmp"
  [ "${INCLUDE_LANGUAGE_PACKAGES}"   = "1" ] && inventory_language_packages_to   "$lang_tmp"
  # Snap + flatpak ride the language_packages[] wire field via the
  # ecosystem discriminator — no new top-level key, no new DB column.
  [ "${INCLUDE_SNAP_PACKAGES}"       = "1" ] && inventory_snap_packages_to       "$lang_tmp"
  [ "${INCLUDE_FLATPAK_PACKAGES}"    = "1" ] && inventory_flatpak_packages_to    "$lang_tmp"
  [ "${INCLUDE_KERNEL_MITIGATIONS}"  = "1" ] && inventory_kernel_mitigations_to  "$km_tmp"
  [ "${INCLUDE_LOADED_MODULES}"      = "1" ] && inventory_loaded_modules_to      "$lm_tmp"
  [ "${INCLUDE_PENDING_UPDATES}"     = "1" ] && inventory_pending_updates_to     "$pu_tmp"
  [ "${INCLUDE_CONTAINER_RUNTIME}"   = "1" ] && inventory_container_runtime_to   "$cr_tmp"
  [ "${INCLUDE_VIRTUALIZATION}"      = "1" ] && inventory_virtualization_to      "$virt_tmp"
  [ "${INCLUDE_UPTIME}"              = "1" ] && inventory_uptime_to              "$up_tmp"

  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  {
    printf '{'
    printf '"agent_version":%s,'   "$(js "$AGENT_VERSION")"
    printf '"collected_at":%s,'    "$(js "$now")"
    printf '"host_id":%s,'         "$(js "$HOST_ID")"
    printf '"hostname":%s,'        "$(js "$HOSTNAME_FQDN")"
    printf '"os":{'
    printf '"id":%s,'              "$(js "$OS_ID")"
    printf '"name":%s,'            "$(js "$OS_NAME")"
    printf '"version":%s,'         "$(js "$OS_VERSION")"
    printf '"version_codename":%s,' "$(js "$OS_VERSION_CODENAME")"
    printf '"id_like":%s'          "$(js "$OS_LIKE")"
    printf '},'
    printf '"kernel":%s,'          "$(js "$KERNEL")"
    printf '"arch":%s,'            "$(js "$ARCH")"
    printf '"package_manager":%s,' "$(js "$PKG_MGR")"
    if [ "${INCLUDE_IP_ADDRESSES}" = "1" ]; then
      printf '"ip_addresses":'
      emit_json_array_from_file "$ips_tmp"
      printf ','
    fi
    printf '"packages":'
    emit_json_array_from_file "$pkg_tmp"
    if [ "${INCLUDE_SERVICES}" = "1" ]; then
      printf ',"services":'
      emit_json_array_from_file "$svc_tmp"
    fi
    if [ "${INCLUDE_LISTENERS}" = "1" ]; then
      printf ',"listeners":'
      emit_json_array_from_file "$lis_tmp"
    fi
    if [ "${INCLUDE_CONTAINERS}" = "1" ]; then
      printf ',"containers":'
      emit_json_array_from_file "$ctr_tmp"
    fi
    # Emit language_packages[] when ANY of the three contributing
    # inventories (language pkg managers, snap, flatpak) is enabled.
    # They all share lang_tmp via the ecosystem discriminator.
    if [ "${INCLUDE_LANGUAGE_PACKAGES}" = "1" ] \
      || [ "${INCLUDE_SNAP_PACKAGES}" = "1" ] \
      || [ "${INCLUDE_FLATPAK_PACKAGES}" = "1" ]; then
      printf ',"language_packages":'
      emit_json_array_from_file "$lang_tmp"
    fi
    if [ "${INCLUDE_KERNEL_MITIGATIONS}" = "1" ]; then
      printf ',"kernel_mitigations":'
      emit_json_array_from_file "$km_tmp"
    fi
    if [ "${INCLUDE_LOADED_MODULES}" = "1" ]; then
      printf ',"loaded_modules":'
      emit_json_array_from_file "$lm_tmp"
    fi
    if [ "${INCLUDE_PENDING_UPDATES}" = "1" ]; then
      # pending updates helper writes a complete JSON object already.
      printf ',"pending_updates":'
      if [ -s "$pu_tmp" ]; then cat "$pu_tmp"; else printf '{"count":0,"items":[]}'; fi
    fi
    if [ "${INCLUDE_CONTAINER_RUNTIME}" = "1" ]; then
      printf ',"container_runtime":'
      emit_json_array_from_file "$cr_tmp"
    fi
    if [ "${INCLUDE_VIRTUALIZATION}" = "1" ]; then
      printf ',"virtualization":'
      if [ -s "$virt_tmp" ]; then cat "$virt_tmp"; else printf '{"type":"unknown","source":"unknown"}'; fi
    fi
    if [ "${INCLUDE_UPTIME}" = "1" ] && [ -s "$up_tmp" ]; then
      printf ',"uptime":'
      cat "$up_tmp"
    fi
    printf '}'
  }
}

# ─── Shipment ──────────────────────────────────────────────────────────
ship_payload() {
  local payload_file="$1"
  if [ -z "$COLLECTOR_URL" ]; then
    log "WARN no COLLECTOR_URL set; cannot ship"
    return 1
  fi
  local attempt=1 status
  while [ "$attempt" -le "$HTTP_RETRIES" ]; do
    local headers=(-H "Content-Type: application/json"
                   -H "X-Host-Id: ${HOST_ID}"
                   -H "X-Agent-Version: ${AGENT_VERSION}")
    if [ -n "$COLLECTOR_TOKEN" ]; then
      headers+=(-H "Authorization: Bearer ${COLLECTOR_TOKEN}")
    fi
    status="$(curl -sS -o /dev/null -w '%{http_code}' \
        --max-time "$HTTP_TIMEOUT" \
        "${headers[@]}" \
        --data-binary @"$payload_file" \
        -X POST "$COLLECTOR_URL" 2>/dev/null || echo 000)"
    if [ "$status" -ge 200 ] && [ "$status" -lt 300 ]; then
      log "INFO shipped ok (HTTP $status) attempt=$attempt"
      return 0
    fi
    log "WARN ship attempt $attempt failed (HTTP $status)"
    attempt=$((attempt + 1))
    sleep $((attempt * 2))
  done
  return 1
}

# Replay any previously buffered payloads.
flush_buffer() {
  [ -d "$BUFFER_DIR" ] || return 0
  local f
  for f in "$BUFFER_DIR"/*.json; do
    [ -e "$f" ] || continue
    if ship_payload "$f"; then
      rm -f "$f"
    else
      log "WARN flush failed for $f; will retry next run"
      break
    fi
  done
}

# Persist payload to the buffer dir for later replay.
buffer_payload() {
  local payload_file="$1"
  mkdir -p "$BUFFER_DIR" 2>/dev/null || true
  local stamp dest
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dest="$BUFFER_DIR/${stamp}-${HOST_ID}.json"
  cp -f "$payload_file" "$dest" 2>/dev/null || {
    log "ERROR cannot write to buffer dir $BUFFER_DIR"
    return 1
  }
  log "INFO buffered payload at $dest"
}

# ─── Main ──────────────────────────────────────────────────────────────
main() {
  parse_args "$@"
  init_dirs
  log "INFO software-inventory.sh v${AGENT_VERSION} starting"
  read_os_release
  load_or_create_host_id
  detect_pkg_mgr
  log "INFO host=${HOSTNAME_FQDN} os=${OS_ID}/${OS_VERSION} pkgmgr=${PKG_MGR}"

  # Boot-time handshake. Talks to the collector to learn what the rest
  # of the fleet is gathering this week. Local --no-X flags survive the
  # round-trip — see resolve_config().
  resolve_config

  # Collector-driven self-update. Runs AFTER resolve_config so we can
  # read agent.current_sha256 from the freshly-fetched config, and
  # BEFORE any inventory collection so a successful update re-execs on
  # this same tick with the new logic. Forwards args via "$@" so the
  # re-launched process sees identical flags.
  self_update "$@"

  local payload_file
  payload_file="$(mktemp -t inv-payload.XXXXXX)"
  # shellcheck disable=SC2064
  trap "rm -f '$payload_file'" EXIT

  build_payload > "$payload_file"

  if [ "$DRY_RUN" = "1" ]; then
    if [ "$PRETTY" = "1" ]; then
      pretty_print_json < "$payload_file"
    else
      cat "$payload_file"
      echo
    fi
    return 0
  fi

  # Flush any pending buffered payloads first so the order on the
  # collector matches the order they were produced on the host.
  flush_buffer

  if ship_payload "$payload_file"; then
    log "INFO run complete"
  else
    log "WARN shipment failed; buffering"
    buffer_payload "$payload_file"
  fi
}

main "$@"
