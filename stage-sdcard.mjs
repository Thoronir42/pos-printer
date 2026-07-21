// Stage a freshly-flashed Raspberry Pi OS SD card for pos-printer autostart.
//
// Runs on Node (>=16) or Deno, on any OS:
//   node stage-sdcard.mjs G:\                       (Windows)
//   node stage-sdcard.mjs /Volumes/bootfs           (macOS)
//   node stage-sdcard.mjs /media/you/bootfs         (Linux)
//   deno run --allow-read --allow-write stage-sdcard.mjs G:\
//
// Run it AFTER flashing Raspberry Pi OS (Lite, 64-bit) with Raspberry Pi
// Imager, while the card is still mounted. It:
//   1. copies the app onto the boot partition  (<boot>/pos-printer/)
//   2. seeds <boot>/pos-printer/.env from .env.example  (edit before eject!)
//   3. hooks first-boot autostart into the card's firstrun.sh (+ cmdline.txt)
//
// Flags:  --no-firstrun   copy the app only, skip the autostart hook

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.dirname(fileURLToPath(import.meta.url));

// ---- args -----------------------------------------------------------------
const args = process.argv.slice(2);
const noFirstrun = args.includes("--no-firstrun");
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
  die(
    "Usage: node stage-sdcard.mjs <boot-partition> [--no-firstrun]\n" +
      "  e.g. node stage-sdcard.mjs G:\\   |   /Volumes/bootfs   |   /media/you/bootfs",
  );
}

// Normalise a bare Windows drive letter ("G:") to a root path ("G:\").
let boot = target;
if (/^[A-Za-z]:$/.test(boot)) boot += path.sep;

if (!existsDir(boot)) die(`Boot partition '${boot}' not found. Is the card mounted?`);

// Sanity: must be a Raspberry Pi *boot* partition, not the empty/unflashed card.
const isBoot = fs.existsSync(path.join(boot, "config.txt")) ||
  fs.existsSync(path.join(boot, "cmdline.txt"));
if (!isBoot) {
  die(
    `'${boot}' has no config.txt/cmdline.txt - it does not look like a flashed ` +
      `Raspberry Pi boot partition.\nFlash Raspberry Pi OS with Imager first, then re-run.`,
  );
}

// ---- 1. copy the app payload -> <boot>/pos-printer/ -----------------------
const dest = path.join(boot, "pos-printer");
console.log(`Copying app  ->  ${dest}`);
// Excluded relative to the repo root. .env is skipped so an edited one on the
// card survives re-runs; heavy/dev-only trees are not worth shipping.
const skipDirs = new Set([".git", "node_modules", "dist"]);
const skipRel = new Set([norm("data/prints"), norm(".env")]);
copyTree(repo, dest, "");

// ---- 2. seed .env (never overwrite an existing one) -----------------------
const envDst = path.join(dest, ".env");
if (!fs.existsSync(envDst)) {
  fs.copyFileSync(path.join(repo, ".env.example"), envDst);
  console.log(`\nCreated ${envDst}`);
  console.log("  -> EDIT IT: set TELEGRAM_BOT_TOKEN and TELEGRAM_JANITOR_CHAT_ID before ejecting.");
} else {
  console.log(".env already present on card - left untouched.");
}

if (noFirstrun) {
  console.log("\nDone (app copied; firstrun hook skipped).");
  process.exit(0);
}

// ---- 3. install the first-boot autostart hook -----------------------------
// Imager writes one of three first-boot formats depending on the OS/version.
// We detect which and compose with it, never overriding the boot flow:
//   * cloud-init (user-data)  -> add setup.sh to runcmd            [preferred]
//   * firstrun.sh             -> enable a one-shot before cleanup
//   * neither (older Bookworm)-> create firstrun.sh + cmdline hook [legacy]
const marker = "pos-printer autostart (managed by stage-sdcard)";
const userDataPath = path.join(boot, "user-data");
const firstrunPath = path.join(boot, "firstrun.sh");
const cmdlinePath = path.join(boot, "cmdline.txt");

const userData = fs.existsSync(userDataPath) ? lf(fs.readFileSync(userDataPath, "utf8")) : null;
const isCloudInit = userData !== null && /^#cloud-config\b/.test(userData.trimStart());

if (isCloudInit) {
  hookCloudInit(userDataPath, userData);
} else if (fs.existsSync(firstrunPath)) {
  hookFirstrun(firstrunPath);
} else {
  createFirstrun(firstrunPath, cmdlinePath);
}

console.log("\nDone. Next:");
console.log(`  1. Edit  ${envDst}  (Telegram token + janitor chat id)`);
console.log("  2. Safely eject the card, put it in the Pi, plug in the printer, boot.");
console.log("  3. First boot installs everything (a few minutes, needs internet).");
console.log("     Debug from a card reader afterwards: <boot>/pos-printer-setup.log");

// ---- first-boot hooks -----------------------------------------------------
// cloud-init (Debian 13 / trixie RPi OS and Ubuntu): add setup.sh to runcmd,
// which cloud-init runs late in first boot with the network already up. No
// firstrun.sh, no cmdline.txt changes - so we never touch the boot flow.
function hookCloudInit(p, ud) {
  if (ud.includes(marker)) {
    console.log("cloud-init user-data already has the pos-printer hook - nothing to do.");
    return;
  }
  const item = `  - [ bash, /boot/firmware/pos-printer/deploy/setup.sh ]   # ${marker}`;
  const lines = ud.split("\n");
  const idx = lines.findIndex((l) => /^runcmd:\s*$/.test(l));
  let out;
  if (idx !== -1) {
    // Insert as the first runcmd item (existing items still run).
    out = [...lines.slice(0, idx + 1), item, ...lines.slice(idx + 1)].join("\n");
  } else if (/^runcmd:/m.test(ud)) {
    console.log(
      "WARNING: user-data has an inline 'runcmd:' - add this item by hand:\n" + item,
    );
    return;
  } else {
    out = ud.replace(/\n*$/, "") + "\nruncmd:\n" + item + "\n";
  }
  fs.writeFileSync(p, lf(out));
  console.log("Added pos-printer setup to cloud-init runcmd (user-data).");
}

// Imager firstrun.sh: enable a one-shot that runs setup.sh after network-online
// on the first normal boot. Inserted before Imager's own cleanup so its
// customisation is preserved.
function hookFirstrun(p) {
  const hook = lf(fs.readFileSync(path.join(repo, "deploy", "firstrun-hook.sh"), "utf8"));
  const content = lf(fs.readFileSync(p, "utf8"));
  if (content.includes(marker)) {
    console.log("firstrun.sh already hooked - nothing to do.");
    return;
  }
  const lines = content.split("\n");
  let idx = lines.findIndex((l) => /\brm\b/.test(l) && l.includes("firstrun.sh"));
  if (idx === -1) idx = lines.findIndex((l) => l.trim() === "exit 0");
  const out = idx === -1
    ? content.replace(/\n+$/, "") + "\n\n" + hook + "\n"
    : [...lines.slice(0, idx), "", hook, "", ...lines.slice(idx)].join("\n");
  fs.writeFileSync(p, lf(out));
  console.log("Hooked existing firstrun.sh (Imager customisation preserved).");
}

// No cloud-init and no firstrun.sh (older Bookworm): create firstrun.sh and
// wire it into cmdline.txt. The cleanup strips ALL three tokens we add - a
// stray systemd.unit= would pin every boot to a minimal target (emergency mode).
function createFirstrun(p, clPath) {
  const hook = lf(fs.readFileSync(path.join(repo, "deploy", "firstrun-hook.sh"), "utf8"));
  const body = "#!/bin/bash\nset +e\n\n" + hook +
    "\n\nrm -f /boot/firmware/firstrun.sh /boot/firstrun.sh\n" +
    "sed -i -E 's/ systemd\\.(run|run_success_action|unit)=[^ ]*//g'" +
    " /boot/firmware/cmdline.txt /boot/cmdline.txt 2>/dev/null\n" +
    "exit 0\n";
  fs.writeFileSync(p, lf(body));

  const cl = lf(fs.readFileSync(clPath, "utf8")).replace(/\n+$/, "");
  if (/systemd\.run=/.test(cl)) {
    console.log(
      "WARNING: cmdline.txt already has a systemd.run= hook. Created firstrun.sh " +
        "but did NOT touch cmdline.txt - verify manually.",
    );
    return;
  }
  const patched = cl +
    " systemd.run=/boot/firmware/firstrun.sh systemd.run_success_action=reboot systemd.unit=kernel-command-line.target";
  fs.writeFileSync(clPath, patched + "\n");
  console.log("Created firstrun.sh and patched cmdline.txt.");
}

// ---- helpers --------------------------------------------------------------
function copyTree(srcDir, dstDir, rel) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const childRel = norm(rel ? `${rel}/${entry.name}` : entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name) || skipRel.has(childRel)) continue;
      copyTree(path.join(srcDir, entry.name), path.join(dstDir, entry.name), childRel);
    } else if (entry.isFile()) {
      if (skipRel.has(childRel)) continue;
      fs.copyFileSync(path.join(srcDir, entry.name), path.join(dstDir, entry.name));
    }
  }
}

function existsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function norm(p) {
  return p.split(path.sep).join("/");
}

function lf(s) {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}
