import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunLogger } from './logger.js';
import { RunEvent } from '../schema/run-event.js';

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

describe('createRunLogger', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  function makeRoot(): string {
    root = mkdtempSync(path.join(tmpdir(), 'evidence-logger-'));
    return root;
  }

  it('writes run_started first at seq 0, then monotonically increasing seq', () => {
    const rootDir = makeRoot();
    const logger = createRunLogger({ runId: 'run_20260101_aaaaaaaa', runKind: 'replay', rootDir });
    logger.event({ kind: 'action', data: { note: 'step 1' } });
    logger.event({ kind: 'action_result', data: { note: 'step 2' } });

    const lines = readFileSync(path.join(logger.dir, 'events.jsonl'), 'utf8').trim().split('\n');
    const events = lines.map((l) => JSON.parse(l) as { kind: string; seq: number });
    expect(events[0]?.kind).toBe('run_started');
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('every appended line parses as a valid RunEvent with an ISO ts', () => {
    const rootDir = makeRoot();
    const logger = createRunLogger({ runId: 'run_20260101_bbbbbbbb', runKind: 'discovery', rootDir });
    logger.event({ kind: 'observation', data: { url: 'http://localhost:4173/login' } });
    logger.event({ kind: 'decision', stepId: 's01', data: { reasoning: 'click login' } });

    const lines = readFileSync(path.join(logger.dir, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(lines.length).toBe(3);
    for (const line of lines) {
      const parsed = RunEvent.parse(JSON.parse(line));
      expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts);
    }
  });

  it('redacts data deeply so a raw secret and a raw SSN never appear anywhere on disk', () => {
    const rootDir = makeRoot();
    const logger = createRunLogger({ runId: 'run_20260101_cccccccc', runKind: 'replay', rootDir });
    const secret = 'hunter2-raw-password-value';
    const ssn = '123-45-6789';

    logger.event({ kind: 'action', data: { password: secret, note: `ssn is ${ssn}` } });
    logger.finish({
      runId: logger.runId,
      capabilityId: 'lookup-member-savings-balance',
      capabilityVersion: '1.0.0',
      stepsExecuted: 1,
      durationMs: 10,
      locatorReport: [],
      recoveries: [],
      kind: 'success',
      outputs: { password: secret },
    });

    for (const file of walkFiles(logger.dir)) {
      const contents = readFileSync(file, 'utf8');
      expect(contents.includes(secret)).toBe(false);
      expect(contents.includes(ssn)).toBe(false);
    }
  });

  it('screenshot()/dom() write under the run dir, default to the next event seq, and dom is pattern-redacted', () => {
    const rootDir = makeRoot();
    const logger = createRunLogger({ runId: 'run_20260101_dddddddd', runKind: 'replay', rootDir });
    logger.event({ kind: 'action', data: {} }); // consumes seq 1 (seq 0 was run_started)

    const shotPath = logger.screenshot(Buffer.from([137, 80, 78, 71]));
    expect(shotPath).toBe('shots/2.png');
    expect(existsSync(path.join(logger.dir, 'shots', '2.png'))).toBe(true);

    const domPath = logger.dom('<div>ssn 123-45-6789</div>', 5);
    expect(domPath).toBe('dom/5.html');
    const domContents = readFileSync(path.join(logger.dir, 'dom', '5.html'), 'utf8');
    expect(domContents).not.toContain('123-45-6789');
    expect(domContents).toContain('[REDACTED:ssn]');
  });

  it('finish() writes a valid ReplayResult to result.json and appends run_finished', () => {
    const rootDir = makeRoot();
    const logger = createRunLogger({ runId: 'run_20260101_eeeeeeee', runKind: 'replay', rootDir });
    const relPath = logger.finish({
      runId: logger.runId,
      capabilityId: 'lookup-member-savings-balance',
      capabilityVersion: '1.0.0',
      stepsExecuted: 3,
      durationMs: 123,
      locatorReport: [],
      recoveries: [],
      kind: 'success',
      outputs: { memberName: 'Jane Q. Sample' },
    });
    expect(relPath).toBe('result.json');

    const written = JSON.parse(readFileSync(path.join(logger.dir, 'result.json'), 'utf8')) as { kind: string };
    expect(written.kind).toBe('success');

    const lines = readFileSync(path.join(logger.dir, 'events.jsonl'), 'utf8').trim().split('\n');
    const events = lines.map((l) => JSON.parse(l) as { kind: string; data: unknown });
    const last = events[events.length - 1];
    expect(last?.kind).toBe('run_finished');
    expect(last?.data).toEqual({ kind: 'success' });
  });

  it('rejects an invalid ReplayResult shape passed to finish()', () => {
    const rootDir = makeRoot();
    const logger = createRunLogger({ runId: 'run_20260101_ffffffff', runKind: 'replay', rootDir });
    expect(() => logger.finish({ kind: 'success' })).toThrow();
  });

  it('writes a non-ReplayResult-shaped (e.g. discovery) result as-is', () => {
    const rootDir = makeRoot();
    const logger = createRunLogger({ runId: 'run_20260101_gggggggg', runKind: 'discovery', rootDir });
    const relPath = logger.finish({ kind: 'discovery_summary', memberId: '12345', savingsBalance: 1234.56 });
    expect(relPath).toBe('result.json');
    const written = JSON.parse(readFileSync(path.join(logger.dir, 'result.json'), 'utf8')) as { kind: string };
    expect(written.kind).toBe('discovery_summary');
  });

  it('throws if event() is called after finish()', () => {
    const rootDir = makeRoot();
    const logger = createRunLogger({ runId: 'run_20260101_hhhhhhhh', runKind: 'replay', rootDir });
    logger.finish({ kind: 'not_a_replay_result' });
    expect(() => logger.event({ kind: 'action', data: {} })).toThrow();
  });

  it('throws if finish() is called twice', () => {
    const rootDir = makeRoot();
    const logger = createRunLogger({ runId: 'run_20260101_jjjjjjjj', runKind: 'replay', rootDir });
    logger.finish({ kind: 'not_a_replay_result' });
    expect(() => logger.finish({ kind: 'not_a_replay_result' })).toThrow();
  });

  it('dir is an absolute path ending in the runId', () => {
    const rootDir = makeRoot();
    const logger = createRunLogger({ runId: 'run_20260101_iiiiiiii', runKind: 'replay', rootDir });
    expect(path.isAbsolute(logger.dir)).toBe(true);
    expect(logger.dir.endsWith('run_20260101_iiiiiiii')).toBe(true);
  });
});
