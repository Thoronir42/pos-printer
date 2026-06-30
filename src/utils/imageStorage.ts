import { Buffer } from "node:buffer";
import type { AppContext } from "./context.ts";
import { extensionFromMimeType, getImageMimeType, parseDataUri } from "./image.ts";

/** Metadata captured alongside an archived image, stored as a `.json` sidecar. */
export type HistoryMediaMetadata = {
    /** ISO timestamp the media was sent/received — used to filter rewinds. */
    date: string,
    /** Human readable sender name, if known. */
    sender?: string,
    /** Human readable media name (e.g. sticker emoji/pack or "photo WxH"). */
    mediaName?: string,
    messageId?: number,
    chatId?: number | string,
    fileId?: string,
    mimeType?: string,
};

/** An archived image discovered on disk, with metadata (real or synthesized). */
export type HistoryEntry = HistoryMediaMetadata & {
    /** Absolute path to the archived image file. */
    imagePath: string,
    /** Parsed {@link HistoryMediaMetadata.date} for convenience. */
    receivedAt: Date,
    /** Whether a `.json` sidecar was found (false = synthesized from the file). */
    hasMetadata: boolean,
};

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"]);

function getHistoryDir(): string | null {
    const historyDir = Deno.env.get("POS_HISTORY_PRINTS");
    if (!historyDir) {
        return null;
    }

    return historyDir.replace(/\/+$/, "");
}

/** Like {@link getHistoryDir} but throws when unset — for callers that require it. */
export function getHistoryBaseDir(): string {
    const historyDir = getHistoryDir();
    if (!historyDir) {
        throw new Error("POS_HISTORY_PRINTS is not set; nothing to explore");
    }

    return historyDir;
}

function isImageFileName(name: string): boolean {
    const extension = name.split(".").pop()?.toLowerCase() ?? "";
    return IMAGE_EXTENSIONS.has(extension);
}

/** Rejects day names that are empty or could escape the base directory. */
function assertSafeDay(day: string): void {
    if (day === "" || day.includes("/") || day.includes("\\") || day === "." || day.includes("..")) {
        throw new Error(`Invalid day: ${day}`);
    }
}

function formatHistoryFileName(date: Date, extension: string) {
    return `${date.toISOString().replace(/:/g, "-")}.${extension}`;
}

function formatDayDirectory(date: Date) {
    return date.toISOString().slice(0, 10);
}

async function writeImageFile(dirPath: string, fileName: string, buffer: Uint8Array): Promise<string> {
    await Deno.mkdir(dirPath, { recursive: true });
    const filePath = `${dirPath}/${fileName}`;
    await Deno.writeFile(filePath, buffer);
    return filePath;
}

/**
 * Saves a printed image to the history directory (if configured). Used by the
 * generic print path that has no richer metadata to attach.
 */
export async function saveToHistoryPrints(ctx: AppContext, dataUri: string): Promise<void> {
    const baseDirPath = getHistoryDir();
    if (!baseDirPath) {
        return;
    }

    const parsed = parseDataUri(dataUri);
    if (!parsed) {
        return;
    }

    const now = new Date();
    const extension = extensionFromMimeType(parsed.mimeType);
    const dirPath = `${baseDirPath}/${formatDayDirectory(now)}`;
    const filePath = await writeImageFile(dirPath, formatHistoryFileName(now, extension), new Uint8Array(parsed.buffer));

    ctx.logger.debug("Saved print image history", { filePath });
}

/**
 * Archives a received image together with a metadata sidecar, independently of
 * whether it is ever printed. The image file name is keyed on receive time (for
 * uniqueness) while {@link HistoryMediaMetadata.date} carries the message time
 * used to filter rewinds.
 */
export async function saveMediaToHistory(
    ctx: AppContext,
    media: { buffer: Uint8Array, mimeType: string, metadata: HistoryMediaMetadata },
): Promise<void> {
    const baseDirPath = getHistoryDir();
    if (!baseDirPath) {
        return;
    }

    const now = new Date();
    const extension = extensionFromMimeType(media.mimeType);
    const dirPath = `${baseDirPath}/${formatDayDirectory(now)}`;
    const baseName = formatHistoryFileName(now, extension).replace(new RegExp(`\\.${extension}$`), "");

    const imageFileName = `${baseName}.${extension}`;
    const imagePath = await writeImageFile(dirPath, imageFileName, media.buffer);

    const metadata: HistoryMediaMetadata & { image: string } = {
        ...media.metadata,
        mimeType: media.metadata.mimeType ?? media.mimeType,
        image: imageFileName,
    };
    await Deno.writeTextFile(`${dirPath}/${baseName}.json`, JSON.stringify(metadata, null, 2));

    ctx.logger.debug("Saved media history", { imagePath, sender: media.metadata.sender, mediaName: media.metadata.mediaName });
}

/** Reverses {@link formatHistoryFileName} to recover the timestamp of a legacy file. */
function dateFromHistoryFileName(baseName: string): Date | null {
    const restored = baseName.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
    const date = new Date(restored);
    return Number.isNaN(date.getTime()) ? null : date;
}

async function readSidecar(jsonPath: string): Promise<(HistoryMediaMetadata & { image?: string }) | null> {
    try {
        const raw = await Deno.readTextFile(jsonPath);
        return JSON.parse(raw) as HistoryMediaMetadata & { image?: string };
    } catch {
        return null;
    }
}

async function* walkImageFiles(dirPath: string): AsyncGenerator<{ dir: string, name: string }> {
    let entries: Deno.DirEntry[];
    try {
        entries = [...Deno.readDirSync(dirPath)];
    } catch {
        return;
    }

    for (const entry of entries) {
        const path = `${dirPath}/${entry.name}`;
        if (entry.isDirectory) {
            yield* walkImageFiles(path);
            continue;
        }

        const extension = entry.name.split(".").pop()?.toLowerCase() ?? "";
        if (entry.isFile && IMAGE_EXTENSIONS.has(extension)) {
            yield { dir: dirPath, name: entry.name };
        }
    }
}

/**
 * Lists archived images whose effective date falls within `[from, to]`.
 * Entries with a `.json` sidecar carry real sender/media metadata; legacy
 * images without one are synthesized from their file name so they can still be
 * replayed. Returns entries sorted by ascending date.
 */
export async function listHistoryEntries(
    ctx: AppContext,
    range: { from: Date, to: Date },
): Promise<HistoryEntry[]> {
    const baseDirPath = getHistoryDir();
    if (!baseDirPath) {
        throw new Error("POS_HISTORY_PRINTS is not set; nothing to rewind from");
    }

    const entries: HistoryEntry[] = [];

    for await (const { dir, name } of walkImageFiles(baseDirPath)) {
        const baseName = name.replace(/\.[^.]+$/, "");
        const imagePath = `${dir}/${name}`;

        const sidecar = await readSidecar(`${dir}/${baseName}.json`);
        const receivedAt = sidecar?.date ? new Date(sidecar.date) : dateFromHistoryFileName(baseName);
        if (!receivedAt || Number.isNaN(receivedAt.getTime())) {
            ctx.logger.debug("Skipping history file with no resolvable date", { imagePath });
            continue;
        }

        if (receivedAt < range.from || receivedAt > range.to) {
            continue;
        }

        entries.push({
            imagePath,
            receivedAt,
            hasMetadata: sidecar != null,
            date: receivedAt.toISOString(),
            sender: sidecar?.sender,
            mediaName: sidecar?.mediaName ?? (sidecar ? undefined : name),
            messageId: sidecar?.messageId,
            chatId: sidecar?.chatId,
            fileId: sidecar?.fileId,
            mimeType: sidecar?.mimeType ?? getImageMimeType(name, null) ?? undefined,
        });
    }

    entries.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
    return entries;
}

/** A day (subfolder) in the history archive, with its image count. */
export type HistoryDay = {
    /** Folder name (typically `YYYY-MM-DD`). */
    name: string,
    count: number,
};

/** A single archived image within a day, with its raw sidecar metadata (if any). */
export type DayMediaEntry = {
    /** Image file name (basename) within the day folder. */
    file: string,
    /** File size in bytes. */
    size: number,
    /** Best-effort mime type derived from the file extension. */
    mimeType: string | null,
    /** ISO timestamp: sidecar `date` if present, else recovered from the file name. */
    receivedAt: string | null,
    /** Whether a `.json` sidecar was found next to the image. */
    hasMetadata: boolean,
    /** Raw parsed sidecar contents, exactly as stored (null when absent). */
    metadata: (HistoryMediaMetadata & { image?: string }) | null,
};

/**
 * Lists the days (subfolders) available in the history archive. Sorted newest
 * day first. Loose image files in the base directory itself are ignored.
 */
export function listHistoryDays(): HistoryDay[] {
    const baseDirPath = getHistoryBaseDir();

    let entries: Deno.DirEntry[];
    try {
        entries = [...Deno.readDirSync(baseDirPath)];
    } catch {
        return [];
    }

    const days: HistoryDay[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory) {
            continue;
        }

        let count = 0;
        for (const child of Deno.readDirSync(`${baseDirPath}/${entry.name}`)) {
            if (child.isFile && isImageFileName(child.name)) {
                count += 1;
            }
        }
        days.push({ name: entry.name, count });
    }

    days.sort((a, b) => b.name.localeCompare(a.name));

    return days;
}

/**
 * Lists the images in a single day folder, reading each `.json` sidecar raw so
 * the stored metadata can be inspected verbatim. Sorted by ascending timestamp
 * (falling back to file name).
 */
export async function listDayMedia(day: string): Promise<DayMediaEntry[]> {
    assertSafeDay(day);

    const baseDirPath = getHistoryBaseDir();
    const dirPath = `${baseDirPath}/${day}`;

    let dirEntries: Deno.DirEntry[];
    try {
        dirEntries = [...Deno.readDirSync(dirPath)];
    } catch {
        return [];
    }

    const media: DayMediaEntry[] = [];

    for (const dirEntry of dirEntries) {
        if (!dirEntry.isFile || !isImageFileName(dirEntry.name)) {
            continue;
        }

        const baseName = dirEntry.name.replace(/\.[^.]+$/, "");
        const filePath = `${dirPath}/${dirEntry.name}`;

        const sidecar = await readSidecar(`${dirPath}/${baseName}.json`);
        const receivedAt = sidecar?.date ? new Date(sidecar.date) : dateFromHistoryFileName(baseName);

        let size = 0;
        try {
            size = (await Deno.stat(filePath)).size;
        } catch {
            size = 0;
        }

        media.push({
            file: dirEntry.name,
            size,
            mimeType: getImageMimeType(dirEntry.name, null),
            receivedAt: receivedAt && !Number.isNaN(receivedAt.getTime()) ? receivedAt.toISOString() : null,
            hasMetadata: sidecar != null,
            metadata: sidecar,
        });
    }

    media.sort((a, b) => {
        const at = a.receivedAt ?? a.file;
        const bt = b.receivedAt ?? b.file;
        return at.localeCompare(bt);
    });

    return media;
}

/** Reads an archived image back as a data URL ready for the print action. */
export async function readHistoryImageDataUrl(entry: HistoryEntry): Promise<string> {
    const buffer = await Deno.readFile(entry.imagePath);
    const mimeType = entry.mimeType ?? getImageMimeType(entry.imagePath, null);
    if (!mimeType) {
        throw new Error(`Cannot determine mime type for ${entry.imagePath}`);
    }

    return `data:${mimeType};base64,${Buffer.from(buffer).toString("base64")}`;
}
