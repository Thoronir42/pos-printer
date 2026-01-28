export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
    message?: string,
    cause?: Error,
  ) {
    super(message, { cause });
    this.code = code;
  }
}
