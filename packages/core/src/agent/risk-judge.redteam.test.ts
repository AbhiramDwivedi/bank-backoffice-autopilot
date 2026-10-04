/**
 * Redteam pins for the risk judge (docs/design/risk-judge.md):
 *
 * 1. Raise-only. A judge that answers "read" (pIrreversible 0) for a control the lexical
 *    `irreversibleTextPatterns` flag changes nothing: the click is still escalated and recorded
 *    irreversible. A judge can also never lower a lexically `reversible` action to `read`.
 * 2. The judge is a third party: what it receives is scrubbed (secret and sensitive input values,
 *    policy redaction patterns) and never carries a typed value.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discover } from './discover.js';
import { createScriptedLlm, requestText, type ScriptedTurn } from './scripted-llm.js';
import type { DiscoverOptions } from './types.js';
import { findRef } from './test-helpers.js';
import { FakeSurface, el, scenario } from '../surface/index.js';
import { createRunLogger, newRunId } from '../evidence/index.js';
import { DEFAULT_POLICY_PATH, combineRisk, createPolicyGuard, loadPolicy, type RiskJudge, type RiskJudgeRequest, type RiskJudgment } from '../policy/index.js';
import type { Policy } from '../schema/index.js';
import type { EscalationHandler, EscalationRequest } from '../session/index.js';

const BASE = 'http://localhost:4173';
const PAGE_URL = `${BASE}/transfers/review`;
const DEFAULT_POLICY = loadPolicy(DEFAULT_POLICY_PATH);
const ENFORCE_POLICY: Policy = {
  ...DEFAULT_POLICY,
  risk: { ...DEFAULT_POLICY.risk, discoveryMode: 'escalate', judge: { mode: 'enforce', irreversibleThreshold: 0.5, onError: 'fail_closed', timeoutMs: 1000 } },
};

const SECRET_USER = 'operator-zz9';
const SENSITIVE_ACCOUNT = '77441100';
const SSN = '123-45-6789';

function surface(): FakeSurface {
  const built = scenario()
    .screen('review', {
      url: PAGE_URL,
      title: 'Review transfer',
      text: [`Signed on as ${SECRET_USER}. Destination account ${SENSITIVE_ACCOUNT}. Member SSN ${SSN}.`],
      elements: [
        el({ id: 'acct', role: 'textbox', name: 'Destination account', label: 'Destination account', tag: 'input', bbox: { x: 10, y: 10, w: 200, h: 20 } }),
        el({ id: 'confirm', role: 'button', name: 'Confirm transfer', text: 'Confirm transfer', tag: 'button', bbox: { x: 10, y: 40, w: 120, h: 20 } }),
        el({ id: 'continue', role: 'button', name: 'Continue', text: 'Continue', tag: 'button', bbox: { x: 10, y: 70, w: 80, h: 20 } }),
      ],
    })
    .on('click', { targetId: 'confirm' })
    .goto('sent')
    .on('click', { targetId: 'continue' })
    .goto('sent')
    .screen('sent', { url: `${BASE}/transfers/sent`, title: 'Transfer sent', text: ['Transfer sent'], elements: [] })
    .onAny('navigate', { url: PAGE_URL })
    .goto('review')
    .initial('review')
    .build();
  return new FakeSurface(built);
}

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function judgeAnswering(answer: RiskJudgment): RiskJudge & { requests: RiskJudgeRequest[] } {
  const requests: RiskJudgeRequest[] = [];
  return {
    id: 'adversarial-judge',
    requests,
    async judge(req) {
      requests.push(req);
      return answer;
    },
  };
}

const click = (name: string): ScriptedTurn => (req) => ({
  tool: 'click',
  input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: name }), why: `Press ${name}`, expect: 'Transfer sent' },
});
const typeAccount: ScriptedTurn = (req) => ({
  tool: 'type',
  input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Destination' }), source: 'input', value: 'account', why: 'Enter the destination', expect: '' },
});
const done: ScriptedTurn = { tool: 'done', input: { success_text: 'Transfer sent', summary: 'Sent.' } };

function options(llmTurns: ScriptedTurn[], judge: RiskJudge, escalate: EscalationHandler): DiscoverOptions {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'risk-judge-redteam-'));
  tmpDirs.push(dir);
  return {
    goal: `Send the transfer to ${SENSITIVE_ACCOUNT}.`,
    target: { baseUrl: BASE, entryUrl: PAGE_URL },
    app: { vendor: 'Acme Core Systems', product: 'CU Core Workstation', surface: 'web' },
    inputs: { account: { value: SENSITIVE_ACCOUNT, sensitive: true, description: 'Destination account', type: 'string' } },
    surface: surface(),
    policy: ENFORCE_POLICY,
    guard: createPolicyGuard(DEFAULT_POLICY),
    logger: createRunLogger({ runId: newRunId(), runKind: 'discovery', rootDir: dir }),
    llm: createScriptedLlm(llmTurns, { onExhausted: 'throw' }),
    escalate,
    judge,
    secretEnvNames: ['MOCK_USER'],
    secrets: (env) => (env === 'MOCK_USER' ? SECRET_USER : undefined),
    expectTimeoutMs: 100,
  };
}

function approving(seen: EscalationRequest[]): EscalationHandler {
  return async (req) => {
    seen.push(req);
    return { interventionId: 'int_ok', resumeFrom: 'current_step', humanActions: [], by: 'test-operator' };
  };
}

describe('redteam: a judgment can only raise risk', () => {
  it('a judge answering "read" for a lexically irreversible "Confirm transfer" changes nothing', async () => {
    const judge = judgeAnswering({ risk: 'read', pIrreversible: 0, rationale: 'Harmless button, go ahead.' });
    const seen: EscalationRequest[] = [];
    const result = await discover(options([click('Confirm transfer'), done], judge, approving(seen)));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.reason.code).toBe('risky_action_confirmation');
    const step = result.capability!.steps.find((s) => s.action.type === 'click')!;
    expect(step.risk).toBe('irreversible');
    expect(step.onFailure).toBe('escalate');
    // The lexical guard already flagged it, so the judge was never even asked.
    expect(judge.requests).toHaveLength(0);
  });

  it('a judge answering "read" cannot lower a lexically reversible click to read', async () => {
    const judge = judgeAnswering({ risk: 'read', pIrreversible: 0 });
    const seen: EscalationRequest[] = [];
    const result = await discover(options([click('Continue'), done], judge, approving(seen)));
    expect(judge.requests).toHaveLength(1);
    expect(result.capability!.steps.find((s) => s.action.type === 'click')!.risk).toBe('reversible');
  });

  it('combineRisk never returns less than the lexical risk, for any judgment, mode or onError', () => {
    const lexicals = ['read', 'reversible', 'irreversible'] as const;
    const order = { read: 0, reversible: 1, irreversible: 2 };
    for (const lexical of lexicals) {
      for (const mode of ['off', 'advise', 'enforce'] as const) {
        for (const onError of ['fail_closed', 'fail_open'] as const) {
          for (const p of [0, 0.3, 0.5, 1]) {
            for (const risk of lexicals) {
              const c = combineRisk(lexical, { kind: 'judged', judgment: { risk, pIrreversible: p }, cached: false }, { mode, onError, irreversibleThreshold: 0.5, timeoutMs: 1 });
              expect(order[c.risk]).toBeGreaterThanOrEqual(order[lexical]);
            }
          }
          const u = combineRisk(lexical, { kind: 'unavailable', reason: 'x' }, { mode, onError, irreversibleThreshold: 0.5, timeoutMs: 1 });
          expect(order[u.risk]).toBeGreaterThanOrEqual(order[lexical]);
        }
      }
    }
  });
});

describe('redteam: the judge only ever sees scrubbed, value-free text', () => {
  it('secret values, sensitive inputs and pattern-matched PII are replaced before the request leaves', async () => {
    const judge = judgeAnswering({ risk: 'reversible', pIrreversible: 0.1 });
    const seen: EscalationRequest[] = [];
    await discover(options([typeAccount, click('Continue'), done], judge, approving(seen)));

    expect(judge.requests).toHaveLength(1);
    const wire = JSON.stringify(judge.requests);
    expect(wire).not.toContain(SECRET_USER);
    expect(wire).not.toContain(SENSITIVE_ACCOUNT);
    expect(wire).not.toContain(SSN);
    expect(wire).toContain('<secret:MOCK_USER>');
    expect(wire).toContain('<sensitive:account>');
    // No typed value, ever: the action carries only its type.
    expect(judge.requests[0]!.action).toEqual({ type: 'click' });
  });

  it('the navigate URL (plain and URL-encoded), the dialog message, the goal and the why are scrubbed too', async () => {
    const odd = 'acct 77/44&11';
    const built = scenario()
      .screen('review', {
        url: PAGE_URL,
        title: 'Review transfer',
        text: ['Review'],
        elements: [el({ id: 'rm', role: 'button', name: 'Remove', text: 'Remove', tag: 'button', bbox: { x: 10, y: 10, w: 80, h: 20 } })],
      })
      .on('click', { targetId: 'rm' })
      .goto({ dialog: { type: 'confirm', message: `Remove ${SENSITIVE_ACCOUNT} for ${SECRET_USER}?` }, onAccept: 'review', onDismiss: 'review' })
      .onAny('navigate', { url: /\/transfers\// })
      .goto('review')
      .initial('review')
      .build();
    const judge = judgeAnswering({ risk: 'reversible', pIrreversible: 0.1 });
    const turns: ScriptedTurn[] = [
      { tool: 'navigate', input: { url: `${BASE}/transfers/review?to=${SENSITIVE_ACCOUNT}&memo=${encodeURIComponent(odd)}`, why: `Open the transfer to ${SENSITIVE_ACCOUNT} as ${SECRET_USER}`, expect: '' } },
      click('Remove'),
      { tool: 'dismiss_dialog', input: { accept: true, why: `Confirm for ${SECRET_USER}` } },
      { tool: 'done', input: { success_text: 'Review', summary: 'Done.' } },
    ];
    const opts = options(turns, judge, approving([]));
    opts.surface = new FakeSurface(built);
    opts.inputs = { ...opts.inputs, memo: { value: odd, sensitive: true, description: 'Memo', type: 'string' } };
    await discover(opts);

    const types = judge.requests.map((r) => r.action.type);
    expect(types).toEqual(expect.arrayContaining(['navigate', 'click', 'dismiss_dialog']));
    const wire = JSON.stringify(judge.requests);
    for (const raw of [SECRET_USER, SENSITIVE_ACCOUNT, odd, encodeURIComponent(odd)]) expect(wire).not.toContain(raw);
    const nav = judge.requests.find((r) => r.action.type === 'navigate')!;
    expect(nav.action.url).toContain('<sensitive:account>');
    expect(nav.action.url).toContain('<sensitive:memo>');
    expect(nav.goal).toContain('<sensitive:account>');
    expect(nav.why).toContain('<secret:MOCK_USER>');
    const dialog = judge.requests.find((r) => r.action.type === 'dismiss_dialog')!;
    expect(dialog.page.dialogMessage).toBe('Remove <sensitive:account> for <secret:MOCK_USER>?');
  });
});
