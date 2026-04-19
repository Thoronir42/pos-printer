import { command, create } from "@md/cli";
import { runTelegramBot } from "../bot/telegram.ts";
import type { AppContext } from "../utils/context.ts";
import { createContext } from "../utils/context.ts";
import { createLogger } from "../utils/logger.ts";
import type { PrinterSelection } from "../utils/printer.ts";

function parseWidthMm(value: unknown) {
    if (value == null || value === "") {
        return undefined;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 120) {
        throw new Error("widthMm must be a number between 1 and 120");
    }

    return parsed;
}

function getPrinterSelection(printerId: unknown): PrinterSelection | undefined {
    if (typeof printerId !== "string" || printerId.length === 0) {
        return undefined;
    }

    return { id: printerId };
}

export const cmd = command({
    description: "Run the application in Telegram bot mode",
    arguments: [],
    flags: {
        token: { type: "value", description: "Telegram bot token, defaults to TELEGRAM_BOT_TOKEN" },
        locale: { type: "value", description: "Locale passed to the print-image task" },
        printerId: { type: "value", description: "Printer selection id passed to the print-image task" },
        widthMm: { type: "value", description: "Printed image width in mm (defaults to 72 in bot mode)" },
        pollingTimeoutSeconds: { type: "value", description: "Telegram long-poll timeout in seconds" },
    },
}).runner(async (_arguments, flags) => {
    const ctx: AppContext = createContext(createLogger({ mode: "telegram-bot" }));

    const signalController = new AbortController();
    const handleSignal = () => {
        if (!signalController.signal.aborted) {
            ctx.logger.info("Stopping Telegram bot...");
            signalController.abort();
        }
    };

    const token = String(flags.token ?? Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "").trim();
    if (!token) {
        throw new Error("Telegram bot token is required via --token or TELEGRAM_BOT_TOKEN");
    }

    const locale = typeof flags.locale === "string" ? flags.locale : undefined;
    const printerId = flags.printerId
    const widthMm = parseWidthMm(flags.widthMm);
    const pollingTimeoutSeconds = Number(flags.pollingTimeoutSeconds ?? "");

    Deno.addSignalListener("SIGINT", handleSignal);
    Deno.addSignalListener("SIGTERM", handleSignal);

    try {
        await runTelegramBot(ctx, {
            token,
            locale,
            printer: getPrinterSelection(printerId),
            widthMm,
            pollingTimeoutSeconds,
            signal: signalController.signal,
        });
    } finally {
        Deno.removeSignalListener("SIGINT", handleSignal);
        Deno.removeSignalListener("SIGTERM", handleSignal);
    }
});

if (import.meta.main) {
    create("bot", { cmd }).run(["cmd", ...Deno.args]);
}
