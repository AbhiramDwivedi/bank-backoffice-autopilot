/**
 * Central error shaping for Relay's HTTP API. Every non-2xx response is `{error:{code,message,
 * state?}}` -- never a stack trace, never an HTML error page. See docs/design/relay.md and
 * apps/relay/src/shared/api.ts (`ApiError`/`ApiErrorCode`).
 */
import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import type { ZodError } from 'zod';
import { FILESYSTEM_PATH_PATTERN } from './core.js';
import type { ApiError, ApiErrorCode } from '../shared/api.js';
import { PortConflictError, PortNotFoundError } from './ports.js';

/** Applied to every JSON body this app sends (see `RelayAppOptions.redact`). */
export type Redactor = (value: unknown) => unknown;

/** Sends `body` through the app's redactor before it goes on the wire. */
export type Respond = (res: Response, status: number, body: unknown) => void;

export function makeRespond(redact: Redactor): Respond {
  return function respond(res: Response, status: number, body: unknown): void {
    res.status(status).json(redact(body));
  };
}

export function apiError(code: ApiErrorCode, message: string, state?: string): ApiError {
  return state !== undefined ? { error: { code, message, state } } : { error: { code, message } };
}

/** Joins zod issue messages the same way Relay's route handlers expect for a 400 body. */
export function zodIssues(error: ZodError): string {
  return error.issues.map((i) => i.message).join('; ');
}

function isEntityTooLarge(err: unknown): err is { type: string } {
  return err !== null && typeof err === 'object' && (err as { type?: unknown }).type === 'entity.too.large';
}

/**
 * Strips a local absolute filesystem path out of an unexpected error's message, before the
 * message ever reaches the redactor. Reuses the same shape `FILESYSTEM_PATH_PATTERN`
 * (`@cu/core/evidence`, re-exported from `core.ts`) matches for evidence -- Windows drive
 * (`C:\...`, `C:/...`), UNC (`\\server\share\...`), and POSIX paths rooted at a well-known
 * directory (`/home/`, `/Users/`, `/tmp/`, etc.) -- so an fs/ENOENT error or a Playwright error
 * quoting a screenshot/DOM-snapshot path never reaches the client verbatim. Leaves http(s) URLs
 * (and everything else) untouched; see `FILESYSTEM_PATH_PATTERN`'s own doc comment for why URLs
 * and relative evidence paths never match.
 */
export function stripFilesystemPaths(message: string): string {
  return message.replace(FILESYSTEM_PATH_PATTERN, '[path]');
}

/**
 * Last-resort error handler: catches everything a route threw or a rejected async handler
 * produced (Express 5 forwards a rejected promise to this automatically), plus body-parser's
 * malformed-JSON and oversized-body errors, and maps `PortNotFoundError`/`PortConflictError` from
 * the broker adapter to their wire status codes. Registered last, after every route.
 */
export function createFinalErrorHandler(redact: Redactor): ErrorRequestHandler {
  const respond = makeRespond(redact);
  return (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      // Nothing left to do but let Express's own default (stream-safe) handling close the
      // connection; we never reach here in normal operation since every route we write finishes
      // its own response before an error could occur downstream.
      next(err);
      return;
    }
    if (err instanceof PortNotFoundError) {
      respond(res, 404, apiError('not_found', err.message));
      return;
    }
    if (err instanceof PortConflictError) {
      respond(res, 409, apiError('conflict', err.message, err.state));
      return;
    }
    if (err instanceof SyntaxError) {
      respond(res, 400, apiError('bad_request', 'invalid JSON body'));
      return;
    }
    if (isEntityTooLarge(err)) {
      respond(res, 413, apiError('payload_too_large', 'request body too large'));
      return;
    }
    // Never echo a stack trace; the message goes through the same redactor as every other
    // payload, since a surface/core error can quote page content. An absolute filesystem path is
    // stripped first (see `stripFilesystemPaths`) -- the redactor's own path pattern would also
    // catch it, but stripping it here first keeps a good message readable (`[path]` instead of
    // `[REDACTED:path]`) without weakening what leaves the process.
    const message = err instanceof Error ? stripFilesystemPaths(err.message) : 'internal error';
    respond(res, 500, apiError('internal', message));
  };
}
