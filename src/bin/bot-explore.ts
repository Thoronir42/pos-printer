import { command, create } from "@md/cli";
import { runExplore } from "../bot/explore.ts";
import type { AppContext } from "../utils/context.ts";
import { createContext } from "../utils/context.ts";
import { createLogger } from "../utils/logger.ts";
import { getPrinterSelection, parseWidthMm } from "./flags.ts";

const DEFAULT_PORT = 4545;

function parsePort(value: unknown) {
    if (value == null || value === "") {
        return DEFAULT_PORT;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error("port must be an integer between 1 and 65535");
    }

    return parsed;
}

export const cmd = command({
    description: "Browse archived media (from POS_HISTORY_PRINTS) in a web gallery and reprint on demand",
    arguments: [],
    flags: {
        port: { type: "value", description: "Port to serve on (defaults to 4545)" },
        locale: { type: "value", description: "Locale passed to the print-image task" },
        printerId: { type: "value", description: "Printer selection id passed to the print-image task" },
        widthMm: { type: "value", description: "Reprinted image width in mm (defaults to 72)" },
    },
}).runner(async (_arguments, flags) => {
    const ctx: AppContext = createContext(createLogger({ mode: "telegram-explore" }));

    const signalController = new AbortController();
    const handleSignal = () => {
        if (!signalController.signal.aborted) {
            ctx.logger.info("Stopping explore server...");
            signalController.abort();
        }
    };

    const port = parsePort(flags.port);
    const locale = typeof flags.locale === "string" ? flags.locale : undefined;
    const widthMm = parseWidthMm(flags.widthMm);

    Deno.addSignalListener("SIGINT", handleSignal);
    Deno.addSignalListener("SIGTERM", handleSignal);

    try {
        await runExplore(ctx, {
            port,
            hostname: "0.0.0.0",
            locale,
            printer: getPrinterSelection(flags.printerId),
            widthMm,
            signal: signalController.signal,
        });
    } finally {
        Deno.removeSignalListener("SIGINT", handleSignal);
        Deno.removeSignalListener("SIGTERM", handleSignal);
    }
});

if (import.meta.main) {
    create("bot-explore", { cmd }).run(["cmd", ...Deno.args]);
}
