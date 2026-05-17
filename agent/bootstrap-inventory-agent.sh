#!/usr/bin/env bash
#
# bootstrap-inventory-agent.sh — one-shot installer for software-inventory.sh
#
# Designed to be piped through `curl | sudo bash -s --` or pasted into EC2
# user-data. POSIX-leaning bash, no deps beyond curl + coreutils + (cron|systemd).
# Idempotent: safe to re-run.
#
set -eu

SCRIPT_NAME="bootstrap-inventory-agent"
AGENT_DEST="/usr/local/sbin/software-inventory.sh"
ENV_DIR="/etc/inventory-agent"
ENV_FILE="${ENV_DIR}/env"
LOG_FILE="/var/log/inventory-agent.log"

TOKEN=""
COLLECTOR_URL=""
SCHEDULE="0 3 * * *"
SMOKE_TEST=1

die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()  { printf '\033[32m✓ %s\033[0m\n' "$*"; }
log() { printf '  %s\n' "$*"; }

usage() {
  cat <<EOF
Usage: $SCRIPT_NAME --token <t> --collector-url <url> [--schedule <cron>] [--no-smoke-test]

  --token          Ingest bearer token (argus_…). Required.
  --collector-url  Full reports endpoint, e.g. https://host/api/v1/reports. Required.
  --schedule       Cron expression. Default: "0 3 * * *" (daily 03:00).
  --no-smoke-test  Skip the immediate validation run.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --token)          TOKEN="${2:-}"; shift 2 ;;
    --collector-url)  COLLECTOR_URL="${2:-}"; shift 2 ;;
    --schedule)       SCHEDULE="${2:-}"; shift 2 ;;
    --no-smoke-test)  SMOKE_TEST=0; shift ;;
    -h|--help)        usage; exit 0 ;;
    *) die "unknown arg: $1 (try --help)" ;;
  esac
done

[ -n "$TOKEN" ]         || { usage; die "--token is required"; }
[ -n "$COLLECTOR_URL" ] || { usage; die "--collector-url is required"; }

# Platform gate. Linux only — macOS launchd / Windows scheduled tasks
# are out of scope for this agent.
case "$(uname -s)" in
  Linux) : ;;
  *) die "Unsupported platform: $(uname -s). Linux only." ;;
esac

# Root gate. We're writing /etc, /usr/local, and (maybe) systemd units.
if [ "$(id -u)" -ne 0 ]; then
  die "Must run as root (try: sudo $0 ...)"
fi

# Derive the collector base from the reports URL — that's where the
# agent script lives at /install/agent.sh.
BASE_URL="${COLLECTOR_URL%/api/v1/reports}"
[ "$BASE_URL" = "$COLLECTOR_URL" ] && BASE_URL="${COLLECTOR_URL%/}"
AGENT_URL="${BASE_URL}/install/agent.sh"

log "Downloading agent from ${AGENT_URL}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
curl -sSfL --retry 3 --max-time 30 -o "$TMP" "$AGENT_URL" \
  || die "Failed to download agent script"
install -m 0755 "$TMP" "$AGENT_DEST"
ok "Agent installed at ${AGENT_DEST}"

# Env file — mode 600, holds the bearer token.
install -d -m 0750 "$ENV_DIR"
umask 077
cat > "$ENV_FILE" <<EOF
# Managed by ${SCRIPT_NAME} — re-run the installer to update.
COLLECTOR_URL=${COLLECTOR_URL}
COLLECTOR_TOKEN=${TOKEN}
EOF
chmod 600 "$ENV_FILE"
ok "Env written to ${ENV_FILE}"

# Pick scheduler: systemd timer preferred, cron fallback.
SCHEDULER=""
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  SCHEDULER="systemd"

  # Translate the 5-field cron into systemd OnCalendar. Best-effort for
  # the common cases (M H * * *, M */N * * *, M * * * *). Fall back to
  # daily if we can't map cleanly — operator can edit the unit later.
  set -- $SCHEDULE
  CMIN="${1:-0}"; CHR="${2:-3}"; CDOM="${3:-*}"; CMON="${4:-*}"; CDOW="${5:-*}"
  if [ "$CDOM" = "*" ] && [ "$CMON" = "*" ] && [ "$CDOW" = "*" ]; then
    case "$CHR" in
      \*)                    ONCAL="*:${CMIN}:00" ;;
      \*/*)                  ONCAL="*-*-* ${CHR}:${CMIN}:00" ;;
      *)                     ONCAL="*-*-* ${CHR}:${CMIN}:00" ;;
    esac
  else
    ONCAL="daily"
  fi

  cat > /etc/systemd/system/inventory-agent.service <<EOF
[Unit]
Description=Software inventory reporter (one-shot)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=${ENV_FILE}
ExecStart=${AGENT_DEST}
EOF

  cat > /etc/systemd/system/inventory-agent.timer <<EOF
[Unit]
Description=Run software inventory reporter on schedule

[Timer]
OnCalendar=${ONCAL}
Persistent=true
RandomizedDelaySec=120
Unit=inventory-agent.service

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now inventory-agent.timer >/dev/null
  ok "Systemd timer enabled (OnCalendar=${ONCAL})"
  # Remove any stale cron file so we don't double-fire.
  rm -f /etc/cron.d/inventory-agent
else
  SCHEDULER="cron"
  cat > /etc/cron.d/inventory-agent <<EOF
# Managed by ${SCRIPT_NAME}
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
${SCHEDULE} root . ${ENV_FILE} && ${AGENT_DEST} >> ${LOG_FILE} 2>&1
EOF
  chmod 644 /etc/cron.d/inventory-agent
  ok "Cron entry installed (${SCHEDULE})"
fi

# Smoke test: run once now so the operator sees green/red before walking away.
if [ "$SMOKE_TEST" -eq 1 ]; then
  log "Running smoke test…"
  set +e
  # shellcheck disable=SC1090
  ( . "$ENV_FILE" && "$AGENT_DEST" ) >>"$LOG_FILE" 2>&1
  RC=$?
  set -e
  if [ "$RC" -eq 0 ]; then
    ok "Smoke test passed — host has reported in."
  else
    printf '\033[31m✗ Smoke test failed (exit %d). Last 20 log lines:\033[0m\n' "$RC" >&2
    tail -n 20 "$LOG_FILE" >&2 || true
    exit "$RC"
  fi
fi

ok "Done. scheduler=${SCHEDULER} schedule='${SCHEDULE}' log=${LOG_FILE}"
