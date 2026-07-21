import type { PrinterSelection } from "../utils/printer.ts";

/** Parses the shared `--widthMm` CLI flag (1–120 mm, undefined when unset). */
export function parseWidthMm(value: unknown) {
    if (value == null || value === "") {
        return undefined;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 120) {
        throw new Error("widthMm must be a number between 1 and 120");
    }

    return parsed;
}

/** Parses the shared `--printerId` CLI flag into a printer selection. */
export function getPrinterSelection(printerId: unknown): PrinterSelection | undefined {
    if (typeof printerId !== "string" || printerId.length === 0) {
        return undefined;
    }

    return { id: printerId };
}
