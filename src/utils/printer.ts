import { Buffer } from "node:buffer";
import escpos from "escpos";

type UsbDeviceDescriptor = {
    idVendor?: number,
    idProduct?: number,
}

type UsbDevice = {
    deviceDescriptor?: UsbDeviceDescriptor,
    busNumber?: number,
    deviceAddress?: number,
}

type UsbAdapter = {
    open: (callback?: (err?: Error | null) => void) => UsbAdapter,
    write: (data: Buffer, callback?: (err?: Error | null) => void) => UsbAdapter,
    close: (callback?: (err?: Error | null) => void) => UsbAdapter,
}

type UsbConstructor = {
    new (device?: string | UsbDevice, pid?: string): UsbAdapter,
    findPrinter: () => UsbDevice[],
}

type EscposPrinter = escpos.Printer & {
    setCharacterCodeTable: (codeTable: number) => EscposPrinter,
}

const EscposUsb = (await import("../../lib/escpos-usb/index.cjs")).default as unknown as UsbConstructor;

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

export type PrinterInfo = {
    id: string,
    vendorId: number,
    productId: number,
    busNumber: number | null,
    deviceAddress: number | null,
}

export type PrinterSelection = {
    id: string,
}

function getPrinterIdentityParts(id: string) {
    const [vendorId, productId, busNumber, deviceAddress] = id.split(':')
    return {
        vendorId,
        productId,
        busNumber,
        deviceAddress,
    }
}

function describePrinter(device: UsbDevice): PrinterInfo | null {
    const vendorId = device.deviceDescriptor?.idVendor
    const productId = device.deviceDescriptor?.idProduct
    if (vendorId == null || productId == null) {
        return null
    }

    const busNumber = device.busNumber ?? null
    const deviceAddress = device.deviceAddress ?? null
    return {
        id: [vendorId, productId, busNumber ?? 0, deviceAddress ?? 0].join(':'),
        vendorId,
        productId,
        busNumber,
        deviceAddress,
    }
}

function matchesPrinterSelection(device: UsbDevice, selection?: PrinterSelection) {
    if (!selection) {
        return true
    }

    const printerInfo = describePrinter(device)
    if (!printerInfo) {
        return false
    }

    if (printerInfo.id === selection.id) {
        return true
    }

    const selected = getPrinterIdentityParts(selection.id)
    return String(printerInfo.vendorId) === selected.vendorId
        && String(printerInfo.productId) === selected.productId
}

function selectPrinterDevice(selection?: PrinterSelection) {
    const printers = EscposUsb.findPrinter()
    if (printers.length === 1) {
        return printers[0]
    }

    if (!selection) {
        return printers[0] ?? null
    }

    const exactMatch = printers.find((device) => matchesPrinterSelection(device, selection))
    if (exactMatch) {
        return exactMatch
    }

    const selected = getPrinterIdentityParts(selection.id)
    const vendorProductMatches = printers.filter((device) => {
        const printerInfo = describePrinter(device)
        if (!printerInfo) {
            return false
        }

        return String(printerInfo.vendorId) === selected.vendorId
            && String(printerInfo.productId) === selected.productId
    })

    if (vendorProductMatches.length === 1) {
        return vendorProductMatches[0]
    }

    return null
}

export function listPrinters(): PrinterInfo[] {
    return EscposUsb.findPrinter()
        .map(describePrinter)
        .filter((printer): printer is PrinterInfo => printer !== null)
}

type PrinterOptions = {
    locale?: string,
    selection?: PrinterSelection,
}

export async function getPrinter(opts: PrinterOptions = {}) {
    const selectedDevice = selectPrinterDevice(opts.selection)
    if (!selectedDevice) {
        return null
    }

    const device = new EscposUsb(selectedDevice)
    const printer = new escpos.Printer(device) as EscposPrinter

    if (opts.locale) {
        applyMappingForLocale(printer, opts.locale)
    }

    await new Promise<void>((resolve, reject) => {
        device.open((err?: Error | null) => {
            if (err) {
                reject(err)
                return
            }
            resolve()
        })
    })
    return printer
}

export async function flushPrinter(printer: escpos.Printer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        printer.flush((err?: Error | null) => {
            if (err) {
                reject(err)
                return
            }
            resolve()
        })
    })
}

export async function closePrinter(printer: escpos.Printer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        printer.close((err?: Error | null) => {
            if (err) {
                reject(err)
                return
            }
            resolve()
        })
    })
}

export function isPrinterAccessError(error: unknown) {
    return error instanceof Error && error.message.includes('LIBUSB_ERROR_ACCESS')
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
    printer: EscposPrinter,
    mapping: string | ReturnType<typeof getMappingForLocale>,
) {
    if (typeof mapping === 'string') mapping = getMappingForLocale(mapping)
    printer
        .setCharacterCodeTable(mapping.codeTable)
        .encode(mapping.encoding)

    return mapping
}
