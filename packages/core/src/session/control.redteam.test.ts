/**
 * Adversarial probes for the control-transfer guarantees in `createSessionBroker` (see
 * docs/design/handoff.md). Each `it` documents one attack and the guarantee it is checking. Many
 * of the base transitions are already covered in `broker.test.ts`; this file targets attacks not
 * already exercised there: a descriptor-target act during human control, waitFor as a possible
 * side channel, a second escalate leaving no residue, handBack/takeControl aimed at the wrong
 * intervention id while a real one is in progress, resolve() after abort, control-token rotation
 * across two intervention rounds, and the accepted, documented lack of operator identity
 * enforcement on handBack.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TargetDescriptor } from '../schema/index.js';
import { createRunLogger, newRunId } from '../evidence/index.js';
import { el, FakeSurface, scenario, type FakeScenario } from '../surface/index.js';
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
    .on('click', { targetId: 'submit' })
    .goto('done')
    .screen('done', {
      url: 'http://x.test/done',
      title: 'Done',
      elements: [el({ id: 'doneMsg', role: 'generic', name: 'Done!', text: 'Done!', tag: 'div', bbox: { x: 0, y: 0, w: 60, h: 20 } })],
    })
    .build();
}

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'control-redteam-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function setup() {
  const dir = makeTmpDir();
  const runId = newRunId();
  const fakeSurface = new FakeSurface(buildScenario());
  const logger = createRunLogger({ runId, runKind: 'replay', rootDir: dir });
  const broker = createSessionBroker({ surface: fakeSurface, logger, runId, runKind: 'replay' });
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

function dummyTarget(): TargetDescriptor {
  return { description: 'dummy', frame: [], locators: [{ strategy: { kind: 'text', text: 'nonexistent' }, confidence: 0.5, source: 'inferred' }] };
}

// ---------------------------------------------------------------------------------------------
// act() by descriptor target (not just {ref}) is refused while human holds control
// ---------------------------------------------------------------------------------------------

describe('act() with a full TargetDescriptor (not just a bare {ref}) is refused while control is not automation\'s', () => {
  it('a click by TargetDescriptor is refused in paused/human/resuming and never reaches the raw surface', async () => {
    const { runId, broker, fakeSurface } = setup();
    const ackDescriptor: TargetDescriptor = {
      description: 'Acknowledge button',
      frame: [],
      locators: [{ strategy: { kind: 'role', role: 'button', name: 'Acknowledge' }, confidence: 0.9, source: 'inferred' }],
    };

    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    const beforePaused = fakeSurface.actionLog().length;
    const pausedResult = await broker.surface.act({ type: 'click', target: ackDescriptor }, 1000);
    expect(pausedResult.ok).toBe(false);
    expect(pausedResult.error?.message).toContain('control held by human');
    expect(fakeSurface.actionLog().length).toBe(beforePaused);

    await broker.takeControl(id, 'alice');
    const humanResult = await broker.surface.act({ type: 'click', target: ackDescriptor }, 1000);
    expect(humanResult.ok).toBe(false);
    expect(fakeSurface.actionLog().length).toBe(beforePaused);
    expect(fakeSurface.currentScreenId()).toBe('blocked'); // the descriptor-target click never actually ran

    await broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    broker.resumed(id);
    await resolutionPromise;
  });
});

// ---------------------------------------------------------------------------------------------
// waitFor() is a read (allowed in every state) and provides no mutation side channel
// ---------------------------------------------------------------------------------------------

describe('waitFor() during human control is a pure read, not a bypass', () => {
  it('waitFor() succeeds while human holds control (by design -- the caller needs to re-verify checkpoints) but never mutates screen/state', async () => {
    const { runId, broker, fakeSurface } = setup();
    const { id } = await escalateAndGetId(broker, runId);
    await broker.takeControl(id, 'alice');

    const met = await broker.surface.waitFor({ kind: 'text_visible', text: 'Acknowledge' }, 200);
    expect(met).toBe(true);
    // Still on 'blocked': waitFor evaluated a condition, it did not click anything or advance state.
    expect(fakeSurface.currentScreenId()).toBe('blocked');
    expect(fakeSurface.actionLog().length).toBe(0);

    await broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    broker.resumed(id);
  });
});

// ---------------------------------------------------------------------------------------------
// a second escalate() while one is pending leaves no residue on the first
// ---------------------------------------------------------------------------------------------

describe('a second escalate() while one is already pending is refused and leaves the first intervention untouched', () => {
  it('token, current intervention id, and the store are all unchanged after the rejected second escalate()', async () => {
    const { runId, broker } = setup();
    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    const before = broker.token;
    const beforeCount = broker.interventions.list({ runId }).length;

    await expect(broker.escalate(escalationRequest(runId, { stepId: 's2' }))).rejects.toThrow(IllegalControlTransitionError);

    expect(broker.token).toEqual(before);
    expect(broker.interventions.list({ runId }).length).toBe(beforeCount); // no phantom second intervention record

    await broker.takeControl(id, 'alice');
    await broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    broker.resumed(id);
    await resolutionPromise;
  });
});

// ---------------------------------------------------------------------------------------------
// handBack / takeControl aimed at the wrong intervention id while a real one is in progress
// ---------------------------------------------------------------------------------------------

describe('control operations aimed at a stale/wrong intervention id are refused, and the real one is unaffected', () => {
  it('handBack with a different intervention id throws while the real one stays "human"; a correct handBack afterward still works', async () => {
    const { runId, broker } = setup();
    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    await broker.takeControl(id, 'alice');

    await expect(broker.handBack('not-the-real-id', { resumeFrom: 'next_step', by: 'mallory' })).rejects.toThrow(IllegalControlTransitionError);
    expect(broker.token).toEqual({ state: 'human', holder: 'human', interventionId: id });

    const resolution = await broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    broker.resumed(id);
    await expect(resolutionPromise).resolves.toEqual(resolution);
  });

  it('takeControl called twice for the same intervention: the second call (state already human) throws', async () => {
    const { runId, broker } = setup();
    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    await broker.takeControl(id, 'alice');
    await expect(broker.takeControl(id, 'bob')).rejects.toThrow(IllegalControlTransitionError);
    expect(broker.token).toEqual({ state: 'human', holder: 'human', interventionId: id });

    await broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    broker.resumed(id);
    await resolutionPromise;
  });
});

// ---------------------------------------------------------------------------------------------
// abort() then act()/resolve() -- both refused, not just act()
// ---------------------------------------------------------------------------------------------

describe('after abort(), every surface entry point is refused (not only act())', () => {
  it('resolve() after abort reports not-found via the control-refusal path, matching act()', async () => {
    const { runId, broker } = setup();
    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    await broker.abort(id, 'alice', 'giving up');
    await resolutionPromise;

    const resolveResult = await broker.surface.resolve(dummyTarget(), 1000);
    expect(resolveResult).toEqual({ found: false, tried: [{ strategyKind: 'control', error: 'control held by human' }] });

    const actResult = await broker.surface.act({ type: 'click', target: { ref: 'e1' } }, 1000);
    expect(actResult.ok).toBe(false);
    expect(actResult.error?.message).toContain('run aborted by operator');
  });
});

// ---------------------------------------------------------------------------------------------
// a "recovery rule" style reversible action attempted mid-escalation
// ---------------------------------------------------------------------------------------------

describe('a recovery-rule-style action (reversible risk, fired by replay mid-run) is refused the same as any other automation act during an open escalation', () => {
  it('an in-flight recovery rule cannot act on broker.surface once escalate() has flipped control to paused', async () => {
    const { runId, broker, fakeSurface } = setup();
    // Simulate: replay's recovery-rule executor calls broker.surface.act(...) directly (it has no
    // special channel; it uses the same guarded surface automation always uses).
    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    const before = fakeSurface.actionLog().length;
    const recoveryAttempt = await broker.surface.act({ type: 'click', target: { ref: 'e1' } }, 1000);
    expect(recoveryAttempt.ok).toBe(false);
    expect(recoveryAttempt.error?.code).toBe('policy_violation');
    expect(fakeSurface.actionLog().length).toBe(before);

    await broker.takeControl(id, 'alice');
    await broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    broker.resumed(id);
    await resolutionPromise;
  });
});

// ---------------------------------------------------------------------------------------------
// control-token rotation across two intervention rounds -- a stale operator surface is inert
// ---------------------------------------------------------------------------------------------

describe('control token effectively rotates on every new intervention -- a stale operatorSurface handle cannot act after handBack, even once a NEW intervention reaches "human"', () => {
  it('operatorSurface(id1) stays refused after id1 hands back, including once id2 later takes control', async () => {
    const { runId, broker } = setup();

    const round1 = await escalateAndGetId(broker, runId);
    const op1 = broker.operatorSurface(round1.id);
    await broker.takeControl(round1.id, 'alice');
    expect((await op1.act({ type: 'click', target: { ref: 'e1' } }, 1000)).ok).toBe(true); // acts fine while it is genuinely current+human
    await broker.handBack(round1.id, { resumeFrom: 'next_step', by: 'alice' });
    broker.resumed(round1.id);
    await round1.resolutionPromise;

    // op1 must be inert now (state moved on) -- confirm before round 2 even starts.
    expect((await op1.act({ type: 'click', target: { ref: 'e1' } }, 1000)).ok).toBe(false);

    const round2 = await escalateAndGetId(broker, runId, { stepId: 's2' });
    expect(round2.id).not.toBe(round1.id);
    await broker.takeControl(round2.id, 'bob');

    // Even now that the broker is genuinely back in 'human' state (for id2), the STALE op1
    // handle -- scoped to id1 -- must still refuse: control did not implicitly transfer to it.
    const staleAttempt = await op1.act({ type: 'click', target: { ref: 'e1' } }, 1000);
    expect(staleAttempt.ok).toBe(false);
    expect(staleAttempt.error?.message).toContain('operator does not hold control');

    // The correct, current operator surface for id2 does work.
    const op2 = broker.operatorSurface(round2.id);
    const obs = await op2.observe();
    const submit = obs.elements.find((e) => e.name === 'Submit')!;
    expect((await op2.act({ type: 'click', target: { ref: submit.ref } }, 1000)).ok).toBe(true);

    await broker.handBack(round2.id, { resumeFrom: 'next_step', by: 'bob' });
    broker.resumed(round2.id);
    await round2.resolutionPromise;
  });
});

// ---------------------------------------------------------------------------------------------
// handBack by a different operator identity than took control -- documented, accepted gap
// ---------------------------------------------------------------------------------------------

describe('handBack does not verify that "by" matches whoever called takeControl (documented limitation, not a bug fixed here)', () => {
  it('handBack labelled by a different identity than takeControl still succeeds, because no operator-identity check is enforced', async () => {
    const { runId, broker } = setup();
    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    await broker.takeControl(id, 'alice');

    // "mallory" never took control, but nothing checks that handBack's `by` matches the
    // takeControl caller: there is no operator identity/auth layer, by design (see
    // docs/design/handoff.md "Known limits"). Hardening this would need a full operator-auth
    // system, well outside this module's scope.
    const resolution = await broker.handBack(id, { resumeFrom: 'next_step', by: 'mallory' });
    expect(resolution.by).toBe('mallory');
    broker.resumed(id);
    await expect(resolutionPromise).resolves.toEqual(resolution);
  });
});

// ---------------------------------------------------------------------------------------------
// The recorder-only record context: discovery's surface forwards it, the operator's never does
// ---------------------------------------------------------------------------------------------

describe("recordContextOf (real row text for discovery's recorder) never reaches the operator", () => {
  it('broker.surface forwards it; operatorSurface(id) has no such method, even while the operator holds control', async () => {
    const dir = makeTmpDir();
    const runId = newRunId();
    const fake = new FakeSurface(buildScenario());
    const context = { ownText: 'View', rowCells: [{ text: 'Al Smithers', relation: 'right-of' as const }], cell: null, containerText: '', tag: 'button' };
    const surface = new Proxy(fake, {
      get: (t, p, r) => (p === 'recordContextOf' ? (ref: string) => (ref === 'e1' ? context : undefined) : (Reflect.get(t, p, r) as unknown)),
    });
    const logger = createRunLogger({ runId, runKind: 'discovery', rootDir: dir });
    const broker = createSessionBroker({ surface, logger, runId, runKind: 'discovery' });
    expect(broker.surface.recordContextOf?.('e1')).toEqual(context);

    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    await broker.takeControl(id, 'alice');
    const op = broker.operatorSurface(id);
    expect('recordContextOf' in op).toBe(false);
    await broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    broker.resumed(id);
    await resolutionPromise;
  });
});
