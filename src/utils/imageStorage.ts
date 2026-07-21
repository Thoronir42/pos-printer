import type { AppContext } from "./context.ts";
import { bufferToDataUri, extensionFromMimeType, getImageMimeType, parseDataUri } from "./image.ts";

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

/** True when a path segment is non-empty and cannot escape its parent directory. */
export function isSafePathSegment(segment: string): boolean {
    return segment !== "" && !segment.includes("/") && !segment.includes("\\") && segment !== "." && !segment.includes("..");
}

/** Rejects day names that are empty or could escape the base directory. */
function assertSafeDay(day: string): void {
    if (!isSafePathSegment(day)) {
        throw new Error(`Invalid day: ${day}`);
    }
}

/** File-name stem (extension-less) for an archived image and its sidecar. */
function formatHistoryStem(date: Date) {
    return date.toISOString().replace(/:/g, "-");
}

function formatDayDirectory(date: Date) {
    return date.toISOString().slice(0, 10);
}

/**
 * Saves a printed image to the history directory (if configured). Used by the
 * generic print path that has no richer metadata to attach — delegates to
 * {@link saveMediaToHistory} with a minimal date-only sidecar so all archive
 * entries share one write path and format.
 */
export async function saveToHistoryPrints(ctx: AppContext, dataUri: string): Promise<void> {
    if (!getHistoryDir()) {
        return;
    }

    const parsed = parseDataUri(dataUri);
    if (!parsed) {
        return;
    }

    await saveMediaToHistory(ctx, {
        buffer: new Uint8Array(parsed.buffer),
        mimeType: parsed.mimeType,
        metadata: { date: new Date().toISOString() },
    });
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
    const stem = formatHistoryStem(now);
    const extension = extensionFromMimeType(media.mimeType);
    const dirPath = `${baseDirPath}/${formatDayDirectory(now)}`;
    const imageFileName = `${stem}.${extension}`;
    const imagePath = `${dirPath}/${imageFileName}`;

    const metadata: HistoryMediaMetadata & { image: string } = {
        ...media.metadata,
        mimeType: media.metadata.mimeType ?? media.mimeType,
        image: imageFileName,
    };

    await Deno.mkdir(dirPath, { recursive: true });
    // The image and its sidecar are independent files — write them concurrently.
    const writes = await Promise.allSettled([
        Deno.writeFile(imagePath, media.buffer),
        Deno.writeTextFile(`${dirPath}/${stem}.json`, JSON.stringify(metadata, null, 2)),
    ]);
    for (const write of writes) {
        if (write.status === "rejected") {
            throw write.reason;
        }
    }

    ctx.logger.debug("Saved media history", { imagePath, sender: media.metadata.sender, mediaName: media.metadata.mediaName });
}

/** Reverses {@link formatHistoryStem} to recover the timestamp of a legacy file. */
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

/**
 * Resolves an image file's sidecar metadata and effective date: the sidecar
 * `date` when present, else the timestamp recovered from the file name
 * (null when neither yields a valid date).
 */
async function resolveSidecar(dir: string, fileName: string): Promise<{
    sidecar: (HistoryMediaMetadata & { image?: string }) | null,
    receivedAt: Date | null,
}> {
    const baseName = fileName.replace(/\.[^.]+$/, "");
    const sidecar = await readSidecar(`${dir}/${baseName}.json`);
    const receivedAt = sidecar?.date ? new Date(sidecar.date) : dateFromHistoryFileName(baseName);
    return {
        sidecar,
        receivedAt: receivedAt && !Number.isNaN(receivedAt.getTime()) ? receivedAt : null,
    };
}

async function* walkImageFiles(dirPath: string): AsyncGenerator<{ dir: string, name: string }> {
    let entries: Deno.DirEntry[];
    try {
        entries = await Array.fromAsync(Deno.readDir(dirPath));
    } catch {
        return;
    }

    for (const entry of entries) {
        if (entry.isDirectory) {
            yield* walkImageFiles(`${dirPath}/${entry.name}`);
            continue;
        }

        if (entry.isFile && isImageFileName(entry.name)) {
            yield { dir: dirPath, name: entry.name };
        }
    }
}

/** Maps one walked file to a {@link HistoryEntry}, or null when dateless or out of range. */
async function buildHistoryEntry(
    ctx: AppContext,
    file: { dir: string, name: string },
    range: { from: Date, to: Date },
): Promise<HistoryEntry | null> {
    const imagePath = `${file.dir}/${file.name}`;
    const { sidecar, receivedAt } = await resolveSidecar(file.dir, file.name);
    if (!receivedAt) {
        ctx.logger.debug("Skipping history file with no resolvable date", { imagePath });
        return null;
    }

    if (receivedAt < range.from || receivedAt > range.to) {
        return null;
    }

    return {
        imagePath,
        receivedAt,
        hasMetadata: sidecar != null,
        date: receivedAt.toISOString(),
        sender: sidecar?.sender,
        mediaName: sidecar?.mediaName ?? (sidecar ? undefined : file.name),
        messageId: sidecar?.messageId,
        chatId: sidecar?.chatId,
        fileId: sidecar?.fileId,
        mimeType: sidecar?.mimeType ?? getImageMimeType(file.name, null) ?? undefined,
    };
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

    const files = await Array.fromAsync(walkImageFiles(baseDirPath));
    // Per-file sidecar reads are independent — run them concurrently; the sort re-imposes order.
    const results = await Promise.allSettled(files.map((file) => buildHistoryEntry(ctx, file, range)));
    const entries = results
        .filter((result): result is PromiseFulfilledResult<HistoryEntry | null> => result.status === "fulfilled")
        .map((result) => result.value)
        .filter((entry): entry is HistoryEntry => entry != null);

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
export async function listHistoryDays(): Promise<HistoryDay[]> {
    const baseDirPath = getHistoryBaseDir();

    let entries: Deno.DirEntry[];
    try {
        entries = await Array.fromAsync(Deno.readDir(baseDirPath));
    } catch {
        return [];
    }

    // Day folders are independent — count their images concurrently.
    const days = await Promise.all(
        entries.filter((entry) => entry.isDirectory).map(async (entry) => {
            let count = 0;
            for await (const child of Deno.readDir(`${baseDirPath}/${entry.name}`)) {
                if (child.isFile && isImageFileName(child.name)) {
                    count += 1;
                }
            }
            return { name: entry.name, count };
        }),
    );

    days.sort((a, b) => b.name.localeCompare(a.name));

    return days;
}

/** Maps one image file in a day folder to a {@link DayMediaEntry}. */
async function buildDayMediaEntry(dirPath: string, fileName: string): Promise<DayMediaEntry> {
    // The sidecar read and the stat are independent — run them concurrently.
    const [meta, stat] = await Promise.allSettled([
        resolveSidecar(dirPath, fileName),
        Deno.stat(`${dirPath}/${fileName}`),
    ]);
    const { sidecar, receivedAt } = meta.status === "fulfilled" ? meta.value : { sidecar: null, receivedAt: null };

    return {
        file: fileName,
        size: stat.status === "fulfilled" ? stat.value.size : 0,
        mimeType: getImageMimeType(fileName, null),
        receivedAt: receivedAt?.toISOString() ?? null,
        hasMetadata: sidecar != null,
        metadata: sidecar,
    };
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
        dirEntries = await Array.fromAsync(Deno.readDir(dirPath));
    } catch {
        return [];
    }

    // Per-file metadata reads are independent — run them concurrently; the sort re-imposes order.
    const media = await Promise.all(
        dirEntries
            .filter((entry) => entry.isFile && isImageFileName(entry.name))
            .map((entry) => buildDayMediaEntry(dirPath, entry.name)),
    );

    media.sort((a, b) => {
        const at = a.receivedAt ?? a.file;
        const bt = b.receivedAt ?? b.file;
        return at.localeCompare(bt);
    });

    return media;
}

/** Reads an image file back as a data URL ready for the print action. */
export async function readImageFileAsDataUrl(filePath: string, mimeType?: string): Promise<string> {
    const buffer = await Deno.readFile(filePath);
    const resolvedMimeType = mimeType ?? getImageMimeType(filePath, null);
    if (!resolvedMimeType) {
        throw new Error(`Cannot determine mime type for ${filePath}`);
    }

    return bufferToDataUri(buffer, resolvedMimeType);
}

/** Reads an archived image back as a data URL ready for the print action. */
export function readHistoryImageDataUrl(entry: HistoryEntry): Promise<string> {
    return readImageFileAsDataUrl(entry.imagePath, entry.mimeType);
}
