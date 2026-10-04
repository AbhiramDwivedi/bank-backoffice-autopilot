import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import { agentSource } from '@cu/browser-agent';
import { createSeedState, formatCents, fullName } from './data/seed.js';
import { defaultFaults } from './faults.js';
import { SessionStore } from './session.js';
import { TENANTS, PRODUCT, PRODUCT_VERSION, VENDOR, type TenantId } from './tenant.js';
import { chaosRuntime, drawSite, isTransactionPath, type AppContext } from './context.js';
import { drawDelay, drawFault } from './chaos.js';
import { registerFaultRoutes } from './routes/faults.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerShellRoutes } from './routes/shell.js';
import { registerMemberRoutes } from './routes/members.js';
import { registerSubaccountRoutes } from './routes/subaccounts.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Options for building one mock-app instance. */
export interface CreateAppOptions {
  tenant: TenantId;
  /** Defaults to process.env.MOCK_PASSWORD ?? 'demo-pass-123'. */
  password?: string;
}

/** Builds a fresh, isolated mock-app instance for the given tenant. Throws if the tenant id is unknown. */
export function createApp(opts: CreateAppOptions): Express {
  const tenant = TENANTS[opts.tenant];
  if (!tenant) throw new Error(`unknown tenant ${String(opts.tenant)}`);

  const ctx: AppContext = {
    tenant,
    state: createSeedState(),
    faults: defaultFaults(),
    chaos: null,
    sessions: new SessionStore(),
    password: opts.password ?? process.env.MOCK_PASSWORD ?? 'demo-pass-123',
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('views', path.join(here, 'views'));
  app.set('view engine', 'ejs');
  app.set('view cache', false);
  Object.assign(app.locals, { ctx, tenant, formatCents, fullName, VENDOR, PRODUCT, PRODUCT_VERSION });

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(cookieParser());

  // Fault routes first: no auth, no slowMs (test harnesses call them).
  registerFaultRoutes(app, ctx);

  // slowMs: delay every other response, static assets included. Chaos slowMs draws only where
  // the switch is off, and only on transaction routes (chaos.ts explains why).
  // A delayed request whose client gave up meanwhile (a replay step timed out, the run's browser
  // context closed) is dropped after the delay instead of handled: otherwise it would draw from the
  // other chaos streams at a wall-clock moment, possibly in the middle of the next run.
  app.use((req: Request, res: Response, next: NextFunction) => {
    let ms = ctx.faults.slowMs;
    if (ms === 0 && isTransactionPath(req.path)) ms = drawDelay(chaosRuntime(ctx), drawSite(req));
    if (ms <= 0) {
      next();
      return;
    }
    let abandoned = false;
    res.once('close', () => {
      abandoned = true;
    });
    setTimeout(() => {
      if (!abandoned) next();
    }, ms);
  });

  // The institution's monitoring/RUM tag, shipped as a plain script asset: unauthenticated (it is
  // before the auth gate anyway) and delayed by slowMs like every other asset (registered after
  // the slowMs middleware above). @cu/browser-agent builds dist/ on demand; if that build throws,
  // respond with a short plain-text 500 instead of letting it crash the process.
  app.get('/static/cu-agent.js', (_req: Request, res: Response) => {
    let source: string;
    try {
      source = agentSource();
    } catch {
      res.status(500).type('text/plain').send('cu-agent.js build failed');
      return;
    }
    res.type('application/javascript').send(source);
  });

  app.use('/static', express.static(path.join(here, 'public'), { maxAge: 0 }));

  // Public pages: /, /login, /logout, /session-expired.
  registerAuthRoutes(app, ctx);

  // Everything registered after this requires a session.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const s = ctx.sessions.get(req);
    if (!s) {
      res.redirect(302, '/login');
      return;
    }
    if (ctx.faults.expireSession) {
      ctx.faults.expireSession = false; // one-shot
      ctx.sessions.destroy(req, res);
      res.redirect(302, '/session-expired');
      return;
    }
    // Chaos expiry: a transaction request that drew "expire" behaves exactly like the switch.
    if (isTransactionPath(req.path) && drawFault(chaosRuntime(ctx), 'expireSession', drawSite(req))) {
      ctx.sessions.destroy(req, res);
      res.redirect(302, '/session-expired');
      return;
    }
    res.locals.session = s;
    next();
  });

  registerShellRoutes(app, ctx);
  registerMemberRoutes(app, ctx);
  registerSubaccountRoutes(app, ctx);

  app.use((_req: Request, res: Response) => {
    res.status(404).type('html').send(
      `<html><head><title>404 Not Found</title></head><body><h1>Not Found</h1>` +
        `<p>The requested URL was not found on this server.</p><hr><address>Apache/1.3.27 Server</address></body></html>`,
    );
  });

  // Body-parser errors (malformed JSON/urlencoded): clean 400 instead of Express's stack-trace page.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    const e = err as { type?: string; status?: number } | null;
    if (e && typeof e.type === 'string' && e.type.startsWith('entity.')) {
      const status = e.status ?? 400;
      if (req.path.startsWith('/__')) res.status(status).json({ error: `invalid request body: ${e.type}` });
      else res.status(status).type('html').send('<html><body><h1>Bad Request</h1></body></html>');
      return;
    }
    next(err);
  });

  return app;
}

/** Test/harness access to an app's live context (state, faults, sessions). */
export function getContext(app: Express): AppContext {
  return (app.locals as { ctx: AppContext }).ctx;
}
