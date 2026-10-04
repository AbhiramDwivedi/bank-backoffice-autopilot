/**
 * Record-time rule for vacuous checkpoints (tool-handlers.ts `actAndRecord`): an `expect` text that
 * is already visible BEFORE the action -- in the frame the checkpoint would be scoped to -- proves
 * nothing about the action, so it is not recorded as the step's postcondition, the `checkpoint`
 * event marks it vacuous, and the model is told to pick an expectation that only the action can
 * make true. For the stuck-repeat detector and the history a vacuous expectation counts as not
 * met: repeating the same action with the same already-true expectation is the retry loop that
 * recorded the shipped artifact's password step twice. The stuck reason says so truthfully.
 *
 * Also: `discover --read-only` (DiscoverOptions.readOnly) records `readOnly: true`.
 *
 * Drives `discover()` against the cu-core FakeSurface (or a two-frame fake) with a scripted LLM.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discover } from './discover.js';
import { createScriptedLlm, requestText, type ScriptedTurn } from './scripted-llm.js';
import type { DiscoverOptions, PolicyGuardLike } from './types.js';
import { createCuCoreSurface, el, FakeSurface, type FakeScreenSpec, type Surface } from '../surface/index.js';
import { createRunLogger, newRunId } from '../evidence/index.js';
import { DEFAULT_POLICY_PATH, loadPolicy } from '../policy/index.js';
import { findRef, readJsonlFile } from './test-helpers.js';

const BASE_URL = 'http://localhost:4173';
const NOTICE_TEXT = 'System Maintenance Notice';
const SECRETS: Record<string, string> = { MOCK_USER: 'operator1', MOCK_PASSWORD: 'demo-pass-123' };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function allowGuard(): PolicyGuardLike {
  return { checkAction: () => ({ decision: 'allow', reason: 'ok', risk: 'read' }), checkUrl: () => ({ allowed: true, reason: 'ok' }) };
}

function options(script: ScriptedTurn[], surface: Surface = createCuCoreSurface(), extra: Partial<DiscoverOptions> = {}): { opts: DiscoverOptions; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vacuous-expect-'));
  dirs.push(dir);
  const logger = createRunLogger({ runId: newRunId(), runKind: 'discovery', rootDir: dir });
  return {
    dir: logger.dir,
    opts: {
      goal: 'Log in, look up member 12345 and read their current savings balance.',
      target: { baseUrl: BASE_URL, entryUrl: `${BASE_URL}/login` },
      app: { vendor: 'Acme Core Systems', product: 'CU Core Workstation', surface: 'web' },
      inputs: { memberId: { value: '12345', sensitive: false, description: 'member id', type: 'string' } },
      outputs: { savingsBalance: { type: 'number', description: 'balance' } },
      surface,
      policy: loadPolicy(DEFAULT_POLICY_PATH),
      guard: allowGuard(),
      logger,
      llm: createScriptedLlm(script),
      secretEnvNames: ['MOCK_USER', 'MOCK_PASSWORD'],
      secrets: (env) => SECRETS[env],
      expectTimeoutMs: 150,
      ...extra,
    },
  };
}

function typeSecret(nameIncludes: string, env: string, why: string, expectText = ''): ScriptedTurn {
  return (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes }), source: 'secret', value: env, why, expect: expectText } });
}

function click(role: string, nameIncludes: string, why: string, expectText = ''): ScriptedTurn {
  return (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role, nameIncludes }), why, expect: expectText } });
}

/** Full lookup, with a vacuous expectation on the first step ("Password:" is already on the login page). */
function happyPathScript(): ScriptedTurn[] {
  return [
    typeSecret('User ID', 'MOCK_USER', 'Enter the user ID', 'Password:'),
    typeSecret('Password', 'MOCK_PASSWORD', 'Enter the password'),
    click('button', 'login', 'Sign on', NOTICE_TEXT),
    (req) => ({
      tool: 'dismiss_interstitial',
      input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: 'OK' }), trigger_text: NOTICE_TEXT, title: NOTICE_TEXT, why: 'Dismiss the notice' },
    }),
    (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Member ID' }), source: 'input', value: 'memberId', why: 'Enter the member ID', expect: '' } }),
    click('clickable', 'Search', 'Search for the member', 'record(s) found'),
    click('clickable', '12345', 'Open the matching result', 'Savings Balance'),
    (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'cell', nameIncludes: '$1,234.56' }), output: 'savingsBalance', parse: 'currency', why: 'Read the balance' } }),
    { tool: 'done', input: { success_text: 'Savings Balance', summary: 'Read the balance.' } },
  ];
}

/** A turn that records the request text it was given, then ends the run. */
function captureThenStop(sink: string[]): ScriptedTurn {
  return (req) => {
    sink.push(requestText(req));
    return { tool: 'stuck', input: { reason: 'test ends here' } };
  };
}

function checkpointEvents(dir: string): Record<string, unknown>[] {
  return (readJsonlFile(path.join(dir, 'events.jsonl')) as { kind: string; data: Record<string, unknown> }[]).filter((e) => e.kind === 'checkpoint').map((e) => e.data);
}

/**
 * Two frames, "left" and "right". "Saved" is already visible in the left frame; clicking "Go" in
 * the right frame makes "Saved" appear there too (or, with `appearsInRight: false`, changes nothing).
 */
function twoFrameSurface(appearsInRight: boolean): FakeSurface {
  const LEFT = [{ name: 'left' }];
  const RIGHT = [{ name: 'right' }];
  const frames = [
    { path: LEFT, url: `${BASE_URL}/left` },
    { path: RIGHT, url: `${BASE_URL}/right` },
  ];
  const savedLeft = el({ id: 'savedLeft', role: 'generic', name: 'Saved', text: 'Saved', tag: 'span', frame: LEFT, bbox: { x: 10, y: 10, w: 60, h: 20 } });
  const go = el({ id: 'go', role: 'button', name: 'Go', text: 'Go', tag: 'button', frame: RIGHT, bbox: { x: 400, y: 10, w: 60, h: 20 } });
  const savedRight = el({ id: 'savedRight', role: 'generic', name: 'Saved', text: 'Saved', tag: 'span', frame: RIGHT, bbox: { x: 400, y: 60, w: 60, h: 20 } });
  const screen = (id: string, elements: FakeScreenSpec['elements']): FakeScreenSpec => ({ id, url: `${BASE_URL}/two`, title: 'Two frames', frames, elements });
  return new FakeSurface({
    initial: 'a',
    screens: { a: screen('a', [savedLeft, go]), b: screen('b', appearsInRight ? [savedLeft, go, savedRight] : [savedLeft, go]) },
    rules: [
      { from: '*', match: { actionType: 'navigate' }, to: 'a' },
      { from: 'a', match: { actionType: 'click', targetId: 'go' }, to: 'b' },
    ],
  });
}

describe('record-time vacuous checkpoints', () => {
  it('does not record an expectation that was already visible before the action, and tells the model why', async () => {
    const seen: string[] = [];
    // "Password:" is the login form's own label: visible before the user id is typed.
    const { opts, dir } = options([typeSecret('User ID', 'MOCK_USER', 'Enter the user ID', 'Password:'), captureThenStop(seen)]);
    const result = await discover(opts);

    // The entry-page navigate plus the typed user id.
    expect(result.stepsRecorded).toBe(2);
    const cps = checkpointEvents(dir);
    expect(cps).toHaveLength(1);
    expect(cps[0]).toMatchObject({ expect: 'Password:', met: true, vacuous: true, recorded: false });

    const next = seen[0]!;
    expect(next).toContain('your expectation proves nothing');
    expect(next).toContain('was already visible BEFORE the action');
    expect(next).toContain('expectation was already true before acting; not a checkpoint');
  });

  it('records the step without a postcondition in the finished capability, while a real expectation still becomes one', async () => {
    const { opts } = options(happyPathScript());
    const result = await discover(opts);
    expect(result.status).toBe('success');
    const steps = result.capability!.steps;
    expect(steps.find((s) => s.name === 'Enter the user ID')!.postcondition).toBeUndefined();
    expect(steps.find((s) => s.name === 'Sign on')!.postcondition).toMatchObject({ kind: 'text_visible', text: NOTICE_TEXT });
    expect(result.capability!.readOnly).toBeUndefined();
  });

  it('counts a vacuous expectation as unmet for the stuck-repeat detector, and the stuck reason says what happened', async () => {
    const same = typeSecret('Password', 'MOCK_PASSWORD', 'Enter the password', 'Password:');
    const { opts } = options([same, same, same, { tool: 'stuck', input: { reason: 'not reached' } }]);
    const result = await discover(opts);
    expect(result.status).toBe('stuck');
    expect(result.reason).toContain('repeated 3 times in a row with an expectation that was already visible before the action');
    // Not the false "without meeting its expectation": the text WAS visible, it just proved nothing.
    expect(result.reason).not.toContain('without meeting its expectation');
  });

  it('text already visible in ANOTHER frame does not make the expectation vacuous: the checkpoint is scoped to the frame where it appeared', async () => {
    const goClick: ScriptedTurn = (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'Go' }), why: 'Press Go', expect: 'Saved' } });
    const stop: ScriptedTurn = { tool: 'stuck', input: { reason: 'stop' } };

    const real = options([goClick, stop], twoFrameSurface(true));
    await discover(real.opts);
    const realCp = checkpointEvents(real.dir)[0]!;
    expect(realCp).toMatchObject({ expect: 'Saved', met: true, frame: [{ name: 'right' }] });
    expect(realCp.vacuous).toBeUndefined();

    // Control: nothing appears in the right frame, so the only match is the left frame, where the
    // text already was -- vacuous.
    const none = options([goClick, stop], twoFrameSurface(false));
    await discover(none.opts);
    expect(checkpointEvents(none.dir)[0]).toMatchObject({ expect: 'Saved', met: true, vacuous: true, recorded: false });
  });
});

describe('discover --read-only', () => {
  it('records the operator declaration on the capability', async () => {
    const { opts } = options(happyPathScript(), createCuCoreSurface(), { readOnly: true });
    const result = await discover(opts);
    expect(result.status).toBe('success');
    expect(result.capability!.readOnly).toBe(true);
  });

  it('drops the declaration -- never the capability -- when the run performed an irreversible action', async () => {
    // The guard flags the Search click irreversible; the (scripted) human confirms it.
    const flagSearch: PolicyGuardLike = {
      checkAction: (_a, ctx) =>
        ctx.targetName === 'Search' ? { decision: 'flag_irreversible', reason: 'test', risk: 'irreversible' } : { decision: 'allow', reason: 'ok', risk: 'read' },
      checkUrl: () => ({ allowed: true, reason: 'ok' }),
    };
    const { opts } = options(happyPathScript(), createCuCoreSurface(), {
      readOnly: true,
      guard: flagSearch,
      escalate: async () => ({ interventionId: 'i1', resumeFrom: 'next_step', humanActions: [], by: 'tester' }),
    });
    const result = await discover(opts);
    expect(result.status).toBe('success');
    const search = result.capability!.steps.find((s) => s.name === 'Search for the member')!;
    expect(search.risk).toBe('irreversible');
    expect(result.capability!.readOnly).toBeUndefined();
    expect(result.readOnlyDropped).toEqual([search.id]);
  });
});
