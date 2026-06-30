#!/usr/bin/env bash
#
# Grant non-root raw USB (libusb) access to the thermal printer so pos-printer
# can open it. Without this, opening the device fails with LIBUSB_ERROR_ACCESS,
# which the server reports as HTTP 423 (access-denied / usb-access-denied).
#
# Usage:
#   sudo bash dev/udev/install-udev-rule.sh                 # auto-detect the USB printer
#   sudo bash dev/udev/install-udev-rule.sh 04b8 0e28       # explicit idVendor idProduct (hex)
#
# With no arguments it scans for USB devices exposing a Printer interface
# (bInterfaceClass 07). If exactly one is found it is used; otherwise it lists
# the candidates and asks you to pass the IDs explicitly (see `find-printer`
# below or dev/udev/README.md).
#
# Re-runnable: it overwrites the rule, reloads, and re-triggers. No re-plug needed.

set -euo pipefail

GROUP="plugdev"
RULE_FILE="/etc/udev/rules.d/99-pos-printer.rules"

# List "vendor product  description" for every USB device with a Printer interface.
find_printers() {
  local iface dev v p desc
  for iface in /sys/bus/usb/devices/*:*/bInterfaceClass; do
    [[ -r "${iface}" ]] || continue
    [[ "$(cat "${iface}")" == "07" ]] || continue   # 07 = Printer class
    dev="${iface%:*}"                                # strip ":1.0" -> parent device dir
    [[ -r "${dev}/idVendor" && -r "${dev}/idProduct" ]] || continue
    v="$(cat "${dev}/idVendor")"; p="$(cat "${dev}/idProduct")"
    desc="$(cat "${dev}/product" 2>/dev/null || true)"
    printf '%s %s %s\n' "${v}" "${p}" "${desc}"
  done | sort -u
}

if [[ "${EUID}" -ne 0 ]]; then
  echo "This script must run as root. Re-run: sudo bash $0 [idVendor idProduct]" >&2
  exit 1
fi

if [[ $# -eq 2 ]]; then
  VENDOR="$1"; PRODUCT="$2"
elif [[ $# -eq 0 ]]; then
  mapfile -t FOUND < <(find_printers)
  if [[ "${#FOUND[@]}" -eq 0 ]]; then
    echo "No USB printer-class device found. Is the printer plugged in and on?" >&2
    echo "List all USB devices with: lsusb" >&2
    exit 1
  elif [[ "${#FOUND[@]}" -gt 1 ]]; then
    echo "Multiple USB printers found - re-run with the desired idVendor idProduct:" >&2
    printf '  %s\n' "${FOUND[@]}" >&2
    echo "e.g. sudo bash $0 ${FOUND[0]%% *} $(awk '{print $2}' <<<"${FOUND[0]}")" >&2
    exit 1
  fi
  read -r VENDOR PRODUCT DESC <<<"${FOUND[0]}"
  echo "Detected USB printer ${VENDOR}:${PRODUCT} ${DESC:+(${DESC})}"
else
  echo "Usage: sudo bash $0 [idVendor idProduct]" >&2
  exit 1
fi

# The user who invoked sudo (so we can add them to the group if needed).
TARGET_USER="${SUDO_USER:-}"

echo "Installing udev rule for USB ${VENDOR}:${PRODUCT} (group ${GROUP}) -> ${RULE_FILE}"
cat > "${RULE_FILE}" <<EOF
# Managed by pos-printer (dev/udev/install-udev-rule.sh).
# Grants ${GROUP} group + logged-in user raw libusb access to the thermal printer.
SUBSYSTEM=="usb", ATTRS{idVendor}=="${VENDOR}", ATTRS{idProduct}=="${PRODUCT}", MODE="0660", GROUP="${GROUP}", TAG+="uaccess"
EOF

# Make sure the invoking user is in the group the rule grants access to.
if [[ -n "${TARGET_USER}" ]] && ! id -nG "${TARGET_USER}" | tr ' ' '\n' | grep -qx "${GROUP}"; then
  echo "Adding user '${TARGET_USER}' to group '${GROUP}' (log out/in for it to take full effect)."
  usermod -aG "${GROUP}" "${TARGET_USER}"
fi

echo "Reloading and re-triggering udev..."
udevadm control --reload-rules
udevadm trigger

echo
echo "Done. Verify the printer node is now group '${GROUP}':"
echo "  lsusb -d ${VENDOR}:${PRODUCT}     # find Bus/Device"
echo "  ls -l /dev/bus/usb/<bus>/<dev>    # expect: crw-rw---- root ${GROUP}"
echo
echo "If you just added yourself to '${GROUP}', start a fresh login shell before running the server."
