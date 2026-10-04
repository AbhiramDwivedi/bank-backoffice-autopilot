/**
 * Unit tests for the `approve` CLI command core (`runApprove`, `findSuccessfulReplay`). Every
 * fixture lives under a temp dir created per test; nothing here touches the real `artifacts/` or
 * `runs/` directories.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findSuccessfulReplay, runApprove } from './approve.js';
import { capabilityDigest, validateCapability, type Capability, type ReplayResult } from '@cu/core/schema';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'approve-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// -------------------------------------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------------------------------------

function minimalCapability(overrides: Partial<Capability> = {}): Capability {
  return {
    schemaVersion: '1.0',
    id: 'test-capability',
    version: '1.0.1',
    name: 'Test Capability',
    description: 'A minimal capability used to test the approve command.',
    app: { vendor: 'Acme', product: 'Widget', surface: 'web', entryUrl: '{baseUrl}/login' },
    status: 'draft',
    riskLevel: 'read',
    inputs: {},
    outputs: {},
    steps: [{ id: 's01', name: 'Open the login page', action: { type: 'navigate', url: '{baseUrl}/login' }, risk: 'read' }],
    success: { condition: { kind: 'url_matches', pattern: '/login' }, description: 'On the login page.' },
    businessOutcomes: [],
    recoveryRules: [],
    provenance: { discoveredAt: '2026-01-01T00:00:00Z', discoveryRunId: 'run-0', recordedBy: 'human' },
    ...overrides,
  } as Capability;
}

function writeArtifact(cap: Capability): string {
  const file = path.join(dir, 'artifact.json');
  writeFileSync(file, JSON.stringify(cap, null, 2), 'utf8');
  return file;
}

const REPLAY_BASE = {
  runId: 'run-abc',
  capabilityId: 'test-capability',
  capabilityVersion: '1.0.1',
  stepsExecuted: 1,
  durationMs: 100,
  locatorReport: [],
  recoveries: [],
};

/** A `success` ReplayResult by default; pass `kindOverrides` to build a different `kind` entirely
 *  (it replaces `{ kind: 'success', outputs: {} }`, since ReplayResult is a strict discriminated union). */
function replayResult(fieldOverrides: Partial<typeof REPLAY_BASE> = {}, kindOverrides: Record<string, unknown> = { kind: 'success', outputs: {} }): ReplayResult {
  return { ...REPLAY_BASE, ...fieldOverrides, ...kindOverrides } as unknown as ReplayResult;
}

function writeRun(runsDir: string, runId: string, result: unknown): void {
  const runDir = path.join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
}

// -------------------------------------------------------------------------------------------
// findSuccessfulReplay
// -------------------------------------------------------------------------------------------

describe('findSuccessfulReplay', () => {
  it('returns undefined when runsDir does not exist', () => {
    expect(findSuccessfulReplay(path.join(dir, 'no-such-dir'), 'test-capability', '1.0.1')).toBeUndefined();
  });

  it('returns undefined when no run matches the id/version', () => {
    const runsDir = path.join(dir, 'runs');
    writeRun(runsDir, 'run-1', replayResult({ capabilityId: 'other-capability' }));
    writeRun(runsDir, 'run-2', replayResult({ capabilityVersion: '1.0.2' }));
    expect(findSuccessfulReplay(runsDir, 'test-capability', '1.0.1')).toBeUndefined();
  });

  it('returns undefined when the only matching runs are hard_failure/escalated', () => {
    const runsDir = path.join(dir, 'runs');
    writeRun(
      runsDir,
      'run-1',
      replayResult({}, { kind: 'hard_failure', code: 'checkpoint_failed', expected: 'x', observed: 'y', message: 'm', evidence: {} }),
    );
    writeRun(runsDir, 'run-2', replayResult({}, { kind: 'escalated', interventionId: 'i1', reason: 'stuck' }));
    expect(findSuccessfulReplay(runsDir, 'test-capability', '1.0.1')).toBeUndefined();
  });

  it('finds a matching success run', () => {
    const runsDir = path.join(dir, 'runs');
    writeRun(runsDir, 'run-1', replayResult());
    const found = findSuccessfulReplay(runsDir, 'test-capability', '1.0.1');
    expect(found?.kind).toBe('success');
    expect(found?.runId).toBe('run-abc');
  });

  it('finds a matching business_outcome run too', () => {
    const runsDir = path.join(dir, 'runs');
    writeRun(runsDir, 'run-1', replayResult({}, { kind: 'business_outcome', name: 'member_not_found', data: {} }));
    const found = findSuccessfulReplay(runsDir, 'test-capability', '1.0.1');
    expect(found?.kind).toBe('business_outcome');
  });

  it('ignores a result.json that is not valid JSON or not a ReplayResult', () => {
    const runsDir = path.join(dir, 'runs');
    const brokenDir = path.join(runsDir, 'run-broken');
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(path.join(brokenDir, 'result.json'), '{not json', 'utf8');
    const otherShapeDir = path.join(runsDir, 'run-other-shape');
    mkdirSync(otherShapeDir, { recursive: true });
    writeFileSync(path.join(otherShapeDir, 'result.json'), JSON.stringify({ kind: 'discovery' }), 'utf8');
    writeRun(runsDir, 'run-good', replayResult());
    const found = findSuccessfulReplay(runsDir, 'test-capability', '1.0.1');
    expect(found?.runId).toBe('run-abc');
  });
});

// -------------------------------------------------------------------------------------------
// runApprove
// -------------------------------------------------------------------------------------------

function capture(): { print: (l: string) => void; printError: (l: string) => void; lines: string[]; errorLines: string[] } {
  const lines: string[] = [];
  const errorLines: string[] = [];
  return { print: (l) => lines.push(l), printError: (l) => errorLines.push(l), lines, errorLines };
}

const FIXED_CLOCK = (): Date => new Date('2026-09-26T12:00:00.000Z');

describe('runApprove', () => {
  it('refuses an invalid artifact (exit 1)', () => {
    const file = path.join(dir, 'artifact.json');
    writeFileSync(file, JSON.stringify({ notACapability: true }), 'utf8');
    const out = capture();
    const result = runApprove({ artifactPath: file, by: 'alice', force: false, runsDir: path.join(dir, 'runs') }, out);
    expect(result.exitCode).toBe(1);
    expect(out.errorLines.some((l) => l.includes('not a valid capability'))).toBe(true);
  });

  it('refuses an artifact that could not be read/parsed', () => {
    const file = path.join(dir, 'does-not-exist.json');
    const out = capture();
    const result = runApprove({ artifactPath: file, by: 'alice', force: false, runsDir: path.join(dir, 'runs') }, out);
    expect(result.exitCode).toBe(1);
  });

  it('refuses an already-approved artifact (exit 1, says so)', () => {
    const file = writeArtifact(minimalCapability({ status: 'approved' }));
    const out = capture();
    const result = runApprove({ artifactPath: file, by: 'alice', force: false, runsDir: path.join(dir, 'runs') }, out);
    expect(result.exitCode).toBe(1);
    expect(out.errorLines.some((l) => l.includes('already approved'))).toBe(true);
  });

  it('refuses a deprecated artifact (exit 1, says so)', () => {
    const file = writeArtifact(minimalCapability({ status: 'deprecated' }));
    const out = capture();
    const result = runApprove({ artifactPath: file, by: 'alice', force: false, runsDir: path.join(dir, 'runs') }, out);
    expect(result.exitCode).toBe(1);
    expect(out.errorLines.some((l) => l.includes('deprecated'))).toBe(true);
  });

  it('refuses a draft artifact with no successful replay recorded (exit 1, file unchanged)', () => {
    const cap = minimalCapability();
    const file = writeArtifact(cap);
    const before = readFileSync(file, 'utf8');
    const out = capture();
    const result = runApprove({ artifactPath: file, by: 'alice', force: false, runsDir: path.join(dir, 'runs') }, out);
    expect(result.exitCode).toBe(1);
    expect(out.errorLines.some((l) => l.includes('no successful replay'))).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('succeeds with a recorded successful replay: bumps patch version, sets approved, appends a note', () => {
    const runsDir = path.join(dir, 'runs');
    writeRun(runsDir, 'run-1', replayResult());
    const file = writeArtifact(minimalCapability());
    const out = capture();
    const result = runApprove({ artifactPath: file, by: 'alice', notes: 'looks good', force: false, runsDir }, { ...out, clock: FIXED_CLOCK });

    expect(result.exitCode).toBe(0);
    expect(out.lines).toEqual(['approved test-capability 1.0.1 -> 1.0.2 (by alice)']);

    const written = JSON.parse(readFileSync(file, 'utf8')) as Capability;
    expect(written.status).toBe('approved');
    expect(written.version).toBe('1.0.2');
    expect(written.provenance.notes).toBe('Approved by alice on 2026-09-26T12:00:00.000Z: looks good');
    // 2-space indent and trailing newline.
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
  });

  it('appends the approval note after any existing provenance notes, separated by a newline', () => {
    const runsDir = path.join(dir, 'runs');
    writeRun(runsDir, 'run-1', replayResult());
    const file = writeArtifact(minimalCapability({ provenance: { discoveredAt: '2026-01-01T00:00:00Z', discoveryRunId: 'run-0', recordedBy: 'human', notes: 'original note' } }));
    const out = capture();
    runApprove({ artifactPath: file, by: 'bob', force: false, runsDir }, { ...out, clock: FIXED_CLOCK });

    const written = JSON.parse(readFileSync(file, 'utf8')) as Capability;
    expect(written.provenance.notes).toBe('original note\nApproved by bob on 2026-09-26T12:00:00.000Z');
  });

  it('--force bypasses the successful-replay check even when runsDir does not exist', () => {
    const file = writeArtifact(minimalCapability());
    const out = capture();
    const result = runApprove({ artifactPath: file, by: 'alice', force: true, runsDir: path.join(dir, 'no-such-runs') }, out);

    expect(result.exitCode).toBe(0);
    expect(out.errorLines.some((l) => l.includes('--force skipped'))).toBe(true);
    const written = JSON.parse(readFileSync(file, 'utf8')) as Capability;
    expect(written.status).toBe('approved');
    expect(written.version).toBe('1.0.2');
  });

  it('bumps the patch version and drops a prerelease suffix', () => {
    const runsDir = path.join(dir, 'runs');
    writeRun(runsDir, 'run-1', replayResult({ capabilityVersion: '2.3.9-beta.1' }));
    const file = writeArtifact(minimalCapability({ version: '2.3.9-beta.1' }));
    const out = capture();
    const result = runApprove({ artifactPath: file, by: 'alice', force: false, runsDir }, out);

    expect(result.exitCode).toBe(0);
    const written = JSON.parse(readFileSync(file, 'utf8')) as Capability;
    expect(written.version).toBe('2.3.10');
  });
});

describe('runApprove: content digest', () => {
  it('refuses a replay of DIFFERENT content published under the same id and version', () => {
    const cap = minimalCapability();
    const file = writeArtifact(cap);
    const runsDir = path.join(dir, 'runs');
    // Another candidate's content, same id@version (e.g. two discover --candidates runs, both 1.0.x).
    const other = minimalCapability({ steps: [{ id: 's01', name: 'Open another page', action: { type: 'navigate', url: '{baseUrl}/other' }, risk: 'read' }] });
    writeRun(runsDir, 'run-other', replayResult({ capabilityDigest: capabilityDigest(other) } as never));
    const out = capture();
    const result = runApprove({ artifactPath: file, by: 'alice', force: false, runsDir }, out);
    expect(result.exitCode).toBe(1);
    expect(out.errorLines.join('\n')).toContain('with this content');
  });

  it('accepts a replay whose digest matches the artifact, even though approval changes status, version and provenance', () => {
    const cap = minimalCapability();
    const file = writeArtifact(cap);
    const runsDir = path.join(dir, 'runs');
    writeRun(runsDir, 'run-other', replayResult({ capabilityDigest: 'sha256:0000' } as never));
    writeRun(runsDir, 'run-same', replayResult({ runId: 'run-same', capabilityDigest: capabilityDigest({ ...cap, status: 'approved' }) } as never));
    const out = capture();
    const result = runApprove({ artifactPath: file, by: 'alice', force: false, runsDir }, out);
    expect(result.exitCode).toBe(0);
    expect(out.errorLines.join('\n')).not.toContain('predates content digests');
  });

  it('keeps accepting a legacy result without a digest, with a printed note', () => {
    const file = writeArtifact(minimalCapability());
    const runsDir = path.join(dir, 'runs');
    writeRun(runsDir, 'run-legacy', replayResult({ runId: 'run-legacy' }));
    const out = capture();
    const result = runApprove({ artifactPath: file, by: 'alice', force: false, runsDir }, out);
    expect(result.exitCode).toBe(0);
    expect(out.errorLines.join('\n')).toContain('run-legacy) predates content digests');
  });

  it('refuses the legacy fallback once any result for this id@version carries a digest (of other content)', () => {
    const file = writeArtifact(minimalCapability());
    const runsDir = path.join(dir, 'runs');
    writeRun(runsDir, 'run-legacy', replayResult({ runId: 'run-legacy' }));
    writeRun(runsDir, 'run-other', replayResult({ runId: 'run-other', capabilityDigest: 'sha256:other-content' } as never));
    const out = capture();
    const result = runApprove({ artifactPath: file, by: 'alice', force: false, runsDir }, out);
    expect(result.exitCode).toBe(1);
    expect(out.errorLines.join('\n')).toContain('with this content');
  });
});

describe('runApprove: positional-only reads', () => {
  const bbox = { strategy: { kind: 'bbox', x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, confidence: 0.2, source: 'recorded' } as const;
  const posCss = { strategy: { kind: 'css', selector: '#pnlProfile tr:nth-child(6) td.val' }, confidence: 0.4, source: 'inferred' } as const;

  /** The shipped hand-written example: every extract chain names its value. */
  function example(): Capability {
    const raw = JSON.parse(readFileSync(new URL('../../../../artifacts/examples/lookup-member-savings-balance.example.json', import.meta.url), 'utf8')) as unknown;
    const v = validateCapability(raw);
    if (!v.ok) throw new Error(JSON.stringify(v.issues));
    return { ...structuredClone(v.capability), status: 'draft' };
  }
  function setLocators(cap: Capability, stepId: string, type: 'extract' | 'click'): void {
    const step = cap.steps.find((s) => s.id === stepId)!;
    if (step.action.type !== type || !('target' in step.action)) throw new Error(`${stepId} is not a ${type}`);
    step.action.target.locators = [posCss, bbox];
  }
  const runsFor = (cap: Capability): string => {
    const runsDir = path.join(dir, 'runs');
    writeRun(runsDir, 'run-1', replayResult({ capabilityId: cap.id, capabilityVersion: cap.version }));
    return runsDir;
  };

  it('refuses a positional-only read without --force, naming the step and the fix; file unchanged', () => {
    const cap = example();
    setLocators(cap, 's09', 'extract');
    const file = writeArtifact(cap);
    const before = readFileSync(file, 'utf8');
    const out = capture();
    const result = runApprove({ artifactPath: file, by: 'alice', force: false, runsDir: runsFor(cap) }, out);

    expect(result.exitCode).toBe(1);
    const text = out.errorLines.join('\n');
    expect(text).toContain('step "s09"');
    expect(text).toContain('record the capability again');
    expect(text).toContain('tenant override');
    expect(out.lines).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('--force approves it and says it forced past this check', () => {
    const cap = example();
    setLocators(cap, 's09', 'extract');
    const file = writeArtifact(cap);
    const out = capture();
    const result = runApprove({ artifactPath: file, by: 'alice', force: true, runsDir: path.join(dir, 'no-runs') }, out);

    expect(result.exitCode).toBe(0);
    expect(out.errorLines.join('\n')).toContain('--force approved past 1 positional-only read');
    expect((JSON.parse(readFileSync(file, 'utf8')) as Capability).status).toBe('approved');
  });

  it('approves normally when every read has a label anchor', () => {
    const cap = example();
    const file = writeArtifact(cap);
    const out = capture();
    const result = runApprove({ artifactPath: file, by: 'alice', force: false, runsDir: runsFor(cap) }, out);

    expect(result.exitCode).toBe(0);
    expect(out.errorLines.join('\n')).not.toContain('positional');
  });

  it('a positional-only action alone does not block approval', () => {
    const cap = example();
    setLocators(cap, 's06', 'click');
    const file = writeArtifact(cap);
    const out = capture();
    const result = runApprove({ artifactPath: file, by: 'alice', force: false, runsDir: runsFor(cap) }, out);

    expect(result.exitCode).toBe(0);
  });
});
