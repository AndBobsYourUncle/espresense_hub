#!/usr/bin/env bash
# Install ESPresense Hub as a systemd service.
#
# Run from inside the cloned repo:
#   git clone https://github.com/your-user/espresense_hub.git
#   cd espresense_hub
#   sudo ./deploy/install.sh
#
# The repo's current location becomes the install dir — wherever you cloned
# is where it stays. Use deploy/update.sh to pull + rebuild later.
#
# Environment overrides (optional):
#   STATE_DIR       default /var/lib/espresense-hub
#   SERVICE_USER    default espresense
#   SERVICE_NAME    default espresense-hub
#   PORT            default 3000
#   BIND_ADDR       default 0.0.0.0
#   SKIP_NODE       set to 1 to skip the Node.js install step

set -euo pipefail

# Resolve script + repo location regardless of where you invoke it from.
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

STATE_DIR="${STATE_DIR:-/var/lib/espresense-hub}"
SERVICE_USER="${SERVICE_USER:-espresense}"
SERVICE_NAME="${SERVICE_NAME:-espresense-hub}"
PORT="${PORT:-3000}"
BIND_ADDR="${BIND_ADDR:-0.0.0.0}"

if [[ $EUID -ne 0 ]]; then
  echo "error: must run as root (sudo)" >&2
  exit 1
fi

if [[ ! -f "$INSTALL_DIR/package.json" ]]; then
  echo "error: $INSTALL_DIR doesn't look like the espresense_hub repo" >&2
  exit 1
fi

log() { echo -e "\033[1;34m==>\033[0m $*"; }

log "Installing from $INSTALL_DIR"
log "State dir:    $STATE_DIR"
log "Service user: $SERVICE_USER"
log "Service:      $SERVICE_NAME on $BIND_ADDR:$PORT"
echo

# --- 0. Preflight: make sure the install dir is reachable ---------------------
# Walk every parent dir and verify it has the world-execute bit set, otherwise
# the unprivileged service user won't be able to traverse into INSTALL_DIR even
# if it owns INSTALL_DIR itself. Common gotcha when cloning under /home/$USER
# on Debian (home dirs are mode 700 by default).
check_path="$INSTALL_DIR"
while [[ "$check_path" != "/" && -n "$check_path" ]]; do
  perms=$(stat -c '%a' "$check_path")
  # Last digit is the "other" octet — needs the execute bit (1, 3, 5, or 7).
  other=${perms: -1}
  if (( (other & 1) == 0 )); then
    echo
    echo "  error: $check_path is mode $perms — '$SERVICE_USER' can't traverse it." >&2
    echo "  Re-clone the repo somewhere world-traversable, e.g.:" >&2
    echo "      sudo mv '$INSTALL_DIR' /opt/$(basename "$INSTALL_DIR")" >&2
    echo "      cd /opt/$(basename "$INSTALL_DIR")" >&2
    echo "      sudo ./deploy/install.sh" >&2
    echo
    exit 1
  fi
  check_path=$(dirname "$check_path")
done

# --- 1. Node.js 20 (NodeSource) ----------------------------------------------
if [[ "${SKIP_NODE:-0}" != "1" ]]; then
  if ! command -v node >/dev/null || [[ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 20 ]]; then
    log "Installing Node.js 20.x from NodeSource…"
    apt-get update
    apt-get install -y curl ca-certificates gnupg
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  else
    log "Node.js $(node -v) already installed"
  fi
fi

# --- 2. Service user ----------------------------------------------------------
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating service user '$SERVICE_USER'…"
  useradd --system --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
else
  log "User '$SERVICE_USER' already exists"
fi

# --- 3. State directory -------------------------------------------------------
if [[ ! -d "$STATE_DIR" ]]; then
  log "Creating state dir $STATE_DIR…"
  mkdir -p "$STATE_DIR"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$STATE_DIR"
chmod 750 "$STATE_DIR"

# --- 4. Repo ownership --------------------------------------------------------
# The service user needs to be able to read the repo, run `git pull`, and
# write build outputs (.next/) into it.
log "Setting repo ownership to $SERVICE_USER…"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# --- 5. Seed config.yaml if missing ------------------------------------------
if [[ ! -f "$STATE_DIR/config.yaml" ]]; then
  log "Seeding $STATE_DIR/config.yaml from config.example.yaml…"
  cp "$INSTALL_DIR/config.example.yaml" "$STATE_DIR/config.yaml"
  chown "$SERVICE_USER:$SERVICE_USER" "$STATE_DIR/config.yaml"
  chmod 640 "$STATE_DIR/config.yaml"
  SEEDED_CONFIG=1
else
  log "Existing config preserved at $STATE_DIR/config.yaml"
  SEEDED_CONFIG=0
fi

# --- 6. Install deps + build --------------------------------------------------
log "Installing npm dependencies…"
sudo -u "$SERVICE_USER" -H bash -c "cd '$INSTALL_DIR' && npm ci"

log "Building Next.js production bundle…"
sudo -u "$SERVICE_USER" -H bash -c "cd '$INSTALL_DIR' && npm run build"

# --- 7. systemd unit + sudoers ------------------------------------------------
log "Generating systemd unit…"
cat >"/etc/systemd/system/$SERVICE_NAME.service" <<UNIT
[Unit]
Description=ESPresense Hub (BLE positioning server)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/npm start --silent
Restart=on-failure
RestartSec=5

Environment=ESPRESENSE_CONFIG_PATH=$STATE_DIR/config.yaml
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=HOSTNAME=$BIND_ADDR
# Used by the in-app "Restart" button. Paired with the sudoers.d entry
# below that grants this exact command without a password.
Environment=ESPRESENSE_RESTART_COMMAND=/usr/bin/sudo /bin/systemctl restart $SERVICE_NAME

StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE_NAME

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ReadWritePaths=$STATE_DIR $INSTALL_DIR

[Install]
WantedBy=multi-user.target
UNIT
chmod 644 "/etc/systemd/system/$SERVICE_NAME.service"

# sudoers entry for the in-app restart button
# Allows the unprivileged service user to restart its own service via
# `sudo systemctl restart $SERVICE_NAME` without a password — and nothing
# else. Tightly scoped: this is the only command the rule grants.
SUDOERS_FILE="/etc/sudoers.d/$SERVICE_NAME"
log "Writing sudoers entry $SUDOERS_FILE…"
cat >"$SUDOERS_FILE" <<SUDOERS
# Generated by deploy/install.sh — allows the in-app Restart button.
$SERVICE_USER ALL=(root) NOPASSWD: /bin/systemctl restart $SERVICE_NAME
SUDOERS
chmod 440 "$SUDOERS_FILE"
# Validate syntax — a broken sudoers file would lock root out of `sudo`.
if ! visudo -c -f "$SUDOERS_FILE" >/dev/null; then
  echo "error: generated sudoers entry failed validation; removing" >&2
  rm -f "$SUDOERS_FILE"
  exit 1
fi

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

if [[ "$SEEDED_CONFIG" == "1" ]]; then
  echo
  echo "  ====================================================================="
  echo "  Edit $STATE_DIR/config.yaml — at minimum set mqtt.host,"
  echo "  your floors/rooms, and your nodes — then start the service:"
  echo
  echo "    sudo systemctl start $SERVICE_NAME"
  echo "    sudo journalctl -u $SERVICE_NAME -f"
  echo "  ====================================================================="
elif systemctl is-active --quiet "$SERVICE_NAME"; then
  log "Restarting $SERVICE_NAME…"
  systemctl restart "$SERVICE_NAME"
else
  log "Starting $SERVICE_NAME…"
  systemctl start "$SERVICE_NAME"
fi

log "Done. Hub will be reachable on http://<this-host>:$PORT"
