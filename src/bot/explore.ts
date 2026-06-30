import { Buffer } from "node:buffer";
import { Application, Router } from "@oak/oak";
import { AppError } from "../AppError.ts";
import printImageAction from "../printTasks/print-image.ts";
import type { AppContext } from "../utils/context.ts";
import { getImageMimeType } from "../utils/image.ts";
import { getHistoryBaseDir, listDayMedia, listHistoryDays } from "../utils/imageStorage.ts";
import type { PrinterSelection } from "../utils/printer.ts";
import { createPrintLimiter, type PrintLimiter } from "./printLimiter.ts";

const DEFAULT_EXPLORE_PRINT_WIDTH_MM = 72;

export type ExploreOptions = {
    port: number,
    hostname: string,
    printer?: PrinterSelection,
    locale?: string,
    widthMm?: number,
    signal?: AbortSignal,
};

/** Rejects path segments that are empty or could escape the archive directory. */
function isSafeSegment(segment: string): boolean {
    return segment !== "" && !segment.includes("/") && !segment.includes("\\") && segment !== "." && !segment.includes("..");
}

/** Resolves the on-disk path for a (day, file) pair, or null if it is unsafe. */
function resolveMediaPath(day: string, file: string): string | null {
    if (!isSafeSegment(day) || !isSafeSegment(file)) {
        return null;
    }

    return `${getHistoryBaseDir()}/${day}/${file}`;
}

export function runExplore(ctx: AppContext, opts: ExploreOptions): Promise<void> {
    // Fail fast if the archive directory is not configured.
    getHistoryBaseDir();

    const limiter: PrintLimiter = createPrintLimiter();
    const router = new Router();

    router.get("/", async (routeCtx) => {
        const html = await Deno.readTextFile(`${import.meta.dirname}/explore.html`);
        routeCtx.response.headers.set("content-type", "text/html; charset=utf-8");
        routeCtx.response.body = html;
    });

    router.get("/api/days", (routeCtx) => {
        routeCtx.response.type = "json";
        routeCtx.response.body = { days: listHistoryDays() };
    });

    // day/file travel as query params (not path segments) so the root day (`""`)
    // does not collapse into an unmatched empty path segment.
    router.get("/api/media", async (routeCtx) => {
        const day = routeCtx.request.url.searchParams.get("day") ?? "";
        if (!isSafeSegment(day)) {
            routeCtx.response.status = 400;
            routeCtx.response.body = { error: "invalid-day" };
            return;
        }

        const media = (await listDayMedia(day)).map((entry) => ({
            ...entry,
            url: `/api/file?day=${encodeURIComponent(day)}&file=${encodeURIComponent(entry.file)}`,
        }));
        routeCtx.response.type = "json";
        routeCtx.response.body = { media };
    });

    router.get("/api/file", async (routeCtx) => {
        const day = routeCtx.request.url.searchParams.get("day") ?? "";
        const file = routeCtx.request.url.searchParams.get("file") ?? "";
        const path = resolveMediaPath(day, file);
        if (!path) {
            routeCtx.response.status = 400;
            routeCtx.response.body = { error: "invalid-path" };
            return;
        }

        let bytes: Uint8Array;
        try {
            bytes = await Deno.readFile(path);
        } catch {
            routeCtx.response.status = 404;
            routeCtx.response.body = { error: "not-found" };
            return;
        }

        routeCtx.response.headers.set("content-type", getImageMimeType(file, null) ?? "application/octet-stream");
        routeCtx.response.body = bytes;
    });

    router.post("/api/print", async (routeCtx) => {
        const body = await routeCtx.request.body.json().catch(() => null) as { day?: string, file?: string } | null;
        const day = typeof body?.day === "string" ? body.day : "";
        const file = typeof body?.file === "string" ? body.file : "";
        const path = resolveMediaPath(day, file);
        if (!path || !file) {
            routeCtx.response.status = 400;
            routeCtx.response.body = { error: "invalid-path" };
            return;
        }

        try {
            const bytes = await Deno.readFile(path);
            const mimeType = getImageMimeType(file, null);
            if (!mimeType) {
                throw new Error(`Cannot determine mime type for ${file}`);
            }

            const imageDataUrl = `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;

            // Serialize prints so rapid clicks queue instead of colliding at the printer.
            await limiter.schedule(() =>
                printImageAction.run(ctx, {
                    imageDataUrl,
                    locale: opts.locale,
                    printer: opts.printer,
                    widthMm: opts.widthMm ?? DEFAULT_EXPLORE_PRINT_WIDTH_MM,
                    dither: true,
                    saveHistory: false,
                })
            );

            routeCtx.response.type = "json";
            routeCtx.response.body = { ok: true };
        } catch (error) {
            const message = error instanceof AppError
                ? `${error.code}${error.details ? `: ${JSON.stringify(error.details)}` : ""}`
                : error instanceof Error
                ? error.message
                : String(error);
            ctx.logger.error("Explore print failed", { file, error: message });
            routeCtx.response.status = 500;
            routeCtx.response.type = "json";
            routeCtx.response.body = { error: "print-failed", message };
        }
    });

    const app = new Application();
    app.use(router.routes());
    app.use(router.allowedMethods());

    app.addEventListener("listen", (e) => {
        ctx.logger.info(`Explore server running on http://${e.hostname}:${e.port}/`);
    });

    return app.listen({ port: opts.port, hostname: opts.hostname, signal: opts.signal });
}
