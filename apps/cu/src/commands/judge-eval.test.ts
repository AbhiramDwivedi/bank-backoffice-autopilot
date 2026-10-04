/**
 * The risk-judge eval's scoring and plumbing with a fake judge (the live run needs a key and is
 * the integrator's): the labelled set loads, its `lexicalRisk` labels match the default policy's
 * patterns, and the confusion matrices and misses are counted right.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY_PATH, createPolicyGuard, loadPolicy, type RiskJudge } from '@cu/core/policy';
import type { RiskClass } from '@cu/core/schema';
import { formatJudgeEval, loadEvalCases, parseEvalArgs, runJudgeEval, scoreJudgeEval, type JudgeEvalResult } from './judge-eval.js';

describe('labelled set', () => {
  const cases = loadEvalCases();

  it('has ~25 cases covering every class, including the hard ones', () => {
    expect(cases.length).toBeGreaterThanOrEqual(25);
    for (const c of ['read', 'reversible', 'irreversible'] as const) expect(cases.some((k) => k.expected === c)).toBe(true);
    for (const id of ['continue-on-transfer-review', 'next-in-wizard-step-1', 'ok-on-delete-confirm-dialog', 'search-button', 'save-draft', 'get-link-to-delete', 'sign-off', 'post-as-heading', 'post-as-button']) {
      expect(cases.map((c) => c.id)).toContain(id);
    }
  });

  it("each case's lexicalRisk is what the default policy's patterns actually say", () => {
    const guard = createPolicyGuard(loadPolicy(DEFAULT_POLICY_PATH));
    for (const c of cases) {
      const r = c.request;
      const action = { ...r.action, ...(r.action.type === 'navigate' ? {} : { target: { ref: 'x' } }) } as Parameters<typeof guard.classifyRisk>[0];
      const targetText = r.action.type === 'dismiss_dialog' ? r.page.dialogMessage : r.target?.text;
      const lexical = guard.classifyRisk(action, {
        ...(r.target?.name !== undefined ? { targetName: r.target.name } : {}),
        ...(targetText !== undefined ? { targetText } : {}),
        currentUrl: r.page.url,
      });
      expect({ id: c.id, lexical }).toEqual({ id: c.id, lexical: r.lexicalRisk });
    }
  });

  it('the lexical patterns alone miss most irreversible cases (why the judge exists)', () => {
    const irreversible = cases.filter((c) => c.expected === 'irreversible');
    const lexicallyCaught = irreversible.filter((c) => c.request.lexicalRisk === 'irreversible');
    expect(lexicallyCaught.length).toBeLessThan(irreversible.length / 2);
  });
});

describe('scoreJudgeEval', () => {
  const judged = (id: string, expected: RiskClass, p: number, risk: RiskClass = 'reversible'): JudgeEvalResult => ({
    id,
    expected,
    outcome: { kind: 'judged', judgment: { risk, pIrreversible: p, rationale: `r-${id}` }, cached: false },
  });

  it('counts the binary confusion, the class matrix and the misses', () => {
    const score = scoreJudgeEval(
      [
        judged('tp', 'irreversible', 0.9),
        judged('fn', 'irreversible', 0.2),
        judged('fp', 'read', 0.7),
        judged('tn', 'read', 0.1, 'read'),
        judged('class-miss', 'reversible', 0.1, 'read'),
        { id: 'down', expected: 'irreversible', outcome: { kind: 'unavailable', reason: 'HTTP 529' } },
      ],
      0.5,
    );
    expect(score.binary).toEqual({ tp: 1, fn: 1, fp: 1, tn: 2 });
    expect(score.total).toBe(6);
    expect(score.judged).toBe(5);
    expect(score.recall).toBe(0.5);
    expect(score.precision).toBe(0.5);
    expect(score.accuracy).toBe(0.6);
    expect(score.matrix.irreversible).toEqual({ read: 0, reversible: 1, irreversible: 1 });
    expect(score.matrix.reversible).toEqual({ read: 1, reversible: 0, irreversible: 0 });
    expect(score.misses.map((m) => [m.id, m.kind])).toEqual([
      ['fn', 'false_negative'],
      ['fp', 'false_positive'],
    ]);
    expect(score.classMisses).toEqual([{ id: 'class-miss', expected: 'reversible', predicted: 'read' }]);
    expect(score.unavailable).toEqual([{ id: 'down', reason: 'HTTP 529' }]);

    const report = formatJudgeEval(score, 'fake').join('\n');
    expect(report).toContain('FN fn: expected irreversible, judged reversible (p=0.20) -- r-fn');
    expect(report).toContain('recall 50%');
    expect(report).toContain('down: HTTP 529');
  });

  it('the threshold moves cases across the binary line', () => {
    const results = [judged('a', 'irreversible', 0.6)];
    expect(scoreJudgeEval(results, 0.5).binary.tp).toBe(1);
    expect(scoreJudgeEval(results, 0.7).binary.fn).toBe(1);
  });

  it('has no ratios when nothing was judged', () => {
    const score = scoreJudgeEval([{ id: 'x', expected: 'read', outcome: { kind: 'unavailable', reason: 'down' } }], 0.5);
    expect(score.recall).toBeUndefined();
    expect(formatJudgeEval(score, 'fake').join('\n')).toContain('recall n/a');
  });
});

describe('runJudgeEval with a fake judge', () => {
  it('sends every case (uncached) and a perfect oracle scores 100%', async () => {
    const cases = loadEvalCases();
    const byGoalAndUrl = new Map(cases.map((c) => [JSON.stringify(c.request), c.expected]));
    let calls = 0;
    const oracle: RiskJudge = {
      id: 'oracle',
      async judge(req) {
        calls += 1;
        const expected = byGoalAndUrl.get(JSON.stringify(req))!;
        return { risk: expected, pIrreversible: expected === 'irreversible' ? 0.95 : 0.05 };
      },
    };
    const score = scoreJudgeEval(await runJudgeEval(oracle, cases, { timeoutMs: 1000 }), 0.5);
    expect(calls).toBe(cases.length);
    expect(score.accuracy).toBe(1);
    expect(score.misses).toEqual([]);
    expect(score.classMisses).toEqual([]);
  });
});

describe('parseEvalArgs', () => {
  it('parses the flags and rejects bad ones', () => {
    expect(parseEvalArgs(['--judge', 'jev', '--threshold', '0.7'])).toMatchObject({ judge: 'jev', threshold: 0.7 });
    expect(() => parseEvalArgs(['--judge', 'off'])).toThrow();
    expect(() => parseEvalArgs(['--threshold', '2'])).toThrow();
    expect(() => parseEvalArgs(['--bogus'])).toThrow();
  });
});
