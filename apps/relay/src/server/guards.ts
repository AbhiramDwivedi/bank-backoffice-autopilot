/**
 * CSRF / DNS-rebinding perimeter for Relay's HTTP app, plus the security response headers.
 *
 * Relay binds to loopback only (see start.ts) and, until real auth lands (`RelayAppOptions.
 * authenticate`), has no credential of its own -- its only real perimeter is "which page is
 * allowed to talk to it". The guards run on every route, reads included: a DNS-rebinding page is
 * same-origin with this server from the browser's point of view, so guarding only the mutating
 * POSTs would still let it read intervention context and screenshots. A `Sec-Fetch-Site:
 * cross-site` request is refused outright.
 *
 * `Host` reflects the hostname the browser's own address bar / script believes it is talking to,
 * never a DNS-rebound IP, so checking it defeats rebinding regardless of which ephemeral port this
 * instance listens on. `Origin`, when a browser sends it at all, must be exactly this server's own
 * origin, `http://<Host>` (scheme, host and port): a page served from any other local port (another
 * dev server, another tool on the same machine) is a different origin and is refused. Neither
 * header is required to be present (a same-origin plain navigation or a non-browser client may
 * omit `Origin`).
 */
import type { NextFunction, Request, Response } from 'express';
import { apiError, type Respond } from './errors.js';

const LOCAL_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/** True when `origin` is exactly `http://<host>`, `host` being the request's own (already
 *  Host-guarded) `Host` header. Compared after URL normalisation, case-insensitively. */
function isOwnOrigin(origin: string, host: string | undefined): boolean {
  if (typeof host !== 'string' || !LOCAL_HOST_RE.test(host)) return false;
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && u.origin === new URL(`http://${host}`).origin;
  } catch {
    return false;
  }
}

/** Applied to every route, reads included. */
export function createHostGuard(respond: Respond) {
  return function requireLocalHost(req: Request, res: Response, next: NextFunction): void {
    const host = req.headers.host;
    if (typeof host !== 'string' || !LOCAL_HOST_RE.test(host)) {
      respond(res, 403, apiError('forbidden', 'request Host header does not name this server'));
      return;
    }
    next();
  };
}

/** Applied to every route: a present `Origin` other than this server's own, or an explicit
 *  cross-site fetch, is refused. */
export function createOriginGuard(respond: Respond) {
  return function requireOwnOrigin(req: Request, res: Response, next: NextFunction): void {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin.length > 0 && !isOwnOrigin(origin, req.headers.host)) {
      respond(res, 403, apiError('forbidden', 'request Origin header does not name this server'));
      return;
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      respond(res, 403, apiError('forbidden', 'cross-site request refused'));
      return;
    }
    next();
  };
}

/** POST bodies must declare `Content-Type: application/json`: this forces a CORS preflight for
 *  any cross-origin attempt (a simple/no-preflight request cannot set an arbitrary Content-Type),
 *  and gives a clean 400 instead of `express.json()` silently leaving `req.body` empty. */
export function createJsonContentTypeGuard(respond: Respond) {
  return function requireJsonContentType(req: Request, res: Response, next: NextFunction): void {
    if (req.method !== 'POST') {
      next();
      return;
    }
    const contentType = req.headers['content-type'];
    if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
      respond(res, 400, apiError('bad_request', 'Content-Type must be application/json'));
      return;
    }
    next();
  };
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
}
