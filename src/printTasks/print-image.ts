import { AppError } from "../AppError.ts";
import { defineAction } from "../dataDriven/actionRunner.ts";
import type { AppContext } from "../utils/context.ts";
import { applyFloydSteinbergDithering } from "../utils/imageDithering.ts";
import { formatDimensions, getEscposImageDimensions, loadImageFromDataUri } from "../utils/image.ts";
import { saveToHistoryPrints } from "../utils/imageStorage.ts";
import { closePrinter, flushPrinter, getPrinter, isPrinterAccessError, type PrinterSelection } from "../utils/printer.ts";

const dpiMode = "S8" as const;

type Params = {
    locale?: string,
    imageDataUrl: string,
    widthMm?: number,
    dither?: boolean,
    printer?: PrinterSelection,
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
        let printer
        try {
            printer = await getPrinter({ locale: params.locale, selection: params.printer });
        } catch (error) {
            if (isPrinterAccessError(error)) {
                throw new AppError("access-denied", { subject: "printer", reason: "usb-access-denied" });
            }

            throw error;
        }

        if (!printer) {
            throw new AppError("not-found", { subject: "printer" });
        }

        saveToHistoryPrints(ctx, params.imageDataUrl)
            .catch((err) => ctx.logger.error("Failed to save print to history", { error: err instanceof Error ? err.message : String(err) }));

        const image = await loadImageFromDataUri(ctx, params.imageDataUrl, {
            width: params.widthMm ?? 60,
            dpiMode,
        })
            .then((loadedImage) => {
                ctx.logger.info('image-loaded', { dimensions: formatDimensions(getEscposImageDimensions(loadedImage)), dither: !!params.dither })
                if (!params.dither) {
                    return loadedImage;
                }

                const ditheredImage = applyFloydSteinbergDithering(loadedImage);
                ctx.logger.info("image-dithered", { algorithm: "floyd-steinberg" });
                return ditheredImage;
            });

        const printerImageDimensions = getEscposImageDimensions(image);
        ctx.logger.info('sendingToPrinter', {
            dimensions: printerImageDimensions ? `${printerImageDimensions.width}x${printerImageDimensions.height}` : "unknown",
            mode: "normal",
        });

        printer
            .align("CT")
            .raster(image, "normal");

        printer
            .feed(3)
            .cut();

        await flushPrinter(printer);
        await closePrinter(printer);

        return true;
    },
});

export default action;
