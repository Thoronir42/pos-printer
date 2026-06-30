import Bottleneck from "bottleneck";

/**
 * Assumed duration of a single print task.
 *
 * This is a placeholder used to space tasks apart so the printer (and the
 * Telegram API) are not flooded. Eventually we may want to replace the fixed
 * delay with an actual "ready" signal from the printer.
 */
export const PRINT_TASK_MIN_TIME_MS = 800;

/**
 * Creates a Bottleneck limiter that serializes print tasks: only one runs at a
 * time and the next one is held until {@link PRINT_TASK_MIN_TIME_MS} has passed,
 * preventing the bot from clogging under bursts of requests.
 */
export function createPrintLimiter(): Bottleneck {
    return new Bottleneck({
        maxConcurrent: 1,
        minTime: PRINT_TASK_MIN_TIME_MS,
    });
}

export type PrintLimiter = Bottleneck;
