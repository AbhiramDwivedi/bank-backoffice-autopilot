/**
 * `startOperatorDemo` end to end, over real HTTP against the Relay console it starts: the
 * escalation it raises is visible as one open intervention, a hand-back resolves `resolution`
 * with the chosen `resumeFrom`, and an abort resolves it with `resumeFrom: 'abort'`. A walkthrough
 * that fails after the console started rejects with the console stopped (its port is free again).
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeSurface, scenario } from '@cu/core/surface';
import { startOperatorDemo, type OperatorDemoHandle } from './operator-demo.js';

const tempDirs: string[] = [];
const handles: OperatorDemoHandle[] = [];

function tempRunsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-demo-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    await handle.close().catch(() => undefined);
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

describe('startOperatorDemo', () => {
  it('opens one intervention, and a hand-back resolves the resolution with the chosen resumeFrom', async () => {
    const runsDir = tempRunsDir();
    const handle = await startOperatorDemo({ port: 0, runsDir });
    handles.push(handle);

    const listing = (await getJson(`${handle.url}/api/interventions?status=open`)) as { interventions: { id: string }[] };
    expect(listing.interventions).toHaveLength(1);
    const id = listing.interventions[0]!.id;

    const take = await postJson(`${handle.url}/api/interventions/${id}/take`, { by: 'demo-test' });
    expect(take.status).toBe(200);

    const handback = await postJson(`${handle.url}/api/interventions/${id}/handback`, { by: 'demo-test', resumeFrom: 'next_step' });
    expect(handback.status).toBe(200);

    const resolved = await handle.resolution;
    expect(resolved.resumeFrom).toBe('next_step');
    expect(resolved.by).toBe('demo-test');
  }, 30000);

  it('an abort resolves the resolution with resumeFrom: abort', async () => {
    const runsDir = tempRunsDir();
    const handle = await startOperatorDemo({ port: 0, runsDir });
    handles.push(handle);

    const listing = (await getJson(`${handle.url}/api/interventions?status=open`)) as { interventions: { id: string }[] };
    expect(listing.interventions).toHaveLength(1);
    const id = listing.interventions[0]!.id;

    const abort = await postJson(`${handle.url}/api/interventions/${id}/abort`, { by: 'demo-test' });
    expect(abort.status).toBe(200);

    const resolved = await handle.resolution;
    expect(resolved.resumeFrom).toBe('abort');
  }, 30000);

  it('a walkthrough failure after the console started rejects and stops the console (the port is free again)', async () => {
    const runsDir = tempRunsDir();
    const port = 4443;
    // A surface with none of the controls the walkthrough looks for: the first findByName throws.
    const empty = new FakeSurface(scenario().screen('login', { url: 'http://localhost:4173/login', title: 'login', elements: [] }).build());
    const lines: string[] = [];

    await expect(startOperatorDemo({ port, runsDir, surface: empty, log: (l) => lines.push(l) })).rejects.toThrow(/element not found on screen: "User ID"/);
    expect(lines.some((l) => l.startsWith('Operator console: '))).toBe(true);

    const probe = net.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }, 30000);
});
