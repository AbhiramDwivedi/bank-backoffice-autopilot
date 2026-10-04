/**
 * `startRelayConsole({authenticate})`: the CLI-side start function forwards the operator
 * authentication hook to Relay, so an embedding deployment can gate the console without calling
 * `createRelayApp` itself. Uses a pre-built `staticDir`, so no UI build runs here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startRelayConsole, type RelayServerHandle, type StartRelayConsoleOptions } from './relay-ui.js';

const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function staticDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ui-auth-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body><!--RELAY_BOOTSTRAP--></body></html>');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1);');
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const authenticate: NonNullable<StartRelayConsoleOptions['authenticate']> = (req, res, next) => {
  if (req.headers.authorization === 'Bearer ok') {
    next();
    return;
  }
  res.status(401).json({ error: { code: 'unauthorized', message: 'sign in' } });
};

describe('startRelayConsole({ authenticate })', () => {
  it('applies the hook to the console page, the assets, the API and the event stream', async () => {
    const handle: RelayServerHandle = await startRelayConsole({ port: 0, staticDir: staticDir(), authenticate });
    cleanup.push(() => handle.close());

    for (const route of ['/', '/assets/app.js', '/api/runs', '/api/interventions', '/api/events']) {
      const res = await fetch(`${handle.url}${route}`);
      expect(res.status, route).toBe(401);
      await res.text();
    }
    const ok = await fetch(`${handle.url}/api/runs`, { headers: { Authorization: 'Bearer ok' } });
    expect(ok.status).toBe(200);
  });

  it('without the hook the console stays open to any loopback caller (the documented default)', async () => {
    const handle = await startRelayConsole({ port: 0, staticDir: staticDir() });
    cleanup.push(() => handle.close());
    expect((await fetch(`${handle.url}/api/runs`)).status).toBe(200);
  });
});
