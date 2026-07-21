import type { AppContext } from "../utils/context.ts";
import { getHistoryDir, getHistoryUsage } from "../utils/imageStorage.ts";

/** Human-readable byte size (binary units). */
function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return "?";
    }

    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }

    const rounded = unit === 0 ? String(value) : value.toFixed(1);
    return `${rounded} ${units[unit]}`;
}

type Filesystem = {
    totalBytes: number,
    usedBytes: number,
    availableBytes: number,
    usedPercent: number,
};

/**
 * Reads the filesystem totals for the partition holding `path` via `df -Pk`.
 * Returns null when `df` is unavailable or its output cannot be parsed, so the
 * report can still show the archive size on its own.
 */
async function readFilesystem(ctx: AppContext, path: string): Promise<Filesystem | null> {
    try {
        const { success, stdout } = await new Deno.Command("df", {
            args: ["-Pk", path],
            stdout: "piped",
            stderr: "null",
        }).output();

        if (!success) {
            return null;
        }

        // POSIX (`-P`) prints one data line per filesystem after the header:
        // Filesystem 1024-blocks Used Available Capacity Mounted-on
        const lines = new TextDecoder().decode(stdout).trim().split("\n");
        const dataLine = lines.at(-1);
        if (!dataLine || lines.length < 2) {
            return null;
        }

        const columns = dataLine.trim().split(/\s+/);
        const totalKib = Number(columns.at(-5));
        const usedKib = Number(columns.at(-4));
        const availableKib = Number(columns.at(-3));
        if (![totalKib, usedKib, availableKib].every(Number.isFinite)) {
            return null;
        }

        const totalBytes = totalKib * 1024;
        return {
            totalBytes,
            usedBytes: usedKib * 1024,
            availableBytes: availableKib * 1024,
            usedPercent: totalBytes > 0 ? Math.round((usedKib / totalKib) * 100) : 0,
        };
    } catch (error) {
        ctx.logger.warn("Could not read filesystem usage", {
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}

/**
 * Builds the janitor disk-usage report: how much space the print archive
 * consumes plus the free space on the partition holding it.
 */
export async function buildDiskReport(ctx: AppContext): Promise<string> {
    // The archive is opt-in (POS_HISTORY_PRINTS). When it is unset, still report
    // free space for the working directory instead of failing the command.
    const baseDir = getHistoryDir();

    const lines = ["🗃 Print archive"];
    if (baseDir) {
        const usage = await getHistoryUsage();
        lines.push(
            `• Size: ${formatBytes(usage.totalBytes)}`,
            `• Files: ${usage.fileCount} across ${usage.dayCount} day(s)`,
            `• Path: ${baseDir}`,
        );
    } else {
        lines.push("• Not configured — set POS_HISTORY_PRINTS to archive prints");
    }

    // df the archive dir when configured, otherwise the working directory; fall
    // back to the working directory if the archive dir does not exist yet.
    const fs = (await readFilesystem(ctx, baseDir ?? ".")) ??
        (baseDir ? await readFilesystem(ctx, ".") : null);
    if (fs) {
        lines.push(
            "",
            "💾 Disk",
            `• Used: ${formatBytes(fs.usedBytes)} / ${formatBytes(fs.totalBytes)} (${fs.usedPercent}%)`,
            `• Free: ${formatBytes(fs.availableBytes)}`,
        );
    } else {
        lines.push("", "💾 Disk: unavailable (df failed)");
    }

    return lines.join("\n");
}
