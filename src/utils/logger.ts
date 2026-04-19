export type LoggerContext = Record<string, string | number | boolean | null | undefined>;

export type Logger = {
    child: (ctx: LoggerContext) => Logger,
    info: (message: string, ctx?: LoggerContext) => void,
    warn: (message: string, ctx?: LoggerContext) => void,
    error: (message: string, ctx?: LoggerContext) => void,
    debug: (message: string, ctx?: LoggerContext) => void,
};

function normalizeContext(ctx: LoggerContext) {
    const normalized: LoggerContext = {};
    for (const [key, value] of Object.entries(ctx)) {
        if (value === undefined) {
            continue;
        }

        normalized[key] = value;
    }

    return normalized;
}

function formatContext(ctx: LoggerContext) {
    const parts = Object.entries(normalizeContext(ctx))
        .map(([key, value]) => `${key}=${String(value)}`);

    if (!parts.length) {
        return "";
    }

    return ` ${parts.join(" ")}`;
}

class DefaultLogger implements Logger {
    constructor(private readonly baseContext: LoggerContext = {}) {
    }

    child(ctx: LoggerContext): Logger {
        return new DefaultLogger({
            ...this.baseContext,
            ...normalizeContext(ctx),
        });
    }

    info(message: string, ctx: LoggerContext = {}) {
        console.log(`[info] ${message}${formatContext({ ...this.baseContext, ...ctx })}`);
    }

    warn(message: string, ctx: LoggerContext = {}) {
        console.warn(`[warn] ${message}${formatContext({ ...this.baseContext, ...ctx })}`);
    }

    error(message: string, ctx: LoggerContext = {}) {
        console.error(`[error] ${message}${formatContext({ ...this.baseContext, ...ctx })}`);
    }

    debug(message: string, ctx: LoggerContext = {}) {
        console.log(`[debug] ${message}${formatContext({ ...this.baseContext, ...ctx })}`);
    }
}

export function createLogger(ctx: LoggerContext = {}): Logger {
    return new DefaultLogger(normalizeContext(ctx));
}
