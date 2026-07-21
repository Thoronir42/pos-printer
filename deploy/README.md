# Raspberry Pi autostart

Make an SD card boot Raspberry Pi OS and autostart the pos-printer Telegram bot
on first boot, with no manual steps on the Pi.

## What's here

| File                   | Runs on   | Purpose                                                             |
| ---------------------- | --------- | ------------------------------------------------------------------ |
| `../stage-sdcard.mjs`  | any host  | Copies the app to the card and wires up first-boot autostart.      |
| `firstrun-hook.sh`     | Pi        | Injected into the card's `firstrun.sh`; enables the setup one-shot. |
| `setup.sh`             | Pi        | First real boot: installs Deno + app + udev rule + the service.    |
| `pos-printer.service`  | Pi        | systemd unit that autostarts `deno task bot`.                      |

`stage-sdcard.mjs` runs on **Node (>=16) or Deno**, on Windows/macOS/Linux.

The card cannot be made bootable by copying files alone — Raspberry Pi OS must
be **flashed** first (it creates the ext4 root partition Windows can't see).

## Steps

### 1. Flash Raspberry Pi OS with Raspberry Pi Imager

- OS: **Raspberry Pi OS Lite (64-bit)**.
- Open the **customisation** (gear / "Edit settings") and set:
  - **Enable SSH** (password or key) — your remote lifeline if anything fails.
  - **Username + password** — the app installs into this user's home.
  - **Wi‑Fi** SSID/password + **locale/timezone** — needed on first boot to
    download Deno and dependencies.
  - Hostname (optional), e.g. `posprinter`.
- Write the card. When it finishes, leave/reinsert it so the `bootfs` partition
  appears in Windows (e.g. `G:`). Do **not** eject yet.

### 2. Stage the card

From the repo root, pass the path to the card's boot partition:

```bash
# Windows (drive letter)          macOS                     Linux
node stage-sdcard.mjs G:\         /Volumes/bootfs           /media/you/bootfs
# or, using the Deno you already have for this project:
deno run --allow-read --allow-write stage-sdcard.mjs G:\
```

Add `--no-firstrun` to copy the app only, without touching autostart.

This copies the app to `<boot>/pos-printer/`, creates `<boot>/pos-printer/.env`, and
hooks first-boot autostart into the card's `firstrun.sh` (your Imager
customisation is preserved).

### 3. Fill in the Telegram config

Edit **`G:\pos-printer\.env`** and set:

```
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_JANITOR_CHAT_ID=123456789
```

The bot will not start until `TELEGRAM_BOT_TOKEN` is set.

### 4. Boot the Pi

Eject the card, insert it in the Pi, **plug in the thermal printer**, power on.

- First boot applies the Imager customisation and reboots.
- The next boot (once Wi‑Fi is up) runs `setup.sh`: installs Deno, copies the
  app to `~/pos-printer`, installs the USB udev rule, and starts the service.
  This takes a few minutes and needs internet.

## Verify / troubleshoot

Over SSH:

```bash
systemctl status pos-printer        # bot service
journalctl -u pos-printer -f        # live bot logs
journalctl -u pos-printer-setup     # first-boot install log
```

Headless with no network? Put the card back in a reader and read
`pos-printer-setup.log` on the boot partition.

On cloud-init images (Debian 13 / trixie RPi OS, Ubuntu) setup runs from
cloud-init's `runcmd`, so also check:

```bash
cloud-init status --long                 # did first-boot config finish?
sudo cat /var/log/cloud-init-output.log  # runcmd + setup.sh output
```

Re-run the installer by hand (idempotent):

```bash
sudo bash /boot/firmware/pos-printer/deploy/setup.sh
```

Printer not detected at first boot (rule skipped)? Plug it in, then:

```bash
sudo bash ~/pos-printer/dev/udev/install-udev-rule.sh
sudo systemctl restart pos-printer
```

## Notes

- The card holds the app code (no `git clone` needed on the Pi). Internet is
  only needed once, on first boot, to install Deno + cache dependencies.
- `.env` sits in plaintext on the card and on the Pi — fine for a home
  appliance, but treat the card accordingly.
- The staging script auto-detects the first-boot mechanism and composes with
  it — it never rewrites `cmdline.txt` when the OS already configures itself:
  - **cloud-init** (`user-data` present, e.g. Debian 13 / trixie RPi OS,
    Ubuntu) → adds `setup.sh` to `runcmd`.
  - **`firstrun.sh`** (older Imager) → enables a one-shot before Imager's cleanup.
  - **neither** (older Bookworm) → creates `firstrun.sh` + a `cmdline.txt` hook.
- Assumes the boot partition is at `/boot/firmware`; `setup.sh` also handles the
  older `/boot` layout.
