/**
 * Mounts the three panes (queue, detail, act), the keyboard shortcuts, the heartbeat loop and the
 * shared 1 s ticker that drives queue ages and the lease countdown. Each pane subscribes to the
 * store on its own and decides for itself whether its inputs changed; this module only wires
 * everything up once at startup.
 */
import type { AppContext } from '../context.js';
import { mountHeartbeat } from '../heartbeat.js';
import { mountKeyboard } from '../keyboard.js';
import { mountAct } from './act.js';
import { mountDetail } from './detail.js';
import { mountQueue } from './queue.js';
import { startTicker } from './ticker.js';

export function mountPanes(ctx: AppContext): void {
  mountQueue(ctx);
  mountDetail(ctx);
  mountAct(ctx);
  mountKeyboard(ctx);
  mountHeartbeat(ctx);
  startTicker();
}
