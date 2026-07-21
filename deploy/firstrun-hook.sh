# >>> pos-printer autostart (managed by stage-sdcard) >>>
# Installed into the Pi's firstrun.sh. Runs once as root with the root
# filesystem mounted, so it can drop a systemd unit into /etc. It does NOT do
# the heavy work itself (no network yet at firstrun): it enables a one-shot that
# runs after network-online on the first normal boot -> deploy/setup.sh.
cat > /etc/systemd/system/pos-printer-setup.service <<'POSEOF'
[Unit]
Description=First-boot setup for pos-printer
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c 'for d in /boot/firmware /boot; do [ -f "$d/pos-printer/deploy/setup.sh" ] && exec bash "$d/pos-printer/deploy/setup.sh"; done'
StandardOutput=journal+console
StandardError=journal+console
[Install]
WantedBy=multi-user.target
POSEOF
systemctl enable pos-printer-setup.service
# <<< pos-printer autostart (managed by stage-sdcard) <<<
