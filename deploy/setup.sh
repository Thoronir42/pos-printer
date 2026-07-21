#!/usr/bin/env bash
#
# First-boot installer for pos-printer. Enabled by the firstrun hook and run
# once (as root) after network-online on the first normal boot. Idempotent, so
# it is safe to re-run by hand: sudo bash /boot/firmware/pos-printer/deploy/setup.sh
#
# Steps: install system deps + Deno, copy the app from the SD boot partition
# into the login user's home, cache deps, install the USB udev rule, then create
# and start the pos-printer systemd service that autostarts `deno task bot`.

set -uo pipefail

LOG=/var/log/pos-printer-setup.log
BOOT=""
for d in /boot/firmware /boot; do [ -d "$d" ] && BOOT="$d" && break; done
# Mirror output to the journal, /var/log, and the FAT boot partition (readable
# from a card reader if the Pi is headless and something goes wrong).
exec > >(tee -a "$LOG" ${BOOT:+"$BOOT/pos-printer-setup.log"}) 2>&1

echo "=== pos-printer setup $(date -Is) ==="

# --- locate the app payload copied onto the boot partition -------------------
SRC=""
for d in /boot/firmware/pos-printer /boot/pos-printer; do [ -d "$d" ] && SRC="$d" && break; done
if [ -z "$SRC" ]; then echo "FATAL: app payload not found on boot partition"; exit 1; fi
echo "Payload: $SRC"

# --- resolve the target login user -------------------------------------------
TARGET_USER="${POS_SETUP_USER:-$(getent passwd | awk -F: '$3>=1000 && $3<65534 {print $1; exit}')}"
if [ -z "$TARGET_USER" ]; then echo "FATAL: no login user (uid>=1000) found"; exit 1; fi
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
DEST="$TARGET_HOME/pos-printer"
echo "Target user: $TARGET_USER  home: $TARGET_HOME"

run_user() { sudo -u "$TARGET_USER" -H bash -lc "$*"; }

# --- 1. system deps (curl/unzip for Deno; toolchain for the native usb addon) -
export DEBIAN_FRONTEND=noninteractive
apt-get update -y || true
apt-get install -y curl unzip ca-certificates rsync build-essential python3 pkg-config libudev-dev || \
  echo "warn: apt install had errors (offline?) - continuing"

# --- 2. Deno (per user) ------------------------------------------------------
DENO="$TARGET_HOME/.deno/bin/deno"
if [ ! -x "$DENO" ]; then
  echo "Installing Deno..."
  run_user 'curl -fsSL https://deno.land/install.sh | DENO_INSTALL="$HOME/.deno" sh -s -- -y' || true
fi
if [ ! -x "$DENO" ]; then echo "FATAL: Deno not installed (needs internet on first boot)"; exit 1; fi
echo "Deno: $("$DENO" --version | head -n1)"

# --- 3. copy app into the user's home ----------------------------------------
mkdir -p "$DEST"
rsync -a --delete \
  --exclude '.git' --exclude 'node_modules' --exclude 'dist' --exclude 'data/prints' \
  "$SRC"/ "$DEST"/
mkdir -p "$DEST/data/prints"
# Bring over the .env the user edited on the card (never clobber an existing one).
if [ -f "$SRC/.env" ] && [ ! -f "$DEST/.env" ]; then cp "$SRC/.env" "$DEST/.env"; fi
chown -R "$TARGET_USER":"$TARGET_USER" "$DEST"
[ -f "$DEST/.env" ] && chmod 600 "$DEST/.env"

if [ ! -s "$DEST/.env" ] || ! grep -q '^TELEGRAM_BOT_TOKEN=.\+' "$DEST/.env" 2>/dev/null; then
  echo "warn: $DEST/.env has no TELEGRAM_BOT_TOKEN - the bot will not start until it is set."
fi

# --- 4. cache deps + build native addons (needs network) ---------------------
run_user "cd '$DEST' && '$DENO' cache main.ts" || \
  echo "warn: 'deno cache' failed - the service will retry on start"

# --- 5. USB access: group + udev rule (non-fatal if printer not plugged in) --
usermod -aG plugdev "$TARGET_USER" || true
if bash "$DEST/dev/udev/install-udev-rule.sh"; then
  echo "udev rule installed"
else
  echo "warn: udev rule not installed (printer not detected?). After plugging it in run:"
  echo "      sudo bash $DEST/dev/udev/install-udev-rule.sh"
fi

# --- 6. autostart service ----------------------------------------------------
SERVICE=/etc/systemd/system/pos-printer.service
sed -e "s|__USER__|$TARGET_USER|g" -e "s|__HOME__|$TARGET_HOME|g" \
  "$DEST/deploy/pos-printer.service" > "$SERVICE"
systemctl daemon-reload
systemctl enable pos-printer.service
systemctl restart pos-printer.service || true
echo "pos-printer.service enabled + started"

# --- 7. disarm this one-shot so it never runs again --------------------------
systemctl disable pos-printer-setup.service 2>/dev/null || true
rm -f /etc/systemd/system/pos-printer-setup.service
systemctl daemon-reload || true

echo "=== pos-printer setup done $(date -Is) ==="
echo "Check the bot with:  systemctl status pos-printer  |  journalctl -u pos-printer -f"
