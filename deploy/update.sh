#!/usr/bin/env bash
# Pull latest, rebuild, restart the service.
#
# Run from inside the install directory:
#   sudo /path/to/espresense_hub/deploy/update.sh
#
# Safe to run while the service is up — the old build keeps serving until
# the new build is ready, then systemd swaps in one restart.
#
# Environment overrides (optional):
#   BRANCH          default main
#   SERVICE_USER    default espresense
#   SERVICE_NAME    default espresense-hub

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SERVICE_USER="${SERVICE_USER:-espresense}"
SERVICE_NAME="${SERVICE_NAME:-espresense-hub}"
BRANCH="${BRANCH:-main}"

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

if [[ "$OLD_SHA" == "$NEW_SHA" ]]; then
  log "Already at origin/$BRANCH ($OLD_SHA) — nothing to do"
  exit 0
fi

log "$OLD_SHA → $NEW_SHA"
sudo -u "$SERVICE_USER" -H git -C "$INSTALL_DIR" checkout "$BRANCH"
sudo -u "$SERVICE_USER" -H git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"

log "Installing dependencies…"
sudo -u "$SERVICE_USER" -H bash -c "cd '$INSTALL_DIR' && npm ci"

log "Building…"
sudo -u "$SERVICE_USER" -H bash -c "cd '$INSTALL_DIR' && npm run build"

log "Restarting $SERVICE_NAME…"
systemctl restart "$SERVICE_NAME"
sleep 2
systemctl --no-pager --lines=10 status "$SERVICE_NAME"
