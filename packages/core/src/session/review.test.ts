/**
 * Edge-case tests for the human-in-the-loop handoff module (docs/design/handoff.md).
 *
 * This file does not duplicate what broker.test.ts / scripted-operator.test.ts / store.test.ts
 * already prove. It targets behavior the design doc guarantees that isn't yet covered by an
 * existing test:
 *
 *  1. Race windows around the transition lock: a concurrent abort() while takeControl() is
 *     in-flight (awaiting capture.start()); resumed()/reverifyFailed()/a second handBack() while
 *     handBack() is in-flight (awaiting capture.stop()).
 *  2. Guarded-surface completeness: every act() action type is gated identically (not just
 *     'click'); close() is allowed in plain 'automation' state; frameUrls()/describeRef() pass
 *     through in every state; the raw surface is not reachable from either wrapper (no shared
 *     prototype, no humanCapture, distinct object identity).
 *  3. Adversarial HumanAction payloads through the capture callback, beyond the ones
 *     broker.test.ts already covers (a bare `value` key, an unredacted `input`): `value` nested
 *     under `target`, non-string target fields, a malformed `frame`, a `__proto__` own key, an
 *     unbounded-length `target.text`, and -- the important one -- a rogue capture that puts the
 *     actual typed value into `target.text` on an `input` action instead of a `value` key. The
 *     whitelist only strips the *key* named `value`; it does not (and structurally cannot)
 *     validate the *content* of the fields it allows through.
 *  4. control_transfer is logged (i.e. on disk) before onTransfer listeners run.
 *  5. EscalationRequest.context never becomes part of the persisted Intervention record.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HumanAction } from '../schema/index.js';
import { createRunLogger, newRunId } from '../evidence/index.js';
import { el, FakeSurface, scenario, type FakeScenario } from '../surface/index.js';
import type { HumanActionCapture } from '../surface/types.js';
import { createSessionBroker } from './broker.js';
import { IllegalControlTransitionError, type SessionBroker } from './broker-api.js';
import type { EscalationRequest, EscalationResolution } from './types.js';

function buildScenario(): FakeScenario {
  return scenario()
    .screen('blocked', {
      url: 'http://x.test/blocked',
      title: 'Blocked',
      elements: [el({ id: 'ack', role: 'button', name: 'Acknowledge', tag: 'button', bbox: { x: 0, y: 0, w: 100, h: 24 } })],
    })
    .on('click', { targetId: 'ack' })
    .goto('form')
    .screen('form', {
      url: 'http://x.test/form',
      title: 'Form',
      elements: [
        el({ id: 'note', role: 'textbox', name: 'Note', tag: 'input', bbox: { x: 0, y: 40, w: 150, h: 24 } }),
        el({ id: 'submit', role: 'button', name: 'Submit', tag: 'button', bbox: { x: 0, y: 80, w: 100, h: 24 } }),
      ],
    })
    .build();
}

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'session-review-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A HumanActionCapture whose start()/stop() can be delayed, to open a controllable race window. */
function makeSlowCapture(opts: { startDelayMs?: number; stopDelayMs?: number } = {}) {
  let cb: ((a: HumanAction) => void) | undefined;
  return {
    start: async (onAction: (a: HumanAction) => void) => {
      if (opts.startDelayMs) await sleep(opts.startDelayMs);
      cb = onAction;
    },
    stop: async () => {
      if (opts.stopDelayMs) await sleep(opts.stopDelayMs);
      cb = undefined;
    },
    emit: (a: unknown) => cb?.(a as HumanAction),
  } satisfies HumanActionCapture & { emit: (a: unknown) => void };
}

function setup(opts: { capture?: HumanActionCapture | null } = {}) {
  const dir = makeTmpDir();
  const runId = newRunId();
  const fakeSurface = new FakeSurface(buildScenario());
  const logger = createRunLogger({ runId, runKind: 'replay', rootDir: dir });
  const broker = createSessionBroker({
    surface: fakeSurface,
    logger,
    runId,
    runKind: 'replay',
    ...(opts.capture !== undefined ? { capture: opts.capture } : {}),
  });
  return { dir, runId, fakeSurface, logger, broker };
}

function escalationRequest(runId: string, overrides: Partial<EscalationRequest> = {}): EscalationRequest {
  return {
    runId,
    runKind: 'replay',
    capabilityId: 'test-cap',
    goal: 'do the thing',
    stepId: 's1',
    reason: { code: 'unrecoverable_condition', message: 'automation is blocked' },
    ...overrides,
  };
}

function readRawEventsFile(dir: string, runId: string): string {
  return readFileSync(path.join(dir, runId, 'events.jsonl'), 'utf8');
}

function readEvents(dir: string, runId: string): { kind: string; data: Record<string, unknown> }[] {
  return readRawEventsFile(dir, runId)
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { kind: string; data: Record<string, unknown> });
}

function readInterventionFile(dir: string, runId: string, id: string): string {
  return readFileSync(path.join(dir, runId, 'interventions', `${id}.json`), 'utf8');
}

function captureFirstCreatedId(broker: SessionBroker): { promise: Promise<string>; unsubscribe: () => void } {
  let resolve!: (id: string) => void;
  const promise = new Promise<string>((res) => {
    resolve = res;
  });
  const unsubscribe = broker.interventions.subscribe((i, change) => {
    if (change === 'created') resolve(i.id);
  });
  return { promise, unsubscribe };
}

async function escalateAndGetId(
  broker: SessionBroker,
  runId: string,
  overrides: Partial<EscalationRequest> = {},
): Promise<{ id: string; resolutionPromise: Promise<EscalationResolution> }> {
  const capture = captureFirstCreatedId(broker);
  const resolutionPromise = broker.escalate(escalationRequest(runId, overrides));
  const id = await capture.promise;
  capture.unsubscribe();
  return { id, resolutionPromise };
}

/**
 * Builds a raw, untyped action payload -- deliberately typed as `Record<string, unknown>`, not
 * `HumanAction`, since these tests simulate what an adversarial or buggy capture callback (an
 * untrusted JS/JSON boundary) can hand to `recordHumanAction`, which is exactly the kind of input
 * the compile-time `HumanAction` type does not protect against.
 */
function baseAction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    type: 'click',
    frame: [],
    target: { role: 'button', name: 'Acknowledge' },
    ...overrides,
  };
}

// =================================================================================================
// 1. Race windows around the transition lock
// =================================================================================================

describe('race windows: transition lock closes them', () => {
  it('abort() is refused while takeControl() is awaiting capture.start() (lock held); state is still paused', async () => {
    const capture = makeSlowCapture({ startDelayMs: 120 });
    const { runId, broker } = setup({ capture });
    const { id } = await escalateAndGetId(broker, runId);

    const tc = broker.takeControl(id, 'alice');
    await sleep(20); // well inside the 120ms capture.start() window; takeControl already holds the lock
    expect(broker.token.state).toBe('paused');
    await expect(broker.abort(id, 'bob')).rejects.toThrow(IllegalControlTransitionError);

    await tc;
    expect(broker.token.state).toBe('human');

    await broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    broker.resumed(id);
  });

  it('a second takeControl() is refused while the first is awaiting capture.start()', async () => {
    const capture = makeSlowCapture({ startDelayMs: 80 });
    const { runId, broker } = setup({ capture });
    const { id } = await escalateAndGetId(broker, runId);

    const tc1 = broker.takeControl(id, 'alice');
    await expect(broker.takeControl(id, 'bob')).rejects.toThrow(IllegalControlTransitionError);
    await tc1;
    expect(broker.token.state).toBe('human');

    await broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    broker.resumed(id);
  });

  it('resumed() is refused while handBack() is mid-flight (still stopping capture); state is still human', async () => {
    const capture = makeSlowCapture({ stopDelayMs: 100 });
    const { runId, broker } = setup({ capture });
    const { id } = await escalateAndGetId(broker, runId);
    await broker.takeControl(id, 'alice');

    const hb = broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    await sleep(15); // inside the 100ms stopCapture() window
    expect(broker.token.state).toBe('human'); // NOT yet 'resuming'
    expect(() => broker.resumed(id)).toThrow(IllegalControlTransitionError);

    await hb;
    expect(broker.token.state).toBe('resuming');
    broker.resumed(id);
  });

  it('reverifyFailed() is refused while handBack() is mid-flight', async () => {
    const capture = makeSlowCapture({ stopDelayMs: 100 });
    const { runId, broker } = setup({ capture });
    const { id } = await escalateAndGetId(broker, runId);
    await broker.takeControl(id, 'alice');

    const hb = broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    await sleep(15);
    expect(() => broker.reverifyFailed(id, 'too early')).toThrow(IllegalControlTransitionError);

    await hb;
    broker.resumed(id);
  });

  it('a second handBack() is refused while the first is mid-flight (transition lock)', async () => {
    const capture = makeSlowCapture({ stopDelayMs: 100 });
    const { runId, broker } = setup({ capture });
    const { id } = await escalateAndGetId(broker, runId);
    await broker.takeControl(id, 'alice');

    const hb1 = broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    await expect(broker.handBack(id, { resumeFrom: 'current_step', by: 'bob' })).rejects.toThrow(IllegalControlTransitionError);

    await hb1;
    broker.resumed(id);
  });

  it('abort() is refused while handBack() is mid-flight, even though both would otherwise be legal from human', async () => {
    const capture = makeSlowCapture({ stopDelayMs: 100 });
    const { runId, broker } = setup({ capture });
    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    await broker.takeControl(id, 'alice');

    const hb = broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    await expect(broker.abort(id, 'bob')).rejects.toThrow(IllegalControlTransitionError);

    await hb;
    broker.resumed(id);
    await resolutionPromise;
  });

  it('two concurrent abort() calls from human: the second is refused while the first is stopping capture', async () => {
    const capture = makeSlowCapture({ stopDelayMs: 100 });
    const { runId, broker } = setup({ capture });
    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    await broker.takeControl(id, 'alice');

    const a1 = broker.abort(id, 'alice', 'giving up');
    await expect(broker.abort(id, 'bob', 'also giving up')).rejects.toThrow(IllegalControlTransitionError);

    const resolution = await a1;
    expect(resolution.resumeFrom).toBe('abort');
    expect(broker.terminated).toBe(true);
    await resolutionPromise;
  });
});

// =================================================================================================
// 2. Guarded-surface completeness
// =================================================================================================

describe('guarded surface completeness', () => {
  it('refuses every action type identically while paused and while human (navigate, press, wait, not just click)', async () => {
    const { runId, broker } = setup();
    const { id } = await escalateAndGetId(broker, runId);

    const actions: Array<Parameters<SessionBroker['surface']['act']>[0]> = [
      { type: 'navigate', url: 'http://x.test/blocked' },
      { type: 'press', key: 'Enter' },
      { type: 'wait', condition: { kind: 'dialog_open' }, timeoutMs: 10 },
    ];
    for (const action of actions) {
      const r = await broker.surface.act(action, 100);
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('policy_violation');
    }

    await broker.takeControl(id, 'alice');
    for (const action of actions) {
      const r = await broker.surface.act(action, 100);
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('policy_violation');
    }

    await broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    broker.resumed(id);
  });

  it('close() succeeds in plain automation state (no intervention ever raised)', async () => {
    const { broker, fakeSurface } = setup();
    expect(broker.token.state).toBe('automation');
    await expect(broker.surface.close()).resolves.toBeUndefined();
    expect(fakeSurface.currentScreenId()).toBe('blocked'); // close() doesn't touch app state, just marks closed
  });

  it('frameUrls()/describeRef() pass through in every control state (paused, human, resuming)', async () => {
    const { runId, broker } = setup();
    const obs = await broker.surface.observe();
    const ackRef = obs.elements.find((e) => e.name === 'Acknowledge')!.ref;

    const { id } = await escalateAndGetId(broker, runId);
    await expect(broker.surface.frameUrls!()).resolves.toEqual(['http://x.test/blocked']);
    await expect(broker.surface.describeRef!(ackRef)).resolves.toMatchObject({ name: 'Acknowledge' });

    await broker.takeControl(id, 'alice');
    await expect(broker.surface.frameUrls!()).resolves.toEqual(['http://x.test/blocked']);
    await expect(broker.surface.describeRef!(ackRef)).resolves.toMatchObject({ name: 'Acknowledge' });

    await broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    await expect(broker.surface.frameUrls!()).resolves.toEqual(['http://x.test/blocked']);
    broker.resumed(id);
  });

  it('the guarded surface is a fresh plain object: no shared prototype with the raw surface, no humanCapture', async () => {
    const { broker, fakeSurface } = setup();
    expect(broker.surface).not.toBe(fakeSurface);
    expect(Object.getPrototypeOf(broker.surface)).toBe(Object.getPrototypeOf({}));
    expect((broker.surface as unknown as { humanCapture?: unknown }).humanCapture).toBeUndefined();
    expect(Object.keys(broker.surface)).not.toContain('humanCapture');
    // Spreading it can't reach anything the raw surface has that the guard doesn't forward.
    const spread = { ...broker.surface };
    expect(Object.prototype.hasOwnProperty.call(spread, 'humanCapture')).toBe(false);
  });

  it('operatorSurface: same isolation from the raw surface, close() always throws regardless of state', async () => {
    const { runId, broker, fakeSurface } = setup();
    const { id } = await escalateAndGetId(broker, runId);
    const opSurface = broker.operatorSurface(id);

    expect(opSurface).not.toBe(fakeSurface);
    expect(Object.getPrototypeOf(opSurface)).toBe(Object.getPrototypeOf({}));
    expect((opSurface as unknown as { humanCapture?: unknown }).humanCapture).toBeUndefined();

    await expect(opSurface.close()).rejects.toThrow(IllegalControlTransitionError); // before control
    await broker.takeControl(id, 'alice');
    await expect(opSurface.close()).rejects.toThrow(IllegalControlTransitionError); // during control
    await broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    await expect(opSurface.close()).rejects.toThrow(IllegalControlTransitionError); // after hand-back
    broker.resumed(id);
  });
});

// =================================================================================================
// 3. Adversarial HumanAction payloads through the capture callback
// =================================================================================================

describe('adversarial HumanAction payloads', () => {
  async function withHumanControl(
    fn: (ctx: { dir: string; runId: string; id: string; capture: ReturnType<typeof makeSlowCapture>; broker: SessionBroker }) => Promise<void>,
  ): Promise<{ dir: string; runId: string; id: string }> {
    const capture = makeSlowCapture();
    const { dir, runId, broker } = setup({ capture });
    const { id } = await escalateAndGetId(broker, runId);
    await broker.takeControl(id, 'alice');
    await fn({ dir, runId, id, capture, broker });
    await broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    broker.resumed(id);
    return { dir, runId, id };
  }

  it('a `value` key nested under `target` is stripped, not just a top-level one', async () => {
    await withHumanControl(async ({ id, capture, broker }) => {
      capture.emit(baseAction({ type: 'click', target: { role: 'button', name: 'Acknowledge', value: 'SECRET-IN-TARGET' } }));
      const view = broker.view(id);
      expect(view.humanActions).toHaveLength(1);
      expect(Object.prototype.hasOwnProperty.call(view.humanActions[0]!.target, 'value')).toBe(false);
      expect(JSON.stringify(view.humanActions[0])).not.toContain('SECRET-IN-TARGET');
    });
  });

  it('non-string target fields are dropped rather than coerced', async () => {
    await withHumanControl(async ({ id, broker, capture }) => {
      capture.emit(baseAction({ target: { role: 123, name: true, text: ['array'], selector: 'legit-selector' } }));
      const view = broker.view(id);
      expect(view.humanActions).toHaveLength(1);
      expect(view.humanActions[0]!.target).toEqual({ selector: 'legit-selector' });
    });
  });

  it('a malformed `frame` fails schema validation and the action is dropped, logged as error, never stored', async () => {
    await withHumanControl(async ({ dir, runId, id, broker, capture }) => {
      capture.emit(baseAction({ frame: 'not-an-array' }));
      const view = broker.view(id);
      expect(view.humanActions).toHaveLength(0);
      const errors = readEvents(dir, runId).filter((e) => e.kind === 'error');
      expect(errors.some((e) => String(e.data.message).includes('malformed'))).toBe(true);
    });
  });

  it('type: "input" with valueRedacted: false is forced back to true regardless of what the capture sent', async () => {
    await withHumanControl(async ({ id, broker, capture }) => {
      capture.emit(baseAction({ type: 'input', target: { name: 'Note' }, valueRedacted: false }));
      const view = broker.view(id);
      expect(view.humanActions).toHaveLength(1);
      expect(view.humanActions[0]!.valueRedacted).toBe(true);
    });
  });

  it('a `__proto__` own key on the target does not pollute Object.prototype or leak into the sanitized target', async () => {
    await withHumanControl(async ({ id, broker, capture }) => {
      const pollutedTarget = JSON.parse('{"role":"button","__proto__":{"polluted":"yes"}}') as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(pollutedTarget, '__proto__')).toBe(true); // sanity: JSON.parse made it an own key
      capture.emit(baseAction({ target: pollutedTarget }));
      const view = broker.view(id);
      expect(view.humanActions).toHaveLength(1);
      expect(view.humanActions[0]!.target).toEqual({ role: 'button' });
      expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  it('target strings are capped: a 20k-char text is truncated before it reaches memory or evidence', async () => {
    const longText = 'A'.repeat(20_000);
    await withHumanControl(async ({ dir, runId, id, broker, capture }) => {
      capture.emit(baseAction({ target: { role: 'button', name: 'Acknowledge', text: longText } }));
      const view = broker.view(id);
      expect(view.humanActions[0]!.target.text!.length).toBeLessThan(400);
      expect(readRawEventsFile(dir, runId)).not.toContain(longText);
    });
  });

  it('a rogue capture that reports the typed value via target.text on an input action does not persist it: text is dropped for inputs', async () => {
    const typedSecret = 'hunter2-the-actual-password-the-human-typed';
    const { dir, runId, id } = await withHumanControl(async ({ dir, runId, id, broker, capture }) => {
      // A real HumanActionCapture is documented as never reading values (the surface
      // implementation's responsibility, not this module's). This simulates a capture that
      // violates that contract by putting the entered value where "text" (typically a
      // label/visible-text field) is expected. The whitelist strips the *key* `value`; it does
      // not, and cannot, know that `target.text` here happens to carry the same information.
      capture.emit(baseAction({ type: 'input', target: { name: 'Password field', text: typedSecret }, valueRedacted: false }));
      const view = broker.view(id);
      expect(view.humanActions).toHaveLength(1);
      expect(view.humanActions[0]!.valueRedacted).toBe(true);
      expect(view.humanActions[0]!.target.text).toBeUndefined();
      expect(view.humanActions[0]!.target.name).toBe('Password field');
      expect(readRawEventsFile(dir, runId)).not.toContain(typedSecret);
    });
    // withHumanControl's own handBack() rewrites the intervention file with resolution.humanActions.
    expect(readInterventionFile(dir, runId, id)).not.toContain(typedSecret);
  });
});

// =================================================================================================
// 4. control_transfer is on disk before onTransfer listeners run
// =================================================================================================

describe('control_transfer ordering', () => {
  it('the control_transfer event is already appended to events.jsonl by the time onTransfer listeners run', async () => {
    const { dir, runId, broker } = setup();
    const seenInsideListener: string[] = [];
    broker.onTransfer((e) => {
      const raw = readRawEventsFile(dir, runId);
      seenInsideListener.push(raw.includes(`"to":"${e.to}"`) ? 'present' : 'absent');
    });

    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    await broker.takeControl(id, 'alice');
    await broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    broker.resumed(id);
    await resolutionPromise;

    expect(seenInsideListener.length).toBeGreaterThanOrEqual(4);
    expect(seenInsideListener.every((v) => v === 'present')).toBe(true);
  });
});

// =================================================================================================
// 5. EscalationRequest.context never becomes part of the persisted Intervention
// =================================================================================================

describe('escalation context isolation', () => {
  it('context is in the escalation event and the view, but never a field on the Intervention record', async () => {
    const { dir, runId, broker } = setup();
    const context = { expected: 'member profile', observed: 'access denied', lastActions: ['click search', 'click row'] };
    const { id } = await escalateAndGetId(broker, runId, { context });

    const record = broker.interventions.get(id);
    expect(Object.prototype.hasOwnProperty.call(record ?? {}, 'context')).toBe(false);

    const view = broker.view(id);
    expect(view.context).toEqual(context);

    const escalationEvents = readEvents(dir, runId).filter((e) => e.kind === 'escalation');
    expect(escalationEvents).toHaveLength(1);
    expect(escalationEvents[0]!.data.context).toEqual(context);

    await broker.abort(id, 'cleanup');
  });
});

// =================================================================================================
// A hung capture must not wedge the transition lock.
// =================================================================================================

describe('capture timeouts', () => {
  it('a humanCapture.start() that never settles does not hold the lock forever: takeControl proceeds with capture none, and abort still works', async () => {
    const dir = makeTmpDir();
    const runId = newRunId();
    const logger = createRunLogger({ runId, runKind: 'replay', rootDir: dir });
    const hung: HumanActionCapture = { start: () => new Promise<void>(() => {}), stop: () => new Promise<void>(() => {}) };
    const broker = createSessionBroker({ surface: new FakeSurface(buildScenario()), logger, runId, runKind: 'replay', capture: hung, quiesceTimeoutMs: 100 });
    const pending = broker.escalate(escalationRequest(runId));
    const id = broker.token.interventionId!;
    while (broker.interventions.get(id) === undefined) await sleep(5); // escalate still persisting evidence
    await broker.takeControl(id, 'alice');
    expect(broker.token.state).toBe('human');
    expect(broker.view(id).captureMode).toBe('none');
    const res = await broker.abort(id, 'alice'); // stop() also hangs; must time out, not deadlock
    expect(res.resumeFrom).toBe('abort');
    await expect(pending).resolves.toMatchObject({ resumeFrom: 'abort' });
    expect(readEvents(dir, runId).some((e) => e.kind === 'error' && String(e.data.detail).includes('did not settle'))).toBe(true);
  });

  it('a humanCapture.start() that times out is stopped, so a start that finishes late cleans itself up', async () => {
    const dir = makeTmpDir();
    const runId = newRunId();
    const logger = createRunLogger({ runId, runKind: 'replay', rootDir: dir });
    let finishStart: () => void = () => undefined;
    let stops = 0;
    const slow: HumanActionCapture = {
      start: () => new Promise<void>((resolve) => (finishStart = resolve)),
      stop: () => {
        stops += 1;
        return Promise.resolve();
      },
    };
    const broker = createSessionBroker({ surface: new FakeSurface(buildScenario()), logger, runId, runKind: 'replay', capture: slow, quiesceTimeoutMs: 50 });
    const pending = broker.escalate(escalationRequest(runId));
    const id = broker.token.interventionId!;
    while (broker.interventions.get(id) === undefined) await sleep(5);
    await broker.takeControl(id, 'alice');
    expect(broker.view(id).captureMode).toBe('none');
    for (let i = 0; i < 100 && stops === 0; i++) await sleep(5);
    expect(stops).toBe(1);
    finishStart();
    await broker.abort(id, 'alice');
    await pending;
    // abort has no handle to stop: the timed-out start was already stopped once.
    expect(stops).toBe(1);
  });
});
