/**
 * `cu audit` (runAudit) against a fake judge and a copy of the sample capability: the report and
 * its origins (base steps, override extra steps, recovery actions), the exit codes, `--apply`
 * (raise-only, complete audits only, patch bump, back to draft, provenance note, re-valid), the
 * `auto`-without-a-key refusal, terminal-safe output, and what the judge is (and is not) sent.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RiskJudge, RiskJudgeRequest, RiskJudgment } from '@cu/core/policy';
import { validateCapability, type Capability, type Step } from '@cu/core/schema';
import { AUDIT_INCOMPLETE_EXIT_CODE, AUDIT_RISKIER_EXIT_CODE, runAudit, type RunAuditOptions } from './audit.js';

const SAMPLE = path.resolve('artifacts', 'lookup-member-savings-balance.json');
const CLOCK = (): Date => new Date('2026-09-30T12:00:00.000Z');

let dir: string;
let artifact: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cu-audit-test-'));
  artifact = path.join(dir, 'cap.json');
  copyFileSync(SAMPLE, artifact);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const controlOf = (req: RiskJudgeRequest): string => req.target?.name ?? req.target?.description ?? '';

/** Judges an action irreversible when its control matches `flag`, throws when it matches `fail`;
 *  records every request. */
function judgeFlagging(flag: RegExp | undefined, fail?: RegExp, rationale = 'Commits a record.'): RiskJudge & { requests: RiskJudgeRequest[] } {
  const requests: RiskJudgeRequest[] = [];
  return {
    id: 'fake-judge',
    requests,
    async judge(req): Promise<RiskJudgment> {
      requests.push(req);
      if (fail !== undefined && fail.test(controlOf(req))) throw new Error('HTTP 529 overloaded');
      const hit = flag !== undefined && flag.test(controlOf(req));
      return hit ? { risk: 'irreversible', pIrreversible: 0.91, rationale } : { risk: 'read', pIrreversible: 0.02, rationale: 'Only navigates.' };
    },
  };
}

function options(overrides: Partial<RunAuditOptions> = {}): RunAuditOptions {
  return { artifactPath: artifact, riskJudge: 'auto', apply: false, policy: 'policies/default.yaml', ...overrides };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { print: (l: string) => void out.push(l), printError: (l: string) => void err.push(l), clock: CLOCK } };
}

function readCap(p: string): Capability {
  return JSON.parse(readFileSync(p, 'utf8')) as Capability;
}

function withExtraStep(step: Partial<Step> & Pick<Step, 'action'>): void {
  const cap = readCap(artifact);
  const o = cap.overrides![0]!;
  o.extraSteps = [{ afterStepId: 's07', step: { id: 'x01', name: 'Confirm the tenant search', risk: 'read', ...step } }];
  writeFileSync(artifact, JSON.stringify(cap));
  expect(validateCapability(cap).ok).toBe(true);
}

const continueTarget = {
  description: 'clickable "Continue" (<div>)',
  frame: [{ name: 'main' }],
  locators: [{ strategy: { kind: 'text' as const, text: 'Continue', tag: 'div' }, confidence: 0.7, source: 'inferred' as const }],
  snapshot: { tag: 'div', role: 'clickable', name: 'Continue', text: 'Continue' },
};

describe('cu audit: report', () => {
  it('judges committing steps and recovery actions, and exits 2 when a step is riskier than declared, leaving the file alone', async () => {
    const judge = judgeFlagging(/^Search$/);
    const io = capture();
    const before = readFileSync(artifact, 'utf8');
    const result = await runAudit(options(), { ...io.deps, judge });

    expect(result.exitCode).toBe(AUDIT_RISKIER_EXIT_CODE);
    // navigate s01 + the three clicks + the recovery rule's click; plain `type` and `extract` are never sent.
    expect(result.rows.map((r) => `${r.origin}:${r.id}`)).toEqual(['step:s01', 'step:s05', 'step:s07', 'step:s08', 'recovery:dismiss_system_maintenance_notice#1']);
    expect(judge.requests).toHaveLength(5);
    expect(judge.requests.every((r) => r.phase === 'audit')).toBe(true);
    const search = result.rows.find((r) => r.id === 's07')!;
    expect(search).toMatchObject({ declared: 'reversible', lexical: 'reversible', judged: 'irreversible', effective: 'irreversible', pIrreversible: 0.91, status: 'riskier' });

    expect(io.out.some((l) => /^origin\s+id\s+action\s+declared\s+lexical\s+judged\s+p\s+status\s+rationale$/.test(l))).toBe(true);
    expect(io.out.some((l) => l.includes('s07') && l.includes('RISKIER -> irreversible') && l.includes('0.91'))).toBe(true);
    expect(io.out).toContain('audit: 1 action(s) riskier than declared: s07 reversible -> irreversible');
    expect(io.err.some((l) => l.includes('risk judge: fake-judge (enforce'))).toBe(true);
    expect(readFileSync(artifact, 'utf8')).toBe(before);
  });

  it('exits 0 when nothing is riskier', async () => {
    const io = capture();
    const result = await runAudit(options(), { ...io.deps, judge: judgeFlagging(undefined) });
    expect(result.exitCode).toBe(0);
    expect(io.out).toContain('audit: nothing is riskier than it declares');
  });

  it('builds requests from descriptor texts, step names and the capability description, scrubbed by the policy patterns', async () => {
    const cap = readCap(artifact);
    cap.description = `${cap.description} Example member SSN 123-45-6789.`;
    writeFileSync(artifact, JSON.stringify(cap));
    const judge = judgeFlagging(undefined);
    await runAudit(options(), { ...capture().deps, judge });
    const search = judge.requests.find((r) => r.target?.name === 'Search')!;
    expect(search.why).toBe('Search for the member by ID');
    expect(search.goal).toContain(cap.name);
    expect(search.target).toMatchObject({ description: 'clickable "Search" (<div>)', frame: 'main' });
    expect(search.lexicalRisk).toBe('reversible');
    expect(JSON.stringify(judge.requests)).not.toContain('123-45-6789');
  });

  it('strips control characters (a hostile rationale) from everything it prints', async () => {
    const io = capture();
    await runAudit(options(), { ...io.deps, judge: judgeFlagging(/^Search$/, undefined, '\u001b[2J\u001b[31mfine\rOVERWRITE\u0007') });
    const all = [...io.out, ...io.err].join('\n');
    // eslint-disable-next-line no-control-regex
    expect(all).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(all).toContain('[2J [31mfine OVERWRITE');
  });

  it('--risk-judge off (no judge) still reports the lexical view, exit 0', async () => {
    const result = await runAudit(options({ riskJudge: 'off' }), { ...capture().deps });
    expect(result.exitCode).toBe(0);
    expect(result.rows.every((r) => r.judged === undefined)).toBe(true);
  });

  it('refuses an invalid artifact, and --out without --apply', async () => {
    writeFileSync(artifact, '{"not":"a capability"}');
    expect((await runAudit(options(), { ...capture().deps, judge: null })).exitCode).toBe(1);
    expect((await runAudit(options({ out: path.join(dir, 'x.json') }), { ...capture().deps, judge: null })).exitCode).toBe(1);
  });
});

describe('cu audit: no judge available under auto', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('exits 3 instead of passing on zero judgments; an explicit --risk-judge off is what allows lexical-only', async () => {
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const io = capture();
    const result = await runAudit(options({ riskJudge: 'auto' }), io.deps);
    expect(result.exitCode).toBe(AUDIT_INCOMPLETE_EXIT_CODE);
    expect(result.rows).toEqual([]);
    expect(io.err.some((l) => l.includes('no risk judge is available') && l.includes('--risk-judge off'))).toBe(true);
    expect((await runAudit(options({ riskJudge: 'off' }), capture().deps)).exitCode).toBe(0);
  });
});

describe('cu audit: an unavailable judge', () => {
  it('exits 3 and raises nothing, even with --apply', async () => {
    const before = readFileSync(artifact, 'utf8');
    const result = await runAudit(options({ apply: true }), { ...capture().deps, judge: judgeFlagging(undefined, /.*/) });
    expect(result.exitCode).toBe(AUDIT_INCOMPLETE_EXIT_CODE);
    expect(result.written).toBeUndefined();
    expect(readFileSync(artifact, 'utf8')).toBe(before);
  });

  it('mixed: one action unjudged and another riskier -- --apply writes nothing, exits 3 and names the unjudged action', async () => {
    const io = capture();
    const before = readFileSync(artifact, 'utf8');
    const result = await runAudit(options({ apply: true }), { ...io.deps, judge: judgeFlagging(/^Search$/, /^login$/) });
    expect(result.exitCode).toBe(AUDIT_INCOMPLETE_EXIT_CODE);
    expect(result.written).toBeUndefined();
    expect(result.rows.find((r) => r.id === 's07')!.status).toBe('riskier');
    expect(result.rows.find((r) => r.id === 's05')!.status).toBe('unavailable');
    expect(io.out).toContain('audit: could not judge 1 action(s): step s05');
    expect(io.out.some((l) => l.startsWith('audit: --apply wrote nothing'))).toBe(true);
    expect(readFileSync(artifact, 'utf8')).toBe(before);
  });

  it('mixed without --apply: the riskier finding wins (exit 2)', async () => {
    const result = await runAudit(options(), { ...capture().deps, judge: judgeFlagging(/^Search$/, /^login$/) });
    expect(result.exitCode).toBe(AUDIT_RISKIER_EXIT_CODE);
  });
});

describe('cu audit: recovery actions and tenant extra steps', () => {
  it('a recovery action judged irreversible needs a human: reported, exit 2, and --apply cannot fix it', async () => {
    const io = capture();
    const result = await runAudit(options({ apply: true }), { ...io.deps, judge: judgeFlagging(/^OK$/) });
    const row = result.rows.find((r) => r.origin === 'recovery')!;
    expect(row).toMatchObject({ status: 'needs-human', effective: 'irreversible' });
    expect(row.declared).toBeUndefined();
    expect(result.exitCode).toBe(AUDIT_RISKIER_EXIT_CODE);
    expect(result.written).toBeUndefined();
    expect(io.out.some((l) => l.includes('recovery dismiss_system_maintenance_notice#1') && l.includes('a human must remove or rework this rule'))).toBe(true);
  });

  it('with --apply, fixable raises are written and the run still exits 2 for the recovery finding', async () => {
    const out = path.join(dir, 'raised.json');
    const result = await runAudit(options({ apply: true, out }), { ...capture().deps, judge: judgeFlagging(/^(Search|OK)$/) });
    expect(result.exitCode).toBe(AUDIT_RISKIER_EXIT_CODE);
    expect(result.written).toBe(out);
    const after = readCap(out);
    expect(after.steps.find((s) => s.id === 's07')!.risk).toBe('irreversible');
    expect(after.provenance.notes).toContain('unresolved, needs a human: dismiss_system_maintenance_notice#1');
    expect(validateCapability(after).ok).toBe(true);
  });

  it('an override extra step judged reversible over a declared read is raised by --apply', async () => {
    withExtraStep({ action: { type: 'click', target: continueTarget } });
    const judge: RiskJudge = {
      id: 'fake-judge',
      judge: async (req) => (req.target?.name === 'Continue' ? { risk: 'reversible', pIrreversible: 0.1 } : { risk: 'read', pIrreversible: 0 }),
    };
    const result = await runAudit(options({ apply: true }), { ...capture().deps, judge });
    const row = result.rows.find((r) => r.origin === 'override')!;
    expect(row).toMatchObject({ id: 'riverbend-fcu/x01', declared: 'read', effective: 'reversible', status: 'riskier' });
    expect(result.exitCode).toBe(0);
    const after = readCap(artifact);
    expect(after.overrides![0]!.extraSteps![0]!.step.risk).toBe('reversible');
    expect(validateCapability(after).ok).toBe(true);
  });

  it('an override extra step judged irreversible is report-only (an irreversible override step would fail validation)', async () => {
    withExtraStep({ action: { type: 'click', target: continueTarget } });
    const before = readFileSync(artifact, 'utf8');
    const io = capture();
    const result = await runAudit(options({ apply: true }), { ...io.deps, judge: judgeFlagging(/^Continue$/) });
    expect(result.rows.find((r) => r.origin === 'override')).toMatchObject({ status: 'needs-human', effective: 'irreversible' });
    expect(result.exitCode).toBe(AUDIT_RISKIER_EXIT_CODE);
    expect(result.written).toBeUndefined();
    expect(readFileSync(artifact, 'utf8')).toBe(before);
    expect(io.out.some((l) => l.includes('validateCapability rejects it'))).toBe(true);
  });
});

describe('cu audit --apply', () => {
  it('raises the riskier step, bumps the patch version, resets approved -> draft, notes provenance, writes a valid capability', async () => {
    const out = path.join(dir, 'raised.json');
    const result = await runAudit(options({ apply: true, out }), { ...capture().deps, judge: judgeFlagging(/^Search$/) });
    expect(result.exitCode).toBe(0);
    expect(result.written).toBe(out);

    const before = readCap(artifact);
    const after = readCap(out);
    expect(validateCapability(after).ok).toBe(true);
    expect(before.status).toBe('approved');
    expect(after.status).toBe('draft');
    expect(after.version).toBe('1.2.3');
    expect(after.riskLevel).toBe('irreversible');
    const s07 = after.steps.find((s) => s.id === 's07')!;
    expect(s07.risk).toBe('irreversible');
    expect(s07.onFailure).toBe('escalate');
    expect(after.provenance.notes).toContain('Audited by risk judge fake-judge on 2026-09-30T12:00:00.000Z (all 5 committing actions judged): raised s07 reversible->irreversible (p=0.91)');
    expect(after.steps.filter((s) => s.id !== 's07')).toEqual(before.steps.filter((s) => s.id !== 's07'));
  });

  it('never lowers: a judge answering "read" leaves a declared-irreversible step alone and does not even see it', async () => {
    const cap = readCap(artifact);
    const s05 = cap.steps.find((s) => s.id === 's05')!;
    s05.risk = 'irreversible';
    s05.onFailure = 'escalate';
    cap.riskLevel = 'irreversible';
    writeFileSync(artifact, JSON.stringify(cap));
    const judge = judgeFlagging(undefined);
    const result = await runAudit(options({ apply: true }), { ...capture().deps, judge });
    expect(result.exitCode).toBe(0);
    expect(result.written).toBeUndefined();
    expect(judge.requests.some((r) => r.target?.name === 'login')).toBe(false);
    expect(readCap(artifact).steps.find((s) => s.id === 's05')!.risk).toBe('irreversible');
  });

  it('writes in place by default', async () => {
    const result = await runAudit(options({ apply: true }), { ...capture().deps, judge: judgeFlagging(/^Search$/) });
    expect(result.written).toBe(path.resolve(artifact));
    expect(readCap(artifact).steps.find((s) => s.id === 's07')!.risk).toBe('irreversible');
  });
});
