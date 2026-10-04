/**
 * Red team: a value the surface masked never reaches the model, the transcript, the event log,
 * the result file or the capability, yet discovery still extracts it (docs/design/screen-masking.md,
 * "The model extracts what it cannot see").
 *
 * Runs `discover()` with the scripted LLM against the cu-core FakeSurface scenario, with member
 * 12345's savings balance marked masked (as a surface does when the policy masks its label). The
 * model finds the cell by its `[MASKED:savings_balance]` placeholder and extracts it. Checks:
 *  - every LLM request, transcript.jsonl, events.jsonl, result.json and capability.json are free
 *    of the balance in every textual form ("$1,234.56", "1,234.56", "1234.56");
 *  - the extract feedback says the value is withheld;
 *  - the recorded output is `sensitive: true`, and no locator carries the value;
 *  - the caller still gets the real value in `result.outputs`.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discover } from './discover.js';
import { createScriptedLlm, requestText, type ScriptedTurn } from './scripted-llm.js';
import type { PolicyGuardLike } from './types.js';
import { createCuCoreScenario } from '../surface/fake-scenarios/cu-core.js';
import { FakeSurface } from '../surface/fake/surface.js';
import { el, scenario } from '../surface/fake/scenario.js';
import { createRunLogger, newRunId } from '../evidence/index.js';
import { DEFAULT_POLICY_PATH, loadPolicy } from '../policy/load.js';
import { findRef } from './test-helpers.js';

const BASE_URL = 'http://localhost:4173';
const NOTICE_TEXT = 'System Maintenance Notice';
const SECRET_VALUES: Record<string, string> = { MOCK_USER: 'operator1', MOCK_PASSWORD: 'demo-pass-123' };
const BALANCE_FORMS = ['$1,234.56', '1,234.56', '1234.56'];

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function allowGuard(): PolicyGuardLike {
  return { checkAction: () => ({ decision: 'allow', reason: 'ok', risk: 'read' }), checkUrl: () => ({ allowed: true, reason: 'ok' }) };
}

/** The cu-core scenario with every member's savings balance cell masked, as a masking surface reports it. */
function maskedBalanceSurface(): FakeSurface {
  const sc = createCuCoreScenario();
  for (const screen of Object.values(sc.screens)) {
    screen.elements = screen.elements.map((e) => (e.id === 'savingsBalance' ? { ...e, masked: 'savings_balance' } : e));
  }
  return new FakeSurface(sc);
}

const turn = (tool: string, input: (text: string) => Record<string, unknown>): ScriptedTurn => (req) => ({ tool, input: input(requestText(req)) });

function script(): ScriptedTurn[] {
  return [
    turn('type', (t) => ({ ref: findRef(t, { role: 'textbox', nameIncludes: 'User ID' }), source: 'secret', value: 'MOCK_USER', why: 'Enter the user ID', expect: '' })),
    turn('type', (t) => ({ ref: findRef(t, { role: 'textbox', nameIncludes: 'Password' }), source: 'secret', value: 'MOCK_PASSWORD', why: 'Enter the password', expect: '' })),
    turn('click', (t) => ({ ref: findRef(t, { role: 'button', nameIncludes: 'login' }), why: 'Sign on', expect: NOTICE_TEXT })),
    turn('dismiss_interstitial', (t) => ({ ref: findRef(t, { role: 'clickable', nameIncludes: 'OK' }), trigger_text: NOTICE_TEXT, title: NOTICE_TEXT, why: 'Dismiss the maintenance notice' })),
    turn('type', (t) => ({ ref: findRef(t, { role: 'textbox', nameIncludes: 'Member ID' }), source: 'input', value: 'memberId', why: 'Enter the member ID', expect: '' })),
    turn('click', (t) => ({ ref: findRef(t, { role: 'clickable', nameIncludes: 'Search' }), why: 'Search for the member', expect: '12345 Jane Q. Sample' })),
    turn('click', (t) => ({ ref: findRef(t, { role: 'clickable', nameIncludes: '12345' }), why: 'Open the matching result', expect: 'Savings Balance' })),
    // The model cannot see the balance: it extracts the cell the placeholder names.
    turn('extract', (t) => ({ ref: findRef(t, { role: 'cell', nameIncludes: '[MASKED:savings_balance]' }), output: 'savingsBalance', parse: 'currency', why: 'Read the savings balance' })),
    { tool: 'done', input: { success_text: 'Savings Balance', summary: "Read the member's savings balance." } },
  ];
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (!p.endsWith('.png')) out.push(p);
  }
  return out;
}

describe('screen masking: a masked on-screen value never reaches the model, the transcript, the evidence or the capability', () => {
  it('discovery extracts the masked balance for the caller and nowhere else', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-mask-leak-'));
    tmpDirs.push(root);
    const logger = createRunLogger({ runId: newRunId(), runKind: 'discovery', rootDir: root });
    const llm = createScriptedLlm(script());
    const result = await discover({
      goal: 'Log in, look up member 12345 and read their current savings balance.',
      target: { baseUrl: BASE_URL, entryUrl: `${BASE_URL}/login` },
      app: { vendor: 'Acme Core Systems', product: 'CU Core Workstation', surface: 'web' },
      inputs: { memberId: { value: '12345', sensitive: false, description: 'The member ID to look up.', type: 'string' } },
      outputs: { savingsBalance: { type: 'number', description: 'Savings balance' } },
      surface: maskedBalanceSurface(),
      policy: loadPolicy(DEFAULT_POLICY_PATH),
      guard: allowGuard(),
      logger,
      llm,
      secretEnvNames: ['MOCK_USER', 'MOCK_PASSWORD'],
      secrets: (env) => SECRET_VALUES[env],
      expectTimeoutMs: 150,
    });

    expect(result.status, JSON.stringify(result.issues ?? result.reason)).toBe('success');
    // The caller gets the value it asked for.
    expect(result.outputs?.savingsBalance).toBe(1234.56);

    // The model saw the placeholder, then a "withheld" note, never the value.
    const prompts = llm.requests.map((r) => requestText(r));
    expect(prompts.some((p) => p.includes('[MASKED:savings_balance]'))).toBe(true);
    expect(prompts.some((p) => p.includes('Extracted savingsBalance; the value is withheld because the field is masked.'))).toBe(true);
    for (const [i, p] of prompts.entries()) for (const v of BALANCE_FORMS) expect(p, `LLM request #${i} leaked ${v}`).not.toContain(v);

    // The capability records a sensitive output and no locator, description or snapshot carries the value.
    const cap = result.capability!;
    expect(cap.outputs.savingsBalance).toMatchObject({ type: 'number', sensitive: true });
    const extract = cap.steps.find((s) => s.action.type === 'extract')!;
    expect(extract.action.type === 'extract' && extract.action.target.locators.length).toBeGreaterThan(0);
    for (const v of BALANCE_FORMS) expect(JSON.stringify(cap), `capability leaked ${v}`).not.toContain(v);

    // Nothing in the run directory carries it either.
    const files = filesUnder(logger.dir);
    expect(files.some((f) => f.endsWith('transcript.jsonl'))).toBe(true);
    expect(existsSync(path.join(logger.dir, 'result.json'))).toBe(true);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const v of BALANCE_FORMS) expect(text, `${path.relative(logger.dir, f)} leaked ${v}`).not.toContain(v);
    }
    const persisted = JSON.parse(readFileSync(path.join(logger.dir, 'result.json'), 'utf8')) as { outputs?: Record<string, unknown> };
    expect(persisted.outputs?.savingsBalance).toBe('<masked:savingsBalance>');
  });

  it('extracting from an unmasked container that shows masked content (a row holding a masked cell) is withheld and sensitive too', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-mask-leak-row-'));
    tmpDirs.push(root);
    const logger = createRunLogger({ runId: newRunId(), runKind: 'discovery', rootDir: root });
    const surface = new FakeSurface(
      scenario()
        .screen('summary', {
          url: `${BASE_URL}/summary`,
          title: 'Summary',
          elements: [
            el({ id: 'bal', role: 'cell', name: '$1,234.56', text: '$1,234.56', tag: 'td', bbox: { x: 0, y: 0, w: 10, h: 10 }, masked: 'savings_balance' }),
            el({ id: 'row', role: 'clickable', name: 'Savings $1,234.56 available', text: 'Savings $1,234.56 available', tag: 'tr', bbox: { x: 0, y: 20, w: 10, h: 10 } }),
          ],
        })
        .onAny('navigate', { url: `${BASE_URL}/summary` })
        .goto('summary')
        .build(),
    );
    const llm = createScriptedLlm([
      turn('extract', (t) => ({ ref: findRef(t, { role: 'clickable', nameIncludes: 'Savings' }), output: 'savingsLine', parse: 'text', why: 'Read the savings line' })),
      { tool: 'done', input: { success_text: 'Savings', summary: 'Read the savings line.' } },
    ]);
    const result = await discover({
      goal: 'Read the savings line.',
      target: { baseUrl: BASE_URL, entryUrl: `${BASE_URL}/summary` },
      app: { vendor: 'Acme Core Systems', product: 'CU Core Workstation', surface: 'web' },
      inputs: {},
      surface,
      policy: loadPolicy(DEFAULT_POLICY_PATH),
      guard: allowGuard(),
      logger,
      llm,
      secretEnvNames: [],
      expectTimeoutMs: 150,
    });
    expect(result.status, JSON.stringify([result.reason, result.issues])).toBe('success');
    expect(result.outputs?.savingsLine).toBe('Savings $1,234.56 available');
    expect(result.capability?.outputs.savingsLine?.sensitive).toBe(true);
    for (const [i, req] of llm.requests.entries()) for (const v of BALANCE_FORMS) expect(requestText(req), `LLM request #${i} leaked ${v}`).not.toContain(v);
    for (const f of filesUnder(logger.dir)) for (const v of BALANCE_FORMS) expect(readFileSync(f, 'utf8'), `${f} leaked ${v}`).not.toContain(v);
  });
});
