/**
 * runReplay's own Relay console and the per-run redaction it wires through compose():
 *   - a busy operator port falls back to an OS-assigned one (logged with the real URL), any other
 *     console start failure propagates before compose() runs;
 *   - a sensitive input value in the top-level URL at escalation time, and a pattern only the
 *     policy adds, reach neither the run directory nor the Relay API.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadPolicy } from '@cu/core/policy';
import type { Policy } from '@cu/core/schema';
import { createCuCoreSurface } from '@cu/core/surface';
import { runReplay, sensitiveInputValuesOf } from './run-replay.js';
import { startRelayConsole, type RelayServerHandle, type StartRelayConsoleOptions } from './relay-ui.js';

const EXAMPLE = 'artifacts/examples/lookup-member-savings-balance.example.json';
const BASE_URL = 'http://localhost:4173';
const SENSITIVE_VALUE = 'AcctNum 42&Test/07';

// The example's sign-on steps bind these secrets; the fake cu-core surface accepts exactly these.
beforeAll(() => {
  process.env.MOCK_USER ??= 'operator1';
  process.env.MOCK_PASSWORD ??= 'demo-pass-123';
});

const tempDirs: string[] = [];
const servers: RelayServerHandle[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A static dir with a minimal Relay index.html, so no test here builds the real UI. */
function staticDir(): string {
  const dir = tempDir('run-replay-static-');
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body><!--RELAY_BOOTSTRAP--></body></html>');
  fs.mkdirSync(path.join(dir, 'assets'));
  return dir;
}

function example(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(EXAMPLE, 'utf8')) as Record<string, unknown>;
}

function eaddrinuse(): Error {
  return Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:4300'), { code: 'EADDRINUSE' });
}

describe('sensitiveInputValuesOf', () => {
  it('returns the supplied values of inputs declared sensitive, as strings', () => {
    const cap = { inputs: { a: { sensitive: true }, b: { sensitive: false }, c: { sensitive: true }, d: { sensitive: true } } };
    expect(sensitiveInputValuesOf(cap, { a: 'x-secret', b: 'public', c: 12345 })).toEqual(['x-secret', '12345']);
    expect(sensitiveInputValuesOf(null, { a: 'x' })).toEqual([]);
    expect(sensitiveInputValuesOf({ inputs: [] }, { a: 'x' })).toEqual([]);
  });
});

describe('runReplay: its own Relay console', () => {
  it('a busy operator port falls back to an OS-assigned port, logged with the URL the console actually has', async () => {
    const lines: string[] = [];
    const ports: number[] = [];
    const dir = staticDir();
    const startConsole = async (o: StartRelayConsoleOptions): Promise<RelayServerHandle> => {
      ports.push(o.port);
      if (o.port !== 0) throw eaddrinuse();
      const s = await startRelayConsole({ ...o, staticDir: dir });
      servers.push(s);
      return s;
    };

    const out = await runReplay({
      capability: example(),
      inputs: { memberId: '12345' },
      policyPath: 'policies/default.yaml',
      runsDir: tempDir('run-replay-fallback-'),
      baseUrl: BASE_URL,
      headless: true,
      autoOperator: 'none',
      operator: { port: 4300 },
      surface: createCuCoreSurface(),
      log: (l) => lines.push(l),
      startConsole,
    });

    expect(ports).toEqual([4300, 0]);
    expect(out.operatorUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(out.operatorUrl).not.toBe('http://127.0.0.1:4300');
    expect(lines.some((l) => l.includes('4300') && l.includes('already in use') && l.includes(out.operatorUrl!))).toBe(true);
    expect(out.result.kind).toBe('success');
  });

  it('any other console start failure propagates, before compose() creates a run directory', async () => {
    const runsDir = tempDir('run-replay-console-error-');
    await expect(
      runReplay({
        capability: example(),
        inputs: { memberId: '12345' },
        policyPath: 'policies/default.yaml',
        runsDir,
        baseUrl: BASE_URL,
        headless: true,
        autoOperator: 'none',
        operator: { port: 4300 },
        surface: createCuCoreSurface(),
        startConsole: () => Promise.reject(new Error('relay exploded')),
      }),
    ).rejects.toThrow('relay exploded');
    expect(fs.readdirSync(runsDir)).toEqual([]);
  });
});

describe('runReplay: one redactor per run, shared by evidence and the Relay console', () => {
  it('a sensitive input value in the URL at escalation, and a policy-added pattern, reach neither the run dir nor the Relay API', async () => {
    const cap = example();
    (cap.inputs as Record<string, unknown>).acctNumber = { type: 'string', description: 'Sensitive account number (test).', required: true, sensitive: true };
    const steps = cap.steps as Record<string, unknown>[];
    const search = steps.find((s) => s.id === 's06');
    if (search === undefined) throw new Error('test: example has no step s06');
    search.onFailure = 'escalate';

    const base = loadPolicy(path.resolve('policies/default.yaml'));
    const policy: Policy = {
      ...base,
      redaction: { patterns: [...base.redaction.patterns, { name: 'member', regex: 'MBR-[0-9]{4}', replacement: '[REDACTED:member]' }] },
    };

    const surface = createCuCoreSurface();
    surface.inject({ kind: 'act_error', match: { actionType: 'click', targetId: 'search' }, code: 'app_error', message: 'Search failed for MBR-1234.' });
    const enc = encodeURIComponent(SENSITIVE_VALUE);
    surface.currentUrl = () => Promise.resolve(`${BASE_URL}/members/search?acct=${enc}&q=${enc.replace(/%20/g, '+')}&echo=${SENSITIVE_VALUE}`);

    const server = await startRelayConsole({ port: 0, staticDir: staticDir() });
    servers.push(server);
    const runsDir = tempDir('run-replay-redaction-');
    const run = runReplay({
      capability: cap,
      inputs: { memberId: '12345', acctNumber: SENSITIVE_VALUE },
      policy,
      runsDir,
      baseUrl: BASE_URL,
      headless: true,
      autoOperator: 'none',
      operator: { server },
      surface,
    });

    let id: string | undefined;
    for (let i = 0; i < 400 && id === undefined; i++) {
      const body = (await (await fetch(`${server.url}/api/interventions`)).json()) as { interventions: { id: string }[] };
      id = body.interventions[0]?.id;
      if (id === undefined) await new Promise((r) => setTimeout(r, 10));
    }
    if (id === undefined) throw new Error('test: escalation never reached Relay');

    const apiText = [
      await (await fetch(`${server.url}/api/interventions/${id}`)).text(),
      await (await fetch(`${server.url}/api/interventions`)).text(),
      await (await fetch(`${server.url}/`)).text(),
    ].join('\n');
    expect(apiText).toContain('/members/search?acct=[REDACTED]');
    expect(apiText).toContain('[REDACTED:member]');

    const abort = await fetch(`${server.url}/api/interventions/${id}/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'alice' }),
    });
    expect(abort.status).toBe(200);
    const { result, runDir } = await run;
    expect(result.kind).toBe('escalated');

    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(runDir);
    expect(files.some((f) => f.includes(`${path.sep}interventions${path.sep}`))).toBe(true);
    const record = fs.readFileSync(path.join(runDir, 'interventions', `${id}.json`), 'utf8');
    expect(record).toContain('[REDACTED:member]');

    const everything = [apiText, ...files.map((f) => fs.readFileSync(f).toString('latin1'))].join('\n');
    for (const leak of [SENSITIVE_VALUE, enc, enc.replace(/%20/g, '+'), enc.toLowerCase(), 'MBR-1234', process.env.MOCK_PASSWORD ?? '']) {
      expect(everything, `${leak} leaked`).not.toContain(leak);
    }
  });
});
