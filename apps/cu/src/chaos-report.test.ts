/**
 * The chaos half of `replay --times N`: finding the seed in `--fault`, reading and validating the
 * target's `GET /__faults/chaos` report through an injected fetch, and the human lines.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CHAOS_REPORT_TIMEOUT_MS,
  chaosSeedOf,
  collectSeriesChaos,
  parseTargetChaosReport,
  rerunLine,
  restoreBodyFor,
  seriesChaosLines,
  shellQuote,
  type SeriesChaos,
} from './chaos-report.js';

const REPORT = {
  config: { seed: 42, failSearch: 0.3 },
  stats: { failSearch: { draws: 4, fired: 1 }, interstitial: { draws: 6, fired: 2 } },
  log: [
    { seq: 1, kind: 'interstitial', draw: 2, method: 'GET', path: '/members/12345' },
    { seq: 2, kind: 'failSearch', draw: 3, method: 'GET', path: '/members/search' },
    { seq: 3, kind: 'slowMs', draw: 1, method: 'GET', path: '/members/search', delayMs: 250 },
  ],
  logDropped: 0,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('chaosSeedOf', () => {
  it('finds the seed of a chaos object, and nothing otherwise', () => {
    expect(chaosSeedOf({ chaos: { seed: 7, failSearch: 0.1 } })).toBe(7);
    expect(chaosSeedOf({ chaos: { seed: 0 } })).toBe(0);
    expect(chaosSeedOf({ chaos: null })).toBeUndefined();
    expect(chaosSeedOf({ failSearch: true })).toBeUndefined();
    expect(chaosSeedOf(undefined)).toBeUndefined();
    expect(chaosSeedOf([])).toBeUndefined();
  });
});

describe('restoreBodyFor', () => {
  const snapshot = { slowMs: 0, failSearch: false, chaos: { seed: 9, failSearch: 0.5 } };

  it('leaves chaos out when --fault did not set it, so running chaos is not rewound', () => {
    expect(restoreBodyFor(snapshot, { failSearch: true })).toEqual({ slowMs: 0, failSearch: false });
    expect(snapshot.chaos).toEqual({ seed: 9, failSearch: 0.5 }); // the snapshot itself is not mutated
  });

  it('restores the prior chaos config (null included) when --fault set chaos', () => {
    expect(restoreBodyFor(snapshot, { chaos: { seed: 1 } })).toEqual(snapshot);
    expect(restoreBodyFor({ slowMs: 0, chaos: null }, { chaos: null })).toEqual({ slowMs: 0, chaos: null });
  });

  it('passes anything without a chaos key through unchanged', () => {
    expect(restoreBodyFor({ slowMs: 0 }, { failSearch: true })).toEqual({ slowMs: 0 });
    expect(restoreBodyFor('x', {})).toBe('x');
  });
});

describe('parseTargetChaosReport', () => {
  it('accepts the mock app report shape', () => {
    expect(parseTargetChaosReport(REPORT)).toEqual(REPORT);
  });

  it.each([
    ['a non-object', 'x'],
    ['no stats', { log: [] }],
    ['no log', { stats: {} }],
    ['malformed stats', { stats: { failSearch: { draws: 'x' } }, log: [] }],
    ['a malformed log entry', { stats: {}, log: [{ seq: 1 }] }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseTargetChaosReport(raw)).toThrow();
  });
});

describe('collectSeriesChaos', () => {
  it('returns undefined without fetching when --fault sets no chaos', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await collectSeriesChaos('http://localhost:1', { failSearch: true }, fetchImpl)).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads GET <baseUrl>/__faults/chaos and echoes the seed and the exact fault body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(REPORT));
    const fault = { interstitial: false, chaos: { seed: 42, failSearch: 0.3 } };
    const chaos = await collectSeriesChaos('http://localhost:1', fault, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:1/__faults/chaos', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(chaos).toEqual({ seed: 42, fault, report: REPORT });
  });

  it('never throws: an HTTP error or a non-report body still echoes the seed, with the reason', async () => {
    const notFound = await collectSeriesChaos('http://h', { chaos: { seed: 1 } }, async () => jsonResponse({}, 404));
    expect(notFound).toEqual({ seed: 1, fault: { chaos: { seed: 1 } }, reportError: 'GET http://h/__faults/chaos -> HTTP 404' });
    const wrongShape = await collectSeriesChaos('http://h', { chaos: { seed: 1 } }, async () => jsonResponse({ hello: 1 }));
    expect(wrongShape?.reportError).toContain('not a chaos report');
    const refused = await collectSeriesChaos('http://h', { chaos: { seed: 1 } }, async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(refused?.reportError).toBe('ECONNREFUSED');
  });

  it('gives up on a target that never answers, after the timeout, through the same reportError path', async () => {
    // Never resolves on its own; only the abort signal ends it, as with a real hung server.
    const hung = (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const t0 = performance.now();
    const chaos = await collectSeriesChaos('http://h', { chaos: { seed: 1 } }, hung as typeof fetch, 50);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(chaos?.seed).toBe(1);
    expect(chaos?.report).toBeUndefined();
    expect(chaos?.reportError).toMatch(/timeout|aborted/i);
  });

  it('passes a timeout signal by default', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(REPORT));
    await collectSeriesChaos('http://h', { chaos: { seed: 1 } }, fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(CHAOS_REPORT_TIMEOUT_MS).toBe(5000);
  });
});

describe('seriesChaosLines', () => {
  it('shows the seed, per-kind counters, the injected faults in order, and the exact re-run flags', () => {
    const chaos: SeriesChaos = { seed: 42, fault: { chaos: { seed: 42, failSearch: 0.3 } }, report: REPORT };
    const lines = seriesChaosLines(chaos, 5);
    expect(lines[0]).toBe('chaos seed: 42');
    expect(lines).toContain('  kind          fired  draws');
    expect(lines).toContain('  failSearch        1      4');
    expect(lines).toContain('    #2 failSearch (draw 3) GET /members/search');
    expect(lines).toContain('    #3 slowMs (draw 1) GET /members/search +250ms');
    expect(lines.at(-1)).toBe(`re-run this exact series: the same replay command (artifact, --input and other flags unchanged) with --times 5 --fault '{"chaos":{"seed":42,"failSearch":0.3}}'`);
  });

  it('quotes the fault for bash even when it contains a single quote, and says it is a fragment of the command', () => {
    const fault = { denyMember: "o'brien", chaos: { seed: 1 } };
    const line = rerunLine(4, fault);
    expect(line).toBe(
      `re-run this exact series: the same replay command (artifact, --input and other flags unchanged) with --times 4 --fault '{"denyMember":"o'\\''brien","chaos":{"seed":1}}'`,
    );
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
    expect(shellQuote('')).toBe(`''`);
  });

  it('caps the human log and points at --json for the rest', () => {
    const log = Array.from({ length: 25 }, (_, i) => ({ seq: i + 1, kind: 'failSearch', draw: i + 1, method: 'GET', path: '/members/search' }));
    const lines = seriesChaosLines({ seed: 1, fault: {}, report: { ...REPORT, log } }, 2);
    expect(lines.filter((l) => l.startsWith('    #'))).toHaveLength(20);
    expect(lines).toContain('    ... 5 more (--json has the full log)');
  });

  it('still echoes the seed and the re-run flags when the report could not be read', () => {
    const lines = seriesChaosLines({ seed: 9, fault: { chaos: { seed: 9 } }, reportError: 'HTTP 404' }, 3);
    expect(lines[0]).toBe('chaos seed: 9');
    expect(lines[1]).toContain('HTTP 404');
    expect(lines.at(-1)).toContain('--times 3');
  });
});
