/**
 * compose().close() must stop the session broker's intervention-lease checker: the run is over,
 * so a still-ticking interval would only leak in a long-lived host. Also covers compose()'s own
 * Relay console (`operator: { port: 0 }`): the composition root must actually serve the Relay UI
 * and list the run, and close() must stop that server too. And: the run's policy is narrowed to
 * its own base-URL origin, and a failure part-way through compose() closes what it started.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FakeSurface, scenario } from '@cu/core/surface';
import { compose, runPolicy } from './compose.js';
import type { RelayServerHandle } from './relay-ui.js';

describe('compose().close()', () => {
  it('disposes the session broker (clears the lease checker)', async () => {
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-close-'));
    try {
      const surface = new FakeSurface(scenario().screen('home', { url: 'http://localhost:4173/', title: 'Home', elements: [] }).build());
      const c = await compose({ runKind: 'replay', surface, runsDir, policyPath: 'policies/default.yaml' });
      const dispose = vi.spyOn(c.broker, 'dispose');
      await c.close();
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(runsDir, { recursive: true, force: true });
    }
  });
});

describe('compose({ operator: { port: 0 } })', () => {
  it('mounts the Relay console: serves its UI, lists the run, and close() stops the server', async () => {
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-relay-'));
    try {
      const surface = new FakeSurface(scenario().screen('home', { url: 'http://localhost:4173/', title: 'Home', elements: [] }).build());
      const c = await compose({ runKind: 'replay', surface, runsDir, policyPath: 'policies/default.yaml', operator: { port: 0 } });
      expect(c.operator).toBeDefined();
      const url = c.operator!.url;

      const page = await fetch(`${url}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      const html = await page.text();
      expect(html).toMatch(/<title>[^<]*Relay[^<]*<\/title>/);

      const runsRes = await fetch(`${url}/api/runs`);
      expect(runsRes.status).toBe(200);
      const runsBody = (await runsRes.json()) as { runs: { runId: string }[] };
      expect(runsBody.runs.map((r) => r.runId)).toContain(c.runId);

      await c.close();
      await expect(fetch(`${url}/api/runs`)).rejects.toBeDefined();
    } finally {
      fs.rmSync(runsDir, { recursive: true, force: true });
    }
  }, 30000);
});

function homeSurface(url = 'http://localhost:4173/'): FakeSurface {
  return new FakeSurface(scenario().screen('home', { url, title: 'Home', elements: [] }).build());
}

describe('compose(): the per-run policy', () => {
  it("narrows allowedOrigins to the base URL's origin: a tenant-B run cannot act on tenant A", async () => {
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-origin-'));
    try {
      const c = await compose({ runKind: 'replay', surface: homeSurface('http://localhost:4174/'), runsDir, policyPath: 'policies/default.yaml', baseUrl: 'http://localhost:4174' });
      try {
        expect(c.policy.allowedOrigins).toEqual(['http://localhost:4174']);
        expect(c.guard.checkUrl('http://localhost:4173/workstation').allowed).toBe(false);
        expect(c.guard.checkUrl('http://localhost:4174/workstation').allowed).toBe(true);
        const r = await c.surface.act({ type: 'navigate', url: 'http://localhost:4173/workstation' }, 1000);
        expect(r.ok).toBe(false);
        expect(r.error?.code).toBe('policy_violation');
      } finally {
        await c.close();
      }
    } finally {
      fs.rmSync(runsDir, { recursive: true, force: true });
    }
  });

  it('runPolicy refuses a base URL whose origin the policy does not allow, and never widens the list', () => {
    const policy = { name: 'p', allowedOrigins: ['http://localhost:4173', 'http://localhost:4174'] } as Parameters<typeof runPolicy>[0];
    expect(runPolicy(policy, 'http://localhost:4173/some/path').allowedOrigins).toEqual(['http://localhost:4173']);
    expect(() => runPolicy(policy, 'http://localhost:9999')).toThrow(/not in policy p allowedOrigins/);
  });

  it('compose() with a disallowed base URL throws before creating a run directory', async () => {
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-origin-deny-'));
    try {
      await expect(compose({ runKind: 'replay', surface: homeSurface(), runsDir, policyPath: 'policies/default.yaml', baseUrl: 'http://localhost:9999' })).rejects.toThrow(
        /allowedOrigins/,
      );
      expect(fs.readdirSync(runsDir)).toEqual([]);
    } finally {
      fs.rmSync(runsDir, { recursive: true, force: true });
    }
  });
});

describe('compose(): a failure part-way closes what compose started', () => {
  it('a busy operator port (EADDRINUSE) rejects and closes the surface compose owns', async () => {
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-busy-'));
    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(4423, '127.0.0.1', () => resolve());
    });
    try {
      const surface = homeSurface();
      const close = vi.spyOn(surface, 'close');
      await expect(
        compose({ runKind: 'replay', surface, ownSurface: true, runsDir, policyPath: 'policies/default.yaml', operator: { port: 4423 } }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      fs.rmSync(runsDir, { recursive: true, force: true });
    }
  });

  it('a throw after the broker exists disposes it and closes the owned surface; a caller-owned console is left running', async () => {
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-register-'));
    try {
      const surface = homeSurface();
      const surfaceClose = vi.spyOn(surface, 'close');
      let disposed = 0;
      const serverClose = vi.fn(() => Promise.resolve());
      const server = {
        url: 'http://127.0.0.1:1',
        port: 1,
        register: (broker: { dispose(): void }) => {
          const dispose = broker.dispose.bind(broker);
          broker.dispose = () => {
            disposed += 1;
            dispose();
          };
          throw new Error('register failed');
        },
        unregister: () => undefined,
        close: serverClose,
      } as unknown as RelayServerHandle;
      await expect(
        compose({ runKind: 'replay', surface, ownSurface: true, runsDir, policyPath: 'policies/default.yaml', operator: { server } }),
      ).rejects.toThrow('register failed');
      expect(disposed).toBe(1);
      expect(surfaceClose).toHaveBeenCalledTimes(1);
      expect(serverClose).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(runsDir, { recursive: true, force: true });
    }
  });
});
