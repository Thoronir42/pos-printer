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

/** Keyed sliding-window rate limiter for request sources (e.g. Telegram chats). */
export type SpamGuard = {
    /** Records a request under the key and returns true when it should be blocked. */
    registerRequest: (key: number | string) => boolean,
};

/**
 * Creates a {@link SpamGuard} that blocks a key once it accumulates
 * `threshold` requests within the trailing `windowMs` window.
 */
export function createSpamGuard({ windowMs, threshold }: { windowMs: number, threshold: number }): SpamGuard {
    const timestampsByKey = new Map<number | string, number[]>();

    return {
        registerRequest(key) {
            const now = Date.now();
            const recent = (timestampsByKey.get(key) ?? [])
                .filter((timestamp) => now - timestamp <= windowMs);
            recent.push(now);
            timestampsByKey.set(key, recent);
            return recent.length >= threshold;
        },
    };
}
