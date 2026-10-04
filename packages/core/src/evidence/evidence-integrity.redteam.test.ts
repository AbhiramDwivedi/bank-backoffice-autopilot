/**
 * Evidence integrity (packages/core/src/evidence/logger.ts).
 *
 * Answers, with tests rather than assertions from reading the code:
 *   - Is `seq` strictly monotonic under concurrent async writes?
 *   - Is `run_finished` always the last event, even if something races right up to `finish()`?
 *   - What happens if a caller logs an event AFTER `finish()` -- silently dropped, or a loud error?
 *   - Can a crash mid-`finish()` (an invalid `ReplayResult` shape) leave `result.json` missing
 *     forever, or does the logger stay retryable, which `replay.ts` relies on: it calls
 *     `log.finish(result)` a second time with a minimal fallback result if the first call throws
 *     (see replay.ts's outer try/catch around `log.finish`)?
 *   - Is every screenshot/DOM path referenced in events.jsonl/result.json an actual file that
 *     exists, across a real (non-toy) replay run including a failure?
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunLogger } from './logger.js';
import { newRunId } from './ids.js';
import type { RunEvent } from '../schema/index.js';
import { runReplay } from '../replay/test-helpers.js';
import { createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';

const tmpRoots: string[] = [];
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeLoggerDir() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'evidence-integrity-'));
  tmpRoots.push(rootDir);
  return rootDir;
}

function readEvents(dir: string): RunEvent[] {
  return readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as RunEvent);
}

describe('seq is strictly monotonic under concurrent async writers', () => {
  it('50 concurrent async event-writers, each delayed by a random micro/macrotask hop, still produce seq 0..N with no gaps or duplicates, in file order', async () => {
    const rootDir = makeLoggerDir();
    const runId = newRunId();
    const logger = createRunLogger({ runId, runKind: 'replay', rootDir });

    const N = 50;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        (async () => {
          // A random hop (0-3 macrotask ticks) so writers genuinely interleave their SCHEDULING,
          // even though each individual logger.event() call is itself synchronous.
          const hops = i % 4;
          for (let h = 0; h < hops; h++) await new Promise((r) => setTimeout(r, 0));
          logger.event({ kind: 'observation', data: { i } });
        })(),
      ),
    );
    logger.finish({ status: 'success' });

    const events = readEvents(logger.dir);
    const seqs = events.map((e) => e.seq);
    const expected = Array.from({ length: events.length }, (_, i) => i);
    expect(seqs).toEqual(expected); // strictly increasing, no gaps, no duplicates, matches file order
    expect(new Set(seqs).size).toBe(seqs.length); // belt and suspenders: no duplicate seq at all
    expect(events[events.length - 1]!.kind).toBe('run_finished');
  });
});

describe('run_finished is always last, and logging after finish() is refused, never silently reordered', () => {
  it('a burst of concurrent writers racing right up to finish() never lands after run_finished', async () => {
    const rootDir = makeLoggerDir();
    const runId = newRunId();
    const logger = createRunLogger({ runId, runKind: 'replay', rootDir });

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (async () => {
          if (i % 2 === 0) await new Promise((r) => setTimeout(r, 0));
          logger.event({ kind: 'action_result', data: { i } });
        })(),
      ),
    );
    logger.finish({ status: 'success' });

    const events = readEvents(logger.dir);
    const finishedIdx = events.findIndex((e) => e.kind === 'run_finished');
    expect(finishedIdx).toBe(events.length - 1);
    expect(events.filter((e) => e.kind === 'run_finished')).toHaveLength(1);
  });

  it('event() after finish() throws (and therefore cannot have been appended) rather than silently dropping or reordering', () => {
    const rootDir = makeLoggerDir();
    const runId = newRunId();
    const logger = createRunLogger({ runId, runKind: 'replay', rootDir });
    logger.finish({ status: 'success' });

    expect(() => logger.event({ kind: 'observation', data: {} })).toThrow(/already finished/);

    const events = readEvents(logger.dir);
    expect(events[events.length - 1]!.kind).toBe('run_finished');
    expect(events.some((e) => e.kind === 'observation')).toBe(false);
  });
});

describe('a crash mid-finish() (invalid ReplayResult shape) does not permanently strand result.json', () => {
  it('finish() with a malformed "success" result throws BEFORE writing result.json and BEFORE marking the run finished, so a caller (replay.ts\'s own outer try/catch) can retry with a valid fallback result and still get one written', () => {
    const rootDir = makeLoggerDir();
    const runId = newRunId();
    const logger = createRunLogger({ runId, runKind: 'replay', rootDir });

    // Missing every required field of the `success` ReplayResult variant.
    expect(() => logger.finish({ kind: 'success' })).toThrow();
    expect(existsSync(path.join(logger.dir, 'result.json'))).toBe(false);

    // The logger must still be retryable: `finished` was never flipped by the failed attempt.
    expect(() => logger.event({ kind: 'observation', data: {} })).not.toThrow();

    const fallback = {
      runId,
      capabilityId: 'unknown',
      capabilityVersion: '0.0.0',
      stepsExecuted: 0,
      durationMs: 0,
      locatorReport: [],
      recoveries: [],
      kind: 'hard_failure' as const,
      code: 'internal' as const,
      expected: 'a result that satisfies the ReplayResult schema',
      observed: 'first finish() attempt threw',
      message: 'first finish() attempt threw',
      evidence: {},
    };
    expect(() => logger.finish(fallback)).not.toThrow();
    expect(existsSync(path.join(logger.dir, 'result.json'))).toBe(true);
    const written = JSON.parse(readFileSync(path.join(logger.dir, 'result.json'), 'utf8')) as { kind: string };
    expect(written.kind).toBe('hard_failure');

    // Now genuinely finished: a second finish() is refused (never overwrites a persisted result).
    expect(() => logger.finish(fallback)).toThrow(/already finished/);
  });
});

describe('every screenshot/DOM path referenced in a real run\'s events/result actually exists on disk', () => {
  it('a real replay run that fails (element_not_found, DOM+screenshot evidence) leaves every referenced evidence file present', async () => {
    const surface = createCuCoreSurface();
    surface.inject({ kind: 'hide_element', elementId: 'signOn' });
    const { events, resultJson, runDir } = await runReplay({ surface });

    const referenced = new Set<string>();
    for (const e of events) {
      if (e.evidence?.screenshot) referenced.add(e.evidence.screenshot);
      if (e.evidence?.dom) referenced.add(e.evidence.dom);
    }
    const result = resultJson as { evidence?: { screenshot?: string; dom?: string } };
    if (result.evidence?.screenshot) referenced.add(result.evidence.screenshot);
    if (result.evidence?.dom) referenced.add(result.evidence.dom);

    expect(referenced.size).toBeGreaterThan(0); // sanity: this run actually produced evidence paths
    for (const rel of referenced) {
      expect(existsSync(path.join(runDir, rel)), `referenced evidence file missing: ${rel}`).toBe(true);
    }
  });
});
