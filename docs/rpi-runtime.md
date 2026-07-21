# Running pos-printer on a Raspberry Pi (unattended)

This guide flashes a Raspberry Pi so that, from a cold boot with **no keyboard,
screen, or manual steps**, it:

1. joins your preconfigured Wi-Fi,
2. installs the Deno runtime,
3. clones this project and starts it in **bot mode** as a service that restarts
   on crash or reboot, and
4. sends your **janitor** chat a message that it is up and running.

Once running, the janitor can send the bot **`/disk`** to see how much space the
saved print history is using and how much room is left on the SD card.

Everything after "insert card and power on" happens on its own.

---

## 1. What you need

- A 64-bit-capable Raspberry Pi (Pi 3, 4, 5, or Zero 2 W). **64-bit is
  required** — the official Deno runtime has no 32-bit ARM build.
- A microSD card (8 GB+) and a card reader.
- The USB thermal printer.
- [Raspberry Pi Imager](https://www.raspberrypi.com/software/) on your computer.

## 2. Get your Telegram values

- **Bot token:** message [@BotFather](https://t.me/BotFather), send
  `/newbot`, follow the prompts, and copy the token it gives you.
- **Janitor chat id:** this is the chat that gets the startup ping and is
  allowed to run `/disk`. The simplest way to find it is to message
  [@userinfobot](https://t.me/userinfobot) — it replies with your numeric id.
  (For a private chat, your user id and the chat id are the same number.)

## 3. Flash Raspberry Pi OS with Wi-Fi preconfigured

1. Open Raspberry Pi Imager.
2. **Choose OS** → *Raspberry Pi OS (other)* → **Raspberry Pi OS Lite (64-bit)**.
3. **Choose Storage** → your SD card.
4. Click the **gear / Edit Settings** (OS customization) and set:
   - **Hostname** (e.g. `pos-printer`).
   - **Enable SSH** (password or public key) — handy for troubleshooting.
   - **Configure wireless LAN**: your Wi-Fi **SSID**, **password**, and
     **Wi-Fi country** (the country is required or Wi-Fi stays disabled).
   - **Locale / timezone**.
5. **Save**, then **Write**. Wait for it to finish, then leave the card in the
   reader (or re-insert it) so the **boot partition** mounts on your computer.

This is what gets the Pi onto your Wi-Fi automatically — no code involved.

## 4. Drop in the provisioning files

The boot partition mounts as a small FAT drive (named **`bootfs`**; on the Pi
this is `/boot/firmware`). Do two things there:

**a) Add your filled environment file.** Copy
[`deploy/pos-printer.env.example`](../deploy/pos-printer.env.example) onto the
boot partition, rename it to **`pos-printer.env`**, and fill in at least:

```dotenv
TELEGRAM_BOT_TOKEN=123456:your-token-here
TELEGRAM_JANITOR_CHAT_ID=987654321
POS_HISTORY_PRINTS=/opt/pos-printer/data/prints
```

**b) Enable auto-provisioning.** Raspberry Pi Imager created a `firstrun.sh` on
the boot partition. Open it in a text editor and paste the entire contents of
[`deploy/firstrun-append.sh`](../deploy/firstrun-append.sh) at the **end** of
the file (if the last line is `rm -f /boot/firmware/firstrun.sh`, paste it just
*above* that line).

> The pasted block only writes a couple of files and enables a one-time service;
> it needs no network. The heavy lifting (installing Deno, cloning the repo,
> starting the bot) runs a moment later from that service, once Wi-Fi is up.

Eject the card safely.

## 5. Boot it

Connect the USB printer, insert the SD card, and power on the Pi.

- First boot runs Imager's own setup and reboots once.
- After it reconnects to Wi-Fi, provisioning runs (installing Deno + cloning the
  repo takes a few minutes on the first run).
- When the bot starts you'll get a Telegram message:
  **"✅ pos-printer is up and running as @yourbot"**.

That message is your signal that everything worked. Send the bot a photo or
sticker and it prints.

## 6. Janitor commands

Send these **from the janitor chat** (they're ignored from anyone else):

- **`/disk`** — print-archive size, file/day counts, and SD-card used/free space.
- **`/help`** — list commands.

## 7. Operating & troubleshooting (over SSH)

SSH in as the user you configured in Imager, e.g. `ssh pi@pos-printer.local`.

```bash
# Is the bot running?
systemctl status pos-printer
journalctl -u pos-printer -f          # live logs

# Watch first-boot provisioning (only relevant right after flashing)
systemctl status pos-printer-provision
journalctl -u pos-printer-provision -b

# Restart / re-provision if needed
sudo systemctl restart pos-printer
sudo systemctl start pos-printer-provision   # re-run the installer
```

Common issues:

- **No startup message.** Check `TELEGRAM_BOT_TOKEN` and
  `TELEGRAM_JANITOR_CHAT_ID` in `/opt/pos-printer/.env`, and that the Wi-Fi
  **country** was set during flashing (missing country = no Wi-Fi).
- **Bot never starts / "provisioning" keeps failing.** Confirm the Pi has
  internet (`ping -c1 deno.land`) and the repo URL is reachable. The provisioning
  service retries on every boot until it succeeds.
- **Nothing prints.** Confirm the printer is on and plugged in; check
  `journalctl -u pos-printer` for USB/printer errors.
- **Wrong architecture.** `uname -m` must report `aarch64`. If it says `armv7l`,
  reflash with the **64-bit** Lite image.

## 8. Security notes

- **Rotate the bot token** if it has ever been shared or committed. Set it only
  in `pos-printer.env` on the device; never commit `.env` (it is git-ignored).
- The service runs as **root** so the USB printer works without extra udev
  rules — appropriate for a single-purpose appliance on a trusted network. If
  you need to harden this, run it as a dedicated user and add a udev rule
  granting that user access to the printer's USB device, then adjust
  `deploy/pos-printer.service`.
- Keep SSH access restricted to your own key/password.

---

### How it fits together

| Piece | Role |
| --- | --- |
| Raspberry Pi Imager customization | Preconfigures Wi-Fi, SSH, hostname, locale |
| `deploy/firstrun-append.sh` | Seeds a one-time provisioning service on first boot |
| `deploy/provision.sh` | Installs Deno, clones repo, installs the bot service |
| `deploy/pos-printer.service` | Long-running `deno task bot`, restarts on failure |
| `deploy/pos-printer.env.example` | Template for the per-device secrets/config |
