import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HumanAction } from '../schema/index.js';
import { createRunLogger, newRunId } from '../evidence/index.js';
import { el, FakeSurface, scenario, type FakeScenario } from '../surface/index.js';
import type { HumanActionCapture } from '../surface/types.js';
import { createSessionBroker } from './broker.js';
import type { EscalationRequest } from './types.js';
import { scriptedOperator, type ScriptedOperatorContext, type ScriptedOperatorResult } from './scripted-operator.js';

/**
 * Small scenario used by every test here: an automation-blocking screen with an "Acknowledge"
 * button, a form with a text field and a Submit button, and a final "done" screen -- enough to
 * exercise click + type (an 'input') recording and a full round trip back to automation.
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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'scripted-operator-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

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

function escalationRequest(runId: string): EscalationRequest {
  return {
    runId,
    runKind: 'replay',
    capabilityId: 'test-cap',
    goal: 'do the thing',
    stepId: 's1',
    reason: { code: 'unrecoverable_condition', message: 'automation is blocked' },
  };
}

function readEvents(dir: string, runId: string): { kind: string; data: Record<string, unknown> }[] {
  const raw = readFileSync(path.join(dir, runId, 'events.jsonl'), 'utf8');
  return raw
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { kind: string; data: Record<string, unknown> });
}

function readRawEventsFile(dir: string, runId: string): string {
  return readFileSync(path.join(dir, runId, 'events.jsonl'), 'utf8');
}

describe('scriptedOperator', () => {
  it('clicks Acknowledge and types a note, hands back next_step; actions recorded and evidenced without leaking the typed text', async () => {
    const { dir, runId, fakeSurface, broker } = setup();

    const script = async (ctx: ScriptedOperatorContext): Promise<ScriptedOperatorResult> => {
      expect(ctx.round).toBe(1);
      const obs = await ctx.observe();
      const ack = obs.elements.find((e) => e.name === 'Acknowledge');
      expect(ack).toBeDefined();
      const clickResult = await ctx.act({ type: 'click', target: { ref: ack!.ref } });
      expect(clickResult.ok).toBe(true);

      const obs2 = await ctx.observe();
      const note = obs2.elements.find((e) => e.name === 'Note');
      expect(note).toBeDefined();
      const typeResult = await ctx.act({ type: 'type', target: { ref: note!.ref }, value: 'super secret notes', clear: true });
      expect(typeResult.ok).toBe(true);

      return { resumeFrom: 'next_step', notes: 'acknowledged and filled note' };
    };

    const handle = scriptedOperator({ broker, script });

    const resolution = await broker.escalate(escalationRequest(runId));

    expect(resolution.resumeFrom).toBe('next_step');
    expect(resolution.by).toBe('scripted-operator');
    expect(resolution.humanActions.some((a) => a.type === 'click')).toBe(true);
    const inputAction = resolution.humanActions.find((a) => a.type === 'input');
    expect(inputAction).toBeDefined();
    expect(inputAction?.valueRedacted).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(inputAction ?? {}, 'value')).toBe(false);

    // Same live surface, driven through the guard: the underlying FakeSurface itself moved on.
    expect(fakeSurface.currentScreenId()).toBe('form');

    await handle.idle();
    const events = readEvents(dir, runId);
    const humanActionEvents = events.filter((e) => e.kind === 'human_action');
    expect(humanActionEvents.length).toBeGreaterThanOrEqual(2);
    for (const e of humanActionEvents) {
      expect(e.data.source).toBe('scripted-operator');
    }

    const raw = readRawEventsFile(dir, runId);
    expect(raw).not.toContain('super secret notes');

    handle.stop();
  });

  it('handles reverifyFailed as round 2, hands back again, then resumed() lets automation act', async () => {
    const { runId, fakeSurface, broker } = setup();

    const script = async (ctx: ScriptedOperatorContext): Promise<ScriptedOperatorResult> => {
      if (ctx.round === 1) {
        const obs = await ctx.observe();
        const ack = obs.elements.find((e) => e.name === 'Acknowledge');
        await ctx.act({ type: 'click', target: { ref: ack!.ref } });
        return { resumeFrom: 'next_step', notes: 'round 1 done' };
      }
      expect(ctx.round).toBe(2);
      return { resumeFrom: 'next_step', notes: 'round 2 done' };
    };

    const handle = scriptedOperator({ broker, script });

    const round1 = await broker.escalate(escalationRequest(runId));
    expect(round1.resumeFrom).toBe('next_step');
    expect(fakeSurface.currentScreenId()).toBe('form');

    const interventionId = round1.interventionId;
    broker.reverifyFailed(interventionId, 'still blocked');

    const round2 = await broker.waitForResolution(interventionId);
    expect(round2.resumeFrom).toBe('next_step');
    expect(round2.notes).toContain('round 2');

    broker.resumed(interventionId);
    expect(broker.token.state).toBe('automation');

    const obsAuto = await broker.surface.observe();
    const submit = obsAuto.elements.find((e) => e.name === 'Submit');
    expect(submit).toBeDefined();
    const submitResult = await broker.surface.act({ type: 'click', target: { ref: submit!.ref } }, 1000);
    expect(submitResult.ok).toBe(true);
    expect(fakeSurface.currentScreenId()).toBe('done');

    handle.stop();
  });

  it('aborts once rounds exceed maxRounds, without invoking the script for the extra round', async () => {
    const { runId, broker } = setup();
    const seenRounds: number[] = [];

    const script = async (ctx: ScriptedOperatorContext): Promise<ScriptedOperatorResult> => {
      seenRounds.push(ctx.round);
      return { resumeFrom: 'current_step', notes: `round ${ctx.round}` };
    };

    const handle = scriptedOperator({ broker, script, maxRounds: 2 });

    const r1 = await broker.escalate(escalationRequest(runId));
    expect(r1.resumeFrom).toBe('current_step');
    const interventionId = r1.interventionId;

    broker.reverifyFailed(interventionId, 'nope');
    const r2 = await broker.waitForResolution(interventionId);
    expect(r2.resumeFrom).toBe('current_step');

    broker.reverifyFailed(interventionId, 'nope again');
    const r3 = await broker.waitForResolution(interventionId);
    expect(r3.resumeFrom).toBe('abort');

    const record = broker.interventions.get(interventionId);
    expect(record?.status).toBe('abandoned');
    expect(seenRounds).toEqual([1, 2]);

    handle.stop();
  });

  it('aborts with a "scripted operator failed" note when the script throws', async () => {
    const { runId, broker } = setup();

    const script = async (): Promise<ScriptedOperatorResult> => {
      throw new Error('boom');
    };

    const handle = scriptedOperator({ broker, script });

    const resolution = await broker.escalate(escalationRequest(runId));
    expect(resolution.resumeFrom).toBe('abort');
    expect(resolution.notes).toContain('scripted operator failed');
    expect(resolution.notes).toContain('boom');

    const record = broker.interventions.get(resolution.interventionId);
    expect(record?.status).toBe('abandoned');

    handle.stop();
  });

  it('does not double-record when a real (fake) capture is present: recordActions auto-defaults to false', async () => {
    let emit: ((a: HumanAction) => void) | undefined;
    const fakeCapture: HumanActionCapture = {
      start: async (onAction) => {
        emit = onAction;
      },
      stop: async () => {
        emit = undefined;
      },
    };

    const { runId, broker } = setup({ capture: fakeCapture });

    const script = async (ctx: ScriptedOperatorContext): Promise<ScriptedOperatorResult> => {
      // Simulate the real capture observing a click, exactly as Surface.humanCapture would --
      // independently of anything the scripted operator itself records.
      emit?.({ ts: new Date().toISOString(), type: 'click', frame: [], target: { role: 'button', name: 'Acknowledge' } });

      const obs = await ctx.observe();
      const ack = obs.elements.find((e) => e.name === 'Acknowledge');
      const result = await ctx.act({ type: 'click', target: { ref: ack!.ref } }); // must NOT be separately recorded
      expect(result.ok).toBe(true);

      return { resumeFrom: 'next_step' };
    };

    const handle = scriptedOperator({ broker, script });

    const resolution = await broker.escalate(escalationRequest(runId));

    expect(resolution.humanActions.length).toBe(1);
    expect(resolution.humanActions[0]?.type).toBe('click');

    handle.stop();
  });

  it('stop() unsubscribes: a later escalation is left unhandled', async () => {
    const { runId, broker } = setup();

    const script = async (ctx: ScriptedOperatorContext): Promise<ScriptedOperatorResult> => {
      await ctx.observe();
      return { resumeFrom: 'next_step' };
    };

    const handle = scriptedOperator({ broker, script });
    handle.stop();

    let settled = false;
    const escalatePromise = broker.escalate(escalationRequest(runId));
    void escalatePromise.then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    expect(broker.token.state).toBe('paused');
    expect(handle.handled()).toEqual([]);

    // Clean up the still-open intervention directly (not via the operator, which is stopped).
    const interventionId = broker.token.interventionId;
    expect(interventionId).toBeDefined();
    await broker.abort(interventionId!, 'test-cleanup');
  });
});
