import { Buffer } from "node:buffer";
import escpos from "escpos";
import { Resvg, type ResvgRenderOptions } from "@resvg/resvg-js";

const DpiMode = {
    'S8': 90,
    'D24': 180,
}

const THERMAL_PRINTER_DPI = 203

function getEffectiveDpi(dpiMode: keyof typeof DpiMode | undefined) {
    return DpiMode[dpiMode || 'S8'] || 90
}

function widthMmToPixels(widthMm: number) {
    return Math.max(1, Math.round(widthMm * THERMAL_PRINTER_DPI / 25.4))
}

export type LoadImageOpts = {
    /** Width in mm */
    width?: number,
    dpiMode?: keyof typeof DpiMode,
}

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

function renderSvgToImage(svgData: string, opts?: LoadImageOpts): Promise<InstanceType<typeof escpos.Image>> {
    const resvgOpts: ResvgRenderOptions = {}

    if (opts?.width) {
        const effectiveDpi = getEffectiveDpi(opts.dpiMode)
        resvgOpts.fitTo = {
            mode: 'width',
            value: Math.round(opts.width * effectiveDpi / 25.4),
        }
    }

    const pngData = new Resvg(svgData, resvgOpts)
        .render()
    const pngBuffer = pngData.asPng()
    return loadImageFromBuffer(Buffer.from(pngBuffer), 'image/png')
}

export function parseDataUri(dataUri: string): { mimeType: string, buffer: Buffer } | null {
    const match = dataUri.match(/^data:([^;,]+)(;base64)?,(.*)$/s)
    if (!match) {
        return null
    }

    const [, mimeType, isBase64, payload] = match
    if (isBase64) {
        return {
            mimeType,
            buffer: Buffer.from(payload, 'base64'),
        }
    }

    return {
        mimeType,
        buffer: Buffer.from(decodeURIComponent(payload), 'utf8'),
    }
}

type ImageDimensions = {
    width: number,
    height: number,
}

function getPngDimensions(buffer: Buffer): ImageDimensions | null {
    if (buffer.length < 24) {
        return null
    }

    const pngSignature = '89504e470d0a1a0a'
    if (buffer.subarray(0, 8).toString('hex') !== pngSignature) {
        return null
    }

    return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
    }
}

function getGifDimensions(buffer: Buffer): ImageDimensions | null {
    if (buffer.length < 10) {
        return null
    }

    const header = buffer.subarray(0, 6).toString('ascii')
    if (header !== 'GIF87a' && header !== 'GIF89a') {
        return null
    }

    return {
        width: buffer.readUInt16LE(6),
        height: buffer.readUInt16LE(8),
    }
}

function getJpegDimensions(buffer: Buffer): ImageDimensions | null {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
        return null
    }

    let offset = 2
    while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
            offset += 1
            continue
        }

        const marker = buffer[offset + 1]
        const segmentLength = buffer.readUInt16BE(offset + 2)
        if (segmentLength < 2 || offset + 2 + segmentLength > buffer.length) {
            return null
        }

        const isStartOfFrame = marker === 0xc0
            || marker === 0xc1
            || marker === 0xc2
            || marker === 0xc3
            || marker === 0xc5
            || marker === 0xc6
            || marker === 0xc7
            || marker === 0xc9
            || marker === 0xca
            || marker === 0xcb
            || marker === 0xcd
            || marker === 0xce
            || marker === 0xcf

        if (isStartOfFrame) {
            return {
                height: buffer.readUInt16BE(offset + 5),
                width: buffer.readUInt16BE(offset + 7),
            }
        }

        offset += 2 + segmentLength
    }

    return null
}

function getWebpDimensions(buffer: Buffer): ImageDimensions | null {
    if (buffer.length < 30) {
        return null
    }

    if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WEBP') {
        return null
    }

    const chunkType = buffer.subarray(12, 16).toString('ascii')
    if (chunkType === 'VP8X' && buffer.length >= 30) {
        return {
            width: 1 + buffer.readUIntLE(24, 3),
            height: 1 + buffer.readUIntLE(27, 3),
        }
    }

    if (chunkType === 'VP8 ' && buffer.length >= 30) {
        return {
            width: buffer.readUInt16LE(26) & 0x3fff,
            height: buffer.readUInt16LE(28) & 0x3fff,
        }
    }

    if (chunkType === 'VP8L' && buffer.length >= 25) {
        const b0 = buffer[21]
        const b1 = buffer[22]
        const b2 = buffer[23]
        const b3 = buffer[24]
        return {
            width: ((b1 & 0x3f) << 8 | b0) + 1,
            height: ((b3 & 0x0f) << 10 | b2 << 2 | (b1 >> 6)) + 1,
        }
    }

    return null
}

function getImageDimensions(buffer: Buffer, mimeType: string): ImageDimensions | null {
    switch (mimeType.toLowerCase()) {
        case 'image/png':
            return getPngDimensions(buffer)
        case 'image/jpeg':
        case 'image/jpg':
            return getJpegDimensions(buffer)
        case 'image/gif':
            return getGifDimensions(buffer)
        case 'image/webp':
            return getWebpDimensions(buffer)
        default:
            return null
    }
}

export function extensionFromMimeType(mimeType: string): string {
    const mapping: Record<string, string> = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/svg+xml": "svg",
        "application/pdf": "pdf",
    };

    const mapped = mapping[mimeType.toLowerCase()];
    if (mapped) {
        return mapped;
    }

    const subtype = mimeType.split("/")[1] ?? "bin";
    return subtype.split("+")[0].replace(/[^a-z0-9]/gi, "") || "bin";
}

function escapeAttribute(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
}

function resizeRasterBufferToWidth(buffer: Buffer, mimeType: string, opts?: LoadImageOpts): Buffer {
    if (!opts?.width) {
        return buffer
    }

    const sourceDimensions = getImageDimensions(buffer, mimeType)
    if (!sourceDimensions || sourceDimensions.width <= 0 || sourceDimensions.height <= 0) {
        return buffer
    }

    const targetWidthPx = widthMmToPixels(opts.width)
    const targetHeightPx = Math.max(1, Math.round(sourceDimensions.height * targetWidthPx / sourceDimensions.width))
    const sourceDataUri = `data:${mimeType};base64,${buffer.toString('base64')}`

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${targetWidthPx}" height="${targetHeightPx}" viewBox="0 0 ${targetWidthPx} ${targetHeightPx}"><image href="${escapeAttribute(sourceDataUri)}" width="${targetWidthPx}" height="${targetHeightPx}" preserveAspectRatio="none"/></svg>`
    return Buffer.from(new Resvg(svg).render().asPng())
}

export function loadImageFromDataUri(dataUri: string, opts?: LoadImageOpts): Promise<InstanceType<typeof escpos.Image>> {
    const parsed = parseDataUri(dataUri)
    if (!parsed) {
        throw new Error('Invalid image data URI')
    }

    if (parsed.mimeType === 'image/svg+xml') {
        return renderSvgToImage(parsed.buffer.toString('utf8'), opts)
    }

    const resizedBuffer = resizeRasterBufferToWidth(parsed.buffer, parsed.mimeType, opts)
    return loadImageFromBuffer(resizedBuffer, 'image/png')
}

export async function loadImage(path: string, opts?: LoadImageOpts): Promise<InstanceType<typeof escpos.Image>> {
    if (path.endsWith('.svg')) {
        const svgData = await Deno.readTextFile(path)
        return renderSvgToImage(svgData, opts)
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
