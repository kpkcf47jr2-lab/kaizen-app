#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
#  Kaizen AI — one-shot install / update script for an Ubuntu VPS.
#
#  Idempotent. Run as root or via sudo on the target host after cloning
#  the repo to /opt/kaizen-app (or set REPO_DIR=/some/where).
#
#  Prerequisites owner installs manually first-time:
#    - Ubuntu 22.04 / 24.04 LTS
#    - Node 20+ (`curl -fsSL https://deb.nodesource.com/setup_20.x | bash -`)
#    - /etc/kaizen-app.env populated (copy deploy/.env.production.example)
#
#  Usage:
#    sudo REPO_DIR=/opt/kaizen-app REPO_URL=https://github.com/kpkcf47jr2-lab/kaizen-app.git \
#      bash deploy/install.sh
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/kpkcf47jr2-lab/kaizen-app.git}"
REPO_DIR="${REPO_DIR:-/opt/kaizen-app}"
SERVICE_USER="${SERVICE_USER:-kaizen}"
ENV_FILE="${ENV_FILE:-/etc/kaizen-app.env}"
SERVICE_NAME="kaizen-app.service"

log() { printf "\033[1;36m[install]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m[install:err]\033[0m %s\n" "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || die "Run as root (or sudo)."
command -v node >/dev/null 2>&1 || die "Node not installed. Install Node 20+ first."
node -v | grep -qE 'v(2[0-9]|[3-9][0-9])\.' || die "Node 20+ required. Have: $(node -v)"

# 1. Ensure service user + dirs
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "creating service user $SERVICE_USER"
  useradd --system --home-dir "$REPO_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
mkdir -p "$REPO_DIR" "$REPO_DIR/data"

# 2. Clone or update repo
if [[ -d "$REPO_DIR/.git" ]]; then
  log "updating existing repo at $REPO_DIR"
  git -C "$REPO_DIR" fetch --quiet origin
  git -C "$REPO_DIR" reset --quiet --hard origin/master
else
  log "cloning $REPO_URL → $REPO_DIR"
  git clone --quiet "$REPO_URL" "$REPO_DIR"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$REPO_DIR"

# 3. Install deps as service user
log "npm install (workspaces)"
sudo -u "$SERVICE_USER" -H bash -c "cd '$REPO_DIR' && npm ci --no-audit --no-fund --loglevel=error" \
  || sudo -u "$SERVICE_USER" -H bash -c "cd '$REPO_DIR' && npm install --no-audit --no-fund --loglevel=error"

# 4. Env file guard
if [[ ! -f "$ENV_FILE" ]]; then
  log "WARN: $ENV_FILE missing — copying template. Owner MUST edit before start."
  install -o root -g "$SERVICE_USER" -m 0640 \
    "$REPO_DIR/deploy/.env.production.example" "$ENV_FILE"
  log "  edit: sudo nano $ENV_FILE"
fi

# 5. Systemd unit
log "installing systemd unit $SERVICE_NAME"
install -o root -g root -m 0644 "$REPO_DIR/deploy/$SERVICE_NAME" "/etc/systemd/system/$SERVICE_NAME"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null

# 6. Start (or restart if already running)
if systemctl is-active --quiet "$SERVICE_NAME"; then
  log "restart $SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
else
  log "start $SERVICE_NAME"
  systemctl start "$SERVICE_NAME" || die "start failed — journalctl -u $SERVICE_NAME -n 40"
fi

# 7. Health probe
sleep 5
PORT="$(grep -E '^KAIZEN_PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2)"
PORT="${PORT:-4711}"
if curl -fsS -m 5 "http://127.0.0.1:$PORT/healthz" | grep -q '"ok":true'; then
  log "✅ Kaizen backend healthy on :$PORT"
else
  die "Health probe failed. journalctl -u $SERVICE_NAME -n 60"
fi

log "Done. Tail logs with: journalctl -u $SERVICE_NAME -f"
