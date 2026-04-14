import { applyMappingForLocale, getPrinter } from "../utils/printer.ts";
import { command, create } from "@md/cli";

export const cmd = command({
    description: "Test printing of given text with various code pages",
    arguments: ['text'],
    flags: {
        locale: { type: 'value', description: 'Locale to select code page mapping', },
    }
}).runner(async ([text], flags) => {
    const printer = await getPrinter()
    if (!printer) {
        throw new Error('No printer found')
    }

    const locale = flags.locale || 'cs'
    const mapping = applyMappingForLocale(printer, locale)

    printer.align('CT')
        .text(`--- [${locale}] Codetable ${mapping.codeTable} ---`)
        .align('LT')

    printer
        .font('B').text(`${mapping.encoding}`)
        .font('A').text(text)
    printer.control('CR')

    await new Promise<void>((resolve) => printer.flush(() => resolve()))

    printer
        .barcode('000000670000', 'EAN13', { width: 3, height: 40, position: 'OFF', font: 'A', includeParity: false })
        .cut()

    await new Promise<void>((resolve) => printer.flush(() => resolve()))

    printer.close()
    console.log("Done")
})

if (import.meta.main) {
    create('print-encodings-cli', { cmd }).run(['cmd', ...Deno.args])
}
