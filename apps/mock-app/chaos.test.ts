/**
 * Unit tests for chaos.ts: the PRNG (determinism, a pinned reference sequence, distribution
 * sanity), per-kind stream independence, chaos-config validation, and the runtime's counters and
 * log. The HTTP-level behaviour (precedence, isolation, reset, the routes) is in
 * faults.chaos.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  CHAOS_KINDS,
  CHAOS_LOG_LIMIT,
  chaosReport,
  createChaosRuntime,
  drawDelay,
  drawFault,
  mulberry32,
  parseChaos,
  streamSeed,
  type ChaosConfig,
} from './chaos.js';

const SITE = { method: 'GET', path: '/members/search' };

function take(next: () => number, n: number): number[] {
  return Array.from({ length: n }, () => next());
}

describe('mulberry32', () => {
  it('is deterministic: the same seed gives the same sequence', () => {
    expect(take(mulberry32(42), 50)).toEqual(take(mulberry32(42), 50));
  });

  it('pins the reference sequence for seed 42 (changing the generator silently re-rolls every pinned-seed test)', () => {
    expect(take(mulberry32(42), 3)).toEqual([0.6011037519201636, 0.44829055899754167, 0.8524657934904099]);
  });

  it('different seeds give different sequences', () => {
    expect(take(mulberry32(1), 10)).not.toEqual(take(mulberry32(2), 10));
  });

  it('treats the seed as unsigned 32-bit', () => {
    expect(take(mulberry32(2 ** 32 + 7), 5)).toEqual(take(mulberry32(7), 5));
  });

  it('produces floats in [0, 1), roughly uniform over a large sample', () => {
    const next = mulberry32(12345);
    const n = 200_000;
    const buckets = new Array<number>(10).fill(0);
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      const x = next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      sum += x;
      buckets[Math.floor(x * 10)]! += 1;
    }
    expect(sum / n).toBeGreaterThan(0.495);
    expect(sum / n).toBeLessThan(0.505);
    // Each decile holds 10% +/- 0.5% of the sample (the expected deviation is ~0.07%).
    for (const b of buckets) {
      expect(b / n).toBeGreaterThan(0.095);
      expect(b / n).toBeLessThan(0.105);
    }
  });
});

describe('per-kind streams', () => {
  it('every kind gets a distinct stream seed, and the derivation is a pure function of (seed, kind)', () => {
    const seeds = CHAOS_KINDS.map((k) => streamSeed(42, k));
    expect(new Set(seeds).size).toBe(CHAOS_KINDS.length);
    expect(CHAOS_KINDS.map((k) => streamSeed(42, k))).toEqual(seeds);
    expect(streamSeed(43, 'failSearch')).not.toBe(streamSeed(42, 'failSearch'));
  });

  it('a kind fires on the same draws whether or not other kinds are configured and drawing', () => {
    const firedDraws = (config: ChaosConfig, interleave: boolean): number[] => {
      const rt = createChaosRuntime(config);
      for (let i = 0; i < 500; i += 1) {
        if (interleave) {
          // Other kinds draw a varying number of times between failSearch draws.
          for (let j = 0; j < i % 4; j += 1) drawFault(rt, 'interstitial', SITE);
          drawDelay(rt, SITE);
          drawFault(rt, 'expireSession', SITE);
        }
        drawFault(rt, 'failSearch', SITE);
      }
      return rt.log.filter((e) => e.kind === 'failSearch').map((e) => e.draw);
    };
    const alone = firedDraws({ seed: 7, failSearch: 0.1 }, false);
    const crowded = firedDraws(
      { seed: 7, failSearch: 0.1, interstitial: 0.5, expireSession: 0.3, slowMs: { p: 0.5, minMs: 1, maxMs: 9 } },
      true,
    );
    expect(alone.length).toBeGreaterThan(20);
    expect(crowded).toEqual(alone);
  });

  it('fire rate matches the configured probability over a large sample', () => {
    const rt = createChaosRuntime({ seed: 99, failSearch: 0.05 });
    for (let i = 0; i < 100_000; i += 1) drawFault(rt, 'failSearch', SITE);
    const stats = rt.stats.failSearch!;
    expect(stats.draws).toBe(100_000);
    // 5000 expected, standard deviation ~69.
    expect(stats.fired).toBeGreaterThan(4700);
    expect(stats.fired).toBeLessThan(5300);
  });

  it('probability 0 never fires and probability 1 always fires', () => {
    const rt = createChaosRuntime({ seed: 1, failSearch: 0, expireSession: 1 });
    for (let i = 0; i < 1000; i += 1) {
      expect(drawFault(rt, 'failSearch', SITE)).toBe(false);
      expect(drawFault(rt, 'expireSession', SITE)).toBe(true);
    }
  });

  it('an unconfigured kind never draws, and a null runtime never fires', () => {
    const rt = createChaosRuntime({ seed: 1, failSearch: 1 });
    expect(drawFault(rt, 'interstitial', SITE)).toBe(false);
    expect(drawDelay(rt, SITE)).toBe(0);
    expect(rt.stats.interstitial).toBeUndefined();
    expect(rt.stats.slowMs).toBeUndefined();
    expect(drawFault(null, 'failSearch', SITE)).toBe(false);
    expect(drawDelay(null, SITE)).toBe(0);
  });

  it('slowMs delays are integers within [minMs, maxMs] and cover the range', () => {
    const rt = createChaosRuntime({ seed: 5, slowMs: { p: 1, minMs: 100, maxMs: 104 } });
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i += 1) {
      const d = drawDelay(rt, SITE);
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(100);
      expect(d).toBeLessThanOrEqual(104);
      seen.add(d);
    }
    expect([...seen].sort()).toEqual([100, 101, 102, 103, 104]);
  });
});

describe('runtime counters and log', () => {
  it('counts draws and fires per kind and logs only fired draws, in order, with their per-kind draw index', () => {
    const rt = createChaosRuntime({ seed: 3, failSearch: 1, interstitial: 0, slowMs: { p: 1, minMs: 7, maxMs: 7 } });
    drawFault(rt, 'failSearch', { method: 'GET', path: '/members/search' });
    drawFault(rt, 'interstitial', { method: 'GET', path: '/members/12345' });
    drawDelay(rt, { method: 'POST', path: '/members/12345/subaccounts' });
    drawFault(rt, 'failSearch', { method: 'GET', path: '/members/search' });

    const report = chaosReport(rt);
    expect(report.stats).toEqual({
      failSearch: { draws: 2, fired: 2 },
      slowMs: { draws: 1, fired: 1 },
      interstitial: { draws: 1, fired: 0 },
    });
    expect(report.log).toEqual([
      { seq: 1, kind: 'failSearch', draw: 1, method: 'GET', path: '/members/search' },
      { seq: 2, kind: 'slowMs', draw: 1, method: 'POST', path: '/members/12345/subaccounts', delayMs: 7 },
      { seq: 3, kind: 'failSearch', draw: 2, method: 'GET', path: '/members/search' },
    ]);
    expect(report.logDropped).toBe(0);
  });

  it('the report is a copy: mutating it (config included) does not touch the live runtime', () => {
    const rt = createChaosRuntime({ seed: 3, failSearch: 1, slowMs: { p: 0, minMs: 1, maxMs: 2 } });
    drawFault(rt, 'failSearch', SITE);
    const report = chaosReport(rt);
    report.stats.failSearch!.fired = 99;
    report.log.length = 0;
    report.config!.failSearch = 0;
    report.config!.slowMs!.p = 1;
    expect(rt.stats.failSearch!.fired).toBe(1);
    expect(rt.log).toHaveLength(1);
    expect(rt.config.failSearch).toBe(1);
    expect(rt.config.slowMs!.p).toBe(0);
    expect(report.config).not.toBe(rt.config);
  });

  it('a slowMs draw that comes out at 0 ms is a draw, but not a fired fault and not a log entry', () => {
    const rt = createChaosRuntime({ seed: 4, slowMs: { p: 1, minMs: 0, maxMs: 0 } });
    for (let i = 0; i < 5; i += 1) expect(drawDelay(rt, SITE)).toBe(0);
    expect(rt.stats.slowMs).toEqual({ draws: 5, fired: 0 });
    expect(rt.log).toEqual([]);
  });

  it(`keeps only the latest ${CHAOS_LOG_LIMIT} log entries and counts the dropped ones`, () => {
    const rt = createChaosRuntime({ seed: 3, failSearch: 1 });
    for (let i = 0; i < CHAOS_LOG_LIMIT + 5; i += 1) drawFault(rt, 'failSearch', SITE);
    const report = chaosReport(rt);
    expect(report.log).toHaveLength(CHAOS_LOG_LIMIT);
    expect(report.logDropped).toBe(5);
    expect(report.log[0]!.seq).toBe(6);
    expect(report.log.at(-1)!.seq).toBe(CHAOS_LOG_LIMIT + 5);
  });

  it('chaos off reports an empty, null-config report', () => {
    expect(chaosReport(null)).toEqual({ config: null, stats: {}, log: [], logDropped: 0 });
  });
});

describe('parseChaos', () => {
  it('accepts null (off) and a full valid config', () => {
    expect(parseChaos(null)).toEqual({ ok: true, config: null });
    const full = { seed: 42, failSearch: 0.05, interstitial: 0.2, expireSession: 0.02, slowMs: { p: 0.3, minMs: 0, maxMs: 3000 } };
    expect(parseChaos(full)).toEqual({ ok: true, config: full });
  });

  it('accepts the seed bounds 0 and 2^32-1, and a seed-only config', () => {
    expect(parseChaos({ seed: 0 })).toEqual({ ok: true, config: { seed: 0 } });
    expect(parseChaos({ seed: 0xffffffff }).ok).toBe(true);
  });

  it.each([
    ['a non-object', 'nope', ['chaos (expected an object or null)']],
    ['an array', [1], ['chaos (expected an object or null)']],
    ['a missing seed', { failSearch: 0.1 }, ['chaos.seed (required)']],
    ['a negative seed', { seed: -1 }, ['chaos.seed']],
    ['a fractional seed', { seed: 1.5 }, ['chaos.seed']],
    ['a seed above 2^32-1', { seed: 2 ** 32 }, ['chaos.seed']],
    ['a string seed', { seed: '42' }, ['chaos.seed']],
    ['a probability above 1', { seed: 1, failSearch: 1.01 }, ['chaos.failSearch']],
    ['a negative probability', { seed: 1, interstitial: -0.1 }, ['chaos.interstitial']],
    ['a boolean probability', { seed: 1, expireSession: true }, ['chaos.expireSession']],
    ['an unknown kind', { seed: 1, denyMember: 0.5 }, ['chaos.denyMember']],
    ['slowMs as a bare range', { seed: 1, slowMs: [0, 3000] }, ['chaos.slowMs (expected {p, minMs, maxMs})']],
    ['slowMs with maxMs < minMs', { seed: 1, slowMs: { p: 1, minMs: 10, maxMs: 5 } }, ['chaos.slowMs.maxMs (must be >= minMs)']],
    ['slowMs with an unknown field', { seed: 1, slowMs: { p: 1, minMs: 0, maxMs: 5, jitter: 1 } }, ['chaos.slowMs.jitter']],
    ['slowMs with a fractional delay', { seed: 1, slowMs: { p: 1, minMs: 0.5, maxMs: 5 } }, ['chaos.slowMs.minMs']],
    ['slowMs with a delay over the cap', { seed: 1, slowMs: { p: 1, minMs: 0, maxMs: 120_001 } }, ['chaos.slowMs.maxMs']],
    ['slowMs missing p', { seed: 1, slowMs: { minMs: 0, maxMs: 5 } }, ['chaos.slowMs.p']],
  ])('rejects %s and names every problem', (_label, value, rejected) => {
    expect(parseChaos(value)).toEqual({ ok: false, rejected });
  });

  it('reports every problem in one object, not just the first', () => {
    const parsed = parseChaos({ seed: 'x', failSearch: 2, bogus: 1 });
    expect(parsed).toEqual({ ok: false, rejected: ['chaos.seed', 'chaos.failSearch', 'chaos.bogus'] });
  });
});
