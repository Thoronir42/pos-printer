import type { AppContext } from "./context.ts";
import { extensionFromMimeType, parseDataUri } from "./image.ts";

function formatHistoryFileName(date: Date, extension: string) {
    return `${date.toISOString().replace(/:/g, "-")}.${extension}`;
}

function formatDayDirectory(date: Date) {
    return date.toISOString().slice(0, 10);
}

export async function saveToHistoryPrints(ctx: AppContext, dataUri: string): Promise<void> {
    const historyDir = Deno.env.get("POS_HISTORY_PRINTS");
    if (!historyDir) {
        return;
    }

    const parsed = parseDataUri(dataUri);
    if (!parsed) {
        return;
    }

    const now = new Date();
    const extension = extensionFromMimeType(parsed.mimeType);
    const baseDirPath = historyDir.replace(/\/+$/, "");
    const dayDirectory = formatDayDirectory(now);
    const dirPath = `${baseDirPath}/${dayDirectory}`;
    const filePath = `${dirPath}/${formatHistoryFileName(now, extension)}`;

    await Deno.mkdir(dirPath, { recursive: true });
    await Deno.writeFile(filePath, new Uint8Array(parsed.buffer));

    ctx.logger.debug("Saved print image history", { filePath });
}
