/**
 * An error whose message is safe to show a client.
 *
 * Anything thrown that is NOT an AppError is assumed to be an internal
 * problem and is reported as a generic message, with the detail logged
 * server-side only.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly headers: Record<string, string>;

  constructor(statusCode: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.headers = headers;
  }

  static badRequest(message: string, code = 'bad_request'): AppError {
    return new AppError(400, code, message);
  }

  static unauthorized(message = 'Authentication required'): AppError {
    return new AppError(401, 'unauthorized', message);
  }

  static forbidden(message = 'Not allowed'): AppError {
    return new AppError(403, 'forbidden', message);
  }

  static notFound(message = 'Not found'): AppError {
    return new AppError(404, 'not_found', message);
  }

  static conflict(message: string, code = 'conflict'): AppError {
    return new AppError(409, code, message);
  }

  static tooManyRequests(message = 'Too many requests', headers: Record<string, string> = {}): AppError {
    return new AppError(429, 'rate_limited', message, headers);
  }

  /**
   * Login throttling answers with 429 + Retry-After. The message is identical
   * whether the IP or the username tripped the limit, so the response cannot be
   * used to work out which one.
   */
  static loginLocked(retryAfterSeconds: number): AppError {
    const safeSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
    return new AppError(429, 'rate_limited', 'Too many attempts. Try again later.', {
      'retry-after': String(safeSeconds),
    });
  }
}
