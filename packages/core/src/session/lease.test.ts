/**
 * The intervention lease (see docs/design/handoff.md): a `human` round needs a heartbeat within
 * `interventionLeaseMs` or it reopens as `paused`; a `paused` (open) intervention aborts if nobody
 * takes control within another lease window. Driven here with an injected `clock` plus a manual
 * `LeaseTimerHooks` scheduler (packages/core/src/session/broker-api.ts) instead of real wall-clock time or
 * vitest's global fake timers, so a test controls exactly when the checker "ticks" without
 * touching unrelated `setTimeout`-based code elsewhere in the broker (e.g. `waitForQuiesce`).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunLogger, newRunId } from '../evidence/index.js';
import { el, FakeSurface, scenario, type FakeScenario } from '../surface/index.js';
import { createSessionBroker } from './broker.js';
import type { LeaseTimerHooks, SessionBroker } from './broker-api.js';
import { scriptedOperator, type ScriptedOperatorContext, type ScriptedOperatorResult } from './scripted-operator.js';
import type { EscalationRequest } from './types.js';

function buildScenario(): FakeScenario {
  return scenario()
    .screen('blocked', {
      url: 'http://x.test/blocked',
      title: 'Blocked',
      elements: [el({ id: 'ack', role: 'button', name: 'Acknowledge', tag: 'button', bbox: { x: 0, y: 0, w: 100, h: 24 } })],
    })
    .on('click', { targetId: 'ack' })
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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'session-lease-'));
  tmpDirs.push(dir);
  return dir;
}

const liveBrokers: SessionBroker[] = [];

afterEach(() => {
  while (liveBrokers.length > 0) liveBrokers.pop()!.dispose();
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** A clock the test moves forward on demand, plus a manual "interval" the test fires by calling
 *  `tick()`. Decouples the lease checker entirely from real wall-clock time and from vitest's
 *  global fake timers (which would also affect `waitForQuiesce`'s `setTimeout`-based polling). */
function makeFakeClockAndTimer(startMs = Date.parse('2026-01-01T00:00:00.000Z')) {
  let nowMs = startMs;
  let cb: (() => void | Promise<void>) | undefined;
  const hooks: LeaseTimerHooks = {
    setInterval: (fn) => {
      cb = fn;
      return 'fake-lease-timer';
    },
    clearInterval: () => {
      cb = undefined;
    },
  };
  return {
    clock: (): Date => new Date(nowMs),
    advance(ms: number): void {
      nowMs += ms;
    },
    async tick(): Promise<void> {
      await cb?.();
    },
    hooks,
  };
}

function setup(opts: { interventionLeaseMs?: number } = {}) {
  const dir = makeTmpDir();
  const runId = newRunId();
  const fakeSurface = new FakeSurface(buildScenario());
  const logger = createRunLogger({ runId, runKind: 'replay', rootDir: dir });
  const timer = makeFakeClockAndTimer();
  const broker = createSessionBroker({
    surface: fakeSurface,
    logger,
    runId,
    runKind: 'replay',
    clock: timer.clock,
    leaseTimerHooks: timer.hooks,
    interventionLeaseMs: opts.interventionLeaseMs ?? 1000,
  });
  liveBrokers.push(broker);
  return { dir, runId, fakeSurface, logger, broker, timer };
}

function escalationRequest(runId: string): EscalationRequest {
  return {
    runId,
    runKind: 'replay',
    capabilityId: 'test-cap',
    stepId: 's1',
    reason: { code: 'unrecoverable_condition', message: 'automation is blocked' },
  };
}

/** Resolves with the id of the first intervention `store.create` notifies about, then unsubscribes
 *  (mirrors the same helper in broker.test.ts / control.redteam.test.ts). */
async function escalateAndGetId(broker: SessionBroker, runId: string) {
  let resolveId!: (id: string) => void;
  const idPromise = new Promise<string>((res) => {
    resolveId = res;
  });
  const unsubscribe = broker.interventions.subscribe((i, change) => {
    if (change === 'created') resolveId(i.id);
  });
  const resolutionPromise = broker.escalate(escalationRequest(runId));
  const id = await idPromise;
  unsubscribe();
  return { id, resolutionPromise };
}

function readEvents(dir: string, runId: string): { kind: string; data: Record<string, unknown> }[] {
  const raw = readFileSync(path.join(dir, runId, 'events.jsonl'), 'utf8');
  return raw
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { kind: string; data: Record<string, unknown> });
}

describe('human lease expiry (no heartbeat)', () => {
  it('a `human` round with no heartbeat past interventionLeaseMs reopens as paused, with a control_transfer event and a note carrying the elapsed ms', async () => {
    const { dir, runId, broker, timer } = setup({ interventionLeaseMs: 1000 });
    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    await broker.takeControl(id, 'alice');
    expect(broker.token.state).toBe('human');

    timer.advance(1500); // > interventionLeaseMs since takeControl (no heartbeat was ever sent)
    await timer.tick();

    expect(broker.token).toEqual({ state: 'paused', holder: 'none', interventionId: id });
    const record = broker.interventions.get(id);
    expect(record?.status).toBe('open');

    const transfers = readEvents(dir, runId).filter((e) => e.kind === 'control_transfer');
    const last = transfers[transfers.length - 1]!;
    expect(last.data).toMatchObject({ from: 'human', to: 'paused', interventionId: id, by: 'lease-checker' });
    expect(String(last.data.reason)).toBe('[lease expired: no operator heartbeat for 1500 ms]');

    const view = broker.view(id);
    expect(view.leaseExpiredNote).toBe('[lease expired: no operator heartbeat for 1500 ms]');

    // Clean up: abort the reopened, still-pending escalation.
    await broker.abort(id, 'test-cleanup');
    await resolutionPromise;
  });

  it('appends the lease-expired note onto the previous round\'s resolution.notes when this is not the first round', async () => {
    const { runId, broker, timer } = setup({ interventionLeaseMs: 1000 });
    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    await broker.takeControl(id, 'alice');
    const round1 = await broker.handBack(id, { resumeFrom: 'next_step', notes: 'round1 notes', by: 'alice' });
    void round1;
    broker.reverifyFailed(id, 'still blocked', 'automation');

    await broker.takeControl(id, 'bob'); // round 2, never hands back
    timer.advance(1500);
    await timer.tick();

    const record = broker.interventions.get(id);
    expect(record?.status).toBe('open');
    expect(record?.resolution?.notes).toContain('round1 notes');
    expect(record?.resolution?.notes).toContain('[lease expired: no operator heartbeat for 1500 ms]');

    await broker.abort(id, 'test-cleanup');
    await resolutionPromise;
  });
});

describe('paused-unattended abort (nobody takes control)', () => {
  it('a paused (open) intervention with no take within interventionLeaseMs is aborted through the same path as a human abort', async () => {
    const { runId, broker, timer } = setup({ interventionLeaseMs: 1000 });
    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);

    timer.advance(1500);
    await timer.tick();

    const resolution = await resolutionPromise;
    expect(resolution.resumeFrom).toBe('abort');
    expect(resolution.by).toBe('lease-checker');
    expect(resolution.notes).toBe('[unattended: no operator took control within 1500 ms]');
    expect(broker.terminated).toBe(true);

    const record = broker.interventions.get(id);
    expect(record?.status).toBe('abandoned');
    expect(record?.resolution?.resumeFrom).toBe('abort');
  });

  it('a paused intervention reopened by a lease expiry is itself aborted if nobody takes control within another lease window', async () => {
    const { runId, broker, timer } = setup({ interventionLeaseMs: 1000 });
    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    await broker.takeControl(id, 'alice');

    timer.advance(1500); // human lease expires -> back to paused
    await timer.tick();
    expect(broker.token.state).toBe('paused');

    timer.advance(1500); // and now nobody re-takes control within another lease window
    await timer.tick();

    const resolution = await resolutionPromise;
    expect(resolution.resumeFrom).toBe('abort');
    const record = broker.interventions.get(id);
    expect(record?.status).toBe('abandoned');
  });
});

describe('heartbeats keep the lease alive', () => {
  it('a heartbeat resets the human-lease anchor so the round survives past the original deadline', async () => {
    const { runId, broker, timer } = setup({ interventionLeaseMs: 1000 });
    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    await broker.takeControl(id, 'alice');

    timer.advance(700);
    broker.recordHeartbeat(id);
    const view1 = broker.view(id);
    expect(view1.lastHeartbeatAt).toBeDefined();

    timer.advance(700); // 1400ms since takeControl, but only 700ms since the heartbeat
    await timer.tick();

    expect(broker.token.state).toBe('human'); // still human: the heartbeat kept the lease alive

    await broker.handBack(id, { resumeFrom: 'next_step', by: 'alice' });
    broker.resumed(id);
    await expect(resolutionPromise).resolves.toMatchObject({ resumeFrom: 'next_step' });
  });

  it('recordHeartbeat rejects when the intervention is not currently human (state check, same shape as other broker transitions)', async () => {
    const { runId, broker } = setup();
    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    expect(() => broker.recordHeartbeat(id)).toThrow(/heartbeat requires state 'human'/);

    await broker.abort(id, 'test-cleanup');
    await resolutionPromise;
  });
});

describe('scripted-operator exemption', () => {
  it('never expires a human round held by a scripted operator, even with a lease shorter than the script takes', async () => {
    const { runId, broker, timer, fakeSurface } = setup({ interventionLeaseMs: 50 });

    const script = async (ctx: ScriptedOperatorContext): Promise<ScriptedOperatorResult> => {
      const obs = await ctx.observe();
      const ack = obs.elements.find((e) => e.name === 'Acknowledge')!;
      const result = await ctx.act({ type: 'click', target: { ref: ack.ref } });
      expect(result.ok).toBe(true);

      // The checker fires well past interventionLeaseMs while this round is still open, with no
      // heartbeat ever sent (a scripted operator never calls the heartbeat endpoint).
      timer.advance(1000);
      await timer.tick();

      return { resumeFrom: 'next_step', notes: 'scripted done' };
    };
    const handle = scriptedOperator({ broker, script });

    const resolution = await broker.escalate(escalationRequest(runId));
    expect(resolution.resumeFrom).toBe('next_step');
    expect(fakeSurface.currentScreenId()).toBe('done');

    handle.stop();
  });

  it('a scripted round is not exempt from being resumed normally afterward: the next real human round IS still subject to the lease', async () => {
    const { runId, broker, timer, fakeSurface } = setup({ interventionLeaseMs: 1000 });

    const script = async (ctx: ScriptedOperatorContext): Promise<ScriptedOperatorResult> => {
      const obs = await ctx.observe();
      const ack = obs.elements.find((e) => e.name === 'Acknowledge')!;
      await ctx.act({ type: 'click', target: { ref: ack.ref } });
      return { resumeFrom: 'next_step' };
    };
    const handle = scriptedOperator({ broker, script });
    const round1 = await broker.escalate(escalationRequest(runId));
    expect(round1.resumeFrom).toBe('next_step');
    broker.resumed(round1.interventionId); // caller's job after a hand-back; see docs/design/handoff.md
    handle.stop(); // a real human takes over from here

    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    await broker.takeControl(id, 'carol'); // a REAL operator this time, no `scripted` marker
    timer.advance(1500);
    await timer.tick();

    expect(broker.token).toEqual({ state: 'paused', holder: 'none', interventionId: id });

    await broker.abort(id, 'test-cleanup');
    await resolutionPromise;
    void fakeSurface;
  });
});

describe('default interventionLeaseMs', () => {
  it('defaults to 900000ms (15 minutes) when not given', async () => {
    const dir = makeTmpDir();
    const runId = newRunId();
    const fakeSurface = new FakeSurface(buildScenario());
    const logger = createRunLogger({ runId, runKind: 'replay', rootDir: dir });
    const timer = makeFakeClockAndTimer();
    const broker = createSessionBroker({ surface: fakeSurface, logger, runId, runKind: 'replay', clock: timer.clock, leaseTimerHooks: timer.hooks });
    liveBrokers.push(broker);

    const { id, resolutionPromise } = await escalateAndGetId(broker, runId);
    await broker.takeControl(id, 'alice');

    timer.advance(900_000 - 1);
    await timer.tick();
    expect(broker.token.state).toBe('human'); // not yet expired

    timer.advance(2);
    await timer.tick();
    expect(broker.token.state).toBe('paused'); // now expired

    await broker.abort(id, 'test-cleanup');
    await resolutionPromise;
  });
});
