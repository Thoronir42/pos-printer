import printImageAction from "../printTasks/print-image.ts";
import type { AppContext } from "../utils/context.ts";
import { createContext } from "../utils/context.ts";
import {
    type HistoryEntry,
    listHistoryEntries,
    readHistoryImageDataUrl,
} from "../utils/imageStorage.ts";
import { DEFAULT_PRINT_WIDTH_MM, type PrinterSelection } from "../utils/printer.ts";
import { createPrintLimiter, type PrintLimiter } from "./printLimiter.ts";

/** A strategy that decides what happens when a rewound entry is "printed". */
export type RewindController = {
    print: (ctx: AppContext, entry: HistoryEntry, opts: RewindOptions) => Promise<void>;
};

/** Does the real print, reading the archived image straight from disk. */
const armed: RewindController = {
    print: async (ctx, entry, opts) => {
        const imageDataUrl = await readHistoryImageDataUrl(entry);
        await printImageAction.run(ctx, {
            imageDataUrl,
            locale: opts.locale,
            printer: opts.printer,
            widthMm: opts.widthMm ?? DEFAULT_PRINT_WIDTH_MM,
            dither: true,
            saveHistory: false,
        });
    },
};

/** Lists but never touches the printer — usable without a printer present. */
const dry: RewindController = {
    print: () => Promise.resolve(),
};

const ctrls = { dry, armed } as const;

export type RewindOptions = {
    from: Date,
    to: Date,
    dry?: boolean,
    locale?: string,
    printer?: PrinterSelection,
    widthMm?: number,
    signal?: AbortSignal,
};

function formatSender(entry: HistoryEntry) {
    return entry.sender ?? "unknown";
}

function formatMedia(entry: HistoryEntry) {
    return entry.mediaName ?? "unknown";
}

export async function runRewind(ctx: AppContext, opts: RewindOptions) {
    const controller: RewindController = ctrls[opts.dry ? "dry" : "armed"];

    ctx.logger.info("Rewind starting", {
        from: opts.from.toISOString(),
        to: opts.to.toISOString(),
        mode: opts.dry ? "dry" : "armed",
    });

    const entries = await listHistoryEntries(ctx, { from: opts.from, to: opts.to });
    ctx.logger.info("Rewind entries collected", { count: entries.length });

    const limiter: PrintLimiter = createPrintLimiter();

    for (const entry of entries) {
        if (opts.signal?.aborted) {
            break;
        }

        console.log(`${entry.receivedAt.toISOString()}  ${formatSender(entry)} — ${formatMedia(entry)}`);

        const entryContext: AppContext = createContext(ctx.logger.child({
            messageId: entry.messageId ?? "unknown",
            chatId: entry.chatId ?? "unknown",
            image: entry.imagePath,
        }));

        // Serialize each rewound entry through the limiter so they are pushed one
        // at a time, holding each until the previous one finishes.
        await limiter.schedule(() => controller.print(entryContext, entry, opts));
    }

    ctx.logger.info("Rewind finished", { count: entries.length });
}
