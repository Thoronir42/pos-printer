import { command, create } from "@md/cli";
import { runRewind } from "../bot/rewind.ts";
import type { AppContext } from "../utils/context.ts";
import { createContext } from "../utils/context.ts";
import { createLogger } from "../utils/logger.ts";
import { getPrinterSelection, parseWidthMm } from "./flags.ts";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDateFlag(value: unknown, flagName: string, opts?: { endOfDay?: boolean }) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`--${flagName} is required (date or ISO timestamp)`);
    }

    // For a bare date, treat the boundary as the whole day so ranges are inclusive.
    const normalized = DATE_ONLY_PATTERN.test(value)
        ? `${value}T${opts?.endOfDay ? "23:59:59.999" : "00:00:00.000"}`
        : value;

    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`--${flagName} is not a valid date: ${value}`);
    }

    return date;
}

export const cmd = command({
    description: "Replay previously archived media (from POS_HISTORY_PRINTS) within a date range",
    arguments: [],
    flags: {
        from: { type: "value", required: true, description: "Start of range (YYYY-MM-DD or ISO timestamp)" },
        to: { type: "value", required: true, description: "End of range, inclusive (YYYY-MM-DD or ISO timestamp)" },
        dry: { type: "boolean", short: "d", description: "List sender and media names without printing (no printer required)" },
        locale: { type: "value", description: "Locale passed to the print-image task" },
        printerId: { type: "value", description: "Printer selection id passed to the print-image task" },
        widthMm: { type: "value", description: "Printed image width in mm (defaults to 72)" },
    },
}).runner(async (_arguments, flags) => {
    const ctx: AppContext = createContext(createLogger({ mode: "telegram-rewind" }));

    const signalController = new AbortController();
    const handleSignal = () => {
        if (!signalController.signal.aborted) {
            ctx.logger.info("Stopping rewind...");
            signalController.abort();
        }
    };

    const from = parseDateFlag(flags.from, "from");
    const to = parseDateFlag(flags.to, "to", { endOfDay: true });
    if (from > to) {
        throw new Error("--from must not be after --to");
    }

    const locale = typeof flags.locale === "string" ? flags.locale : undefined;
    const widthMm = parseWidthMm(flags.widthMm);

    Deno.addSignalListener("SIGINT", handleSignal);
    Deno.addSignalListener("SIGTERM", handleSignal);

    try {
        await runRewind(ctx, {
            locale,
            printer: getPrinterSelection(flags.printerId),
            widthMm,
            from,
            to,
            dry: flags.dry,
            signal: signalController.signal,
        });
    } finally {
        Deno.removeSignalListener("SIGINT", handleSignal);
        Deno.removeSignalListener("SIGTERM", handleSignal);
    }
});

if (import.meta.main) {
    create("bot-rewind", { cmd }).run(["cmd", ...Deno.args]);
}
