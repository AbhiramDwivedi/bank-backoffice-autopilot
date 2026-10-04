/**
 * `cu replay --times N --fault '{"chaos": ...}'`: the fault body is POSTed once for the whole series
 * (so the target's chaos streams are not reset between runs), the target's chaos report is read
 * after the series and BEFORE the faults are restored (restoring turns chaos off), and the seed and
 * report land in the stability summary. Also pins the corrected `--operator-port` help text.
 * `runReplay`, Chromium and `fetch` are mocked: nothing here launches a browser or touches a port.
 */
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplayResult } from '@cu/core/schema';

// The replay command loads the capability's credentials itself, before the fault POST and before
// any browser; the mock app's demo login is what the example artifact binds.
process.env.MOCK_USER ??= 'operator1';
process.env.MOCK_PASSWORD ??= 'demo-pass-123';

const runReplayMock = vi.hoisted(() => vi.fn());

vi.mock('../runtime/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime/index.js')>();
  return { ...actual, runReplay: runReplayMock };
});
vi.mock('playwright', () => ({ chromium: { launch: vi.fn(async () => ({ close: vi.fn(async () => undefined) })) } }));

const { registerReplay, FAULT_HTTP_TIMEOUT_MS } = await import('./replay.js');

const EXAMPLE = path.resolve('artifacts/examples/lookup-member-savings-balance.example.json');
const BASE = 'http://localhost:4173';

function success(runId: string): ReplayResult {
  return { runId, capabilityId: 'c', capabilityVersion: '1.0.0', stepsExecuted: 1, durationMs: 1, locatorReport: [], recoveries: [], kind: 'success', outputs: {} };
}

function program(): Command {
  const p = new Command();
  p.exitOverride();
  p.option('--policy <path>').option('--runs-dir <dir>').option('--headless').option('--headed').option('--base-url <url>').option('--tenant <t>');
  registerReplay(p);
  return p;
}

const REPORT = {
  config: { seed: 42, failSearch: 0.5 },
  stats: { failSearch: { draws: 4, fired: 2 } },
  log: [
    { seq: 1, kind: 'failSearch', draw: 1, method: 'GET', path: '/members/search' },
    { seq: 2, kind: 'failSearch', draw: 4, method: 'GET', path: '/members/search' },
  ],
  logDropped: 0,
};

let calls: string[];
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  calls = [];
  runReplayMock.mockReset();
  stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  process.exitCode = undefined;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.replace(BASE, '')}${init?.body !== undefined ? ` ${String(init.body)}` : ''}`);
    const body = url.endsWith('/__faults/chaos') ? REPORT : { slowMs: 0, chaos: null };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  stdout.mockRestore();
  stderr.mockRestore();
  process.exitCode = undefined;
});

describe('cu replay --times under --fault chaos', () => {
  it('sets the faults once, reads the chaos report before restoring, and puts the seed and report in the JSON summary', async () => {
    runReplayMock.mockResolvedValue({ result: success('r'), runDir: 'd', controlState: 'automation' });
    const fault = { chaos: { seed: 42, failSearch: 0.5 } };
    await program().parseAsync([
      'node', 'cu', '--base-url', BASE, 'replay', EXAMPLE, '--input', 'memberId=12345', '--auto-operator', 'abort',
      '--times', '3', '--json', '--fault', JSON.stringify(fault),
    ]);

    expect(runReplayMock).toHaveBeenCalledTimes(3);
    expect(calls).toEqual([
      'GET /__faults',
      `POST /__faults ${JSON.stringify(fault)}`,
      'GET /__faults/chaos',
      'POST /__faults {"slowMs":0,"chaos":null}',
    ]);
    const out = JSON.parse(String(stdout.mock.calls[0]?.[0])) as { chaos: unknown; stability: { runs: number } };
    expect(out.stability.runs).toBe(3);
    expect(out.chaos).toEqual({ seed: 42, fault, report: REPORT });
    expect(process.exitCode).toBe(0);
  });

  it('a --fault the target rejects (200 with rejected keys) fails setup with exit 1, runs nothing, and restores the snapshot', async () => {
    let posts = 0;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url.replace(BASE, '')}${init?.body !== undefined ? ` ${String(init.body)}` : ''}`);
      const first = method === 'POST' && (posts += 1) === 1;
      const flags = { slowMs: 0, chaos: null };
      const body = method === 'GET' ? flags : { ...flags, rejected: first ? ['chaos.failSearch'] : [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await program().parseAsync([
      'node', 'cu', '--base-url', BASE, 'replay', EXAMPLE, '--input', 'memberId=12345', '--auto-operator', 'abort',
      '--times', '3', '--json', '--fault', '{"chaos":{"seed":42,"failSearch":5}}',
    ]);
    expect(runReplayMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr.mock.calls.map((c: unknown[]) => String(c[0]))).toContain('cu replay: --fault setup failed: the target rejected: chaos.failSearch');
    expect(calls).toEqual(['GET /__faults', 'POST /__faults {"chaos":{"seed":42,"failSearch":5}}', 'POST /__faults {"slowMs":0,"chaos":null}']);
  });

  it('a --fault without chaos restores the other flags but never re-posts chaos that was already running (that would rewind it)', async () => {
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url.replace(BASE, '')}${init?.body !== undefined ? ` ${String(init.body)}` : ''}`);
      const flags = { slowMs: 0, failSearch: false, chaos: { seed: 9, failSearch: 0.5 } };
      return new Response(JSON.stringify(method === 'GET' ? flags : { ...flags, rejected: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    runReplayMock.mockResolvedValue({ result: success('r'), runDir: 'd', controlState: 'automation' });
    await program().parseAsync([
      'node', 'cu', '--base-url', BASE, 'replay', EXAMPLE, '--input', 'memberId=12345', '--auto-operator', 'abort', '--fault', '{"failSearch":true}',
    ]);
    expect(calls).toEqual(['GET /__faults', 'POST /__faults {"failSearch":true}', 'POST /__faults {"slowMs":0,"failSearch":false}']);
  });

  it('a --fault that sets chaos restores the prior chaos config too (null here), turning its own chaos off', async () => {
    runReplayMock.mockResolvedValue({ result: success('r'), runDir: 'd', controlState: 'automation' });
    await program().parseAsync([
      'node', 'cu', '--base-url', BASE, 'replay', EXAMPLE, '--input', 'memberId=12345', '--auto-operator', 'abort', '--fault', '{"chaos":{"seed":1}}',
    ]);
    expect(calls.at(-1)).toBe('POST /__faults {"slowMs":0,"chaos":null}');
  });

  it('a --fault against a target that never answers fails setup after the timeout instead of hanging', async () => {
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
    );
    const t0 = performance.now();
    await program().parseAsync([
      'node', 'cu', '--base-url', BASE, 'replay', EXAMPLE, '--input', 'memberId=12345', '--auto-operator', 'abort', '--fault', '{"failSearch":true}',
    ]);
    expect(performance.now() - t0).toBeLessThan(FAULT_HTTP_TIMEOUT_MS + 3000);
    expect(runReplayMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stderr.mock.calls.map((c: unknown[]) => String(c[0])).some((l: string) => l.startsWith('cu replay: --fault setup failed:'))).toBe(true);
  }, 20_000);

  it('without chaos in --fault, no chaos report is read and the JSON has no chaos key', async () => {
    runReplayMock.mockResolvedValue({ result: success('r'), runDir: 'd', controlState: 'automation' });
    await program().parseAsync([
      'node', 'cu', '--base-url', BASE, 'replay', EXAMPLE, '--input', 'memberId=12345', '--auto-operator', 'abort',
      '--times', '2', '--json', '--fault', '{"failSearch":true}',
    ]);
    expect(calls.some((c) => c.includes('/__faults/chaos'))).toBe(false);
    expect(Object.keys(JSON.parse(String(stdout.mock.calls[0]?.[0])) as object)).toEqual(['runs', 'stability']);
  });

  it('a single run under chaos logs the seed and the re-run flags to stderr', async () => {
    runReplayMock.mockResolvedValue({ result: success('r'), runDir: 'd', controlState: 'automation' });
    await program().parseAsync([
      'node', 'cu', '--base-url', BASE, 'replay', EXAMPLE, '--input', 'memberId=12345', '--auto-operator', 'abort',
      '--fault', '{"chaos":{"seed":42,"failSearch":0.5}}',
    ]);
    const err = stderr.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(err).toContain('chaos seed: 42');
    expect(err).toContain(`re-run this exact series: the same replay command (artifact, --input and other flags unchanged) with --times 1 --fault '{"chaos":{"seed":42,"failSearch":0.5}}'`);
  });
});

describe('cu replay --operator-port help', () => {
  it('describes the real busy-port behaviour (OS-assigned port, URL logged), not "no console"', () => {
    const replay = program().commands.find((c) => c.name() === 'replay');
    const help = replay?.options.find((o) => o.long === '--operator-port')?.description ?? '';
    expect(help).toContain('OS-assigned port');
    expect(help).not.toContain('falls back to no console');
  });
});
