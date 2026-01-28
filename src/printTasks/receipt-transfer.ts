import { AppError } from "../AppError.ts";
import { defineAction } from "../dataDriven/actionRunner.ts";
import { getPrinter } from "../printer.ts";

const dpiMode = 's8' as const
const headerImage = await (async () => {
    const header = Deno.env.get("POS_PRINTER_HEADER_IMG")
    if (!header) return null
    const { loadImage } = await import("../printer.ts")
    return loadImage(header, { width: 60, dpiMode })
})()

type Params = {
    locale: string,
    text: string,
    headerImg: false,
}
export default defineAction({
    schema: {
        type: "object",
        properties: {
            locale: { type: "string", minLength: 2, maxLength: 2 },
            text: { type: "string", minLength: 1 },
            headerImg: { type: "boolean" },
        },
        required: [
            'locale',
            'text',
        ],
        additionalProperties: false,
    },

    run: async (params: Params) => {
        const printer = await getPrinter({locale: params.locale})
        if (!printer) {
            throw new AppError('not-found', {subject: 'printer'})
        }

        if (headerImage && params.headerImg !== false) {
            await printer
                .align('CT')
                .image(headerImage, dpiMode)
        }

        printer
            .align("CT")
            .style("B")
            .size(1, 1)
            .text(params.text)
            .feed(3)
            .cut()
            .close()

        return true
    },
})
