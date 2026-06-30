# Linux setup (USB printer access)

On Linux the app talks to the printer over raw USB via libusb. Two things must be
in place that "just work" on macOS:

## 1. Run with `--allow-sys`

A transitive dependency (`@resvg/resvg-js`) probes `os.cpus()` during an
`isMusl()` check at import time. Without `--allow-sys` Deno aborts before the
server starts. The `dev`, `bot`, and `compile:linux` tasks in `deno.json` already
include it. If you run Deno by hand, add `--allow-sys`.

## 2. Grant USB access (fixes HTTP 423)

By default the printer's USB node (`/dev/bus/usb/<bus>/<dev>`) is owned `root:lp`
mode `0660`. A user not in the `lp` group cannot open it for writing, so libusb
returns `LIBUSB_ERROR_ACCESS`, which the server reports as **HTTP 423**
(`access-denied` / `usb-access-denied`).

Fix once per machine:

```bash
sudo bash dev/udev/install-udev-rule.sh
```

With no arguments the script auto-detects the USB printer (any device exposing a
Printer interface, USB class `07`), writes `99-pos-printer.rules`, adds you to
`plugdev`, reloads udev, and re-triggers it (no re-plug needed). After it runs the
node should be `crw-rw---- root plugdev`.

### Finding the IDs yourself

If you have more than one USB printer, the script asks you to pass the
`idVendor idProduct` explicitly:

```bash
sudo bash dev/udev/install-udev-rule.sh <idVendor> <idProduct>   # hex, e.g. 04b8 0e28
```

Discover the IDs of every connected USB printer (vendor:product + name) with this
one-liner — no pre-baked values, it reads them from the kernel:

```bash
for f in /sys/bus/usb/devices/*:*/bInterfaceClass; do [ "$(cat "$f")" = 07 ] && \
  d=${f%:*} && printf '%s:%s  %s\n' "$(cat "$d/idVendor")" "$(cat "$d/idProduct")" \
  "$(cat "$d/product" 2>/dev/null)"; done | sort -u
```

Or just `lsusb` to list all USB devices and read the `ID vvvv:pppp` column.

## Verify

```bash
deno task dev serve --port 3639                    # start server
curl http://127.0.0.1:3639/list-printers           # should list the printer
# POST the bruno "print image reciept" request -> expect HTTP 200
```
