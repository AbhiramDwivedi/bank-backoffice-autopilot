/**
 * Relay's Express app: the human-in-the-loop console's HTTP surface. A pure delivery adapter --
 * every route reads/writes through `RelayBrokerPort` (ports.ts) and nothing else, so this file
 * never imports the core (see apps/relay/eslint.config.js) and its tests run against a fake port
 * as easily as a real broker. See docs/design/relay.md for the route table and security perimeter,
 * and guards.ts for the Host/Origin/Sec-Fetch-Site guards, which apply to every route (reads
 * included, not just the mutating POSTs).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import express, { type Express, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { Bootstrap, InterventionStatus } from '../shared/api.js';
import { renderIndexHtml } from './bootstrap.js';
import { createEventHub, type EventHub } from './events.js';
import { apiError, makeRespond, createFinalErrorHandler, zodIssues, type Redactor, type Respond } from './errors.js';
import { createHostGuard, createOriginGuard, createJsonContentTypeGuard, securityHeaders } from './guards.js';
import { createLiveScreenshotCache } from './live-screenshot.js';
import { PortNotFoundError, type RelayBrokerPort } from './ports.js';

export interface RelayAppOptions {
  port: RelayBrokerPort;
  /** Applied to EVERY JSON body, SSE payload, and error message this app sends. */
  redact: Redactor;
  /** Built UI: `index.html` + `assets/`. */
  staticDir: string;
  /**
   * Seam for real auth (no implementation ships; see docs/design/relay.md "Production deployment").
   * Mounted app-wide after the Host/Origin guards, so it runs before EVERY route: `GET /` (whose
   * page inlines every intervention), `/assets`, every `/api` route including the `/api/events`
   * SSE stream, and the 404 fallback. To refuse, respond without calling `next()`. When it sets
   * `res.locals.operator` (a string), that identity overrides the request body's `by` for every
   * mutating endpoint below. Reachable from `startRelayServer({authenticate})`.
   *
   * The hook is wrapped: if it throws, returns a rejected promise, or calls `next(err)`, the
   * caller gets a fixed `401 {error:{code:'unauthorized', message:'authentication failed'}}`
   * and nothing from the error (an LDAP or IdP error can quote a password or a token). The
   * failure is reported to `onAuthError` with the error's class name only.
   */
  authenticate?: RequestHandler;
  /** Called when `authenticate` fails by throwing/rejecting/`next(err)`, with the error's class
   *  name only (never its message). Default: one `console.error` line with that name. */
  onAuthError?: (errorKind: string) => void;
  liveScreenshotMinIntervalMs?: number;
  keepAliveMs?: number;
  eventBufferSize?: number;
}

export interface RelayApp {
  app: Express;
  events: EventHub;
  /** Ends every open SSE stream and unsubscribes from the port. Idempotent. */
  close(): Promise<void>;
}

const ByField = z.string().trim().min(1).max(100);
const NotesField = z.string().max(4000).optional();
const TakeBody = z.object({ by: ByField });
/** `resumeAtStepId`: the API-only lever for "resume at this step instead of the failing one" (the
 *  console UI never sends it). Shape-checked here; whether the step exists and whether resuming
 *  there is safe is the run's decision, which asks the operator again when it refuses. */
const StepIdField = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+$/, 'must be a step id');
const HandBackBody = z
  .object({ by: ByField, resumeFrom: z.enum(['current_step', 'next_step']), resumeAtStepId: StepIdField.optional(), notes: NotesField })
  .refine((b) => b.resumeAtStepId === undefined || b.resumeFrom === 'current_step', {
    message: 'resumeAtStepId is only valid with resumeFrom "current_step"',
    path: ['resumeAtStepId'],
  });
const AbortBody = z.object({ by: ByField, notes: NotesField });
/** `by` is optional here alone: a heartbeat records no operator identity in the core (see
 *  SessionBroker.recordHeartbeat), so this is accepted only for parity with the other endpoints. */
const HeartbeatBody = z.object({ by: ByField.optional() });
const StatusFilter = z.enum(['open', 'human_active', 'resolved', 'abandoned']);

/** Identity seam: `res.locals.operator`, set by `opts.authenticate`, wins over the request body's
 *  `by` whenever it is present. Until real auth exists, every caller supplies its own `by`. */
function resolveBy(res: Response, bodyBy: string): string {
  const operator = res.locals.operator as unknown;
  return typeof operator === 'string' && operator.length > 0 ? operator : bodyBy;
}

/** Name of an error's class, for logging an auth failure without its (possibly secret) message. */
function errorKind(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * Wraps the deployment's `authenticate` hook so that a failure inside it can never reach an
 * unauthenticated caller: a synchronous throw, a rejected promise, or `next(err)` all end in a
 * fixed-message 401 (nothing from the error), reported to `onAuthError` by class name only. A
 * hook that already responded (a normal refusal) is left alone, and `next()` without an error
 * passes through. The response is never written twice.
 */
function guardAuthenticate(hook: RequestHandler, respond: Respond, onAuthError?: (errorKind: string) => void): RequestHandler {
  const report = onAuthError ?? ((kind: string) => console.error(`relay: authenticate hook failed (${kind}); answered 401`));
  return (req, res, next) => {
    let settled = false;
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      try {
        report(errorKind(err));
      } catch {
        /* a broken reporter must not change the answer */
      }
      if (!res.headersSent) respond(res, 401, apiError('unauthorized', 'authentication failed'));
    };
    const guardedNext = (err?: unknown): void => {
      if (settled) return;
      // Express treats next('route'/'router') as control flow, not an error.
      if (err !== undefined && err !== null && err !== 'route' && err !== 'router') {
        fail(err);
        return;
      }
      settled = true;
      next(err as undefined);
    };
    try {
      const out: unknown = hook(req, res, guardedNext);
      if (out !== null && typeof out === 'object' && typeof (out as Promise<unknown>).then === 'function') {
        (out as Promise<unknown>).then(undefined, fail);
      }
    } catch (err) {
      fail(err);
    }
  };
}

export function createRelayApp(opts: RelayAppOptions): RelayApp {
  const redact = opts.redact;
  const respond: Respond = makeRespond(redact);

  const events = createEventHub({
    bufferSize: opts.eventBufferSize ?? 500,
    keepAliveMs: opts.keepAliveMs ?? 15000,
  });
  const liveScreenshots = createLiveScreenshotCache({
    capture: (runId) => opts.port.liveScreenshot(runId),
    minIntervalMs: opts.liveScreenshotMinIntervalMs ?? 1000,
  });

  let cachedTemplate: string | undefined;
  async function getTemplate(): Promise<string | undefined> {
    if (cachedTemplate !== undefined) return cachedTemplate;
    try {
      cachedTemplate = await readFile(join(opts.staticDir, 'index.html'), 'utf8');
      return cachedTemplate;
    } catch {
      return undefined;
    }
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(createHostGuard(respond));
  app.use(createOriginGuard(respond));

  // Authentication is mounted ONCE, app-wide, after the Host/Origin guards and before every route:
  // the console page (which inlines every run and intervention), the static bundle, the whole API
  // including the SSE stream, and the 404 fallback. Mounting it per route let `/assets` and the
  // fallback escape it; app-level mounting means no route registered below can. The fallback is
  // gated on purpose: an unauthenticated caller gets the same refusal for every path, so it cannot
  // probe which routes exist.
  if (opts.authenticate !== undefined) app.use(guardAuthenticate(opts.authenticate, respond, opts.onAuthError));

  app.get('/', async (_req: Request, res: Response) => {
    const template = await getTemplate();
    if (template === undefined) {
      respond(res, 503, apiError('unavailable', 'Relay UI is not built. Run: npm --prefix apps/relay run build'));
      return;
    }
    const boot = redact({
      runs: opts.port.runs(),
      interventions: opts.port.listInterventions(),
      lastEventId: events.lastEventId(),
      serverTime: new Date().toISOString(),
    }) as Bootstrap;
    res.status(200);
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(renderIndexHtml(template, boot));
  });

  app.use(
    '/assets',
    express.static(join(opts.staticDir, 'assets'), {
      index: false,
      fallthrough: true,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  const api = express.Router();
  api.use(createJsonContentTypeGuard(respond));
  api.use(express.json({ limit: '16kb' }));
  api.use((_req: Request, res: Response, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  api.get('/runs', (_req: Request, res: Response) => {
    respond(res, 200, { runs: opts.port.runs() });
  });

  api.get('/interventions', (req: Request, res: Response) => {
    const statusParam = req.query.status;
    let status: InterventionStatus | undefined;
    if (statusParam !== undefined) {
      if (typeof statusParam !== 'string') {
        respond(res, 400, apiError('bad_request', 'invalid status filter'));
        return;
      }
      const parsed = StatusFilter.safeParse(statusParam);
      if (!parsed.success) {
        respond(res, 400, apiError('bad_request', 'invalid status filter'));
        return;
      }
      status = parsed.data;
    }
    const interventions = opts.port.listInterventions(status !== undefined ? { status } : undefined);
    respond(res, 200, { interventions, lastEventId: events.lastEventId() });
  });

  api.get('/interventions/:id', (req: Request, res: Response) => {
    const id = req.params.id as string;
    const dto = opts.port.getIntervention(id);
    if (dto === undefined) {
      respond(res, 404, apiError('not_found', `unknown intervention ${id}`));
      return;
    }
    respond(res, 200, dto);
  });

  api.get('/interventions/:id/screenshot', async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const png = await opts.port.escalationScreenshot(id);
    if (png === undefined) {
      respond(res, 404, apiError('not_found', `no screenshot for intervention ${id}`));
      return;
    }
    res.status(200);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.type('png').send(Buffer.from(png));
  });

  api.get('/runs/:runId/screenshot', async (req: Request, res: Response) => {
    const runId = req.params.runId as string;
    try {
      const { png, capturedAt } = await liveScreenshots.get(runId);
      res.status(200);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Relay-Captured-At', capturedAt.toISOString());
      res.type('png').send(Buffer.from(png));
    } catch (err) {
      if (err instanceof PortNotFoundError) {
        respond(res, 404, apiError('not_found', err.message));
        return;
      }
      const message = err instanceof Error ? err.message : 'live screenshot capture failed';
      respond(res, 503, apiError('unavailable', message));
    }
  });

  api.post('/interventions/:id/take', async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const parsed = TakeBody.safeParse(req.body);
    if (!parsed.success) {
      respond(res, 400, apiError('bad_request', zodIssues(parsed.error)));
      return;
    }
    const dto = await opts.port.take(id, resolveBy(res, parsed.data.by));
    respond(res, 200, dto);
  });

  api.post('/interventions/:id/handback', async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const parsed = HandBackBody.safeParse(req.body);
    if (!parsed.success) {
      respond(res, 400, apiError('bad_request', zodIssues(parsed.error)));
      return;
    }
    const result = await opts.port.handBack(id, {
      by: resolveBy(res, parsed.data.by),
      resumeFrom: parsed.data.resumeFrom,
      ...(parsed.data.resumeAtStepId !== undefined ? { resumeAtStepId: parsed.data.resumeAtStepId } : {}),
      notes: parsed.data.notes,
    });
    respond(res, 200, result);
  });

  api.post('/interventions/:id/abort', async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const parsed = AbortBody.safeParse(req.body);
    if (!parsed.success) {
      respond(res, 400, apiError('bad_request', zodIssues(parsed.error)));
      return;
    }
    const result = await opts.port.abort(id, resolveBy(res, parsed.data.by), parsed.data.notes);
    respond(res, 200, result);
  });

  api.post('/interventions/:id/heartbeat', (req: Request, res: Response) => {
    const id = req.params.id as string;
    const parsed = HeartbeatBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      respond(res, 400, apiError('bad_request', zodIssues(parsed.error)));
      return;
    }
    const by = parsed.data.by !== undefined ? resolveBy(res, parsed.data.by) : undefined;
    const { at, intervention } = opts.port.heartbeat(id, by);
    if (intervention.lease === undefined) {
      // Invariant: a successful heartbeat only ever happens while status is human_active, which
      // is exactly when the DTO carries a lease. Surfaced as 500 rather than asserted, so a future
      // core change that breaks this shows up as a clear API error instead of a thrown TypeError.
      respond(res, 500, apiError('internal', 'heartbeat succeeded but the intervention has no active lease'));
      return;
    }
    respond(res, 200, { interventionId: id, at, lease: intervention.lease });
  });

  api.get('/events', (req: Request, res: Response) => {
    const headerId = req.headers['last-event-id'];
    const queryId = req.query.lastEventId;
    const lastEventId = typeof headerId === 'string' ? headerId : typeof queryId === 'string' ? queryId : undefined;
    events.connect(req, res, lastEventId);
  });

  app.use('/api', api);

  app.use((_req: Request, res: Response) => {
    respond(res, 404, apiError('not_found', 'not found'));
  });
  app.use(createFinalErrorHandler(redact));

  const unsubscribe = opts.port.subscribe((change) => {
    if (change.type === 'intervention') {
      const intervention = opts.port.getIntervention(change.interventionId);
      if (intervention === undefined) return; // gone by the time we looked
      events.publish('intervention', redact({ change: change.change, intervention }));
      return;
    }
    if (change.type === 'control') {
      const run = opts.port.controlToken(change.runId);
      if (run === undefined) return;
      events.publish(
        'control',
        redact({ from: change.from, to: change.to, by: change.by, at: change.at, interventionId: change.interventionId, run }),
      );
      if (change.interventionId !== undefined) {
        const intervention = opts.port.getIntervention(change.interventionId);
        if (intervention !== undefined) events.publish('intervention', redact({ change: 'updated', intervention }));
      }
      return;
    }
    // change.type === 'heartbeat'
    const intervention = opts.port.getIntervention(change.interventionId);
    if (intervention?.lease === undefined) return;
    events.publish('heartbeat', redact({ runId: change.runId, interventionId: change.interventionId, at: change.at, lease: intervention.lease }));
  });

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    events.close();
    unsubscribe();
  }

  return { app, events, close };
}
