#!/usr/bin/env bash
# Pull latest, rebuild, restart the service.
#
# Run from inside the install directory:
#   sudo /path/to/espresense_hub/deploy/update.sh
#
# By default, fetches origin and skips the rebuild if the build marker
# matches the current HEAD. Pass --force (or -f) to rebuild and restart
# regardless — useful when something out-of-band happened (manual git pull,
# .next dir got nuked, dependencies installed by hand, etc).
#
# Safe to run while the service is up — the old build keeps serving until
# the new build is ready, then systemd swaps in one restart.
#
# Environment overrides (optional):
#   BRANCH          default main
#   SERVICE_USER    default espresense
#   SERVICE_NAME    default espresense-hub

set -euo pipefail

FORCE=0
for arg in "$@"; do
  case "$arg" in
    -f|--force) FORCE=1 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "error: unknown arg '$arg' (try --help)" >&2
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SERVICE_USER="${SERVICE_USER:-espresense}"
SERVICE_NAME="${SERVICE_NAME:-espresense-hub}"
BRANCH="${BRANCH:-main}"
BUILD_STAMP="$INSTALL_DIR/.next/.built-from-sha"

if [[ $EUID -ne 0 ]]; then
  echo "error: must run as root (sudo)" >&2
  exit 1
fi

if [[ ! -d "$INSTALL_DIR/.git" ]]; then
  echo "error: $INSTALL_DIR is not a git checkout" >&2
  exit 1
fi

log() { echo -e "\033[1;34m==>\033[0m $*"; }

log "Updating $INSTALL_DIR (branch $BRANCH)"

sudo -u "$SERVICE_USER" -H git -C "$INSTALL_DIR" fetch origin

OLD_SHA="$(sudo -u "$SERVICE_USER" -H git -C "$INSTALL_DIR" rev-parse HEAD)"
NEW_SHA="$(sudo -u "$SERVICE_USER" -H git -C "$INSTALL_DIR" rev-parse "origin/$BRANCH")"

GIT_CHANGED=0
if [[ "$OLD_SHA" != "$NEW_SHA" ]]; then
  GIT_CHANGED=1
  log "$OLD_SHA → $NEW_SHA"
  sudo -u "$SERVICE_USER" -H git -C "$INSTALL_DIR" checkout "$BRANCH"
  sudo -u "$SERVICE_USER" -H git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
else
  log "Already at origin/$BRANCH ($OLD_SHA)"
fi

# Decide whether to rebuild. We rebuild if:
#   - git just moved (always),
#   - --force was passed,
#   - or the build stamp is missing/stale (covers manual `git pull`,
#     missing .next/, deps installed out of band, etc).
HEAD_SHA="$(sudo -u "$SERVICE_USER" -H git -C "$INSTALL_DIR" rev-parse HEAD)"
STAMPED_SHA=""
if [[ -f "$BUILD_STAMP" ]]; then
  STAMPED_SHA="$(cat "$BUILD_STAMP")"
fi

if [[ "$GIT_CHANGED" == "1" || "$FORCE" == "1" || "$STAMPED_SHA" != "$HEAD_SHA" ]]; then
  if [[ "$GIT_CHANGED" == "0" && "$FORCE" == "0" ]]; then
    log "Build stamp ($STAMPED_SHA) doesn't match HEAD ($HEAD_SHA) — rebuilding"
  fi
  log "Installing dependencies…"
  sudo -u "$SERVICE_USER" -H bash -c "cd '$INSTALL_DIR' && npm ci"

  log "Building…"
  sudo -u "$SERVICE_USER" -H bash -c "cd '$INSTALL_DIR' && npm run build"

  # Stamp the build with the SHA we just built from, so a future run can
  # detect a mismatched build (e.g., source moved out from under it).
  echo "$HEAD_SHA" | sudo -u "$SERVICE_USER" -H tee "$BUILD_STAMP" >/dev/null

  log "Restarting $SERVICE_NAME…"
  systemctl restart "$SERVICE_NAME"
  sleep 2
  systemctl --no-pager --lines=10 status "$SERVICE_NAME"
else
  log "Build stamp matches HEAD — nothing to rebuild. Use --force to rebuild anyway."
fi
