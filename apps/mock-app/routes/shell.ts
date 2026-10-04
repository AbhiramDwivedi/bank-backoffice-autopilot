import type { Express, Request, Response } from 'express';
import type { AppContext } from '../context.js';

/**
 * Shell routes: /workstation (frameset for tenant A, iframe-in-table for tenant B),
 * /frames/banner, /frames/nav. All require a session (registered after the auth gate).
 */
export function registerShellRoutes(app: Express, ctx: AppContext): void {
  app.get('/workstation', (_req: Request, res: Response) => {
    if (ctx.tenant.shell === 'frameset') {
      res.render('workstation-frameset');
    } else {
      res.render('workstation-iframe');
    }
  });

  app.get('/frames/banner', (_req: Request, res: Response) => {
    res.render('banner');
  });

  app.get('/frames/nav', (_req: Request, res: Response) => {
    res.render('nav');
  });
}
