import { AppError } from "../AppError.ts";
import { defineAction } from "../dataDriven/actionRunner.ts";
import { extensionFromMimeType, parseDataUri } from "../utils/image.ts";
import { closePrinter, flushPrinter, getPrinter, isPrinterAccessError, loadImageFromDataUri, type PrinterSelection } from "../utils/printer.ts";

const dpiMode = "S8" as const;

type Params = {
    locale?: string,
    imageDataUrl: string,
    widthMm?: number,
    printer?: PrinterSelection,
};

async function saveToHistoryPrints(dataUri: string): Promise<void> {
    const historyDir = Deno.env.get("POS_HISTORY_PRINTS");
    if (!historyDir) {
        return;
    }

    const parsed = parseDataUri(dataUri);
    if (!parsed) {
        return;
    }

    const isoDate = new Date().toISOString().replace(/:/g, "-");
    const extension = extensionFromMimeType(parsed.mimeType);
    const dirPath = historyDir.replace(/\/+$/, "");
    const filePath = `${dirPath}/${isoDate}.${extension}`;

    await Deno.mkdir(dirPath, { recursive: true });
    await Deno.writeFile(filePath, parsed.buffer);
}

export default defineAction({
    schema: {
        type: "object",
        properties: {
            locale: { type: "string", minLength: 2, maxLength: 2, nullable: true },
            imageDataUrl: { type: "string", minLength: 1 },
            widthMm: { type: "number", minimum: 1, maximum: 120, nullable: true },
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

    run: async (params: Params) => {
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

        await saveToHistoryPrints(params.imageDataUrl);

        const image = await loadImageFromDataUri(params.imageDataUrl, {
            width: params.widthMm ?? 60,
            dpiMode,
        });

        printer
            .align("LT")
            .raster(image, "normal");

        printer
            .feed(3)
            .cut();

        await flushPrinter(printer);
        await closePrinter(printer);

        return true;
    },
});
