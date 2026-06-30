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
    type TelegramSticker,
    type TelegramUpdate,
} from "../libs/telegram.ts";
import type { AppContext } from "../utils/context.ts";
import { createContext } from "../utils/context.ts";
import { getImageDimensions } from "../utils/image.ts";
import { saveMediaToHistory } from "../utils/imageStorage.ts";
import type { PrinterSelection } from "../utils/printer.ts";
import { createPrintLimiter, type PrintLimiter } from "./printLimiter.ts";

const MAX_IMAGE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_WIDTH_PX = 4096;
const MAX_IMAGE_HEIGHT_PX = 4096;
const MAX_IMAGE_PIXELS = 12_000_000;
const DEFAULT_POLLING_TIMEOUT_SECONDS = 30;
const RETRY_DELAY_MS = 3000;
const DEFAULT_BOT_PRINT_WIDTH_MM = 72;
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
};

function formatDimensions(width: number, height: number) {
    return `${width}x${height}`;
}

function formatOptionalDimensions(dimensions: { width: number, height: number } | null) {
    if (!dimensions) {
        return "unknown";
    }

    return formatDimensions(dimensions.width, dimensions.height);
}

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
        return `photo ${formatDimensions(photo.width, photo.height)}`;
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

function bufferToDataUrl(buffer: Uint8Array, mimeType: string) {
    return `data:${mimeType};base64,${Buffer.from(buffer).toString("base64")}`;
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
            imageDataUrl: bufferToDataUrl(media.buffer, media.mimeType),
            locale: opts.locale,
            printer: opts.printer,
            widthMm: opts.widthMm ?? DEFAULT_BOT_PRINT_WIDTH_MM,
            dither: true,
            saveHistory: false,
        },
    );
}

async function handleStickerMessage(ctx: AppContext, sticker: TelegramSticker, message: TelegramMessage, opts: PrintMediaOptions) {
    if (sticker.is_animated || sticker.is_video) {
        throw new Error(`Unsupported sticker type animated=${sticker.is_animated} video=${sticker.is_video}`);
    }

    ctx.logger.info(
        `[telegram] received sticker message=${message.message_id} chat=${message.chat?.id ?? "unknown"} ${formatDimensions(sticker.width, sticker.height)} bytes=${sticker.file_size ?? "unknown"}`,
    );

    assertWithinImageLimits(sticker.width, sticker.height, sticker.file_size);

    const file = await getTelegramFile(opts.token, sticker.file_id, opts.signal);
    if (!file.file_path) {
        throw new Error("Telegram file path is missing");
    }

    ctx.logger.info(
        `[telegram] file metadata path=${file.file_path} declaredSize=${file.file_size ?? "unknown"}`,
    );

    assertWithinImageLimits(sticker.width, sticker.height, file.file_size ?? sticker.file_size);

    const { buffer, mimeType } = await downloadTelegramFile(opts.token, file.file_path, opts.signal);
    if (buffer.byteLength > MAX_IMAGE_FILE_BYTES) {
        throw new Error(`Downloaded sticker exceeds ${MAX_IMAGE_FILE_BYTES} bytes`);
    }

    ctx.logger.info(
        `[telegram] downloaded mime=${mimeType} bytes=${buffer.byteLength} targetWidthMm=${opts.widthMm ?? DEFAULT_BOT_PRINT_WIDTH_MM}`,
    );

    await archiveAndPrint(ctx, message, { buffer, mimeType, fileId: sticker.file_id }, opts);

    ctx.logger.info("Printed Telegram sticker", {
        chatId: message.chat?.id ?? "unknown",
        messageId: message.message_id,
    });
}

async function handlePhotoMessage(ctx: AppContext, message: TelegramMessage, opts: PrintMediaOptions) {
    const photos = message.photo;
    const photo = photos?.length ? selectLargestPhotoVariant(photos) : undefined;
    if (!photo) {
        return;
    }

    ctx.logger.info(
        `[telegram] received message=${message.message_id} chat=${message.chat?.id ?? "unknown"} variants=${photos?.length ?? 0} selected=${formatDimensions(photo.width, photo.height)} bytes=${photo.file_size ?? "unknown"}`,
    );

    assertWithinImageLimits(photo.width, photo.height, photo.file_size);

    const file = await getTelegramFile(opts.token, photo.file_id, opts.signal);
    if (!file.file_path) {
        throw new Error("Telegram file path is missing");
    }

    ctx.logger.info(
        `[telegram] file metadata path=${file.file_path} declaredSize=${file.file_size ?? "unknown"} selected=${formatDimensions(photo.width, photo.height)}`,
    );

    assertWithinImageLimits(photo.width, photo.height, file.file_size ?? photo.file_size);

    const { buffer, mimeType } = await downloadTelegramFile(opts.token, file.file_path, opts.signal);
    if (buffer.byteLength > MAX_IMAGE_FILE_BYTES) {
        throw new Error(`Downloaded image exceeds ${MAX_IMAGE_FILE_BYTES} bytes`);
    }

    const dimensions = getImageDimensions(Buffer.from(buffer), mimeType);
    if (dimensions) {
        assertWithinImageLimits(dimensions.width, dimensions.height, buffer.byteLength);
    }

    ctx.logger.info(
        `[telegram] downloaded mime=${mimeType} bytes=${buffer.byteLength} dimensions=${formatOptionalDimensions(dimensions)} targetWidthMm=${opts.widthMm ?? DEFAULT_BOT_PRINT_WIDTH_MM}`,
    );

    await archiveAndPrint(ctx, message, { buffer, mimeType, fileId: photo.file_id }, opts);

    ctx.logger.info("Printed Telegram photo", {
        chatId: message.chat?.id ?? "unknown",
        messageId: message.message_id,
    });
}

/** Downloads and prints whatever printable media a message carries. */
export function processPrintableMessage(ctx: AppContext, message: TelegramMessage, opts: PrintMediaOptions) {
    if (message.sticker) {
        return handleStickerMessage(ctx, message.sticker, message, opts);
    }

    return handlePhotoMessage(ctx, message, opts);
}

export async function runTelegramBot(ctx: AppContext, opts: RunTelegramBotOptions) {
    const timeoutSeconds = getPollingTimeoutSeconds(opts.pollingTimeoutSeconds);
    const me = await getMe(opts.token, opts.signal);
    ctx.logger.info("Telegram bot listening", { username: me.username ?? "unknown" });

    let offset = 0;
    const requestTimestampsByChatId = new Map<number, number[]>();
    const limiter: PrintLimiter = createPrintLimiter();

    while (!opts.signal?.aborted) {
        try {
            const updates = await getUpdates(opts.token, offset, timeoutSeconds, opts.signal);
            for (const update of updates) {
                offset = update.update_id + 1;

                const message = getProcessableMessage(update);
                if (!message) {
                    continue;
                }

                const chatId = message.chat?.id;
                if (chatId == null) {
                    continue;
                }

                const now = Date.now();
                const requestTimestamps = requestTimestampsByChatId.get(chatId) ?? [];
                const recentRequestTimestamps = requestTimestamps
                    .filter((timestamp) => now - timestamp <= SPAM_WINDOW_MS);
                recentRequestTimestamps.push(now);
                requestTimestampsByChatId.set(chatId, recentRequestTimestamps);

                const updateContext: AppContext = createContext(ctx.logger.child({
                    updateId: update.update_id,
                    messageId: message.message_id,
                    chatId,
                }));

                const spamBlocked = recentRequestTimestamps.length >= SPAM_THRESHOLD;
                if (spamBlocked) {
                    await sendTelegramMessage(
                        opts.token,
                        chatId,
                        getSpamReply(),
                        { replyToMessageId: message.message_id },
                        opts.signal,
                    );
                    continue;
                }

                try {
                    // Serialize prints through the limiter so bursts of requests
                    // are held until the previous print finishes.
                    await limiter.schedule(() => processPrintableMessage(updateContext, message, opts));

                    await sendTelegramMessage(
                        opts.token,
                        chatId,
                        getSuccessReply(),
                        { replyToMessageId: message.message_id },
                        opts.signal,
                    );
                } catch (error) {
                    updateContext.logger.error("Failed to process Telegram update", {
                        error: error instanceof Error ? error.message : String(error),
                    });

                    await sendTelegramMessage(
                        opts.token,
                        chatId,
                        getErrorReply(),
                        { replyToMessageId: message.message_id },
                        opts.signal,
                    );
                }
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