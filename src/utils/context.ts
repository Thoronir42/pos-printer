import type { Logger } from "./logger.ts";

export type AppContext = {
    logger: Logger,

    with(modify: (ctx: Readonly<AppContext>) => AppContext): AppContext;
};

export function createContext(logger: Logger): AppContext {
    const ctx: AppContext = {
        logger,
        with(modify) {
            return modify(this);
        },
    };

    return ctx;
}
