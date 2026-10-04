import type { Express, Request, Response } from 'express';
import { createSeedState } from '../data/seed.js';
import { defaultFaults, mergeFaults } from '../faults.js';
import { chaosReport } from '../chaos.js';
import { chaosRuntime, type AppContext } from '../context.js';

/**
 * Fault-injection endpoints. No auth, not delayed by slowMs: these are registered before the
 * slowMs middleware and the auth gate in app.ts.
 *
 * Every route lives under `/__faults` or `/__reset` on purpose: the policy's
 * `deniedPathPatterns` (`^/__faults`, `^/__reset`) already keep the automated surface off both
 * prefixes, so the chaos report at `/__faults/chaos` is covered without a new pattern.
 */
export function registerFaultRoutes(app: Express, ctx: AppContext): void {
  app.get('/__faults', (_req: Request, res: Response) => {
    res.json(ctx.faults);
  });

  // Chaos config, per-kind draw/fire counters and the ordered log of injected faults. Read-only.
  app.get('/__faults/chaos', (_req: Request, res: Response) => {
    res.json(chaosReport(chaosRuntime(ctx)));
  });

  app.post('/__faults', (req: Request, res: Response) => {
    const rejected = mergeFaults(ctx.faults, req.body);
    const badBody = rejected.length === 1 && rejected[0]?.startsWith('(body');
    res.status(badBody ? 400 : 200).json({ ...ctx.faults, rejected });
  });

  app.post('/__reset', (_req: Request, res: Response) => {
    Object.assign(ctx.faults, defaultFaults());
    ctx.chaos = null;
    ctx.state = createSeedState();
    res.json({ ok: true, faults: ctx.faults });
  });
}
