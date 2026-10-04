import type { Express, Request, Response } from 'express';
import type { AppContext } from '../context.js';

/**
 * Public routes: /, /login, /logout, /session-expired. Registered before the auth gate in
 * app.ts, so these never require a session.
 */
export function registerAuthRoutes(app: Express, ctx: AppContext): void {
  app.get('/', (req: Request, res: Response) => {
    if (ctx.sessions.get(req)) {
      res.redirect(302, '/workstation');
    } else {
      res.redirect(302, '/login');
    }
  });

  app.get('/login', (_req: Request, res: Response) => {
    res.render('login');
  });

  app.post('/login', (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const userId = typeof body.userId === 'string' ? body.userId : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (userId === 'operator1' && password === ctx.password) {
      ctx.sessions.create(res, 'operator1');
      res.redirect(302, '/workstation');
      return;
    }
    res.status(200).render('login', { error: 'Invalid user ID or password.' });
  });

  app.get('/logout', (req: Request, res: Response) => {
    ctx.sessions.destroy(req, res);
    res.redirect(302, '/login');
  });

  app.get('/session-expired', (_req: Request, res: Response) => {
    res.render('session-expired');
  });
}
