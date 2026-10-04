/**
 * Red team: every condition discovery evaluates for model-written text goes to the surface with
 * `{ view: 'masked' }` (docs/design/screen-masking.md, "Conditions the model writes are evaluated in
 * the masked view"), including the optimizer's vacuous-expectation pre-check, which runs BEFORE the
 * action (`preActVisibility`). A check against the real page would answer a guess at hidden text
 * differently from a miss: the yes/no oracle masking closes.
 *
 * The surface here records the options of every `check`/`waitFor` call. The script exercises an
 * `expect` that is already visible before its action (the vacuous path: pre-check, checkpoint,
 * frame probe), an `expect` that becomes visible, `dismiss_interstitial`, and `done`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discover } from './discover.js';
import { createScriptedLlm, requestText, type ScriptedTurn } from './scripted-llm.js';
import type { PolicyGuardLike } from './types.js';
import { createCuCoreScenario } from '../surface/fake-scenarios/cu-core.js';
import { FakeSurface } from '../surface/fake/surface.js';
import type { CheckOptions, Surface } from '../surface/index.js';
import type { Condition } from '../schema/index.js';
import { createRunLogger, newRunId } from '../evidence/index.js';
import { DEFAULT_POLICY_PATH, loadPolicy } from '../policy/load.js';
import { findRef } from './test-helpers.js';

const BASE_URL = 'http://localhost:4173';
const NOTICE_TEXT = 'System Maintenance Notice';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const turn = (tool: string, input: (text: string) => Record<string, unknown>): ScriptedTurn => (req) => ({ tool, input: input(requestText(req)) });

/** A surface that records the `view` of every condition check. */
function recording(inner: FakeSurface): { surface: Surface; calls: { condition: Condition; view: CheckOptions['view'] }[] } {
  const calls: { condition: Condition; view: CheckOptions['view'] }[] = [];
  const surface = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'check') {
        return (condition: Condition, opts?: CheckOptions) => {
          calls.push({ condition, view: opts?.view });
          return target.check(condition, opts);
        };
      }
      if (prop === 'waitFor') {
        return (condition: Condition, timeoutMs: number, opts?: CheckOptions) => {
          calls.push({ condition, view: opts?.view });
          return target.waitFor(condition, timeoutMs, opts);
        };
      }
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as unknown as Surface;
  return { surface, calls };
}

describe('discovery evaluates every model-written condition in the masked view', () => {
  it('including the vacuous-expectation pre-check before an action', async () => {
    const { surface, calls } = recording(new FakeSurface(createCuCoreScenario()));
    const root = mkdtempSync(path.join(os.tmpdir(), 'masked-view-'));
    tmpDirs.push(root);
    const guard: PolicyGuardLike = { checkAction: () => ({ decision: 'allow', reason: 'ok', risk: 'read' }), checkUrl: () => ({ allowed: true, reason: 'ok' }) };
    const script: ScriptedTurn[] = [
      // Vacuous: "User ID" is on the login screen before the action.
      turn('type', (t) => ({ ref: findRef(t, { role: 'textbox', nameIncludes: 'User ID' }), source: 'secret', value: 'MOCK_USER', why: 'Enter the user ID', expect: 'User ID' })),
      turn('type', (t) => ({ ref: findRef(t, { role: 'textbox', nameIncludes: 'Password' }), source: 'secret', value: 'MOCK_PASSWORD', why: 'Enter the password', expect: '' })),
      turn('click', (t) => ({ ref: findRef(t, { role: 'button', nameIncludes: 'login' }), why: 'Sign on', expect: NOTICE_TEXT })),
      turn('dismiss_interstitial', (t) => ({ ref: findRef(t, { role: 'clickable', nameIncludes: 'OK' }), trigger_text: NOTICE_TEXT, title: NOTICE_TEXT, why: 'Dismiss the notice' })),
      { tool: 'done', input: { success_text: 'Member ID', summary: 'Reached the lookup.' } },
    ];
    const result = await discover({
      goal: 'Sign on.',
      target: { baseUrl: BASE_URL, entryUrl: `${BASE_URL}/login` },
      app: { vendor: 'Acme Core Systems', product: 'CU Core Workstation', surface: 'web' },
      inputs: {},
      surface,
      policy: loadPolicy(DEFAULT_POLICY_PATH),
      guard,
      logger: createRunLogger({ runId: newRunId(), runKind: 'discovery', rootDir: root }),
      llm: createScriptedLlm(script),
      secretEnvNames: ['MOCK_USER', 'MOCK_PASSWORD'],
      secrets: (env) => ({ MOCK_USER: 'operator1', MOCK_PASSWORD: 'demo-pass-123' })[env],
      expectTimeoutMs: 200,
    });
    expect(result.status, JSON.stringify([result.reason, result.issues])).toBe('success');
    // The vacuous path ran: the pre-check and the checkpoint both looked for "User ID".
    expect(calls.filter((c) => c.condition.kind === 'text_visible' && c.condition.text === 'User ID').length).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBeGreaterThan(0);
    const real = calls.filter((c) => c.view !== 'masked');
    expect(real, JSON.stringify(real)).toEqual([]);
  });
});
