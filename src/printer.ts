import { Buffer } from "node:buffer";
import escpos from "escpos";
import { Resvg, type ResvgRenderOptions } from "@resvg/resvg-js";
escpos.USB = (await import("../lib/escpos-usb/index.cjs")).default;

function loadImageFromBuffer(buffer: Buffer, mimeType: string): Promise<InstanceType<typeof escpos.Image>> {
    const dataUri = `data:${mimeType};base64,${buffer.toString('base64')}`
    return new Promise((resolve, reject) => {
        escpos.Image.load(dataUri, (result: Error | InstanceType<typeof escpos.Image>) => {
            if (result instanceof Error) {
                reject(result);
            } else {
                resolve(result);
            }
        });
    });
}

const DpiMode = {
    's8': 90,
    'd24': 180,
}
type LoadImageOpts = {
    /** Width in mm */
    width?: number,
    dpiMode?: keyof typeof DpiMode,
}
export async function loadImage(path: string, opts?: LoadImageOpts): Promise<InstanceType<typeof escpos.Image>> {
    if (path.endsWith('.svg')) {
        const svgData = await Deno.readTextFile(path)
        const resvgOpts: ResvgRenderOptions = {}

        if (opts?.width) {
            const effectiveDpi = DpiMode[opts.dpiMode || 's8'] || 90
            resvgOpts.fitTo = {
                mode: 'width',
                value: Math.round(opts.width * effectiveDpi / 25.4),
            }
        }

        const pngData = new Resvg(svgData, resvgOpts)
            .render()
        const pngBuffer = pngData.asPng()
        console.log(pngData.width, pngData.height)
        return loadImageFromBuffer(Buffer.from(pngBuffer), 'image/png')
    }

    return new Promise((resolve, reject) => {
        escpos.Image.load(path, (result: Error | InstanceType<typeof escpos.Image>) => {
            if (result instanceof Error) {
                reject(result);
            } else {
                resolve(result);
            }
        });
    });
}

const codePageMappings = [
    { codeTable: 18, encoding: 'CP852', name: 'CP852 (Latin-2 DOS)', locales: ['cs'] },
    { codeTable: 46, encoding: 'win1250', name: 'Windows-1250 (CE)' },
    
    // Western European
    { codeTable: 0, encoding: 'CP437', name: 'CP437 (US)' },
    { codeTable: 2, encoding: 'CP850', name: 'CP850 (Multilingual)' },
    { codeTable: 16, encoding: 'win1252', name: 'Windows-1252 (Latin-1)' },
    
    // ISO variants
    { codeTable: 15, encoding: 'ISO-8859-1', name: 'ISO-8859-1 (Latin-1)' },
    { codeTable: 47, encoding: 'ISO-8859-2', name: 'ISO-8859-2 (Latin-2)' },
]

type PrinterOptions = {
    locale?: string,
}
export async function getPrinter(opts: PrinterOptions = {}) {
  try {
      const device = new escpos.USB()
      const printer = new escpos.Printer(device)

      if (opts.locale) {
        applyMappingForLocale(printer, opts.locale)
      }

      await new Promise<void>((resolve) => device.open(() => resolve()))
      return printer
  } catch (e) {
    return null
  }
}

export function getMappingForLocale(locale: string) {
    for (const mapping of codePageMappings) {
        if (mapping.locales?.includes(locale)) {
            return mapping
        }
    }

    return codePageMappings[0]
}
export function applyMappingForLocale(
    printer: escpos.Printer,
    mapping: string | ReturnType<typeof getMappingForLocale>,
) {
    if (typeof mapping === 'string') mapping = getMappingForLocale(mapping)
    printer
        .setCharacterCodeTable(mapping.codeTable)
        .encode(mapping.encoding)

    return mapping
}
