/**
 * A replay run whose known values also occur inside generated fields (the run id's date, a seq
 * number, a duration) still writes a `result.json` that parses as a `ReplayResult`, with its ids,
 * timestamps, durations and evidence paths intact, and with the values gone from content fields.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReplayResult, RunEvent } from '../schema/index.js';
import { createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';
import { replayCapability } from '../replay/replay.js';
import { BASE_A, MOCK_PASSWORD, MOCK_USER, loadExample, makeFakeClock } from '../replay/test-helpers.js';
import { createRunLogger } from './logger.js';
import { createRunRedactor } from './redact.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const RUN_ID = 'run_20260926_ab1234cd';
const VALUES = ['2026', '1234'];

async function replayWithValues(inject?: (s: ReturnType<typeof createCuCoreSurface>) => void) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'run-redactor-replay-'));
  tempDirs.push(rootDir);
  const redactor = createRunRedactor({ values: () => VALUES });
  const logger = createRunLogger({ runId: RUN_ID, runKind: 'replay', rootDir, redactor });
  const clock = makeFakeClock();
  const surface = createCuCoreSurface({ clock });
  inject?.(surface);
  const result = await replayCapability({
    capability: loadExample(),
    inputs: { memberId: '12345' },
    surface,
    baseUrl: BASE_A,
    logger,
    clock,
    stepTimeoutMs: 2000,
    secret: (env) => ({ MOCK_USER, MOCK_PASSWORD })[env],
  });
  const written: unknown = JSON.parse(readFileSync(path.join(logger.dir, 'result.json'), 'utf8'));
  return { result, written, dir: logger.dir };
}

describe('the run redactor on a replay run whose values occur in generated fields', () => {
  it('writes a result.json that parses, keeps the run id and duration, and scrubs content', async () => {
    const { result, written, dir } = await replayWithValues();
    expect(result.kind).toBe('success');
    const parsed = ReplayResult.safeParse(written);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    if (!parsed.success || parsed.data.kind !== 'success') throw new Error('unreachable');
    expect(parsed.data.runId).toBe(RUN_ID);
    expect(parsed.data.durationMs).toBe(result.durationMs);
    expect(typeof parsed.data.durationMs).toBe('number');
    for (const v of Object.values(parsed.data.outputs)) {
      if (typeof v === 'string') for (const value of VALUES) expect(v).not.toContain(value);
    }

    const events = readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => RunEvent.parse(JSON.parse(l)));
    expect(events.every((e) => e.runId === RUN_ID)).toBe(true);
  });

  it('keeps a hard failure parseable, with its evidence paths pointing at files that exist', async () => {
    const { result, written, dir } = await replayWithValues((s) =>
      s.inject({ kind: 'act_error', match: { actionType: 'click' }, code: 'app_error', message: 'Search failed for 12345 in 2026.' }),
    );
    expect(result.kind).toBe('hard_failure');
    const parsed = ReplayResult.safeParse(written);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    if (!parsed.success || parsed.data.kind !== 'hard_failure') throw new Error('unreachable');
    expect(parsed.data.runId).toBe(RUN_ID);
    for (const rel of [parsed.data.evidence.screenshot, parsed.data.evidence.dom]) {
      if (rel !== undefined) expect(existsSync(path.join(dir, rel)), rel).toBe(true);
    }
    for (const value of VALUES) {
      expect(parsed.data.message).not.toContain(value);
      expect(parsed.data.observed).not.toContain(value);
    }
    // The DOM snapshots keep their markup: every tag the snapshot had is still there.
    const domDir = path.join(dir, 'dom');
    if (existsSync(domDir)) {
      for (const f of readdirSync(domDir)) {
        const html = readFileSync(path.join(domDir, f), 'utf8');
        expect(html).not.toContain('[REDACTED]<');
      }
    }
  });
});
