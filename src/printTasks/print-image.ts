import { AppError } from "../AppError.ts";
import { defineAction } from "../dataDriven/actionRunner.ts";
import type { AppContext } from "../utils/context.ts";
import { applyFloydSteinbergDithering } from "../utils/imageDithering.ts";
import { formatDimensions, getEscposImageDimensions, loadImageFromDataUri } from "../utils/image.ts";
import { saveToHistoryPrints } from "../utils/imageStorage.ts";
import { closePrinter, cutPaper, flushPrinter, getPrinter, isPrinterAccessError, type PrinterSelection } from "../utils/printer.ts";

const dpiMode = "S8" as const;

type Params = {
    locale?: string,
    imageDataUrl: string,
    widthMm?: number,
    dither?: boolean,
    printer?: PrinterSelection,
    /** Save the image to the print history. Defaults to true. */
    saveHistory?: boolean,
};

export type { Params as PrintImageParams };

const action = defineAction({
    schema: {
        type: "object",
        properties: {
            locale: { type: "string", minLength: 2, maxLength: 2, nullable: true },
            imageDataUrl: { type: "string", minLength: 1 },
            widthMm: { type: "number", minimum: 1, maximum: 120, nullable: true },
            dither: { type: "boolean", nullable: true },
            saveHistory: { type: "boolean", nullable: true },
            printer: {
                type: "object",
                nullable: true,
                properties: {
                    id: { type: "string", minLength: 1 },
                },
                required: ["id"],
                additionalProperties: false,
            },
        },
        required: [
            "imageDataUrl",
        ],
        additionalProperties: false,
    },

    run: async (ctx: AppContext, params: Params) => {
        // Archive before touching the printer so media is preserved even when the
        // printer is unavailable. Callers that already archived (e.g. the bot,
        // with richer metadata) pass saveHistory: false to avoid a duplicate.
        if (params.saveHistory !== false) {
            saveToHistoryPrints(ctx, params.imageDataUrl)
                .catch((err) => ctx.logger.error("Failed to save print to history", { error: err instanceof Error ? err.message : String(err) }));
        }

        // Opening the USB printer and decoding/dithering the image are
        // independent — run them concurrently.
        const [printerResult, imageResult] = await Promise.allSettled([
            acquirePrinter(ctx, params),
            prepareImage(ctx, params),
        ]);

        if (printerResult.status === "rejected") {
            throw printerResult.reason;
        }
        const printer = printerResult.value;

        if (imageResult.status === "rejected") {
            // Don't leak the opened USB handle when the image cannot be prepared.
            await closePrinter(printer)
                .catch((err) => ctx.logger.error("Failed to close printer", { error: err instanceof Error ? err.message : String(err) }));
            throw imageResult.reason;
        }

        await printImage(ctx, printer, imageResult.value);

        return true;
    },
});

/** Opens the selected printer, mapping driver failures to app errors. */
async function acquirePrinter(ctx: AppContext, params: Params) {
    let printer;
    try {
        printer = await getPrinter({ locale: params.locale, selection: params.printer });
    } catch (error) {
        ctx.logger.error("Failed to open printer", { error: error instanceof Error ? error.message : String(error) });
        if (isPrinterAccessError(error)) {
            throw new AppError("access-denied", { subject: "printer", reason: "usb-access-denied" });
        }

        throw error;
    }

    if (!printer) {
        throw new AppError("not-found", { subject: "printer" });
    }

    return printer;
}

/** Loads the image from the data URI and applies optional dithering. */
async function prepareImage(ctx: AppContext, params: Params) {
    const loadedImage = await loadImageFromDataUri(ctx, params.imageDataUrl, {
        width: params.widthMm ?? 60,
        dpiMode,
    });
    ctx.logger.info('image-loaded', { dimensions: formatDimensions(getEscposImageDimensions(loadedImage)), dither: !!params.dither })
    if (!params.dither) {
        return loadedImage;
    }

    const ditheredImage = applyFloydSteinbergDithering(loadedImage);
    ctx.logger.info("image-dithered", { algorithm: "floyd-steinberg" });
    return ditheredImage;
}

/** Sends the prepared image to the printer and finishes the job (cut, flush, close). */
async function printImage(ctx: AppContext, printer: Awaited<ReturnType<typeof acquirePrinter>>, image: Awaited<ReturnType<typeof prepareImage>>) {
    ctx.logger.info('sendingToPrinter', {
        dimensions: formatDimensions(getEscposImageDimensions(image)),
        mode: "normal",
    });

    printer
        .align("CT")
        .raster(image, "normal");

    cutPaper(printer);

    await flushPrinter(printer);
    await closePrinter(printer);
}

export default action;
