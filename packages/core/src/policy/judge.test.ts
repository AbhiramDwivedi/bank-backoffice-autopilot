/**
 * Unit tests for the risk-judge port's pure pieces (policy/judge.ts): which actions are judged,
 * how a judgment combines with the lexical risk under each mode/onError, the timeout + typed
 * error wrapper, the per-run cache, and the static (audit-time) request builder.
 */
import { describe, expect, it } from 'vitest';
import type { Capability, RiskJudgeConfig } from '../schema/index.js';
import { Policy } from '../schema/index.js';
import { DEFAULT_POLICY_PATH, loadPolicy } from './load.js';
import { createPolicyGuard } from './guard.js';
import type { ObservedElement } from '../surface/index.js';
import {
  capDigest,
  combineRisk,
  createGuardedJudge,
  frameLabel,
  nearbyLabels,
  textFingerprint,
  isJudgeableAction,
  judgeCacheKey,
  judgeRequestForStep,
  judgedRiskClass,
  resolveRiskJudgeConfig,
  staticLexicalRisk,
  type RiskJudge,
  type RiskJudgeRequest,
  type RiskJudgment,
} from './judge.js';

const ENFORCE: RiskJudgeConfig = { mode: 'enforce', irreversibleThreshold: 0.5, onError: 'fail_closed', timeoutMs: 1000 };

function req(overrides: Partial<RiskJudgeRequest> = {}): RiskJudgeRequest {
  return {
    phase: 'record',
    action: { type: 'click' },
    target: { name: 'Continue', role: 'button', tag: 'button' },
    page: { url: 'http://localhost:4173/transfers/review', title: 'Review transfer', textDigest: 'Review your transfer of $500 to account 9' },
    goal: 'Transfer $500',
    why: 'Proceed',
    lexicalRisk: 'reversible',
    ...overrides,
  };
}

function fixedJudge(judgment: RiskJudgment | (() => Promise<RiskJudgment>)): RiskJudge & { calls: number } {
  const j = {
    id: 'fake',
    calls: 0,
    async judge(): Promise<RiskJudgment> {
      j.calls += 1;
      return typeof judgment === 'function' ? judgment() : judgment;
    },
  };
  return j;
}

describe('resolveRiskJudgeConfig', () => {
  it('fills every default when the block is absent (existing policy files parse unchanged)', () => {
    const policy = loadPolicy(DEFAULT_POLICY_PATH);
    const riskWithoutJudge = { ...policy.risk };
    delete riskWithoutJudge.judge;
    expect(resolveRiskJudgeConfig({ risk: riskWithoutJudge })).toEqual({ mode: 'enforce', irreversibleThreshold: 0.5, onError: 'fail_closed', timeoutMs: 5000 });
  });

  it('fills defaults inside a partial block, and rejects an out-of-range threshold', () => {
    const policy = loadPolicy(DEFAULT_POLICY_PATH);
    const parsed = Policy.parse({ ...policy, risk: { ...policy.risk, judge: { mode: 'advise' } } });
    expect(parsed.risk.judge).toEqual({ mode: 'advise', irreversibleThreshold: 0.5, onError: 'fail_closed', timeoutMs: 5000 });
    expect(Policy.safeParse({ ...policy, risk: { ...policy.risk, judge: { irreversibleThreshold: 1.5 } } }).success).toBe(false);
    expect(Policy.safeParse({ ...policy, risk: { ...policy.risk, judge: { mode: 'sometimes' } } }).success).toBe(false);
  });
});

describe('isJudgeableAction', () => {
  it('sends only actions that can commit something', () => {
    const ref = { ref: 'e1' };
    expect(isJudgeableAction({ type: 'click', target: ref })).toBe(true);
    expect(isJudgeableAction({ type: 'select', target: ref, value: 'x' })).toBe(true);
    expect(isJudgeableAction({ type: 'navigate', url: '/x' })).toBe(true);
    expect(isJudgeableAction({ type: 'press', key: 'Enter' })).toBe(true);
    expect(isJudgeableAction({ type: 'press', key: 'Tab' })).toBe(false);
    for (const key of ['NumpadEnter', ' ', 'Space', 'Spacebar']) expect(isJudgeableAction({ type: 'press', key }), key).toBe(true);
    expect(isJudgeableAction({ type: 'press', key: 'Escape' })).toBe(false);
    expect(isJudgeableAction({ type: 'type', target: ref, value: 'x' })).toBe(false);
    expect(isJudgeableAction({ type: 'type', target: ref, value: 'x', pressEnter: true })).toBe(true);
    expect(isJudgeableAction({ type: 'dismiss_dialog', accept: true })).toBe(true);
    expect(isJudgeableAction({ type: 'dismiss_dialog', accept: false })).toBe(false);
    expect(isJudgeableAction({ type: 'extract', target: ref, output: 'x' })).toBe(false);
    expect(isJudgeableAction({ type: 'wait', condition: { kind: 'text_visible', text: 'x' } })).toBe(false);
    expect(isJudgeableAction({ type: 'switch_frame', frame: [] })).toBe(false);
  });
});

describe('combineRisk', () => {
  const judged = (pIrreversible: number, risk: RiskJudgment['risk'] = 'reversible') => ({ kind: 'judged' as const, judgment: { risk, pIrreversible }, cached: false });

  it('maps pIrreversible against the threshold, not the judge label', () => {
    expect(judgedRiskClass({ risk: 'read', pIrreversible: 0.9 }, 0.5)).toBe('irreversible');
    expect(judgedRiskClass({ risk: 'irreversible', pIrreversible: 0.2 }, 0.5)).toBe('reversible');
    expect(judgedRiskClass({ risk: 'read', pIrreversible: 0.2 }, 0.5)).toBe('read');
    expect(judgedRiskClass({ risk: 'reversible', pIrreversible: 0.5 }, 0.5)).toBe('irreversible');
  });

  it('enforce raises to irreversible at or above the threshold', () => {
    const c = combineRisk('reversible', judged(0.8), ENFORCE);
    expect(c).toMatchObject({ risk: 'irreversible', raised: true, judgedRisk: 'irreversible' });
    expect(c.reason).toContain('0.80');
  });

  it('enforce raises read to reversible from the label alone', () => {
    expect(combineRisk('read', judged(0.1, 'reversible'), ENFORCE)).toMatchObject({ risk: 'reversible', raised: true });
  });

  it('never lowers: a judge answering read for an irreversible action changes nothing', () => {
    expect(combineRisk('irreversible', judged(0, 'read'), ENFORCE)).toMatchObject({ risk: 'irreversible', raised: false });
    expect(combineRisk('reversible', judged(0, 'read'), ENFORCE)).toMatchObject({ risk: 'reversible', raised: false });
  });

  it('a higher threshold needs a higher probability', () => {
    expect(combineRisk('reversible', judged(0.8), { ...ENFORCE, irreversibleThreshold: 0.9 })).toMatchObject({ risk: 'reversible', raised: false });
  });

  it('advise reports what enforce would do but never changes the risk', () => {
    const c = combineRisk('reversible', judged(0.95), { ...ENFORCE, mode: 'advise' });
    expect(c).toMatchObject({ risk: 'reversible', raised: false, wouldRaise: true, judgedRisk: 'irreversible' });
    const unavailable = combineRisk('reversible', { kind: 'unavailable', reason: 'boom' }, { ...ENFORCE, mode: 'advise' });
    expect(unavailable).toMatchObject({ risk: 'reversible', raised: false });
  });

  it('off (or no outcome) returns the lexical risk', () => {
    expect(combineRisk('reversible', judged(1), { ...ENFORCE, mode: 'off' })).toMatchObject({ risk: 'reversible', raised: false });
    expect(combineRisk('read', undefined, ENFORCE)).toMatchObject({ risk: 'read', raised: false });
  });

  it('fail_closed treats an unavailable judge as irreversible; fail_open keeps the lexical risk', () => {
    expect(combineRisk('reversible', { kind: 'unavailable', reason: 'timed out' }, ENFORCE)).toMatchObject({ risk: 'irreversible', raised: true });
    expect(combineRisk('reversible', { kind: 'unavailable', reason: 'timed out' }, { ...ENFORCE, onError: 'fail_open' })).toMatchObject({ risk: 'reversible', raised: false });
  });
});

describe('createGuardedJudge', () => {
  it('returns a judged outcome and counts the call', async () => {
    const inner = fixedJudge({ risk: 'irreversible', pIrreversible: 0.9, rationale: 'moves money' });
    const g = createGuardedJudge(inner, { timeoutMs: 1000 });
    expect(await g.judge(req())).toEqual({ kind: 'judged', judgment: { risk: 'irreversible', pIrreversible: 0.9, rationale: 'moves money' }, cached: false });
    expect(g.calls).toBe(1);
    expect(g.id).toBe('fake');
  });

  it('turns a thrown error into unavailable', async () => {
    const g = createGuardedJudge(fixedJudge(async () => Promise.reject(new Error('HTTP 529'))), { timeoutMs: 1000 });
    const out = await g.judge(req());
    expect(out.kind).toBe('unavailable');
    expect(out.kind === 'unavailable' && out.reason).toContain('HTTP 529');
    expect(g.unavailable).toBe(1);
  });

  it('times out a judge that never answers, and aborts its signal', async () => {
    let seenSignal: AbortSignal | undefined;
    const hanging: RiskJudge = {
      id: 'hang',
      judge: (_r, signal) => {
        seenSignal = signal;
        return new Promise(() => undefined);
      },
    };
    const g = createGuardedJudge(hanging, { timeoutMs: 20 });
    const out = await g.judge(req());
    expect(out).toEqual({ kind: 'unavailable', reason: 'timed out after 20ms' });
    expect(seenSignal?.aborted).toBe(true);
  });

  it('rejects a malformed judgment (probability out of range, unknown risk class)', async () => {
    const bad = createGuardedJudge(fixedJudge({ risk: 'irreversible', pIrreversible: 1.7 }), { timeoutMs: 100 });
    expect((await bad.judge(req())).kind).toBe('unavailable');
    const nan = createGuardedJudge(fixedJudge({ risk: 'read', pIrreversible: Number.NaN }), { timeoutMs: 100 });
    expect((await nan.judge(req())).kind).toBe('unavailable');
    const label = createGuardedJudge(fixedJudge({ risk: 'dangerous' as never, pIrreversible: 0.1 }), { timeoutMs: 100 });
    expect((await label.judge(req())).kind).toBe('unavailable');
  });

  it('judges the same control on the same page once; a different page or control is judged again', async () => {
    const inner = fixedJudge({ risk: 'reversible', pIrreversible: 0.1 });
    const g = createGuardedJudge(inner, { timeoutMs: 1000 });
    await g.judge(req());
    const second = await g.judge(req({ why: 'a differently worded reason', target: { name: '  continue ', role: 'button', tag: 'button' } }));
    expect(second.kind === 'judged' && second.cached).toBe(true);
    expect(inner.calls).toBe(1);
    expect(g.cacheHits).toBe(1);

    await g.judge(req({ page: { url: 'http://localhost:4173/transfers/review', title: 'Review transfer', textDigest: 'Step 2: confirm' } }));
    await g.judge(req({ target: { name: 'Cancel', role: 'button', tag: 'button' } }));
    expect(inner.calls).toBe(3);
  });

  it('does not cache an unavailable outcome', async () => {
    let fail = true;
    const inner = fixedJudge(async () => {
      if (fail) throw new Error('down');
      return { risk: 'read', pIrreversible: 0 };
    });
    const g = createGuardedJudge(inner, { timeoutMs: 1000 });
    expect((await g.judge(req())).kind).toBe('unavailable');
    fail = false;
    expect((await g.judge(req())).kind).toBe('judged');
    expect(inner.calls).toBe(2);
  });

  it('cache key ignores why but not the page digest', () => {
    expect(judgeCacheKey(req({ why: 'a' }))).toBe(judgeCacheKey(req({ why: 'b' })));
    expect(judgeCacheKey(req())).not.toBe(judgeCacheKey(req({ page: { url: 'http://localhost:4173/transfers/review', textDigest: 'other' } })));
  });

  it('cache key includes the cache context (full-text fingerprint), the frame and the nearby labels, and compares URLs exactly', () => {
    expect(judgeCacheKey(req(), textFingerprint('Step 1 of 3'))).not.toBe(judgeCacheKey(req(), textFingerprint('Step 3 of 3')));
    expect(judgeCacheKey(req({ target: { name: 'OK', frame: 'top' } }))).not.toBe(judgeCacheKey(req({ target: { name: 'OK', frame: 'main' } })));
    expect(judgeCacheKey(req({ target: { name: 'OK', nearby: ['Cancel'] } }))).not.toBe(judgeCacheKey(req({ target: { name: 'OK', nearby: ['Delete all'] } })));
    expect(judgeCacheKey(req({ action: { type: 'navigate', url: 'http://h/a?id=A' } }))).not.toBe(judgeCacheKey(req({ action: { type: 'navigate', url: 'http://h/a?id=a' } })));
    expect(judgeCacheKey(req({ page: { url: 'http://h/Delete' } }))).not.toBe(judgeCacheKey(req({ page: { url: 'http://h/delete' } })));
  });

  it('a late answer after the timeout is not cached', async () => {
    let n = 0;
    const slow: RiskJudge = {
      id: 'slow',
      judge: () => {
        n += 1;
        return new Promise((resolve) => setTimeout(() => resolve({ risk: 'read', pIrreversible: 0 }), 40));
      },
    };
    const g = createGuardedJudge(slow, { timeoutMs: 5 });
    expect((await g.judge(req())).kind).toBe('unavailable');
    await new Promise((r) => setTimeout(r, 80)); // the late answer arrives
    expect((await g.judge(req())).kind).toBe('unavailable');
    expect(n).toBe(2);
    expect(g.cacheHits).toBe(0);
  });

  it('never throws, even for an unprintable thrown value', async () => {
    const hostileToString = { toString: () => { throw new Error('nope'); } };
    const hostileError = new Error('x');
    Object.defineProperty(hostileError, 'message', { get: () => { throw new Error('nope'); } });
    for (const thrown of [Object.create(null), hostileToString, hostileError, undefined, Symbol('s')]) {
      const g = createGuardedJudge({ id: 't', judge: async () => Promise.reject(thrown) }, { timeoutMs: 100 });
      const out = await g.judge(req());
      expect(out.kind).toBe('unavailable');
    }
    const g = createGuardedJudge({ id: 't', judge: async () => Promise.reject(Object.create(null)) }, { timeoutMs: 100 });
    expect(await g.judge(req())).toEqual({ kind: 'unavailable', reason: 'judge failed with an unprintable error' });
  });
});

describe('page context helpers', () => {
  it('capDigest keeps the head and the tail within the budget', () => {
    const text = `HEAD ${'x '.repeat(2000)} TAIL: Continue sends the money`;
    const capped = capDigest(text, 200)!;
    expect(capped.length).toBeLessThanOrEqual(200);
    expect(capped.startsWith('HEAD')).toBe(true);
    expect(capped.endsWith('Continue sends the money')).toBe(true);
    expect(capDigest('short', 200)).toBe('short');
  });

  it('nearbyLabels lists same-frame elements nearest first, scrubbed, within the budget', () => {
    const at = (ref: string, name: string, x: number, frame: { name: string }[] = [], text?: string): ObservedElement => ({
      ref,
      role: 'button',
      name,
      ...(text !== undefined ? { text } : {}),
      tag: 'button',
      bbox: { x, y: 0, w: 10, h: 10 },
      frame,
      enabled: true,
      descriptor: { description: name, frame, locators: [{ strategy: { kind: 'css', selector: 'b' }, confidence: 0.1, source: 'inferred' }] },
    });
    const target = at('e1', 'OK', 0);
    const elements = [target, at('e2', 'Far', 500), at('e3', 'Near', 20, [], 'Delete all records for 12345'), at('e4', 'Other frame', 5, [{ name: 'side' }])];
    const labels = nearbyLabels(target, elements, (s) => s.replace('12345', '<sensitive:id>'));
    expect(labels).toEqual(['Near | Delete all records for <sensitive:id>', 'Far']);
    expect(nearbyLabels(target, elements, (s) => s, 10)).toEqual([]);
    expect(frameLabel([])).toBe('top');
    expect(frameLabel([{ name: 'main' }, { index: 2 }])).toBe('main > #2');
  });
});

// -------------------------------------------------------------------------------------------
// Audit-time (static) requests
// -------------------------------------------------------------------------------------------

function transferCapability(): Capability {
  const descriptor = (name: string) => ({
    description: `button "${name}"`,
    frame: [],
    locators: [{ strategy: { kind: 'role' as const, role: 'button', name }, confidence: 0.9, source: 'recorded' as const }],
    snapshot: { tag: 'button', role: 'button', name },
  });
  return {
    schemaVersion: '1.0',
    id: 'send-transfer',
    version: '1.0.0',
    name: 'Send transfer',
    description: 'Send a transfer between accounts.',
    app: { vendor: 'Acme', product: 'Core', surface: 'web', entryUrl: '{baseUrl}/login' },
    status: 'draft',
    riskLevel: 'reversible',
    inputs: {},
    outputs: {},
    steps: [
      { id: 's01', name: 'Open the review page', action: { type: 'navigate', url: '{baseUrl}/transfers/review' }, risk: 'read' },
      { id: 's02', name: 'Continue to send the transfer', action: { type: 'click', target: descriptor('Continue') }, risk: 'reversible' },
      { id: 's03', name: 'Confirm', action: { type: 'click', target: descriptor('Confirm transfer') }, risk: 'irreversible', onFailure: 'escalate' },
    ],
    success: { condition: { kind: 'text_visible', text: 'Sent' }, description: 'sent' },
    businessOutcomes: [],
    recoveryRules: [],
    provenance: { discoveredAt: '2026-09-01T00:00:00Z', discoveryRunId: 'run_x', recordedBy: 'llm' },
  };
}

describe('static (audit) requests', () => {
  const guard = createPolicyGuard(loadPolicy(DEFAULT_POLICY_PATH));

  it('builds a value-free request from descriptor texts, the step name and the capability description', () => {
    const cap = transferCapability();
    const r = judgeRequestForStep(cap, 1, 'reversible');
    expect(r).toEqual({
      phase: 'audit',
      action: { type: 'click' },
      target: { description: 'button "Continue"', name: 'Continue', text: 'Continue', role: 'button', tag: 'button', frame: 'top' },
      page: { url: '{baseUrl}/transfers/review' },
      goal: 'Send transfer: Send a transfer between accounts.',
      why: 'Continue to send the transfer',
      lexicalRisk: 'reversible',
    });
  });

  it('passes every string through the scrubber', () => {
    const r = judgeRequestForStep(transferCapability(), 1, 'reversible', (s) => s.replace(/Continue/g, '[X]'));
    expect(JSON.stringify(r)).not.toContain('Continue');
  });

  it('is undefined for a step that is not judgeable', () => {
    const cap = transferCapability();
    cap.steps.push({ id: 's04', name: 'Read', action: { type: 'extract', target: cap.steps[1]!.action.type === 'click' ? cap.steps[1]!.action.target : (undefined as never), output: 'x' }, risk: 'read' });
    expect(judgeRequestForStep(cap, 3, 'read')).toBeUndefined();
  });

  it('staticLexicalRisk sees the descriptor texts the way the enforcing surface does', () => {
    const cap = transferCapability();
    expect(staticLexicalRisk(guard, cap.steps[1]!, '{baseUrl}/transfers/review')).toBe('reversible');
    expect(staticLexicalRisk(guard, cap.steps[2]!, '{baseUrl}/transfers/review')).toBe('irreversible');
    expect(staticLexicalRisk(guard, cap.steps[0]!, '{baseUrl}/login')).toBe('read');
  });
});
