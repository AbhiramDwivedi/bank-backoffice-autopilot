/**
 * The risk judge inside the discovery loop (tool-handlers.ts `gateAction`), against FakeSurface,
 * the real lexical guard over the default policy, a scripted LLM and a fake judge.
 *
 * The scenario is the case the lexical patterns cannot see: a transfer-review page whose only
 * committing control reads "Continue". The default policy's `irreversibleTextPatterns` allow it
 * (risk `reversible`), so without a judge the click is recorded as a reversible step and would
 * replay unattended from a draft capability.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discover } from './discover.js';
import { createScriptedLlm, requestText, type ScriptedTurn } from './scripted-llm.js';
import type { DiscoverOptions } from './types.js';
import { findRef, readJsonlFile } from './test-helpers.js';
import { FakeSurface, el, scenario } from '../surface/index.js';
import { createRunLogger, newRunId } from '../evidence/index.js';
import { DEFAULT_POLICY_PATH, createPolicyGuard, loadPolicy, type RiskJudge, type RiskJudgeRequest, type RiskJudgment } from '../policy/index.js';
import { validateCapability, type Policy, type RiskJudgeConfig } from '../schema/index.js';
import type { EscalationHandler, EscalationRequest } from '../session/index.js';

const BASE = 'http://localhost:4173';
const REVIEW_URL = `${BASE}/transfers/review`;
const DEFAULT_POLICY = loadPolicy(DEFAULT_POLICY_PATH);

function policyWith(judge: Partial<RiskJudgeConfig>, discoveryMode: Policy['risk']['discoveryMode'] = 'escalate'): Policy {
  return { ...DEFAULT_POLICY, risk: { ...DEFAULT_POLICY.risk, discoveryMode, judge: { mode: 'enforce', irreversibleThreshold: 0.5, onError: 'fail_closed', timeoutMs: 1000, ...judge } } };
}

function transferSurface(): FakeSurface {
  const built = scenario()
    .screen('review', {
      url: REVIEW_URL,
      title: 'Review transfer',
      text: ['Review your transfer of $500.00 from Savings to account ending 4411.'],
      elements: [
        el({ id: 'memo', role: 'textbox', name: 'Memo', label: 'Memo', tag: 'input', bbox: { x: 10, y: 10, w: 200, h: 20 } }),
        el({ id: 'continue', role: 'button', name: 'Continue', text: 'Continue', tag: 'button', bbox: { x: 10, y: 40, w: 80, h: 20 } }),
      ],
    })
    .on('click', { targetId: 'continue' })
    .goto('sent')
    .screen('sent', { url: `${BASE}/transfers/sent`, title: 'Transfer sent', text: ['Transfer sent'], elements: [] })
    .onAny('navigate', { url: REVIEW_URL })
    .goto('review')
    .initial('review')
    .build();
  return new FakeSurface(built);
}

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function makeLogger() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'risk-judge-test-'));
  tmpDirs.push(dir);
  return createRunLogger({ runId: newRunId(), runKind: 'discovery', rootDir: dir });
}

/** A fake judge that records every request and answers with `answer` (or throws). */
function fakeJudge(answer: RiskJudgment | Error): RiskJudge & { requests: RiskJudgeRequest[] } {
  const requests: RiskJudgeRequest[] = [];
  return {
    id: 'fake-judge',
    requests,
    async judge(req) {
      requests.push(req);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

const MOVES_MONEY: RiskJudgment = { risk: 'irreversible', pIrreversible: 0.92, rationale: 'Submits a funds transfer from a review page.' };

const clickContinue: ScriptedTurn = (req) => ({
  tool: 'click',
  input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'Continue' }), why: 'Proceed past the review page', expect: 'Transfer sent' },
});
const typeMemo: ScriptedTurn = (req) => ({
  tool: 'type',
  input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Memo' }), source: 'input', value: 'memo', why: 'Add the memo', expect: '' },
});
const done: ScriptedTurn = { tool: 'done', input: { success_text: 'Transfer sent', summary: 'Sent the transfer.' } };

function options(overrides: Partial<DiscoverOptions>): DiscoverOptions {
  return {
    goal: 'Send the reviewed transfer.',
    target: { baseUrl: BASE, entryUrl: REVIEW_URL },
    app: { vendor: 'Acme Core Systems', product: 'CU Core Workstation', surface: 'web' },
    inputs: { memo: { value: 'rent', sensitive: false, description: 'Transfer memo', type: 'string' } },
    surface: transferSurface(),
    policy: policyWith({}),
    guard: createPolicyGuard(DEFAULT_POLICY),
    logger: makeLogger(),
    llm: createScriptedLlm([typeMemo, clickContinue, done], { onExhausted: 'throw' }),
    secretEnvNames: [],
    secrets: () => undefined,
    expectTimeoutMs: 100,
    ...overrides,
  };
}

function approveAll(seen: EscalationRequest[]): EscalationHandler {
  return async (req) => {
    seen.push(req);
    return { interventionId: 'int_ok', resumeFrom: 'current_step', humanActions: [], by: 'test-operator' };
  };
}

function judgeEvents(dir: string) {
  return (readJsonlFile(path.join(dir, 'events.jsonl')) as { kind: string; data?: Record<string, unknown> }[]).filter(
    (e) => e.kind === 'policy' && e.data?.source === 'risk-judge',
  );
}

describe('risk judge in discovery: a "Continue" that moves money', () => {
  it('without a judge, the lexical guard records it as a reversible step (the gap this closes)', async () => {
    const seen: EscalationRequest[] = [];
    const opts = options({ escalate: approveAll(seen) });
    const result = await discover(opts);
    expect(result.status).toBe('success');
    expect(seen).toHaveLength(0);
    const click = result.capability!.steps.find((s) => s.action.type === 'click')!;
    expect(click.risk).toBe('reversible');
    expect(result.riskJudge).toBeUndefined();
  });

  it('enforce: escalates the click to a human, then records it irreversible with onFailure escalate', async () => {
    const judge = fakeJudge(MOVES_MONEY);
    const seen: EscalationRequest[] = [];
    const opts = options({ judge, escalate: approveAll(seen) });
    const result = await discover(opts);

    expect(result.status).toBe('success');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.reason.code).toBe('risky_action_confirmation');
    expect(seen[0]!.reason.message).toContain('risk judge');

    const cap = result.capability!;
    expect(validateCapability(cap).ok).toBe(true);
    const click = cap.steps.find((s) => s.action.type === 'click')!;
    expect(click.risk).toBe('irreversible');
    expect(click.onFailure).toBe('escalate');
    expect(cap.riskLevel).toBe('irreversible');
    expect(cap.provenance.notes).toContain('risk judge fake-judge raised');

    // Only the committing click was judged: not the entry navigation, not the plain `type`.
    expect(judge.requests).toHaveLength(1);
    const sent = judge.requests[0]!;
    expect(sent).toMatchObject({ phase: 'record', action: { type: 'click' }, target: { name: 'Continue', role: 'button' }, lexicalRisk: 'reversible' });
    expect(sent.page.url).toBe(REVIEW_URL);
    expect(sent.page.textDigest).toContain('Review your transfer');
    expect(result.riskJudge).toEqual({ id: 'fake-judge', mode: 'enforce', calls: 1, cacheHits: 0, unavailable: 0, raised: 1 });

    const [event] = judgeEvents(opts.logger.dir);
    expect(event!.data).toMatchObject({ judge: 'fake-judge', decision: 'flag_irreversible', pIrreversible: 0.92, risk: 'irreversible', lexicalRisk: 'reversible' });
    expect(event!.data!.rationale).toContain('funds transfer');
  });

  it('enforce: a human abort ends the run without taking the action', async () => {
    const opts = options({
      judge: fakeJudge(MOVES_MONEY),
      escalate: async () => ({ interventionId: 'int_no', resumeFrom: 'abort', humanActions: [], by: 'test-operator' }),
    });
    const result = await discover(opts);
    expect(result.status).toBe('aborted');
    expect((await opts.surface.observe()).title).toBe('Review transfer');
  });

  it('block mode: refuses the click outright and never escalates', async () => {
    const seen: EscalationRequest[] = [];
    const llm = createScriptedLlm([clickContinue], { onExhausted: 'throw' });
    const opts = options({ judge: fakeJudge(MOVES_MONEY), escalate: approveAll(seen), policy: policyWith({}, 'block'), llm });
    const result = await discover(opts);
    expect(result.status).toBe('stuck');
    expect(seen).toHaveLength(0);
    expect(requestText(llm.requests[1]!)).toContain('Refused: this action is irreversible');
    expect((await opts.surface.observe()).title).toBe('Review transfer');
  });

  it('advise: logs the judgment and a provenance note, but the decision and recorded risk are unchanged', async () => {
    const seen: EscalationRequest[] = [];
    const opts = options({ judge: fakeJudge(MOVES_MONEY), escalate: approveAll(seen), policy: policyWith({ mode: 'advise' }) });
    const result = await discover(opts);
    expect(result.status).toBe('success');
    expect(seen).toHaveLength(0);
    const click = result.capability!.steps.find((s) => s.action.type === 'click')!;
    expect(click.risk).toBe('reversible');
    expect(click.onFailure).toBeUndefined();
    expect(result.capability!.provenance.notes).toContain('advise, not enforced');
    expect(judgeEvents(opts.logger.dir)[0]!.data).toMatchObject({ mode: 'advise', decision: 'allow', wouldRaise: true });
    expect(result.riskJudge?.raised).toBe(0);
  });

  it('a low probability leaves the click reversible and unescalated', async () => {
    const seen: EscalationRequest[] = [];
    const opts = options({ judge: fakeJudge({ risk: 'reversible', pIrreversible: 0.1 }), escalate: approveAll(seen) });
    const result = await discover(opts);
    expect(seen).toHaveLength(0);
    expect(result.capability!.steps.find((s) => s.action.type === 'click')!.risk).toBe('reversible');
  });

  it('fails closed: a judge that throws escalates the click and tells the CLI it is down', async () => {
    const seen: EscalationRequest[] = [];
    const down: { judge: string; reason: string; onError: string }[] = [];
    const opts = options({
      judge: fakeJudge(new Error('HTTP 529 overloaded')),
      escalate: approveAll(seen),
      onRiskJudgeUnavailable: (info) => down.push(info),
    });
    const result = await discover(opts);
    expect(result.status).toBe('success');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.reason.message).toContain('fail_closed');
    expect(result.capability!.steps.find((s) => s.action.type === 'click')!.risk).toBe('irreversible');
    expect(down).toEqual([{ judge: 'fake-judge', reason: 'Error: HTTP 529 overloaded', onError: 'fail_closed' }]);
    expect(judgeEvents(opts.logger.dir)[0]!.data).toMatchObject({ outcome: 'unavailable', onError: 'fail_closed', decision: 'flag_irreversible' });
    expect(result.riskJudge?.unavailable).toBe(1);
  });

  it('fail_open: an unavailable judge leaves the lexical decision alone', async () => {
    const seen: EscalationRequest[] = [];
    const opts = options({ judge: fakeJudge(new Error('down')), escalate: approveAll(seen), policy: policyWith({ onError: 'fail_open' }) });
    const result = await discover(opts);
    expect(seen).toHaveLength(0);
    expect(result.capability!.steps.find((s) => s.action.type === 'click')!.risk).toBe('reversible');
  });

  it('a notice-dismissing click the judge flags is never recorded as an (auto-replayed) recovery rule', async () => {
    const built = scenario()
      .screen('notice', {
        url: REVIEW_URL,
        title: 'Notice',
        text: ['Pending transfer notice'],
        elements: [el({ id: 'ok', role: 'clickable', name: 'OK', text: 'OK', tag: 'div', bbox: { x: 10, y: 10, w: 40, h: 20 } })],
      })
      .on('click', { targetId: 'ok' })
      .goto('sent')
      .screen('sent', { url: `${BASE}/transfers/sent`, title: 'Transfer sent', text: ['Transfer sent'], elements: [] })
      .onAny('navigate', { url: REVIEW_URL })
      .goto('notice')
      .initial('notice')
      .build();
    const dismiss: ScriptedTurn = (req) => ({
      tool: 'dismiss_interstitial',
      input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: 'OK' }), trigger_text: 'Pending transfer notice', title: 'Pending transfer notice', why: 'Dismiss the notice' },
    });
    const seen: EscalationRequest[] = [];
    const llm = createScriptedLlm([dismiss, done], { onExhausted: 'throw' });
    const result = await discover(options({ surface: new FakeSurface(built), llm, judge: fakeJudge(MOVES_MONEY), escalate: approveAll(seen) }));
    expect(seen).toHaveLength(1);
    expect(result.status).toBe('success');
    expect(result.capability!.recoveryRules).toEqual([]);
    expect(requestText(llm.requests[1]!)).toContain('Not recorded as a recovery rule');
  });

  it('sends the target frame and the labels nearest it', async () => {
    const judge = fakeJudge({ risk: 'reversible', pIrreversible: 0.1 });
    await discover(options({ judge }));
    expect(judge.requests[0]!.target).toMatchObject({ name: 'Continue', frame: 'top', nearby: ['Memo'] });
  });

  it('block mode: a judge that stays down ends the run stuck after 3 refusals, naming the outage and --risk-judge off', async () => {
    const llm = createScriptedLlm([clickContinue, clickContinue, clickContinue, clickContinue, clickContinue], { onExhausted: 'throw' });
    const judge = fakeJudge(new Error('HTTP 529 overloaded'));
    const result = await discover(options({ judge, llm, policy: policyWith({}, 'block'), escalate: approveAll([]) }));
    expect(result.status).toBe('stuck');
    expect(result.reason).toContain('risk judge fake-judge was unavailable for 3 committing actions in a row');
    expect(result.reason).toContain('--risk-judge off');
    expect(judge.requests).toHaveLength(3);
    expect(llm.requests).toHaveLength(3);
  });

  it('two wizard pages whose capped excerpts coincide are judged separately (the cache keys on the full page text)', async () => {
    const chrome = (tag: string) => `${tag} `.repeat(400);
    const page = (step: string) => ({
      url: `${BASE}/accounts/new`,
      title: 'Open account',
      text: [chrome('Header navigation and help text'), step, chrome('Footer legal and contact text')],
      elements: [el({ id: 'continue', role: 'button', name: 'Continue', text: 'Continue', tag: 'button', bbox: { x: 10, y: 40, w: 80, h: 20 } })],
    });
    const built = scenario()
      .screen('step1', page('Step 1 of 3: choose the account type'))
      .on('click', { targetId: 'continue' })
      .goto('step3')
      .screen('step3', page('Step 3 of 3: Continue opens the account and moves the opening deposit'))
      .on('click', { targetId: 'continue' })
      .goto('sent')
      .screen('sent', { url: `${BASE}/accounts/done`, title: 'Transfer sent', text: ['Transfer sent'], elements: [] })
      .onAny('navigate', { url: `${BASE}/accounts/new` })
      .goto('step1')
      .initial('step1')
      .build();
    const next: ScriptedTurn = (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'Continue' }), why: 'Continue', expect: '' } });
    const judge = fakeJudge({ risk: 'reversible', pIrreversible: 0.1 });
    const result = await discover(
      options({ surface: new FakeSurface(built), target: { baseUrl: BASE, entryUrl: `${BASE}/accounts/new` }, llm: createScriptedLlm([next, next, done], { onExhausted: 'throw' }), judge }),
    );
    expect(judge.requests).toHaveLength(2);
    // The excerpts the judge saw are identical; only the fingerprint of the full text differs.
    expect(judge.requests[0]!.page.textDigest).toBe(judge.requests[1]!.page.textDigest);
    expect(judge.requests[0]!.page.textDigest!.length).toBeLessThanOrEqual(2000);
    expect(result.riskJudge?.cacheHits).toBe(0);
  });

  it('mode off: the judge is never called', async () => {
    const judge = fakeJudge(MOVES_MONEY);
    const result = await discover(options({ judge, policy: policyWith({ mode: 'off' }) }));
    expect(judge.requests).toHaveLength(0);
    expect(result.riskJudge).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Every judged action type is recorded irreversible + onFailure escalate when the judge flags it
// ---------------------------------------------------------------------------------------------

describe('risk judge in discovery: every committing action type', () => {
  const PAYEES_URL = `${BASE}/payees`;

  function payeesSurface(): FakeSurface {
    const built = scenario()
      .screen('payees', {
        url: PAYEES_URL,
        title: 'Payees',
        text: ['Payees'],
        elements: [
          el({ id: 'payee', role: 'combobox', name: 'Payee', label: 'Payee', tag: 'select', bbox: { x: 10, y: 10, w: 200, h: 20 } }),
          el({ id: 'del', role: 'button', name: 'Remove payee', text: 'Remove payee', tag: 'button', bbox: { x: 10, y: 40, w: 100, h: 20 } }),
        ],
      })
      .on('click', { targetId: 'del' })
      .goto({ dialog: { type: 'confirm', message: 'Remove City Water from your payees?' }, onAccept: 'payees', onDismiss: 'payees' })
      .onAny('navigate', { url: /\/payees/ })
      .goto('payees')
      .initial('payees')
      .build();
    return new FakeSurface(built);
  }

  const finish: ScriptedTurn = { tool: 'done', input: { success_text: 'Payees', summary: 'Done.' } };
  const cases: { type: 'select' | 'press' | 'navigate' | 'dismiss_dialog'; turns: ScriptedTurn[] }[] = [
    {
      type: 'select',
      turns: [
        (req) => ({
          tool: 'select',
          input: { ref: findRef(requestText(req), { role: 'combobox', nameIncludes: 'Payee' }), source: 'literal', value: 'City Water', why: 'Pick the payee', expect: '' },
        }),
      ],
    },
    { type: 'press', turns: [{ tool: 'press', input: { key: 'Enter', why: 'Submit the payee form', expect: '' } }] },
    { type: 'navigate', turns: [{ tool: 'navigate', input: { url: `${PAYEES_URL}/delete?id=3`, why: 'Follow the delete link', expect: '' } }] },
    {
      type: 'dismiss_dialog',
      turns: [
        (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'Remove payee' }), why: 'Open the removal prompt', expect: '' } }),
        { tool: 'dismiss_dialog', input: { accept: true, why: 'Confirm the removal' } },
      ],
    },
  ];

  for (const c of cases) {
    it(`${c.type}: escalated, then recorded irreversible with onFailure escalate`, async () => {
      const requests: RiskJudgeRequest[] = [];
      const judge: RiskJudge = {
        id: 'by-type',
        async judge(req) {
          requests.push(req);
          return req.action.type === c.type ? MOVES_MONEY : { risk: 'reversible', pIrreversible: 0.05 };
        },
      };
      const seen: EscalationRequest[] = [];
      const result = await discover(
        options({
          surface: payeesSurface(),
          target: { baseUrl: BASE, entryUrl: PAYEES_URL },
          llm: createScriptedLlm([...c.turns, finish], { onExhausted: 'throw' }),
          judge,
          escalate: approveAll(seen),
        }),
      );
      expect(result.status, result.reason).toBe('success');
      expect(seen).toHaveLength(1);
      expect(requests.some((r) => r.action.type === c.type)).toBe(true);
      const step = result.capability!.steps.find((s) => s.action.type === c.type && s.id !== 's01')!;
      expect(step.risk).toBe('irreversible');
      expect(step.onFailure).toBe('escalate');
      expect(validateCapability(result.capability!).ok).toBe(true);
    });
  }
});
