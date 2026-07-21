# ---------------------------------------------------------------------------
# pos-printer unattended provisioning
#
# Append this block to the END of the firstrun.sh that Raspberry Pi Imager
# generates on the boot partition (/boot/firmware/firstrun.sh), just before its
# final `rm -f /boot/firmware/firstrun.sh` line if present.
#
# It only writes files and enables a service (no network needed here). The
# actual install runs later from pos-printer-provision.service, once Wi-Fi is up.
# ---------------------------------------------------------------------------

cat > /usr/local/sbin/pos-printer-bootstrap.sh <<'BOOTSTRAP'
#!/usr/bin/env bash
set -euo pipefail
ENV_FILE=/boot/firmware/pos-printer.env
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
REPO_URL="${POS_PRINTER_REPO:-https://github.com/Thoronir42/pos-printer.git}"
TARGET=/opt/pos-printer
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y git curl unzip
if [ -d "$TARGET/.git" ]; then
    git -C "$TARGET" pull --ff-only || true
else
    git clone --depth 1 "$REPO_URL" "$TARGET"
fi
exec bash "$TARGET/deploy/provision.sh"
BOOTSTRAP
chmod +x /usr/local/sbin/pos-printer-bootstrap.sh

cat > /etc/systemd/system/pos-printer-provision.service <<'UNIT'
[Unit]
Description=pos-printer first-boot provisioning
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/pos-printer-bootstrap.sh

[Install]
WantedBy=multi-user.target
UNIT

systemctl enable pos-printer-provision.service
