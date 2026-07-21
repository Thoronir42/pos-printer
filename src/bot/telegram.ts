import { Buffer } from "node:buffer";
import printImageAction from "../printTasks/print-image.ts";
import {
    downloadTelegramFile,
    getMe,
    getTelegramFile,
    getUpdates,
    sendTelegramMessage,
    type TelegramMessage,
    type TelegramPhotoSize,
    type TelegramUpdate,
} from "../libs/telegram.ts";
import type { AppContext } from "../utils/context.ts";
import { createContext } from "../utils/context.ts";
import { bufferToDataUri, formatDimensions, getImageDimensions } from "../utils/image.ts";
import { saveMediaToHistory } from "../utils/imageStorage.ts";
import { DEFAULT_PRINT_WIDTH_MM, type PrinterSelection } from "../utils/printer.ts";
import { createPrintLimiter, createSpamGuard, type PrintLimiter } from "./printLimiter.ts";
import { buildDiskReport } from "./diskUsage.ts";

const MAX_IMAGE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_WIDTH_PX = 4096;
const MAX_IMAGE_HEIGHT_PX = 4096;
const MAX_IMAGE_PIXELS = 12_000_000;
const DEFAULT_POLLING_TIMEOUT_SECONDS = 30;
const RETRY_DELAY_MS = 3000;
const SPAM_WINDOW_MS = 20_000;
const SPAM_THRESHOLD = 4;
const RARE_SPAM_REPLY_PROBABILITY = 0.03;

const SUCCESS_REPLIES = ["Done", "Got it", "Punched it out", "Donzo"];
const ERROR_REPLIES = ["Hurk", "Whoops", "I lost it"];
const SPAM_REPLIES = ["Too much", "Ouch, hot hot", "Nope", "Nuh-uh", "Get lost"];
const RARE_SPAM_REPLY = "I'm sorry Dave, I can not let you do that";

/** Options needed to download and print a single piece of Telegram media. */
export type PrintMediaOptions = {
    token: string,
    locale?: string,
    printer?: PrinterSelection,
    widthMm?: number,
    signal?: AbortSignal,
};

type RunTelegramBotOptions = PrintMediaOptions & {
    pollingTimeoutSeconds?: number,
    /** Chat id of the janitor: receives the startup ping and may run commands. */
    janitorChatId?: number,
};

const JANITOR_HELP = [
    "pos-printer janitor commands:",
    "/disk — print archive size and disk free space",
].join("\n");

function selectLargestPhotoVariant(photoSizes: TelegramPhotoSize[]) {
    return photoSizes.reduce((largest, candidate) => {
        const largestPixels = largest.width * largest.height;
        const candidatePixels = candidate.width * candidate.height;
        if (candidatePixels > largestPixels) {
            return candidate;
        }

        if (candidatePixels < largestPixels) {
            return largest;
        }

        const largestBytes = largest.file_size ?? 0;
        const candidateBytes = candidate.file_size ?? 0;
        return candidateBytes > largestBytes ? candidate : largest;
    });
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPollingTimeoutSeconds(timeout?: number) {
    if (!timeout || !Number.isFinite(timeout) || timeout < 1) {
        return DEFAULT_POLLING_TIMEOUT_SECONDS;
    }

    return Math.floor(timeout);
}

function pickRandom<T>(items: T[]): T {
    const index = Math.floor(Math.random() * items.length);
    return items[index];
}

function getSuccessReply() {
    return pickRandom(SUCCESS_REPLIES);
}

function getErrorReply() {
    return pickRandom(ERROR_REPLIES);
}

function getSpamReply() {
    if (Math.random() < RARE_SPAM_REPLY_PROBABILITY) {
        return RARE_SPAM_REPLY;
    }

    return pickRandom(SPAM_REPLIES);
}

/**
 * Extracts a bot command from a message, or null when it carries none.
 * Handles the `/cmd@BotName arg` form, returning the lower-cased `cmd`.
 */
export function getBotCommand(message: TelegramMessage): string | null {
    const text = message.text?.trim();
    if (!text || !text.startsWith("/")) {
        return null;
    }

    const token = text.slice(1).split(/\s+/, 1)[0];
    const command = token.split("@", 1)[0].toLowerCase();
    return command.length ? command : null;
}

export function getProcessableMessage(update: TelegramUpdate) {
    const message = update.message ?? update.edited_message;
    if (!message) {
        return null;
    }

    if (message.photo?.length || message.sticker) {
        return message;
    }

    return null;
}

/** Human readable name of whoever sent the message. */
export function getSenderName(message: TelegramMessage): string {
    const from = message.from;
    if (!from) {
        return "unknown";
    }

    const fullName = [from.first_name, from.last_name].filter(Boolean).join(" ");
    return fullName || from.username || `id:${from.id}`;
}

/** Human readable name of the media carried by the message. */
export function getMediaName(message: TelegramMessage): string {
    if (message.sticker) {
        const { emoji, set_name } = message.sticker;
        return [emoji, set_name].filter(Boolean).join(" ") || "sticker";
    }

    if (message.photo?.length) {
        const photo = selectLargestPhotoVariant(message.photo);
        return `photo ${formatDimensions(photo)}`;
    }

    return "unknown";
}

function assertWithinImageLimits(width: number, height: number, fileSize?: number) {
    if (fileSize != null && fileSize > MAX_IMAGE_FILE_BYTES) {
        throw new Error(`Image file is too large: ${fileSize} bytes`);
    }

    if (width < 1 || height < 1) {
        throw new Error("Image dimensions are invalid");
    }

    if (width > MAX_IMAGE_WIDTH_PX || height > MAX_IMAGE_HEIGHT_PX) {
        throw new Error(`Image dimensions exceed ${MAX_IMAGE_WIDTH_PX}x${MAX_IMAGE_HEIGHT_PX}px`);
    }

    if (width * height > MAX_IMAGE_PIXELS) {
        throw new Error(`Image pixel count exceeds ${MAX_IMAGE_PIXELS}`);
    }
}

function messageDateToIso(message: TelegramMessage) {
    return (message.date != null ? new Date(message.date * 1000) : new Date()).toISOString();
}

/**
 * Archives the downloaded media (image + metadata sidecar) and then prints it.
 * Archiving happens first and unconditionally, so media is preserved even if the
 * printer is unavailable; the print step therefore skips its own history save.
 */
async function archiveAndPrint(
    ctx: AppContext,
    message: TelegramMessage,
    media: { buffer: Uint8Array, mimeType: string, fileId: string },
    opts: PrintMediaOptions,
) {
    await saveMediaToHistory(ctx, {
        buffer: media.buffer,
        mimeType: media.mimeType,
        metadata: {
            date: messageDateToIso(message),
            sender: getSenderName(message),
            mediaName: getMediaName(message),
            messageId: message.message_id,
            chatId: message.chat?.id,
            fileId: media.fileId,
        },
    });

    await printImageAction.run(
        ctx.with((ctx) => ({...ctx, logger: ctx.logger.child({action: 'print-image'})})),
        {
            imageDataUrl: bufferToDataUri(media.buffer, media.mimeType),
            locale: opts.locale,
            printer: opts.printer,
            widthMm: opts.widthMm ?? DEFAULT_PRINT_WIDTH_MM,
            dither: true,
            saveHistory: false,
        },
    );
}

/** A downloadable, printable media item extracted from a message. */
type PrintableMedia = {
    kind: "sticker" | "photo",
    fileId: string,
    width: number,
    height: number,
    fileSize?: number,
};

/**
 * Extracts the printable media a message carries, or null when there is none.
 * Throws for media we recognize but cannot print (animated/video stickers).
 */
function getPrintableMedia(message: TelegramMessage): PrintableMedia | null {
    const sticker = message.sticker;
    if (sticker) {
        if (sticker.is_animated || sticker.is_video) {
            throw new Error(`Unsupported sticker type animated=${sticker.is_animated} video=${sticker.is_video}`);
        }

        return { kind: "sticker", fileId: sticker.file_id, width: sticker.width, height: sticker.height, fileSize: sticker.file_size };
    }

    const photos = message.photo;
    if (photos?.length) {
        const photo = selectLargestPhotoVariant(photos);
        return { kind: "photo", fileId: photo.file_id, width: photo.width, height: photo.height, fileSize: photo.file_size };
    }

    return null;
}

/** Downloads a media file, enforcing size limits before and after the transfer. */
async function downloadMedia(ctx: AppContext, media: PrintableMedia, opts: PrintMediaOptions) {
    assertWithinImageLimits(media.width, media.height, media.fileSize);

    const file = await getTelegramFile(opts.token, media.fileId, opts.signal);
    if (!file.file_path) {
        throw new Error("Telegram file path is missing");
    }

    ctx.logger.info(
        `[telegram] file metadata path=${file.file_path} declaredSize=${file.file_size ?? "unknown"}`,
    );

    assertWithinImageLimits(media.width, media.height, file.file_size ?? media.fileSize);

    const { buffer, mimeType } = await downloadTelegramFile(opts.token, file.file_path, opts.signal);
    if (buffer.byteLength > MAX_IMAGE_FILE_BYTES) {
        throw new Error(`Downloaded ${media.kind} exceeds ${MAX_IMAGE_FILE_BYTES} bytes`);
    }

    // The declared dimensions describe the source; re-check the actual file.
    const dimensions = getImageDimensions(Buffer.from(buffer), mimeType);
    if (dimensions) {
        assertWithinImageLimits(dimensions.width, dimensions.height, buffer.byteLength);
    }

    ctx.logger.info(
        `[telegram] downloaded mime=${mimeType} bytes=${buffer.byteLength} dimensions=${formatDimensions(dimensions)} targetWidthMm=${opts.widthMm ?? DEFAULT_PRINT_WIDTH_MM}`,
    );

    return { buffer, mimeType };
}

/** Downloads and prints whatever printable media a message carries. */
export async function processPrintableMessage(ctx: AppContext, message: TelegramMessage, opts: PrintMediaOptions) {
    const media = getPrintableMedia(message);
    if (!media) {
        return;
    }

    ctx.logger.info(
        `[telegram] received ${media.kind} message=${message.message_id} chat=${message.chat?.id ?? "unknown"} ${formatDimensions(media)} bytes=${media.fileSize ?? "unknown"}`,
    );

    const { buffer, mimeType } = await downloadMedia(ctx, media, opts);
    await archiveAndPrint(ctx, message, { buffer, mimeType, fileId: media.fileId }, opts);

    ctx.logger.info(`Printed Telegram ${media.kind}`, {
        chatId: message.chat?.id ?? "unknown",
        messageId: message.message_id,
    });
}

export async function runTelegramBot(ctx: AppContext, opts: RunTelegramBotOptions) {
    const timeoutSeconds = getPollingTimeoutSeconds(opts.pollingTimeoutSeconds);
    const me = await getMe(opts.token, opts.signal);
    ctx.logger.info("Telegram bot listening", { username: me.username ?? "unknown" });

    const spamGuard = createSpamGuard({ windowMs: SPAM_WINDOW_MS, threshold: SPAM_THRESHOLD });
    const limiter: PrintLimiter = createPrintLimiter();

    const reply = (chatId: number, messageId: number, text: string) =>
        sendTelegramMessage(opts.token, chatId, text, { replyToMessageId: messageId }, opts.signal);

    // Announce readiness to the janitor. A bad id must not block startup.
    if (opts.janitorChatId != null) {
        try {
            await sendTelegramMessage(
                opts.token,
                opts.janitorChatId,
                `✅ pos-printer is up and running as @${me.username ?? "unknown"}`,
                undefined,
                opts.signal,
            );
        } catch (error) {
            ctx.logger.warn("Failed to notify janitor on startup", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /** Runs a janitor-only command. Returns true when the message was a command. */
    async function handleCommand(message: TelegramMessage): Promise<boolean> {
        const command = getBotCommand(message);
        if (!command) {
            return false;
        }

        const chatId = message.chat?.id;
        // Commands are janitor-only; ignore them from anyone else so the bot
        // stays a print surface for the public, not a command surface.
        if (chatId == null || opts.janitorChatId == null || chatId !== opts.janitorChatId) {
            return true;
        }

        try {
            if (command === "disk") {
                await reply(chatId, message.message_id, await buildDiskReport(ctx));
            } else if (command === "start" || command === "help") {
                await reply(chatId, message.message_id, JANITOR_HELP);
            } else {
                await reply(chatId, message.message_id, `Unknown command /${command}\n\n${JANITOR_HELP}`);
            }
        } catch (error) {
            ctx.logger.error("Failed to handle janitor command", {
                command,
                error: error instanceof Error ? error.message : String(error),
            });
            await reply(chatId, message.message_id, getErrorReply());
        }

        return true;
    }

    async function handleUpdate(update: TelegramUpdate) {
        const rawMessage = update.message ?? update.edited_message;
        if (rawMessage && await handleCommand(rawMessage)) {
            return;
        }

        const message = getProcessableMessage(update);
        if (!message) {
            return;
        }

        const chatId = message.chat?.id;
        if (chatId == null) {
            return;
        }

        if (spamGuard.registerRequest(chatId)) {
            await reply(chatId, message.message_id, getSpamReply());
            return;
        }

        const updateContext: AppContext = createContext(ctx.logger.child({
            updateId: update.update_id,
            messageId: message.message_id,
            chatId,
        }));

        try {
            // Serialize prints through the limiter so bursts of requests
            // are held until the previous print finishes.
            await limiter.schedule(() => processPrintableMessage(updateContext, message, opts));

            await reply(chatId, message.message_id, getSuccessReply());
        } catch (error) {
            updateContext.logger.error("Failed to process Telegram update", {
                error: error instanceof Error ? error.message : String(error),
            });

            await reply(chatId, message.message_id, getErrorReply());
        }
    }

    let offset = 0;
    while (!opts.signal?.aborted) {
        try {
            const updates = await getUpdates(opts.token, offset, timeoutSeconds, opts.signal);
            for (const update of updates) {
                offset = update.update_id + 1;
                await handleUpdate(update);
            }
        } catch (error) {
            if (opts.signal?.aborted) {
                break;
            }

            ctx.logger.error("Telegram polling failed", {
                error: error instanceof Error ? error.message : String(error),
            });
            await delay(RETRY_DELAY_MS);
        }
    }
}
