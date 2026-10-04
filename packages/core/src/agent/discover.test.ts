/**
 * Integration tests for the discovery loop (`discover()`), against `FakeSurface` (the cu-core
 * scenario) and a scripted LLM -- no network, no Playwright. See docs/design/agent.md's
 * "Acceptance criteria" and "Quality" sections for what this suite is checking.
 *
 * Every scripted LLM turn is a *function* `(req) => ...` that reads the current turn's ELEMENTS
 * section out of `requestText(req)` and finds its ref by role + name (see ./test-helpers.ts).
 * Refs are positional-per-observation (packages/core/src/surface/fake.ts), so a hardcoded ref would be wrong
 * the moment an earlier step changes the screen.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { discover } from './discover.js';
import { createScriptedLlm, requestText, type ScriptedTurn } from './scripted-llm.js';
import type { DiscoverOptions, InputDecl, PolicyActionContext, PolicyGuardLike } from './types.js';
import type { SurfaceAction } from '../surface/types.js';
import { createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';
import { createRunLogger, newRunId } from '../evidence/index.js';
import { DEFAULT_POLICY_PATH, loadPolicy } from '../policy/load.js';
import { validateCapability, type Policy, type TargetDescriptor } from '../schema/index.js';
import type { EscalationHandler, EscalationRequest } from '../session/types.js';
import { findRef, readJsonlFile, readTextFile } from './test-helpers.js';
import { makeFakeClock, runReplay } from '../replay/test-helpers.js';
import { dispatch } from './tool-handlers.js';
import { createRecorder } from './recorder.js';
import { createScrubber } from './scrub.js';
import { StuckRepeatDetector } from './limits.js';
import type { LoopState, RunContext } from './run-context.js';
import type { FakeSurface } from '../surface/index.js';

// ---------------------------------------------------------------------------------------------
// Fixed scenario facts (packages/core/src/surface/fake-scenarios/cu-core.ts, tenant A).
// ---------------------------------------------------------------------------------------------

const BASE_URL = 'http://localhost:4173';
const ENTRY_URL = `${BASE_URL}/login`;
const NOTICE_TEXT = 'System Maintenance Notice';
const RESULT_TEXT_12345 = '12345 Jane Q. Sample 08/15/2004 Active';

const DEFAULT_POLICY = loadPolicy(DEFAULT_POLICY_PATH);

const SECRET_VALUES: Record<string, string> = { MOCK_USER: 'operator1', MOCK_PASSWORD: 'demo-pass-123' };
function secretsResolver(env: string): string | undefined {
  return SECRET_VALUES[env];
}

// ---------------------------------------------------------------------------------------------
// Temp run directories.
// ---------------------------------------------------------------------------------------------

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeLogger() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'discover-test-'));
  tmpDirs.push(dir);
  const runId = newRunId();
  const logger = createRunLogger({ runId, runKind: 'discovery', rootDir: dir });
  return { dir, runId, logger };
}

// ---------------------------------------------------------------------------------------------
// Guard stubs. Each test controls exactly what it needs; everything else defaults to allow.
// ---------------------------------------------------------------------------------------------

function allowGuard(): PolicyGuardLike {
  return {
    checkAction: () => ({ decision: 'allow', reason: 'ok', risk: 'read' }),
    checkUrl: () => ({ allowed: true, reason: 'ok' }),
  };
}

function denyGuard(shouldDeny: (action: SurfaceAction, ctx: PolicyActionContext) => boolean): PolicyGuardLike {
  return {
    checkAction: (action, ctx) =>
      shouldDeny(action, ctx) ? { decision: 'deny', reason: 'test: denied by policy', risk: 'read' } : { decision: 'allow', reason: 'ok', risk: 'read' },
    checkUrl: () => ({ allowed: true, reason: 'ok' }),
  };
}

function flagGuard(shouldFlag: (action: SurfaceAction, ctx: PolicyActionContext) => boolean): PolicyGuardLike {
  return {
    checkAction: (action, ctx) =>
      shouldFlag(action, ctx)
        ? { decision: 'flag_irreversible', reason: 'test: flagged as irreversible', risk: 'irreversible' }
        : { decision: 'allow', reason: 'ok', risk: 'read' },
    checkUrl: () => ({ allowed: true, reason: 'ok' }),
  };
}

// ---------------------------------------------------------------------------------------------
// Inputs / options builders.
// ---------------------------------------------------------------------------------------------

function makeInputs(overrides: Record<string, InputDecl> = {}): Record<string, InputDecl> {
  return {
    memberId: { value: '12345', sensitive: false, description: 'The member ID to look up.', type: 'string' },
    ...overrides,
  };
}

function baseOptions(logger: ReturnType<typeof makeLogger>['logger'], llm: DiscoverOptions['llm'], overrides: Partial<DiscoverOptions> = {}): DiscoverOptions {
  return {
    goal: 'Log in, look up member 12345 and read their current savings balance.',
    target: { baseUrl: BASE_URL, entryUrl: ENTRY_URL },
    app: { vendor: 'Acme Core Systems', product: 'CU Core Workstation', surface: 'web' },
    inputs: makeInputs(),
    surface: createCuCoreSurface(),
    policy: DEFAULT_POLICY,
    guard: allowGuard(),
    logger,
    llm,
    secretEnvNames: ['MOCK_USER', 'MOCK_PASSWORD'],
    secrets: secretsResolver,
    expectTimeoutMs: 150,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// Reusable scripted turns (functions that resolve refs off the CURRENT turn's request text).
// ---------------------------------------------------------------------------------------------

function typeSecret(nameIncludes: string, env: string, why: string): ScriptedTurn {
  return (req) => ({
    tool: 'type',
    input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes }), source: 'secret', value: env, why, expect: '' },
  });
}

function typeInput(nameIncludes: string, inputName: string, why: string, expect = ''): ScriptedTurn {
  return (req) => ({
    tool: 'type',
    input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes }), source: 'input', value: inputName, why, expect },
  });
}

function clickByRoleName(role: string, nameIncludes: string, why: string, expect = ''): ScriptedTurn {
  return (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role, nameIncludes }), why, expect } });
}

/** `title` defaults to `triggerText` so every EXISTING call site (which passes the notice's
 *  title, "System Maintenance Notice", as `triggerText`) keeps naming its recovery rule the same
 *  way as before. Pass a distinct `title` to reproduce the real artifact's shape: `trigger_text`
 *  = the notice's longer BODY copy, `title` = its short heading -- see the "Defect 3" describe
 *  block below. */
function dismissInterstitial(triggerText: string, why: string, title: string = triggerText): ScriptedTurn {
  return (req) => ({
    tool: 'dismiss_interstitial',
    input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: 'OK' }), trigger_text: triggerText, title, why },
  });
}

function extractField(nameIncludes: string, output: string, parse: 'text' | 'number' | 'currency', why: string): ScriptedTurn {
  return (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'cell', nameIncludes }), output, parse, why } });
}

function doneTurn(successText: string, summary: string): ScriptedTurn {
  return { tool: 'done', input: { success_text: successText, summary } };
}

function stuckTurn(reason: string): ScriptedTurn {
  return { tool: 'stuck', input: { reason } };
}

function loginAndDismissTurns(signOnExpect: string = NOTICE_TEXT): ScriptedTurn[] {
  return [
    typeSecret('User ID', 'MOCK_USER', 'Enter the user ID'),
    typeSecret('Password', 'MOCK_PASSWORD', 'Enter the password'),
    clickByRoleName('button', 'login', 'Sign on', signOnExpect),
    dismissInterstitial(NOTICE_TEXT, 'Dismiss the maintenance notice'),
  ];
}

function searchAndOpenTurns(memberId: string, resultText: string, searchExpect: string = resultText): ScriptedTurn[] {
  return [
    typeInput('Member ID', 'memberId', 'Enter the member ID'),
    clickByRoleName('clickable', 'Search', 'Search for the member', searchExpect),
    clickByRoleName('clickable', memberId, 'Open the matching result', 'Savings Balance'),
  ];
}

function extractSavingsAndDone(): ScriptedTurn[] {
  return [
    extractField('$1,234.56', 'savingsBalance', 'currency', 'Read the savings balance'),
    doneTurn('Savings Balance', "Read the member's savings balance."),
  ];
}

function happyPathScript(): ScriptedTurn[] {
  return [...loginAndDismissTurns(), ...searchAndOpenTurns('12345', RESULT_TEXT_12345), ...extractSavingsAndDone()];
}

function events(dir: string): { kind: string; data?: Record<string, unknown>; stepId?: string }[] {
  return readJsonlFile(path.join(dir, 'events.jsonl')) as { kind: string; data?: Record<string, unknown>; stepId?: string }[];
}

// ---------------------------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------------------------

describe('discover: happy path (cu-core)', () => {
  it('logs in, dismisses the notice, looks up the member, extracts the balance, and produces a valid capability', async () => {
    const { logger, runId } = makeLogger();
    const llm = createScriptedLlm(happyPathScript());
    const opts = baseOptions(logger, llm);
    const result = await discover(opts);

    expect(result.status).toBe('success');
    const cap = result.capability;
    if (cap === undefined) throw new Error(`expected a capability; issues: ${JSON.stringify(result.issues)}`);

    const validated = validateCapability(cap);
    expect(validated.ok).toBe(true);

    expect(cap.status).toBe('draft');
    expect(cap.version).toBe('1.0.0');
    expect(cap.riskLevel).toBe('read');
    // The detail page's main-frame URL (/members/12345?tab=profile) carried the input's run
    // value, so success also checks the final URL belongs to {input.memberId}.
    expect(cap.success.condition).toEqual({
      kind: 'all',
      of: [
        { kind: 'text_visible', text: 'Savings Balance', frame: [{ name: 'main' }] },
        { kind: 'url_matches', pattern: '/members/{input.memberId}(?![A-Za-z0-9])', frame: [{ name: 'main' }] },
      ],
    });
    expect(validated.ok && validated.warnings).toEqual([]);
    expect(cap.outputs.savingsBalance?.type).toBe('number');

    expect(cap.recoveryRules).toHaveLength(1);
    expect(cap.recoveryRules[0]!.trigger.kind).toBe('text_visible');
    if (cap.recoveryRules[0]!.trigger.kind === 'text_visible') {
      expect(cap.recoveryRules[0]!.trigger.frame).toBeDefined();
    }

    // Steps in recorded order: entry navigate, type userId, type password, click signOn,
    // type memberId, click search, click result row, extract savingsBalance. The interstitial
    // dismissal is a recovery rule, not a step.
    expect(cap.steps).toHaveLength(8);
    const [entryStep, userIdStep, , signOnStep, , searchStep, rowStep, extractStep] = cap.steps;
    expect(entryStep!.action.type).toBe('navigate');
    expect(signOnStep!.action.type).toBe('click');
    expect(extractStep!.action.type).toBe('extract');

    if (userIdStep!.action.type !== 'type') throw new Error('expected a type action');
    expect(userIdStep!.action.value).toEqual({ kind: 'secret', env: 'MOCK_USER' });

    // The row-click step's action is fully canonicalized: {input.memberId} appears, the raw
    // member id value never does (checked across the WHOLE action: description, locators,
    // snapshot).
    if (rowStep!.action.type !== 'click') throw new Error('expected a click action');
    const rowStepJson = JSON.stringify(rowStep!.action);
    expect(rowStepJson).toContain('{input.memberId}');
    expect(rowStepJson).not.toContain('12345');

    // The search-click step's `expect` included the row text "12345 ...", so its postcondition
    // is canonicalized too; the results URL (?memberId=12345) adds an input-bound query check.
    const searchPost = searchStep!.postcondition;
    if (searchPost?.kind !== 'all') throw new Error(`expected an all postcondition, got ${JSON.stringify(searchPost)}`);
    expect(searchPost.of).toHaveLength(2);
    expect(searchPost.of[0]!.kind).toBe('text_visible');
    if (searchPost.of[0]!.kind === 'text_visible') expect(searchPost.of[0]!.text).toContain('{input.memberId}');
    expect(searchPost.of[1]).toEqual({ kind: 'url_matches', pattern: '[?&]memberId={input.memberId}(?![A-Za-z0-9])', frame: [{ name: 'main' }] });

    // Opening the row landed the main frame on /members/12345, so the row click's postcondition
    // pins that URL to the input; the extract step (URL unchanged) gets no URL check.
    expect(rowStep!.postcondition).toEqual({
      kind: 'all',
      of: [
        { kind: 'text_visible', text: 'Savings Balance', frame: [{ name: 'main' }] },
        { kind: 'url_matches', pattern: '/members/{input.memberId}(?![A-Za-z0-9])', frame: [{ name: 'main' }] },
      ],
    });
    expect(extractStep!.postcondition).toBeUndefined();
    // Steps before the member search never carried the input in any URL.
    expect(JSON.stringify(cap.steps.slice(0, 5).map((s) => s.postcondition ?? null))).not.toContain('url_matches');

    expect(cap.provenance.recordedBy).toBe('llm');
    expect(cap.provenance.model).toBe(llm.model);
    expect(cap.provenance.discoveryRunId).toBe(runId);

    expect(result.outputs?.savingsBalance).toBe(1234.56);

    for (const file of ['capability.json', 'transcript.jsonl', 'events.jsonl', 'result.json']) {
      expect(existsSync(path.join(logger.dir, file))).toBe(true);
    }

    await opts.surface.close();
  });
});

// ---------------------------------------------------------------------------------------------
// Extend mode
// ---------------------------------------------------------------------------------------------

describe('discover: extend mode', () => {
  it('probes with a different memberId, declares member_not_found, and merges it without touching the recorded steps', async () => {
    const base = makeLogger();
    const baseLlm = createScriptedLlm(happyPathScript());
    const baseOpts = baseOptions(base.logger, baseLlm);
    const baseResult = await discover(baseOpts);
    expect(baseResult.status).toBe('success');
    const baseCap = baseResult.capability;
    if (baseCap === undefined) throw new Error('expected the base happy-path run to produce a capability');
    await baseOpts.surface.close();

    const ext = makeLogger();
    const extLlm = createScriptedLlm([
      ...loginAndDismissTurns(),
      typeInput('Member ID', 'memberId', 'Enter the member ID'),
      clickByRoleName('clickable', 'Search', 'Search for the member', ''),
      {
        tool: 'declare_outcome',
        input: {
          name: 'member_not_found',
          description: 'No member matches the searched memberId.',
          detector_text: 'No records found.',
          returns: [],
        },
      },
    ]);
    const extOpts = baseOptions(ext.logger, extLlm, {
      inputs: makeInputs({ memberId: { value: '99999', sensitive: false, description: 'The member ID to look up.', type: 'string' } }),
      extend: baseCap,
    });
    const extResult = await discover(extOpts);

    expect(extResult.status).toBe('success');
    const merged = extResult.capability;
    if (merged === undefined) throw new Error(`expected the extend run to produce a capability; issues: ${JSON.stringify(extResult.issues)}`);

    expect(merged.version).toBe('1.1.0');
    expect(merged.steps).toEqual(baseCap.steps);

    const outcome = merged.businessOutcomes.find((o) => o.name === 'member_not_found');
    if (!outcome) throw new Error('expected a member_not_found outcome');
    expect(outcome.detector.kind).toBe('text_visible');
    if (outcome.detector.kind === 'text_visible') expect(outcome.detector.frame).toBeDefined();

    const searchStepId = baseCap.steps[5]!.id;
    expect(baseCap.steps[5]!.action.type).toBe('click'); // sanity: index 5 really is the search click
    expect(outcome.afterSteps).toEqual([searchStepId]);

    expect(validateCapability(merged).ok).toBe(true);
    expect(merged.provenance.notes ?? '').toContain('Extended by discovery run');

    await extOpts.surface.close();
  });
});

// ---------------------------------------------------------------------------------------------
// Policy deny
// ---------------------------------------------------------------------------------------------

describe('discover: policy deny', () => {
  it('refuses a denied action, tells the model why, logs a policy deny event, and records no step for it', async () => {
    const { logger } = makeLogger();
    const llm = createScriptedLlm([typeSecret('User ID', 'MOCK_USER', 'Enter the user ID'), stuckTurn('test: stopping after the deny')]);
    const guard = denyGuard((action, ctx) => action.type === 'type' && ctx.targetName === 'User ID');
    const opts = baseOptions(logger, llm, { guard });
    const result = await discover(opts);

    expect(result.status).toBe('stuck');
    expect(result.stepsRecorded).toBe(1); // only the entry navigation

    expect(requestText(llm.requests[1]!)).toContain('Refused by policy');

    const denyEvent = events(logger.dir).find((e) => e.kind === 'policy' && e.data?.decision === 'deny');
    expect(denyEvent).toBeDefined();

    await opts.surface.close();
  });
});

// ---------------------------------------------------------------------------------------------
// Three consecutive denies -> stuck
// ---------------------------------------------------------------------------------------------

describe('discover: repeated policy denies', () => {
  it('gives up as stuck after three consecutive denies with no escalation handler', async () => {
    const { logger } = makeLogger();
    const attempt = typeSecret('User ID', 'MOCK_USER', 'Enter the user ID');
    const llm = createScriptedLlm([attempt, attempt, attempt]);
    const guard = denyGuard((action) => action.type === 'type');
    const opts = baseOptions(logger, llm, { guard });
    const result = await discover(opts);

    expect(result.status).toBe('stuck');
    expect(result.reason).toContain('policy_denied_repeatedly');
    expect(result.reason).toContain('no escalation handler available');
    expect(llm.requests).toHaveLength(3);

    await opts.surface.close();
  });
});

// ---------------------------------------------------------------------------------------------
// Irreversible actions: escalate/abort, escalate/approve, block
// ---------------------------------------------------------------------------------------------

describe('discover: irreversible action, discoveryMode escalate', () => {
  it('raises risky_action_confirmation with a screenshot and aborts when the human aborts', async () => {
    const { logger } = makeLogger();
    const llm = createScriptedLlm([clickByRoleName('button', 'login', 'Sign on immediately', '')]);
    const guard = flagGuard((action, ctx) => action.type === 'click' && ctx.targetName === 'login');
    const escalations: EscalationRequest[] = [];
    const escalate: EscalationHandler = async (req) => {
      escalations.push(req);
      return { interventionId: 'int_test_abort', resumeFrom: 'abort', humanActions: [], by: 'test-operator' };
    };
    const opts = baseOptions(logger, llm, { guard, escalate });
    const result = await discover(opts);

    expect(result.status).toBe('aborted');
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.reason.code).toBe('risky_action_confirmation');
    expect(escalations[0]!.screenshotPng).toBeInstanceOf(Buffer);

    await opts.surface.close();
  });

  it('records the approved action as an irreversible, escalate-on-failure step and finishes successfully', async () => {
    const { logger } = makeLogger();
    const llm = createScriptedLlm([...loginAndDismissTurns(), ...searchAndOpenTurns('12345', RESULT_TEXT_12345), ...extractSavingsAndDone()]);
    const guard = flagGuard((action, ctx) => action.type === 'click' && ctx.targetName === 'Search');
    let escalationCount = 0;
    const escalate: EscalationHandler = async (req) => {
      escalationCount += 1;
      expect(req.reason.code).toBe('risky_action_confirmation');
      return { interventionId: 'int_test_approve', resumeFrom: 'current_step', humanActions: [], by: 'test-operator' };
    };
    const opts = baseOptions(logger, llm, { guard, escalate });
    const result = await discover(opts);

    expect(result.status).toBe('success');
    expect(escalationCount).toBe(1);
    const cap = result.capability;
    if (cap === undefined) throw new Error(`expected a capability; issues: ${JSON.stringify(result.issues)}`);
    expect(cap.riskLevel).toBe('irreversible');

    const searchStep = cap.steps[5]!;
    expect(searchStep.action.type).toBe('click');
    expect(searchStep.risk).toBe('irreversible');
    expect(searchStep.onFailure).toBe('escalate');

    expect(validateCapability(cap).ok).toBe(true);

    await opts.surface.close();
  });
});

describe('discover: irreversible action, discoveryMode block', () => {
  it('refuses the flagged action outright, tells the model, and never calls the escalation handler', async () => {
    const { logger } = makeLogger();
    // Only one scripted turn, and the queue throws (rather than auto-answering `stuck`) once
    // exhausted: `stuck` has its own, unconditional escalation path, which would otherwise
    // confound this test's "escalate is never called" assertion with a second, unrelated
    // reason to call it.
    const llm = createScriptedLlm([clickByRoleName('button', 'login', 'Sign on immediately', '')], { onExhausted: 'throw' });
    const guard = flagGuard((action, ctx) => action.type === 'click' && ctx.targetName === 'login');
    const escalations: EscalationRequest[] = [];
    const escalate: EscalationHandler = async (req) => {
      escalations.push(req);
      return { interventionId: 'int_never', resumeFrom: 'abort', humanActions: [], by: 'test-operator' };
    };
    const blockPolicy: Policy = { ...DEFAULT_POLICY, risk: { ...DEFAULT_POLICY.risk, discoveryMode: 'block' } };
    const opts = baseOptions(logger, llm, { guard, escalate, policy: blockPolicy });
    const result = await discover(opts);

    expect(result.status).toBe('stuck');
    expect(escalations).toHaveLength(0);
    expect(requestText(llm.requests[1]!)).toContain('Refused: this action is irreversible');

    await opts.surface.close();
  });
});

// ---------------------------------------------------------------------------------------------
// `stuck` tool
// ---------------------------------------------------------------------------------------------

describe('discover: stuck tool with an escalation handler', () => {
  it('escalates with reason.code "stuck" and aborts when the human aborts', async () => {
    const { logger } = makeLogger();
    const llm = createScriptedLlm([stuckTurn('nothing on screen advances the goal')]);
    const escalations: EscalationRequest[] = [];
    const escalate: EscalationHandler = async (req) => {
      escalations.push(req);
      return { interventionId: 'int_stuck_abort', resumeFrom: 'abort', humanActions: [], by: 'test-operator' };
    };
    const opts = baseOptions(logger, llm, { escalate });
    const result = await discover(opts);

    expect(result.status).toBe('aborted');
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.reason.code).toBe('stuck');

    await opts.surface.close();
  });

  it('continues the loop when the handler resolves next_step, telling the model a human intervened', async () => {
    const { logger } = makeLogger();
    let escalationCount = 0;
    const escalate: EscalationHandler = async () => {
      escalationCount += 1;
      if (escalationCount === 1) {
        return {
          interventionId: 'int_stuck_next',
          resumeFrom: 'next_step',
          notes: 'Operator clicked around a bit.',
          humanActions: [],
          by: 'test-operator',
        };
      }
      return { interventionId: 'int_stuck_abort_2', resumeFrom: 'abort', humanActions: [], by: 'test-operator' };
    };
    const llm = createScriptedLlm([stuckTurn('nothing on screen advances the goal'), stuckTurn('still nothing')]);
    const opts = baseOptions(logger, llm, { escalate });
    const result = await discover(opts);

    expect(result.status).toBe('aborted');
    expect(escalationCount).toBe(2);
    expect(llm.requests).toHaveLength(2);
    expect(requestText(llm.requests[1]!).toLowerCase()).toContain('human operator intervened');

    await opts.surface.close();
  });
});

describe('discover: stuck tool without an escalation handler', () => {
  it('ends the run as stuck with the model-given reason', async () => {
    const { logger } = makeLogger();
    const llm = createScriptedLlm([stuckTurn('nothing on screen advances the goal')]);
    const opts = baseOptions(logger, llm);
    const result = await discover(opts);

    expect(result.status).toBe('stuck');
    expect(result.reason).toContain('nothing on screen advances the goal');

    await opts.surface.close();
  });
});

// ---------------------------------------------------------------------------------------------
// maxSteps
// ---------------------------------------------------------------------------------------------

describe('discover: maxSteps limit', () => {
  it('ends as max_steps when the script never reaches done/stuck', async () => {
    const { logger } = makeLogger();
    const clickLoginAgain = clickByRoleName('button', 'login', 'Attempt sign on again', '');
    const llm = createScriptedLlm([clickLoginAgain, clickLoginAgain, clickLoginAgain]);
    const opts = baseOptions(logger, llm, { maxSteps: 3 });
    const result = await discover(opts);

    expect(result.status).toBe('max_steps');
    expect(result.reason).toBe('max_steps');
    expect(llm.requests).toHaveLength(3);

    await opts.surface.close();
  });
});

// ---------------------------------------------------------------------------------------------
// Repeated identical action with an unmet expectation gives up early
// ---------------------------------------------------------------------------------------------

describe('discover: repeated identical action with an unmet expectation', () => {
  it('gives up as stuck on the third consecutive repeat, well before maxSteps', async () => {
    const { logger } = makeLogger();
    const clickLoginAgainAndExpectSomethingThatNeverAppears = clickByRoleName(
      'button',
      'login',
      'Attempt sign on again',
      'This exact phrase will never appear on any screen in this app',
    );
    const llm = createScriptedLlm(Array.from({ length: 20 }, () => clickLoginAgainAndExpectSomethingThatNeverAppears));
    const opts = baseOptions(logger, llm, { maxSteps: 1000 });
    const result = await discover(opts);

    expect(result.status).toBe('stuck');
    expect(result.reason).toContain('repeated 3 times');
    expect(llm.requests).toHaveLength(3);

    await opts.surface.close();
  });
});

// ---------------------------------------------------------------------------------------------
// Expectation not met
// ---------------------------------------------------------------------------------------------

describe('discover: expectation not met', () => {
  it('records the step without a postcondition and tells the model the expectation was not met', async () => {
    const { logger } = makeLogger();
    const bogusExpect = 'This exact phrase will never appear on any screen in this app';
    const llm = createScriptedLlm([
      typeSecret('User ID', 'MOCK_USER', 'Enter the user ID'),
      typeSecret('Password', 'MOCK_PASSWORD', 'Enter the password'),
      clickByRoleName('button', 'login', 'Sign on', bogusExpect),
      dismissInterstitial(NOTICE_TEXT, 'Dismiss the maintenance notice'),
      ...searchAndOpenTurns('12345', RESULT_TEXT_12345, ''),
      ...extractSavingsAndDone(),
    ]);
    const opts = baseOptions(logger, llm);
    const result = await discover(opts);

    expect(result.status).toBe('success');
    const cap = result.capability;
    if (cap === undefined) throw new Error(`expected a capability; issues: ${JSON.stringify(result.issues)}`);

    const signOnStep = cap.steps[3]!;
    expect(signOnStep.action.type).toBe('click');
    expect(signOnStep.postcondition).toBeUndefined();

    // Turn index 3 (0-based) is the request shown right after the unmet-expectation click.
    expect(requestText(llm.requests[3]!).toLowerCase()).toContain('expectation not met');

    const checkpointEvent = events(logger.dir).find((e) => e.kind === 'checkpoint' && e.data?.met === false);
    expect(checkpointEvent).toBeDefined();

    await opts.surface.close();
  });
});

// ---------------------------------------------------------------------------------------------
// `done` refused until declared outputs are extracted
// ---------------------------------------------------------------------------------------------

describe('discover: done refused until declared outputs are extracted', () => {
  it('tells the model which output is missing, then succeeds once it is extracted', async () => {
    const { logger } = makeLogger();
    const llm = createScriptedLlm([
      ...loginAndDismissTurns(),
      ...searchAndOpenTurns('12345', RESULT_TEXT_12345),
      doneTurn('Savings Balance', 'Premature done attempt.'),
      ...extractSavingsAndDone(),
    ]);
    const opts = baseOptions(logger, llm, { outputs: { savingsBalance: { type: 'number', description: 'The savings balance.' } } });
    const result = await discover(opts);

    expect(result.status).toBe('success');
    // Turn index 8 (0-based) is the request shown right after the premature `done` refusal.
    const refusalText = requestText(llm.requests[8]!);
    expect(refusalText).toContain('savingsBalance');
    expect(refusalText.toLowerCase()).toContain('not been extracted');

    await opts.surface.close();
  });
});

// ---------------------------------------------------------------------------------------------
// Secrets / sensitive-value hygiene
// ---------------------------------------------------------------------------------------------

describe('discover: secret and sensitive value leaks', () => {
  it('never persists or shows the model a secret or sensitive value', async () => {
    const { logger } = makeLogger();
    const sensitiveValue = 'zq-sensitive-778'; // not shaped like the SSN/card redaction patterns
    const llm = createScriptedLlm([
      ...loginAndDismissTurns(),
      typeInput('Member ID', 'memberId', 'Enter the member ID'),
      (req) => ({
        tool: 'type',
        input: {
          ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Last Name' }),
          source: 'input',
          value: 'memberSsn',
          why: 'Enter the sensitive lookup token',
          expect: '',
        },
      }),
      clickByRoleName('clickable', 'Search', 'Search for the member', RESULT_TEXT_12345),
      clickByRoleName('clickable', '12345', 'Open the matching result', 'Savings Balance'),
      ...extractSavingsAndDone(),
    ]);
    const opts = baseOptions(logger, llm, {
      inputs: makeInputs({ memberSsn: { value: sensitiveValue, sensitive: true, description: 'Sensitive lookup token (test).', type: 'string' } }),
    });
    const result = await discover(opts);
    expect(result.status).toBe('success');

    const forbidden = ['operator1', 'demo-pass-123', sensitiveValue];

    for (const file of ['transcript.jsonl', 'events.jsonl', 'result.json', 'capability.json', 'capability.draft.json']) {
      const filePath = path.join(logger.dir, file);
      if (!existsSync(filePath)) continue;
      const raw = readTextFile(filePath);
      for (const needle of forbidden) expect(raw).not.toContain(needle);
    }

    for (const req of llm.requests) {
      const text = requestText(req);
      for (const needle of forbidden) expect(text).not.toContain(needle);
    }

    await opts.surface.close();
  });
});

describe('discover: prompt redaction of sensitive inputs', () => {
  it('shows <sensitive> for a sensitive input and the real value for a non-sensitive one', async () => {
    const { logger } = makeLogger();
    const llm = createScriptedLlm([stuckTurn('test: inspecting the first prompt only')]);
    const opts = baseOptions(logger, llm, {
      inputs: makeInputs({ memberSsn: { value: 'zq-sensitive-778', sensitive: true, description: 'Sensitive lookup token (test).', type: 'string' } }),
    });
    const result = await discover(opts);
    expect(result.status).toBe('stuck');

    const text = requestText(llm.requests[0]!);
    expect(text).toContain('memberSsn (string, sensitive): Sensitive lookup token (test). = <sensitive>');
    expect(text).toContain('memberId (string): The member ID to look up. = 12345');
    expect(text).not.toContain('zq-sensitive-778');

    await opts.surface.close();
  });
});

// ---------------------------------------------------------------------------------------------
// Literal into a password-like field
// ---------------------------------------------------------------------------------------------

describe('discover: literal value into a password-like field', () => {
  it('is refused, and the model is told', async () => {
    const { logger } = makeLogger();
    const llm = createScriptedLlm([
      (req) => ({
        tool: 'type',
        input: {
          ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Password' }),
          source: 'literal',
          value: 'hunter2',
          why: 'Enter the password directly',
          expect: '',
        },
      }),
      stuckTurn('test: stopping after the refusal'),
    ]);
    const opts = baseOptions(logger, llm);
    const result = await discover(opts);

    expect(result.status).toBe('stuck');
    expect(result.stepsRecorded).toBe(1); // only the entry navigation; the literal type was refused
    expect(requestText(llm.requests[1]!)).toContain('credential-like field');

    await opts.surface.close();
  });
});

// ---------------------------------------------------------------------------------------------
// Unknown ref
// ---------------------------------------------------------------------------------------------

describe('discover: unknown ref', () => {
  it('tells the model instead of crashing', async () => {
    const { logger } = makeLogger();
    const llm = createScriptedLlm([
      { tool: 'click', input: { ref: 'e9999', why: 'Click something bogus', expect: '' } },
      stuckTurn('test: stopping after the unknown ref'),
    ]);
    const opts = baseOptions(logger, llm);
    const result = await discover(opts);

    expect(result.status).toBe('stuck');
    expect(requestText(llm.requests[1]!)).toContain('Unknown ref');

    await opts.surface.close();
  });
});

// ---------------------------------------------------------------------------------------------
// Regression coverage: secret and sensitive values must never leak, even indirectly (echoed back
// in an error message, or extracted as a value that happens to equal a sensitive input).
// ---------------------------------------------------------------------------------------------

describe('discover: secret and sensitive value leaks via echoed errors and extracted values', () => {
  it('never sends a secret to the model when a surface error message echoes the typed value', async () => {
    const { dir, logger } = makeLogger();
    const surface = createCuCoreSurface();
    surface.inject({
      kind: 'act_error',
      match: { actionType: 'type', targetId: 'password' },
      code: 'input_validation',
      message: `field rejected value "${SECRET_VALUES.MOCK_PASSWORD}": must be alphanumeric`,
    });
    const llm = createScriptedLlm(
      [typeSecret('User ID', 'MOCK_USER', 'Enter the user ID'), typeSecret('Password', 'MOCK_PASSWORD', 'Enter the password'), stuckTurn('cannot log in')],
      { onExhausted: 'throw' },
    );
    const result = await discover(baseOptions(logger, llm, { surface }));
    expect(result.status).toBe('stuck');
    const lastRequest = requestText(llm.requests[llm.requests.length - 1]!);
    expect(lastRequest).toContain('<secret:MOCK_PASSWORD>');
    for (const req of llm.requests) expect(requestText(req)).not.toContain(SECRET_VALUES.MOCK_PASSWORD);
    for (const f of ['transcript.jsonl', 'events.jsonl', 'result.json']) {
      expect(readTextFile(path.join(logger.dir, f))).not.toContain(SECRET_VALUES.MOCK_PASSWORD);
    }
    expect(dir).toBeTruthy();
  });

  it('scrubs a numeric extracted value that equals a sensitive input from result.outputs and result.json', async () => {
    const { logger } = makeLogger();
    const llm = createScriptedLlm(happyPathScript(), { onExhausted: 'throw' });
    const result = await discover(
      baseOptions(logger, llm, {
        inputs: makeInputs({ balanceHint: { value: '1234.56', sensitive: true, description: 'A sensitive figure.', type: 'string' } }),
      }),
    );
    expect(result.status).toBe('success');
    expect(result.outputs?.savingsBalance).toBe('<sensitive:balanceHint>');
    expect(readTextFile(path.join(logger.dir, 'result.json'))).not.toContain('1234.56');
    for (const req of llm.requests) expect(requestText(req)).not.toContain('1234.56');
  });
});

// ---------------------------------------------------------------------------------------------
// Defect 3 regression: a recovery rule must be named from the modal's own TITLE, never from
// `trigger_text` -- which, in the real buggy artifact, WAS the notice's longer body copy
// ("Scheduled maintenance Sunday 02:00–04:00 ET. ...") and produced
// "dismiss_scheduled_maintenance_sunday_02_00_04_00_et". Reproducing that exact shape here:
// `trigger_text` = the body, `title` = "System Maintenance Notice" supplied separately.
// ---------------------------------------------------------------------------------------------

describe('discover: recovery rule naming from the modal title, not trigger_text (Defect 3)', () => {
  const BODY_TEXT = 'Scheduled maintenance Sunday 02:00–04:00 ET. Some functions may be unavailable.';

  it('names the recovery rule from the title ("System Maintenance Notice"), even though trigger_text is the long body copy', async () => {
    const { logger } = makeLogger();
    const llm = createScriptedLlm([
      typeSecret('User ID', 'MOCK_USER', 'Enter the user ID'),
      typeSecret('Password', 'MOCK_PASSWORD', 'Enter the password'),
      clickByRoleName('button', 'login', 'Sign on', NOTICE_TEXT),
      dismissInterstitial(BODY_TEXT, 'Dismiss the maintenance notice', NOTICE_TEXT),
      ...searchAndOpenTurns('12345', RESULT_TEXT_12345, 'Member'),
      ...extractSavingsAndDone(),
    ]);
    const opts = baseOptions(logger, llm);
    const result = await discover(opts);

    expect(result.status).toBe('success');
    const cap = result.capability;
    if (cap === undefined) throw new Error(`expected a capability; issues: ${JSON.stringify(result.issues)}`);
    expect(cap.recoveryRules).toHaveLength(1);
    expect(cap.recoveryRules[0]!.name).toBe('dismiss_system_maintenance_notice');
    // The TRIGGER condition itself still matches the body text -- it's what's actually visible
    // and distinctive on screen; only the rule's NAME comes from the title.
    expect(cap.recoveryRules[0]!.trigger).toMatchObject({ kind: 'text_visible', text: BODY_TEXT });

    await opts.surface.close();
  });

  it('falls back to dismiss_interstitial_<n> when the model reports no title (not derived from trigger_text)', async () => {
    const { logger } = makeLogger();
    const llm = createScriptedLlm([
      typeSecret('User ID', 'MOCK_USER', 'Enter the user ID'),
      typeSecret('Password', 'MOCK_PASSWORD', 'Enter the password'),
      clickByRoleName('button', 'login', 'Sign on', NOTICE_TEXT),
      dismissInterstitial(BODY_TEXT, 'Dismiss the maintenance notice', ''),
      ...searchAndOpenTurns('12345', RESULT_TEXT_12345, 'Member'),
      ...extractSavingsAndDone(),
    ]);
    const opts = baseOptions(logger, llm);
    const result = await discover(opts);

    expect(result.status).toBe('success');
    const cap = result.capability;
    if (cap === undefined) throw new Error(`expected a capability; issues: ${JSON.stringify(result.issues)}`);
    expect(cap.recoveryRules).toHaveLength(1);
    expect(cap.recoveryRules[0]!.name).toBe('dismiss_interstitial_1');

    await opts.surface.close();
  });
});

// ---------------------------------------------------------------------------------------------
// Defect 1 regression: an `extract`'s (or a business outcome's) raw record-time value must never
// persist as a reusable locator or leak into the artifact's free text -- reproducing the shape of
// the real buggy artifact (artifacts/lookup-member-savings-balance.json): the extract targets'
// first locator names the extracted value ("$1,234.56" / "Jane Q. Sample"), and `done.summary`
// names both values too.
// ---------------------------------------------------------------------------------------------

/** A minimal, real `RunContext` (not a mock) for a direct `dispatch()` call: the recorder,
 *  scrubber, and every other field `dispatch` might touch, wired the same way `discover()` wires
 *  them, but without running the whole observe/prompt/llm loop. `surface` is whatever raw
 *  FakeSurface the caller already drove to the screen it wants to dispatch a tool call against. */
function makeMinimalRunContext(surface: FakeSurface): RunContext {
  const { logger } = makeLogger();
  const llm = createScriptedLlm([]);
  const opts = baseOptions(logger, llm, { surface });
  const recorder = createRecorder({ baseUrl: opts.target.baseUrl, inputs: opts.inputs });
  const scrubber = createScrubber({ secrets: {}, sensitiveInputs: {} });
  const state: LoopState = {
    turn: 0,
    llmCalls: 0,
    consecutiveDenies: 0,
    consecutiveNoToolUse: 0,
    escalationsUsed: 0,
    history: [],
    lastResult: undefined,
    extractedOutputs: new Map(),
    sensitiveOutputs: new Set(),
  };
  return {
    opts,
    runId: logger.runId,
    isExtend: false,
    recorder,
    scrubber,
    secretValues: {},
    sensitiveInputs: {},
    stuckRepeats: new StuckRepeatDetector(),
    expectTimeoutMs: 150,
    actionTimeoutMs: 2000,
    now: () => new Date(),
    state,
    logEvent: () => {},
  };
}

describe('discover: extracted output values must not persist in the artifact (Defect 1)', () => {
  it('never leaks the extracted balance/name, sanitizes the extract targets, and scrubs free text; replay for a DIFFERENT member still extracts correctly', async () => {
    const { logger, runId } = makeLogger();
    const llm = createScriptedLlm([
      ...loginAndDismissTurns(),
      // The search click's `expect` is a short, stable field label ("Member"), not the full
      // result-row text -- matching the real artifact's own s06 postcondition ("Member"). A row
      // text embedding this record's name would otherwise collide with the memberName leak check
      // below for a reason that has nothing to do with Defect 1 (a pre-existing, separately
      // accepted behavior: postcondition/checkpoint text is functional match text, not prose, and
      // is deliberately never narrowed the way locators are -- see docs/design/agent.md).
      ...searchAndOpenTurns('12345', RESULT_TEXT_12345, 'Member'),
      extractField('$1,234.56', 'savingsBalance', 'currency', 'Read the savings balance'),
      extractField('Jane Q. Sample', 'memberName', 'text', 'Read the member name'),
      // done.summary names BOTH raw values, exactly like the real buggy artifact's summary/
      // success.description did.
      doneTurn('Savings Balance', "Read Jane Q. Sample's savings balance of $1,234.56."),
    ]);
    const opts = baseOptions(logger, llm);
    const result = await discover(opts);

    expect(result.status).toBe('success');
    const cap = result.capability;
    if (cap === undefined) throw new Error(`expected a capability; issues: ${JSON.stringify(result.issues)}`);
    expect(validateCapability(cap).ok).toBe(true);

    // The extracted values never appear anywhere in the emitted artifact, in any field.
    const json = JSON.stringify(cap);
    for (const needle of ['$1,234.56', '1,234.56', 'Jane Q. Sample']) {
      expect(json).not.toContain(needle);
    }

    const balanceStep = cap.steps.find((s) => s.action.type === 'extract' && s.action.output === 'savingsBalance');
    const nameStep = cap.steps.find((s) => s.action.type === 'extract' && s.action.output === 'memberName');
    if (!balanceStep || balanceStep.action.type !== 'extract') throw new Error('expected the savingsBalance extract step');
    if (!nameStep || nameStep.action.type !== 'extract') throw new Error('expected the memberName extract step');

    // Both extract targets lead with the `relative` locator, anchored on the field's own
    // (stable) label -- matching the real, playwright-recorded buggy artifact's shape (which
    // leads with `text`, then `relative`) minus the leading value-bearing locator this fix drops.
    // (The FakeSurface's value cells no longer carry a `label`/name-equals-value `role` locator
    // either -- see cu-core.ts's value-cell comments and fake/view.ts's `isRoleLocatorEligible` --
    // so `relative` is now the genuine first surviving locator, not just "not text/role".)
    function assertSanitizedTarget(target: TargetDescriptor, anchorText: string): void {
      const kinds = target.locators.map((l) => l.strategy.kind);
      expect(kinds.length).toBeGreaterThan(0);
      expect(target.locators[0]!.strategy.kind).toBe('relative');
      expect(target.locators[0]!.strategy).toMatchObject({ kind: 'relative', anchor: { text: anchorText } });
      expect(target.snapshot?.text).toBeUndefined();
      expect(target.snapshot?.name).toBeUndefined();
    }
    assertSanitizedTarget(balanceStep.action.target, 'Savings Balance');
    assertSanitizedTarget(nameStep.action.target, 'Member Name');
    expect(balanceStep.action.target.description).not.toContain('1,234.56');
    expect(nameStep.action.target.description).not.toContain('Jane');

    // description is the goal text ONLY -- never the model's done.summary.
    expect(cap.description).toBe('Log in, look up member {input.memberId} and read their current savings balance.');
    // success.description is the (scrubbed) summary: both raw values replaced by their output
    // placeholders.
    expect(cap.success.description).toContain('{output.memberName}');
    expect(cap.success.description).toContain('{output.savingsBalance}');
    expect(cap.success.description).not.toContain('Jane');
    expect(cap.success.description).not.toContain('1,234.56');

    for (const file of ['capability.json', 'transcript.jsonl', 'events.jsonl', 'result.json']) {
      expect(existsSync(path.join(logger.dir, file))).toBe(true);
    }
    expect(runId).toBeTruthy();

    await opts.surface.close();

    // -- Replay the emitted artifact for a DIFFERENT member (10001, not the recorded 12345) --
    // the sanitized (label/relative) locators are field-shaped, not record-shaped, so they must
    // resolve correctly against a different record's own values.
    const clock = makeFakeClock();
    const replaySurface = createCuCoreSurface({ clock, interstitial: true });
    const { result: replayResult } = await runReplay({
      capability: cap,
      inputs: { memberId: '10001' },
      surface: replaySurface,
      clock,
    });
    expect(replayResult.kind).toBe('success');
    if (replayResult.kind === 'success') {
      expect(replayResult.outputs).toEqual({ memberName: 'Harold T. Abernathy', savingsBalance: 4822.1 });
    }
  });

  it('sanitizes a business-outcome extract target the same way, from the observation alone (no readText call happens for it)', async () => {
    // Isolated at the dispatch() level (not a full discover() run): a business outcome whose
    // detector text stays visible for the rest of the flow (e.g. a field label on the same
    // screen the golden path ends on) would make replay treat every later step as "the outcome
    // fired" instead of reaching success -- a pre-existing property of how business-outcome
    // detectors are checked (see replay/steps.ts's `outcomeEligible`), unrelated to this fix.
    // Driving it through `dispatch()` directly keeps this test about ONE thing: that the exact
    // same `sanitizeExtractedTarget` treatment `extract` gets is also applied to
    // `declare_outcome`'s `returns` targets.
    const surface = createCuCoreSurface({ interstitial: false });
    async function actByRoleName(role: string, name: string, action: 'click' | 'type', value?: string): Promise<void> {
      const obs = await surface.observe();
      const el = obs.elements.find((e) => e.role === role && e.name === name);
      if (!el) throw new Error(`test setup: no ${role} "${name}" on screen`);
      const res =
        action === 'click'
          ? await surface.act({ type: 'click', target: { ref: el.ref } }, 2000)
          : await surface.act({ type: 'type', target: { ref: el.ref }, value: value!, clear: true }, 2000);
      if (!res.ok) throw new Error(`test setup: ${action} on ${role} "${name}" failed: ${JSON.stringify(res.error)}`);
    }
    await actByRoleName('textbox', 'User ID', 'type', 'operator1');
    await actByRoleName('textbox', 'Password', 'type', 'demo-pass-123');
    await actByRoleName('button', 'login', 'click');
    await actByRoleName('textbox', 'Member ID', 'type', '12345');
    await actByRoleName('clickable', 'Search', 'click');
    let obs = await surface.observe();
    const row = obs.elements.find((e) => e.role === 'clickable' && e.name.startsWith('12345'));
    if (!row) throw new Error('test setup: result row not found');
    await surface.act({ type: 'click', target: { ref: row.ref } }, 2000);
    obs = await surface.observe();
    const balanceEl = obs.elements.find((e) => e.role === 'cell' && e.name === '$1,234.56');
    if (!balanceEl) throw new Error('test setup: savings balance cell not found');

    const ctx = makeMinimalRunContext(surface);
    const outcome = await dispatch(
      ctx,
      {
        tool: 'declare_outcome',
        name: 'balance_visible',
        description: 'The savings balance is visible.',
        detector_text: 'Savings Balance',
        returns: [{ output: 'balanceSnapshot', ref: balanceEl.ref, parse: 'currency', description: 'The savings balance value.' }],
      },
      obs,
    );
    expect(outcome.kind).toBe('continue');

    const recorded = ctx.recorder.outcomes.find((o) => o.name === 'balance_visible');
    if (!recorded?.extract?.[0]) throw new Error('expected the balance_visible outcome with its extract');
    const target = recorded.extract[0].target;
    expect(target.locators.length).toBeGreaterThan(0);
    expect(target.locators[0]!.strategy).toMatchObject({ kind: 'relative', anchor: { text: 'Savings Balance' } });
    expect(JSON.stringify(recorded)).not.toContain('1,234.56');

    await surface.close();
  });
});

// ---------------------------------------------------------------------------------------------
// Review fix: a leaked extracted value must be redacted from the WRITTEN draft too, not just
// reported in `issues` -- `output_value_in_artifact` can fire on a Condition's match text (a
// postcondition, `success.condition`, a business-outcome detector, a recovery trigger), a field
// the free-text scrub deliberately never touches (it must stay byte-exact for replay). Before the
// fix, `recorder.build()`'s failure-path `redactDeep(draft, this.forbiddenAll)` calls did not
// include extracted values, so `capability.draft.json` still contained the raw value even though
// the run correctly failed closed.
// ---------------------------------------------------------------------------------------------

describe('discover: a leaked extracted value is redacted from the written draft, not just reported (review fix)', () => {
  it('fails with output_value_in_artifact when success_text IS the raw extracted balance, and capability.draft.json never contains it', async () => {
    const { logger } = makeLogger();
    const llm = createScriptedLlm([
      ...loginAndDismissTurns(),
      ...searchAndOpenTurns('12345', RESULT_TEXT_12345, 'Member'),
      extractField('$1,234.56', 'savingsBalance', 'currency', 'Read the savings balance'),
      // Pathological but exactly the case that matters: success_text becomes success.condition.text
      // verbatim (a Condition, never scrubbed), and it IS the raw extracted value.
      doneTurn('$1,234.56', 'Read the savings balance.'),
    ]);
    const opts = baseOptions(logger, llm);
    const result = await discover(opts);

    expect(result.status).toBe('stuck');
    expect(result.reason).toBe('capability_invalid');
    expect(result.issues?.some((i) => i.code === 'output_value_in_artifact')).toBe(true);

    const draftPath = path.join(logger.dir, 'capability.draft.json');
    expect(existsSync(draftPath)).toBe(true);
    const draftRaw = readTextFile(draftPath);
    expect(draftRaw).not.toContain('1,234.56');
    expect(draftRaw).not.toContain('$1,234.56');

    await opts.surface.close();
  });
});

// ---------------------------------------------------------------------------------------------
// dismiss_interstitial records a recovery rule only for a click that cleared the notice
// ---------------------------------------------------------------------------------------------

describe('dispatch: dismiss_interstitial', () => {
  it('records no recovery rule when the click leaves the notice on screen, and records one once it is dismissed', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock, interstitial: true });
    async function actByRoleName(role: string, name: string, value?: string): Promise<void> {
      const obs = await surface.observe();
      const el = obs.elements.find((e) => e.role === role && e.name === name);
      if (!el) throw new Error(`test setup: no ${role} "${name}" on screen`);
      const res =
        value === undefined
          ? await surface.act({ type: 'click', target: { ref: el.ref } }, 2000)
          : await surface.act({ type: 'type', target: { ref: el.ref }, value, clear: true }, 2000);
      if (!res.ok) throw new Error(`test setup: act on ${role} "${name}" failed: ${JSON.stringify(res.error)}`);
    }
    await actByRoleName('textbox', 'User ID', 'operator1');
    await actByRoleName('textbox', 'Password', 'demo-pass-123');
    await actByRoleName('button', 'login');

    const ctx = makeMinimalRunContext(surface);
    let obs = await surface.observe();
    const titleEl = obs.elements.find((e) => e.name === NOTICE_TEXT);
    if (!titleEl) throw new Error('test setup: notice title not on screen');

    // Clicking the notice's own heading does not dismiss it.
    const miss = await dispatch(
      ctx,
      { tool: 'dismiss_interstitial', ref: titleEl.ref, trigger_text: NOTICE_TEXT, title: NOTICE_TEXT, why: 'Dismiss the notice' },
      obs,
    );
    expect(miss.kind).toBe('continue');
    expect(ctx.recorder.recoveryRules).toHaveLength(0);
    expect(ctx.state.lastResult).toContain('no recovery rule was recorded');

    obs = await surface.observe();
    const okEl = obs.elements.find((e) => e.role === 'clickable' && e.name.includes('OK'));
    if (!okEl) throw new Error('test setup: OK control not on screen');
    await dispatch(ctx, { tool: 'dismiss_interstitial', ref: okEl.ref, trigger_text: NOTICE_TEXT, title: NOTICE_TEXT, why: 'Dismiss the notice' }, obs);
    expect(ctx.recorder.recoveryRules).toHaveLength(1);
    expect(ctx.recorder.recoveryRules[0]!.name).toBe('dismiss_system_maintenance_notice');

    await surface.close();
  });
});

// ---------------------------------------------------------------------------------------------
// Extend mode: a draft written on a failure path is redacted like a discovery draft
// ---------------------------------------------------------------------------------------------

describe('discover: extend mode redacts the written draft', () => {
  async function baseCapability() {
    const base = makeLogger();
    const baseOpts = baseOptions(base.logger, createScriptedLlm(happyPathScript()));
    const baseResult = await discover(baseOpts);
    await baseOpts.surface.close();
    if (baseResult.capability === undefined) throw new Error('expected the base happy-path run to produce a capability');
    return baseResult.capability;
  }

  it('fails with output_value_in_artifact when a declared outcome detector IS an extracted value, and the draft never contains it', async () => {
    const baseCap = await baseCapability();
    const ext = makeLogger();
    const extLlm = createScriptedLlm([
      ...loginAndDismissTurns(),
      ...searchAndOpenTurns('12345', RESULT_TEXT_12345, 'Member'),
      (req) => ({
        tool: 'declare_outcome',
        input: {
          name: 'balance_shown',
          description: 'The savings balance is shown.',
          detector_text: '$1,234.56',
          returns: [{ output: 'shownBalance', ref: findRef(requestText(req), { role: 'cell', nameIncludes: '$1,234.56' }), parse: 'currency', description: 'The balance.' }],
        },
      }),
    ]);
    const extOpts = baseOptions(ext.logger, extLlm, { extend: baseCap });
    const result = await discover(extOpts);

    expect(result.status).toBe('stuck');
    expect(result.reason).toBe('capability_invalid');
    expect(result.issues?.some((i) => i.code === 'output_value_in_artifact')).toBe(true);
    const draftRaw = readTextFile(path.join(ext.logger.dir, 'capability.draft.json'));
    expect(draftRaw).not.toContain('1,234.56');
    expect(existsSync(path.join(ext.logger.dir, 'capability.json'))).toBe(false);

    await extOpts.surface.close();
  });

  const DENIED_TEXT = 'Access Denied: your role does not permit viewing this member.';
  const RESTRICTED_INPUTS = makeInputs({ memberId: { value: '90001', sensitive: false, description: 'The member ID to look up.', type: 'string' } });

  function openRestrictedAndDeclareDenied(): ScriptedTurn[] {
    return [
      ...loginAndDismissTurns(),
      typeInput('Member ID', 'memberId', 'Enter the member ID'),
      clickByRoleName('clickable', 'Search', 'Search for the member'),
      clickByRoleName('clickable', '90001', 'Open the matching result'),
      (req) => ({
        tool: 'declare_outcome',
        input: {
          name: 'access_denied',
          description: 'The operator may not view this member.',
          detector_text: DENIED_TEXT,
          returns: [{ output: 'denialMessage', ref: findRef(requestText(req), { nameIncludes: 'Access Denied' }), parse: 'text', description: 'The denial message.' }],
        },
      }),
    ];
  }

  it('merges an outcome whose text return is its own detector message (static page text, not record data)', async () => {
    const baseCap = await baseCapability();
    const ext = makeLogger();
    const extOpts = baseOptions(ext.logger, createScriptedLlm(openRestrictedAndDeclareDenied()), { inputs: RESTRICTED_INPUTS, extend: baseCap });
    const result = await discover(extOpts);

    if (result.status !== 'success') throw new Error(`expected success, got ${result.status}: ${JSON.stringify(result.issues)}`);
    const outcome = result.capability?.businessOutcomes.find((o) => o.name === 'access_denied');
    expect(outcome?.detector).toMatchObject({ kind: 'text_visible', text: DENIED_TEXT });
    expect(outcome?.returns).toHaveProperty('denialMessage');
    await extOpts.surface.close();
  });

  it('builds a discovery capability whose outcome text return is its own detector message', async () => {
    const run = makeLogger();
    const opts = baseOptions(run.logger, createScriptedLlm([...openRestrictedAndDeclareDenied(), doneTurn('Access Denied', 'The member is restricted.')]), {
      inputs: RESTRICTED_INPUTS,
    });
    const result = await discover(opts);

    if (result.status !== 'success') throw new Error(`expected success, got ${result.status}: ${JSON.stringify(result.issues)}`);
    expect(result.capability?.businessOutcomes.find((o) => o.name === 'access_denied')?.detector).toMatchObject({ text: DENIED_TEXT });
    await opts.surface.close();
  });

  it('fails closed when a declared outcome would persist a secret, and the draft never contains it', async () => {
    const baseCap = await baseCapability();
    const ext = makeLogger();
    const extLlm = createScriptedLlm([
      ...loginAndDismissTurns(),
      typeInput('Member ID', 'memberId', 'Enter the member ID'),
      clickByRoleName('clickable', 'Search', 'Search for the member', ''),
      {
        tool: 'declare_outcome',
        input: {
          name: 'member_not_found',
          description: `No member matches (signed in with ${SECRET_VALUES.MOCK_PASSWORD}).`,
          detector_text: 'No records found.',
          returns: [],
        },
      },
    ]);
    const extOpts = baseOptions(ext.logger, extLlm, {
      inputs: makeInputs({ memberId: { value: '99999', sensitive: false, description: 'The member ID to look up.', type: 'string' } }),
      extend: baseCap,
    });
    const result = await discover(extOpts);

    expect(result.status).toBe('stuck');
    expect(result.reason).toBe('capability_invalid');
    expect(result.issues?.some((i) => i.message === 'secret or sensitive value would be persisted')).toBe(true);
    const draftRaw = readTextFile(path.join(ext.logger.dir, 'capability.draft.json'));
    expect(draftRaw).not.toContain(SECRET_VALUES.MOCK_PASSWORD);
    expect(draftRaw).toContain('member_not_found');

    await extOpts.surface.close();
  });
});
