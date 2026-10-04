import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HumanAction, TargetDescriptor } from '../schema/index.js';
import { createRunLogger, newRunId } from '../evidence/index.js';
import { el, FakeSurface, scenario, type FakeScenario } from '../surface/index.js';
import type { HumanActionCapture } from '../surface/types.js';
import { createSessionBroker } from './broker.js';
import { IllegalControlTransitionError, UnknownInterventionError, type SessionBroker } from './broker-api.js';
import type { EscalationRequest, EscalationResolution } from './types.js';

/**
 * Two-screen-plus scenario shared by every test: a "blocked" screen with an Acknowledge button
 * (what the human is expected to click first), a "form" screen with a Note field and a Submit
 * button, and a final "done" screen -- enough to exercise click + type ('input') recording and a
 * full automation -> human -> automation round trip on the same live FakeSurface.
 */
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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'session-broker-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function setup(opts: { capture?: HumanActionCapture | null; quiesceTimeoutMs?: number } = {}) {
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
    ...(opts.quiesceTimeoutMs !== undefined ? { quiesceTimeoutMs: opts.quiesceTimeoutMs } : {}),
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

function readEvents(dir: string, runId: string): { kind: string; stepId?: string; data: Record<string, unknown> }[] {
  return readRawEventsFile(dir, runId)
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { kind: string; stepId?: string; data: Record<string, unknown> });
}

function readRawEventsFile(dir: string, runId: string): string {
  return readFileSync(path.join(dir, runId, 'events.jsonl'), 'utf8');
}

function readInterventionFile(dir: string, runId: string, id: string): string {
  return readFileSync(path.join(dir, runId, 'interventions', `${id}.json`), 'utf8');
}

/** Resolves with the id of the first intervention `store.create` notifies about, then unsubscribes. */
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

async function escalateToHuman(
  broker: SessionBroker,
  runId: string,
  by = 'alice',
): Promise<{ id: string; resolutionPromise: Promise<EscalationResolution> }> {
  const r = await escalateAndGetId(broker, runId);
  await broker.takeControl(r.id, by);
  return r;
}

async function escalateToResuming(
  broker: SessionBroker,
  runId: string,
  by = 'alice',
  notes = 'handled',
): Promise<{ id: string; resolutionPromise: Promise<EscalationResolution>; resolution: EscalationResolution }> {
  const r = await escalateToHuman(broker, runId, by);
  const resolution = await broker.handBack(r.id, { resumeFrom: 'next_step', notes, by });
  return { ...r, resolution };
}

function clickAction(name: string): HumanAction {
  return { ts: new Date().toISOString(), type: 'click', frame: [], target: { role: 'button', name } };
}

function dummyTarget(): TargetDescriptor {
  return { description: 'dummy', frame: [], locators: [{ strategy: { kind: 'text', text: 'nonexistent' }, confidence: 0.5, source: 'inferred' }] };
}

function makeFakeCapture() {
  let cb: ((a: HumanAction) => void) | undefined;
  let started = false;
  let stopped = false;
  return {
    start: async (onAction: (a: HumanAction) => void) => {
      started = true;
      cb = onAction;
    },
    stop: async () => {
      stopped = true;
      cb = undefined;
    },
    emit: (a: unknown) => cb?.(a as HumanAction),
    wasStarted: () => started,
    wasStopped: () => stopped,
  } satisfies HumanActionCapture & { emit: (a: unknown) => void; wasStarted: () => boolean; wasStopped: () => boolean };
}

// ---------------------------------------------------------------------------------------------
// 1. Legal transitions
// ---------------------------------------------------------------------------------------------

describe('legal transitions', () => {
  it('automation -> paused -> human -> resuming -> automation, with control_transfer events at every hop', async () => {
    const { dir, runId, broker } = setup();
    expect(broker.token).toEqual({ state: 'automation', holder: 'automation', interventionId: undefined });

    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    expect(broker.token).toEqual({ state: 'paused', holder: 'none', interventionId: id });

    await broker.takeControl(id, 'alice');
    expect(broker.token).toEqual({ state: 'human', holder: 'human', interventionId: id });

    const resolution = await broker.handBack(id, { resumeFrom: 'next_step', notes: 'done', by: 'alice' });
    expect(broker.token).toEqual({ state: 'resuming', holder: 'none', interventionId: id });

    broker.resumed(id, 'automation');
    expect(broker.token).toEqual({ state: 'automation', holder: 'automation', interventionId: undefined });

    await expect(resolutionPromise).resolves.toEqual(resolution);

    const transfers = readEvents(dir, runId).filter((e) => e.kind === 'control_transfer');
    expect(transfers.map((e) => [e.data.from, e.data.to])).toEqual([
      ['automation', 'paused'],
      ['paused', 'human'],
      ['human', 'resuming'],
      ['resuming', 'automation'],
    ]);
    for (const e of transfers) {
      expect(typeof e.data.by).toBe('string');
      expect(typeof e.data.at).toBe('string');
      expect(e.data.interventionId === id || e.data.interventionId === undefined).toBe(true);
    }
  });

  it('resuming -> paused via reverifyFailed, with the reason on the control_transfer event', async () => {
    const { dir, runId, broker } = setup();
    const { id } = await escalateToResuming(broker, runId);
    expect(broker.token.state).toBe('resuming');

    broker.reverifyFailed(id, 'checkpoint mismatch', 'automation');
    expect(broker.token).toEqual({ state: 'paused', holder: 'none', interventionId: id });

    const transfers = readEvents(dir, runId).filter((e) => e.kind === 'control_transfer');
    const last = transfers[transfers.length - 1]!;
    expect(last.data).toMatchObject({ from: 'resuming', to: 'paused', interventionId: id, by: 'automation', reason: 'checkpoint mismatch' });
  });

  it('abort reaches the terminal state from paused', async () => {
    const { dir, runId, broker } = setup();
    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    await assertAbortReachesTerminal(broker, dir, runId, id, resolutionPromise, true);
  });

  it('abort reaches the terminal state from human', async () => {
    const { dir, runId, broker } = setup();
    const { id, resolutionPromise } = await escalateToHuman(broker, runId);
    await assertAbortReachesTerminal(broker, dir, runId, id, resolutionPromise, true);
  });

  it('abort reaches the terminal state from resuming', async () => {
    const { dir, runId, broker } = setup();
    // escalateToResuming already ran a handBack, which resolved the ORIGINAL escalate() promise
    // with round 1's resolution. Aborting from 'resuming' has nothing left to resolve, since
    // handBack already resolved it.
    const { id, resolutionPromise, resolution: round1 } = await escalateToResuming(broker, runId);
    await assertAbortReachesTerminal(broker, dir, runId, id, resolutionPromise, false);
    await expect(resolutionPromise).resolves.toEqual(round1);
  });

  async function assertAbortReachesTerminal(
    broker: SessionBroker,
    dir: string,
    runId: string,
    id: string,
    resolutionPromise: Promise<EscalationResolution>,
    expectAbortResolvesTheOriginalPromise: boolean,
  ): Promise<void> {
    const resolution = await broker.abort(id, 'alice', 'operator gave up');
    expect(resolution.resumeFrom).toBe('abort');
    expect(broker.terminated).toBe(true);
    expect(broker.token).toEqual({ state: 'paused', holder: 'none', interventionId: undefined });

    const record = broker.interventions.get(id);
    expect(record?.status).toBe('abandoned');

    const transfers = readEvents(dir, runId).filter((e) => e.kind === 'control_transfer');
    const last = transfers[transfers.length - 1]!;
    expect(last.data.terminal).toBe(true);
    expect(last.data.to).toBe('paused');

    if (expectAbortResolvesTheOriginalPromise) {
      await expect(resolutionPromise).resolves.toEqual(resolution);
    }
  }

  it('broker.token already reflects the new state by the time a store subscriber sees the create/update that caused it', async () => {
    const { runId, broker } = setup();
    const seen: Array<{ state: string; interventionId: string | undefined; status: string }> = [];
    const unsubscribe = broker.interventions.subscribe((i) => {
      seen.push({ state: broker.token.state, interventionId: broker.token.interventionId, status: i.status });
    });

    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    await broker.takeControl(id, 'alice');
    await broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    broker.reverifyFailed(id, 'nope');
    unsubscribe();

    expect(seen).toEqual([
      { state: 'paused', interventionId: id, status: 'open' }, // escalate()'s store.create
      { state: 'human', interventionId: id, status: 'human_active' }, // takeControl()'s store.update
      { state: 'resuming', interventionId: id, status: 'resolved' }, // handBack()'s store.update
      { state: 'paused', interventionId: id, status: 'open' }, // reverifyFailed()'s reopen
    ]);

    // The intervention is left 'open' in 'paused' (reverifyFailed put it there); the ORIGINAL
    // escalate() promise already settled with round 1's resolution at the earlier handBack.
    await resolutionPromise;
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Illegal transitions
// ---------------------------------------------------------------------------------------------

describe('illegal transitions', () => {
  it('takeControl throws from automation, human, and resuming', async () => {
    const { runId, broker } = setup();
    await expect(broker.takeControl('nope')).rejects.toThrow(IllegalControlTransitionError);

    const human = await escalateToHuman(broker, runId);
    await expect(broker.takeControl(human.id)).rejects.toThrow(IllegalControlTransitionError);
    await broker.handBack(human.id, { resumeFrom: 'next_step', by: 'alice' });
    await expect(broker.takeControl(human.id)).rejects.toThrow(IllegalControlTransitionError); // now resuming
    broker.resumed(human.id);
    await human.resolutionPromise;
  });

  it('handBack throws from paused, resuming, and automation', async () => {
    const { runId, broker } = setup();
    await expect(broker.handBack('nope', { resumeFrom: 'next_step', by: 'alice' })).rejects.toThrow(IllegalControlTransitionError);

    const paused = await escalateAndGetId(broker, runId);
    await expect(broker.handBack(paused.id, { resumeFrom: 'next_step', by: 'alice' })).rejects.toThrow(IllegalControlTransitionError);

    await broker.takeControl(paused.id, 'alice');
    await broker.handBack(paused.id, { resumeFrom: 'next_step', by: 'alice' }); // -> resuming
    await expect(broker.handBack(paused.id, { resumeFrom: 'next_step', by: 'alice' })).rejects.toThrow(IllegalControlTransitionError);
    broker.resumed(paused.id);
    await paused.resolutionPromise;
  });

  it('resumed throws from paused, human, and automation', async () => {
    const { runId, broker } = setup();
    expect(() => broker.resumed()).toThrow(IllegalControlTransitionError);

    const paused = await escalateAndGetId(broker, runId);
    expect(() => broker.resumed(paused.id)).toThrow(IllegalControlTransitionError);

    await broker.takeControl(paused.id, 'alice');
    expect(() => broker.resumed(paused.id)).toThrow(IllegalControlTransitionError);

    await broker.handBack(paused.id, { resumeFrom: 'next_step', by: 'alice' });
    broker.resumed(paused.id);
    await paused.resolutionPromise;
  });

  it('reverifyFailed throws from human and paused', async () => {
    const { runId, broker } = setup();
    const human = await escalateToHuman(broker, runId);
    expect(() => broker.reverifyFailed(human.id, 'x')).toThrow(IllegalControlTransitionError);

    const resolution = await broker.handBack(human.id, { resumeFrom: 'next_step', by: 'alice' });
    broker.resumed(human.id);
    await human.resolutionPromise;
    void resolution;

    const paused2 = await escalateAndGetId(broker, runId);
    expect(() => broker.reverifyFailed(paused2.id, 'x')).toThrow(IllegalControlTransitionError); // still paused, never resuming
  });

  it('escalate throws from paused, human, and resuming', async () => {
    const { runId, broker } = setup();
    const paused = await escalateAndGetId(broker, runId);
    await expect(broker.escalate(escalationRequest(runId))).rejects.toThrow(IllegalControlTransitionError);

    await broker.takeControl(paused.id, 'alice');
    await expect(broker.escalate(escalationRequest(runId))).rejects.toThrow(IllegalControlTransitionError);

    await broker.handBack(paused.id, { resumeFrom: 'next_step', by: 'alice' });
    await expect(broker.escalate(escalationRequest(runId))).rejects.toThrow(IllegalControlTransitionError);

    broker.resumed(paused.id);
    await paused.resolutionPromise;
  });

  it('abort throws from automation', async () => {
    const { broker } = setup();
    await expect(broker.abort('nope')).rejects.toThrow(IllegalControlTransitionError);
  });

  it('every operation throws once the run is terminated', async () => {
    const { runId, broker } = setup();
    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    await broker.abort(id, 'alice', 'stop');
    await resolutionPromise;

    expect(broker.terminated).toBe(true);
    await expect(broker.escalate(escalationRequest(runId))).rejects.toThrow(IllegalControlTransitionError);
    await expect(broker.takeControl(id)).rejects.toThrow(IllegalControlTransitionError);
    await expect(broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' })).rejects.toThrow(IllegalControlTransitionError);
    await expect(broker.abort(id, 'alice')).rejects.toThrow(IllegalControlTransitionError);
    expect(() => broker.resumed(id)).toThrow(IllegalControlTransitionError);
    expect(() => broker.reverifyFailed(id, 'x')).toThrow(IllegalControlTransitionError);
  });

  it('rejects an id that is not the current intervention', async () => {
    const { runId, broker } = setup();
    const { id } = await escalateAndGetId(broker, runId);
    await expect(broker.takeControl('not-the-current-id')).rejects.toThrow(IllegalControlTransitionError);
    expect(broker.token.interventionId).toBe(id);
  });

  it('a concurrent takeControl call throws while the first is in progress (transition lock)', async () => {
    const { runId, broker } = setup();
    const { id } = await escalateAndGetId(broker, runId);

    const first = broker.takeControl(id, 'alice');
    await expect(broker.takeControl(id, 'bob')).rejects.toThrow(IllegalControlTransitionError);
    await first;
    expect(broker.token.state).toBe('human');
  });

  it('waitForResolution on an unknown id rejects UnknownInterventionError', async () => {
    const { broker } = setup();
    await expect(broker.waitForResolution('does-not-exist')).rejects.toThrow(UnknownInterventionError);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. escalate() blocks until handBack, not merely until takeControl
// ---------------------------------------------------------------------------------------------

describe('escalate() blocks until handBack', () => {
  it('does not resolve at takeControl; resolves once handBack runs', async () => {
    const { runId, broker } = setup();
    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);

    let resolved = false;
    void resolutionPromise.then(() => {
      resolved = true;
    });

    await broker.takeControl(id, 'alice');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    await broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    await resolutionPromise;
    expect(resolved).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Guarded surface
// ---------------------------------------------------------------------------------------------

describe('guarded surface (broker.surface)', () => {
  it('refuses automation act while paused, human, and resuming; reads and resolve still behave correctly; act works again after resumed()', async () => {
    const { runId, broker, fakeSurface } = setup();

    // A {ref} target obtained from automation, before the escalation.
    const obs = await broker.surface.observe();
    const ack = obs.elements.find((e) => e.name === 'Acknowledge')!;

    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    await assertActRefused(broker, fakeSurface, ack.ref);

    await broker.takeControl(id, 'alice');
    await assertActRefused(broker, fakeSurface, ack.ref);

    const resolution = await broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    await assertActRefused(broker, fakeSurface, ack.ref);

    broker.resumed(id);
    await expect(resolutionPromise).resolves.toEqual(resolution);

    expect(fakeSurface.currentScreenId()).toBe('blocked'); // no refused act ever reached the raw surface
    const afterResume = await broker.surface.act({ type: 'click', target: { ref: ack.ref } }, 1000);
    expect(afterResume.ok).toBe(true);
    expect(fakeSurface.currentScreenId()).toBe('form');
  });

  async function assertActRefused(broker: SessionBroker, fakeSurface: FakeSurface, ref: string): Promise<void> {
    const before = fakeSurface.actionLog().length;

    const actResult = await broker.surface.act({ type: 'click', target: { ref } }, 1000);
    expect(actResult.ok).toBe(false);
    expect(actResult.error?.code).toBe('policy_violation');
    expect(actResult.error?.message).toContain('control held by human');
    expect(fakeSurface.actionLog().length).toBe(before); // never reached the raw surface

    const resolveResult = await broker.surface.resolve(dummyTarget(), 1000);
    expect(resolveResult).toEqual({ found: false, tried: [{ strategyKind: 'control', error: 'control held by human' }] });

    // Reads keep working regardless of who holds control.
    await expect(broker.surface.observe()).resolves.toBeDefined();
    await expect(broker.surface.check({ kind: 'dialog_open' })).resolves.toBe(false);
    await expect(broker.surface.screenshot()).resolves.toBeDefined();
    await expect(broker.surface.currentUrl()).resolves.toBeDefined();
    const readTextResult = await broker.surface.readText({ ref }, 1000);
    expect(readTextResult.ok).toBe(true);
  }
});

// ---------------------------------------------------------------------------------------------
// 5. Captured human actions: sanitisation, redaction, malformed-action handling
// ---------------------------------------------------------------------------------------------

describe('recordHumanAction / capture', () => {
  it('rejects recording outside the human window for that intervention', async () => {
    const { runId, broker } = setup();
    const { id } = await escalateAndGetId(broker, runId);
    expect(() => broker.recordHumanAction(id, clickAction('Acknowledge'), 'capture')).toThrow(IllegalControlTransitionError);
    await broker.takeControl(id, 'alice');
    await broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    broker.resumed(id);
  });

  it('captured actions land in view().humanActions and as human_action events; a sneaky value key and unredacted input never reach memory or disk; malformed actions are dropped', async () => {
    const capture = makeFakeCapture();
    const { dir, runId, broker } = setup({ capture });

    const { id } = await escalateAndGetId(broker, runId);
    await broker.takeControl(id, 'alice');
    expect(capture.wasStarted()).toBe(true);
    expect(broker.view(id).captureMode).toBe('surface');

    capture.emit(clickAction('Acknowledge'));
    // Sneaky `value` key and no `valueRedacted` on an 'input' action: must still come out redacted
    // and must never carry the `value` key anywhere.
    capture.emit({
      ts: new Date().toISOString(),
      type: 'input',
      frame: [],
      target: { role: 'textbox', name: 'Note' },
      value: 'SECRET123',
    });
    // Malformed: `ts` is not a valid ISO datetime -> HumanAction.safeParse fails -> dropped + logged.
    capture.emit({ ts: 'not-a-date', type: 'click', frame: [], target: {} });

    const view = broker.view(id);
    expect(view.humanActions).toHaveLength(2);
    const input = view.humanActions.find((a) => a.type === 'input');
    expect(input).toBeDefined();
    expect(input?.valueRedacted).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(input ?? {}, 'value')).toBe(false);

    const rawEvents = readRawEventsFile(dir, runId);
    expect(rawEvents).not.toContain('"value"');
    expect(rawEvents).not.toContain('SECRET123');

    const humanActionEvents = readEvents(dir, runId).filter((e) => e.kind === 'human_action');
    expect(humanActionEvents).toHaveLength(2);
    for (const e of humanActionEvents) expect(e.data.source).toBe('capture');

    const errorEvents = readEvents(dir, runId).filter((e) => e.kind === 'error');
    expect(errorEvents.some((e) => String(e.data.message).includes('malformed'))).toBe(true);

    await broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    const interventionRaw = readInterventionFile(dir, runId, id);
    expect(interventionRaw).not.toContain('"value"');
    expect(interventionRaw).not.toContain('SECRET123');
    expect(capture.wasStopped()).toBe(true);

    broker.resumed(id);
  });
});

// ---------------------------------------------------------------------------------------------
// 6. handBack resolution
// ---------------------------------------------------------------------------------------------

describe('handBack resolution', () => {
  it('carries accumulated humanActions, notes, resumeFrom, by; persisted with status resolved', async () => {
    const { runId, broker } = setup();
    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    await broker.takeControl(id, 'alice');
    broker.recordHumanAction(id, clickAction('Acknowledge'), 'capture');

    const resolution = await broker.handBack(id, { resumeFrom: 'current_step', notes: 'looks good', by: 'alice' });
    expect(resolution).toEqual({
      interventionId: id,
      resumeFrom: 'current_step',
      notes: 'looks good',
      humanActions: [expect.objectContaining({ type: 'click' })],
      by: 'alice',
    });

    const record = broker.interventions.get(id);
    expect(record?.status).toBe('resolved');
    expect(record?.resolution).toEqual({
      by: 'alice',
      at: expect.any(String),
      notes: 'looks good',
      humanActions: resolution.humanActions,
      resumeFrom: 'current_step',
    });

    broker.resumed(id);
    await expect(resolutionPromise).resolves.toEqual(resolution);
  });
});

// ---------------------------------------------------------------------------------------------
// 7. reverifyFailed / waitForResolution / accumulation across rounds
// ---------------------------------------------------------------------------------------------

describe('reverifyFailed and multi-round accumulation', () => {
  it('reopens the intervention (status open, note appended); waitForResolution waits for the next handBack; actions accumulate across rounds', async () => {
    const { runId, broker } = setup();
    const { id, resolutionPromise: round1Promise } = await escalateAndGetId(broker, runId);
    await broker.takeControl(id, 'alice');
    broker.recordHumanAction(id, clickAction('Acknowledge'), 'capture');
    const round1 = await broker.handBack(id, { resumeFrom: 'next_step', notes: 'round1 notes', by: 'alice' });
    expect(round1.humanActions).toHaveLength(1);

    broker.reverifyFailed(id, 'still blocked', 'automation');
    expect(broker.token.state).toBe('paused');

    const record = broker.interventions.get(id);
    expect(record?.status).toBe('open');
    expect(record?.resolution?.notes).toContain('round1 notes');
    expect(record?.resolution?.notes).toContain('re-verification failed');
    expect(record?.resolution?.notes).toContain('still blocked');

    const waitPromise = broker.waitForResolution(id);
    await broker.takeControl(id, 'alice');
    broker.recordHumanAction(id, clickAction('Submit'), 'capture');
    const round2 = await broker.handBack(id, { resumeFrom: 'next_step', notes: 'round2 notes', by: 'alice' });

    expect(round2.humanActions).toHaveLength(2); // accumulated across both rounds
    await expect(waitPromise).resolves.toEqual(round2);

    // The ORIGINAL escalate() promise only ever resolves once, at round 1's handBack.
    await expect(round1Promise).resolves.toEqual(round1);

    broker.resumed(id);
  });
});

// ---------------------------------------------------------------------------------------------
// 8. abort()
// ---------------------------------------------------------------------------------------------

describe('abort()', () => {
  it('resolves the pending escalate promise with resumeFrom abort; guarded act/close behave correctly before and after', async () => {
    const { runId, broker } = setup();
    const { id, resolutionPromise } = await escalateToHuman(broker, runId);
    broker.recordHumanAction(id, clickAction('Acknowledge'), 'capture');

    await expect(broker.surface.close()).rejects.toThrow(IllegalControlTransitionError); // refused while human

    const abortResolution = await broker.abort(id, 'alice', 'giving up');
    expect(abortResolution.resumeFrom).toBe('abort');
    expect(abortResolution.humanActions).toHaveLength(1);
    expect(broker.terminated).toBe(true);
    expect(broker.token).toEqual({ state: 'paused', holder: 'none', interventionId: undefined });

    const record = broker.interventions.get(id);
    expect(record?.status).toBe('abandoned');
    expect(record?.resolution?.resumeFrom).toBe('abort');

    await expect(resolutionPromise).resolves.toEqual(abortResolution);

    const actResult = await broker.surface.act({ type: 'click', target: { ref: 'e1' } }, 1000);
    expect(actResult).toEqual({ ok: false, error: { code: 'policy_violation', message: expect.stringContaining('run aborted by operator') } });

    await expect(broker.surface.close()).resolves.toBeUndefined(); // allowed after abort
  });
});

// ---------------------------------------------------------------------------------------------
// 9. takeControl waits for an in-flight automation act to settle
// ---------------------------------------------------------------------------------------------

describe('takeControl quiescing', () => {
  it('waits for an in-flight automation act to settle before flipping to human', async () => {
    const { runId, broker, fakeSurface } = setup();
    fakeSurface.inject({ kind: 'delay', ms: 200 });

    const obs = await broker.surface.observe();
    const ack = obs.elements.find((e) => e.name === 'Acknowledge')!;
    const inFlightAct = broker.surface.act({ type: 'click', target: { ref: ack.ref } }, 5000);

    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);

    let tookControl = false;
    const takeControlPromise = broker.takeControl(id, 'alice').then(() => {
      tookControl = true;
    });

    await new Promise((r) => setTimeout(r, 60)); // well under the 200ms delay
    expect(tookControl).toBe(false);
    expect(broker.token.state).toBe('paused');

    const actResult = await inFlightAct;
    expect(actResult.ok).toBe(true);

    await takeControlPromise;
    expect(tookControl).toBe(true);
    expect(broker.token.state).toBe('human');

    await broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    broker.resumed(id);
    await resolutionPromise;
  });

  it('gives up and throws IllegalControlTransitionError if the in-flight act does not settle within quiesceTimeoutMs', async () => {
    const { runId, broker, fakeSurface } = setup({ quiesceTimeoutMs: 50 });
    fakeSurface.inject({ kind: 'delay', ms: 500 });

    const obs = await broker.surface.observe();
    const ack = obs.elements.find((e) => e.name === 'Acknowledge')!;
    const inFlightAct = broker.surface.act({ type: 'click', target: { ref: ack.ref } }, 5000);

    const { id } = await escalateAndGetId(broker, runId);
    await expect(broker.takeControl(id, 'alice')).rejects.toThrow(IllegalControlTransitionError);

    await inFlightAct; // drain it so it doesn't outlive the test
  });
});

// ---------------------------------------------------------------------------------------------
// 10. operatorSurface
// ---------------------------------------------------------------------------------------------

describe('operatorSurface', () => {
  it('acts only while state is human for that intervention', async () => {
    const { runId, broker } = setup();
    const { id } = await escalateAndGetId(broker, runId);
    const opSurface = broker.operatorSurface(id);

    const beforeControl = await opSurface.act({ type: 'click', target: { ref: 'e1' } }, 1000);
    expect(beforeControl).toEqual({ ok: false, error: { code: 'policy_violation', message: expect.stringContaining('operator does not hold control') } });
    const resolveBeforeControl = await opSurface.resolve(dummyTarget(), 1000);
    expect(resolveBeforeControl).toEqual({ found: false, tried: [{ strategyKind: 'control', error: 'operator does not hold control' }] });
    await expect(opSurface.close()).rejects.toThrow(IllegalControlTransitionError);

    await broker.takeControl(id, 'alice');
    const obs = await opSurface.observe();
    const ack = obs.elements.find((e) => e.name === 'Acknowledge')!;
    const duringControl = await opSurface.act({ type: 'click', target: { ref: ack.ref } }, 1000);
    expect(duringControl.ok).toBe(true);
    await expect(opSurface.close()).rejects.toThrow(IllegalControlTransitionError); // operator can never close

    await broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    const afterHandBack = await opSurface.act({ type: 'click', target: { ref: 'e1' } }, 1000);
    expect(afterHandBack.ok).toBe(false);

    broker.resumed(id);
  });
});

// ---------------------------------------------------------------------------------------------
// Resume points (resumeAtStepId)
// ---------------------------------------------------------------------------------------------

describe('handBack with a resume point', () => {
  it('carries resumeAtStepId to the awaited resolution and the persisted record', async () => {
    const { dir, runId, broker } = setup();
    const { id, resolutionPromise } = await escalateToHuman(broker, runId);

    const resolution = await broker.handBack(id, { resumeFrom: 'current_step', resumeAtStepId: 's05', by: 'alice' });
    expect(resolution).toMatchObject({ resumeFrom: 'current_step', resumeAtStepId: 's05' });
    await expect(resolutionPromise).resolves.toMatchObject({ resumeAtStepId: 's05' });
    expect(broker.interventions.get(id)?.resolution).toMatchObject({ resumeFrom: 'current_step', resumeAtStepId: 's05' });
    expect(JSON.parse(readInterventionFile(dir, runId, id))).toMatchObject({ resolution: { resumeAtStepId: 's05' } });
    broker.resumed(id);
  });

  it('leaves the field out entirely when none is given (old resolutions stay as they were)', async () => {
    const { runId, broker } = setup();
    const { id } = await escalateToHuman(broker, runId);
    const resolution = await broker.handBack(id, { resumeFrom: 'current_step', by: 'alice' });
    expect(resolution).not.toHaveProperty('resumeAtStepId');
    expect(broker.interventions.get(id)?.resolution).not.toHaveProperty('resumeAtStepId');
    broker.resumed(id);
  });

  it.each([
    { name: 'with next_step', input: { resumeFrom: 'next_step' as const, resumeAtStepId: 's05' } },
    { name: 'that is empty', input: { resumeFrom: 'current_step' as const, resumeAtStepId: '' } },
  ])('refuses a resume point $name, and the human still holds control', async ({ input }) => {
    const { runId, broker } = setup();
    const { id } = await escalateToHuman(broker, runId);
    await expect(broker.handBack(id, { ...input, by: 'alice' })).rejects.toThrow(IllegalControlTransitionError);
    expect(broker.token).toEqual({ state: 'human', holder: 'human', interventionId: id });
    await broker.handBack(id, { resumeFrom: 'current_step', by: 'alice' });
    broker.resumed(id);
  });
});
