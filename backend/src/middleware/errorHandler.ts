import type { FastifyError } from 'fastify';
import { ZodError } from 'zod';
import type { Logger } from '../logger.js';
import { AppError } from '../utils/errors.js';
import type { AppInstance } from '../server.js';

interface ErrorBody {
  error: string;
  code: string;
  details?: unknown;
}

/**
 * Single place where errors become responses.
 *
 * Rule: the client learns *what it can fix* (validation messages, "not found"),
 * never internals (stack traces, SQLite text, file paths). Everything else is
 * logged with full detail and answered with a generic 500.
 */
export function registerErrorHandler(app: AppInstance, logger: Logger): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    // 1. Expected, author-controlled errors: safe to echo.
    if (error instanceof AppError) {
      logger.warn({ code: error.code, url: request.url, status: error.statusCode }, error.message);
      const body: ErrorBody = { error: error.message, code: error.code };
      return reply.code(error.statusCode).send(body);
    }

    // 2. zod validation -> 400 with field-level detail (the client sent it).
    if (error instanceof ZodError) {
      const body: ErrorBody = {
        error: 'Invalid request',
        code: 'validation_failed',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      };
      return reply.code(400).send(body);
    }

    // 3. Schema validation that Fastify itself performed.
    if ('validation' in error && error.validation) {
      const body: ErrorBody = {
        error: 'Invalid request',
        code: 'validation_failed',
        details: error.validation.map((issue) => ({
          path: issue.instancePath || issue.params?.missingProperty || '',
          message: issue.message ?? 'invalid',
        })),
      };
      return reply.code(400).send(body);
    }

    // 4. Client errors raised by Fastify internals (404 for a bad route, etc.).
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: 'Request could not be processed', code: 'bad_request' } satisfies ErrorBody);
    }

    // 5. Unknown failure: full detail to the log, nothing to the client.
    logger.error({ err: error, url: request.url, method: request.method }, 'unhandled request error');
    return reply.code(500).send({ error: 'Internal server error', code: 'internal_error' } satisfies ErrorBody);
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: `Route ${request.method} ${request.url} not found`, code: 'not_found' });
  });
}
