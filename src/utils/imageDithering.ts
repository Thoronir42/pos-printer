import escpos from "escpos";

type EscposImageInternal = InstanceType<typeof escpos.Image> & {
    data: number[],
    pixels: {
        data: ArrayLike<number>,
        shape: [number, number, number],
    },
}

function getImageShape(image: EscposImageInternal) {
    const [width, height, colors] = image.pixels.shape;
    return { width, height, colors };
}

function buildPerPixelLuminance(image: EscposImageInternal, width: number, height: number, colors: number) {
    const rgba = image.pixels.data;
    const luminance = new Float32Array(width * height);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pixelOffset = (y * width + x) * colors;
            const alpha = colors > 3 ? rgba[pixelOffset + 3] ?? 255 : 255;
            const index = y * width + x;

            if (alpha === 0) {
                luminance[index] = 255;
                continue;
            }

            const red = rgba[pixelOffset] ?? 255;
            const green = rgba[pixelOffset + 1] ?? 255;
            const blue = rgba[pixelOffset + 2] ?? 255;
            luminance[index] = 0.299 * red + 0.587 * green + 0.114 * blue;
        }
    }

    return luminance;
}

function diffuseErrorToNeighbors(
    luminance: Float32Array,
    width: number,
    height: number,
    x: number,
    y: number,
    quantizationError: number,
) {
    const index = y * width + x;

    if (x + 1 < width) {
        luminance[index + 1] += quantizationError * (7 / 16);
    }

    if (y + 1 >= height) {
        return;
    }

    if (x > 0) {
        luminance[index + width - 1] += quantizationError * (3 / 16);
    }

    luminance[index + width] += quantizationError * (5 / 16);

    if (x + 1 < width) {
        luminance[index + width + 1] += quantizationError * (1 / 16);
    }
}

function ditherLuminanceToEscposBinary(luminance: Float32Array, width: number, height: number) {
    const binary = new Array<number>(width * height).fill(0);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = y * width + x;
            const oldValue = luminance[index];
            const newValue = oldValue >= 128 ? 255 : 0;
            const quantizationError = oldValue - newValue;

            binary[index] = newValue === 255 ? 0 : 1;
            diffuseErrorToNeighbors(luminance, width, height, x, y, quantizationError);
        }
    }

    return binary;
}

export function applyFloydSteinbergDithering(image: InstanceType<typeof escpos.Image>): InstanceType<typeof escpos.Image> {
    const internal = image as EscposImageInternal;
    const { width, height, colors } = getImageShape(internal);
    if (width < 1 || height < 1 || colors < 3) {
        return image;
    }

    const luminance = buildPerPixelLuminance(internal, width, height, colors);
    internal.data = ditherLuminanceToEscposBinary(luminance, width, height);
    return image;
}
