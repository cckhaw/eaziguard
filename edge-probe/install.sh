#!/usr/bin/env bash
# Installs the edge probe as a systemd service on Raspberry Pi OS / Debian / Ubuntu.
#   sudo ./install.sh
# Re-running upgrades probe.py and the dependencies; /etc/campus-edge-probe/probe.env is never overwritten.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR=/opt/campus-edge-probe
CONF_DIR=/etc/campus-edge-probe
SERVICE=campus-edge-probe

command -v systemctl >/dev/null || { echo "systemd is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required (apt install python3)" >&2; exit 1; }

# python3-venv is a separate package on Debian-based systems.
if ! python3 -c 'import venv, ensurepip' 2>/dev/null; then
  echo "Installing python3-venv ..."
  apt-get update -qq && apt-get install -y -qq python3-venv
fi

id -u edgeprobe >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin edgeprobe

install -d -m 0755 "$APP_DIR"
install -m 0644 "$SRC_DIR/probe.py" "$APP_DIR/probe.py"
install -m 0644 "$SRC_DIR/requirements.txt" "$APP_DIR/requirements.txt"

python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install --quiet --upgrade pip
"$APP_DIR/venv/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

install -d -m 0750 -o root -g edgeprobe "$CONF_DIR"
FIRST_INSTALL=0
if [[ ! -f "$CONF_DIR/probe.env" ]]; then
  FIRST_INSTALL=1
  install -m 0640 -o root -g edgeprobe "$SRC_DIR/probe.env.example" "$CONF_DIR/probe.env"
  echo "Created $CONF_DIR/probe.env - edit PROBE_ZONE, PROBE_INTERFACE, DNS and portal settings."
fi

install -m 0644 "$SRC_DIR/campus-edge-probe.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null

if [[ $FIRST_INSTALL == 1 ]]; then
  echo "Edit $CONF_DIR/probe.env, then start with:  sudo systemctl start $SERVICE"
else
  systemctl restart "$SERVICE"
  echo "Service restarted. Logs: journalctl -u $SERVICE -f   Metrics: curl localhost:8000/metrics"
fi
