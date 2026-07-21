#!/usr/bin/env bash
#
# pos-printer provisioning — runs on the Pi after the repo is cloned (invoked by
# pos-printer-bootstrap.sh). Idempotent: safe to re-run. Installs the Deno
# runtime, wires up the app env, warms the module cache, then installs and
# starts the pos-printer service.
set -euo pipefail

TARGET=/opt/pos-printer
DENO_INSTALL=/opt/deno
DENO_BIN="$DENO_INSTALL/bin/deno"
DENO_DIR="$TARGET/.cache/deno"
ENV_SRC=/boot/firmware/pos-printer.env

export DENO_INSTALL DENO_DIR HOME=/root

echo "[provision] installing Deno into $DENO_INSTALL"
if [ ! -x "$DENO_BIN" ]; then
    curl -fsSL https://deno.land/install.sh | sh
fi

echo "[provision] writing app environment"
if [ -f "$ENV_SRC" ]; then
    cp "$ENV_SRC" "$TARGET/.env"
else
    echo "[provision] WARNING: $ENV_SRC not found; the bot will fail without TELEGRAM_BOT_TOKEN" >&2
fi

mkdir -p "$TARGET/data/prints" "$DENO_DIR"

echo "[provision] warming the Deno module cache"
cd "$TARGET"
"$DENO_BIN" cache main.ts

echo "[provision] installing and starting the pos-printer service"
install -m 0644 "$TARGET/deploy/pos-printer.service" /etc/systemd/system/pos-printer.service
systemctl daemon-reload
systemctl enable --now pos-printer.service

# Provisioning succeeded — don't run it again on future boots.
systemctl disable pos-printer-provision.service || true
echo "[provision] done"
