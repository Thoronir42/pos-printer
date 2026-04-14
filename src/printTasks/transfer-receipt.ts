import { AppError } from "../AppError.ts";
import { defineAction } from "../dataDriven/actionRunner.ts";
import { closePrinter, flushPrinter, getPrinter, isPrinterAccessError, type PrinterSelection } from "../utils/printer.ts";

const dpiMode = 'S8' as const
const headerImage = await (async () => {
    const header = Deno.env.get("POS_PRINTER_HEADER_IMG")
    if (!header) return null
    const { loadImage } = await import("../utils/printer.ts")
    return loadImage(header, { width: 60, dpiMode })
})()

type Params = {
    locale: string,
    attendee: string,
    date: string,
    headerImg: false,
    printer?: PrinterSelection,
}
export default defineAction({
    schema: {
        type: "object",
        properties: {
            locale: { type: "string", minLength: 2, maxLength: 2 },
            attendee: { type: "string", minLength: 1 },
            date: { type: "string", minLength: 1 },
            headerImg: { type: "boolean" },
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
            'locale',
            'attendee',
            "date",
        ],
        additionalProperties: false,
    },

    run: async (params: Params) => {
        let printer
        try {
            printer = await getPrinter({locale: params.locale, selection: params.printer})
        } catch (error) {
            if (isPrinterAccessError(error)) {
                throw new AppError('access-denied', {subject: 'printer', reason: 'usb-access-denied'})
            }

            throw error
        }

        if (!printer) {
            throw new AppError('not-found', {subject: 'printer'})
        }

        if (headerImage && params.headerImg !== false) {
            printer
                .align('CT')
                .raster(headerImage, 'normal')
            printer.align('LT')
        }
        printer
            .style('BU').size(2, 2)
            .text('Artshow Overview\n')
        printer
            .size(1, 1)
            .style('NORMAL').text(`Attendee:\t${params.attendee}`)
            .style('NORMAL').text(`Date:\t${params.date}`)

        // make horizontal line
        printer.align('CT').text('--------------------------------\n').align('LT')

        printer
            .feed(3)
            .cut()

        await flushPrinter(printer)
        await closePrinter(printer)

        // printer
        //     .align("CT")
        //     .style("B")
        //     .size(1, 1)
        //     .text(params.text)
        //     .feed(3)
        //     .cut()
        //     .close()

        return true
    },
})
