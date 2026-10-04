import { afterEach, describe, expect, it } from 'vitest';
import {
  escalateSample,
  FAKE_PNG,
  makeBrokerFixture,
  nextInterventionId,
  sampleAction,
  type BrokerFixture,
  type BrokerFixtureOptions,
} from '../../test/support/fixtures.js';
import { createRunRedactor } from '../../test/support/core-testing.js';
import { createSessionRegistry, fromSessionBroker, type RelaySessionRegistry } from './broker-adapter.js';
import type { PortChange } from './ports.js';
import { PortConflictError, PortNotFoundError } from './ports.js';

const fixtures: BrokerFixture[] = [];
const registries: RelaySessionRegistry[] = [];

function fixture(opts?: BrokerFixtureOptions): BrokerFixture {
  const f = makeBrokerFixture(opts);
  fixtures.push(f);
  return f;
}

function registry(...args: Parameters<typeof createSessionRegistry>): RelaySessionRegistry {
  const r = createSessionRegistry(...args);
  registries.push(r);
  return r;
}

afterEach(() => {
  for (const r of registries.splice(0)) r.dispose();
  for (const f of fixtures.splice(0)) f.dispose();
});

/** Waits a couple of real ticks so every already-queued microtask (in particular this adapter's
 *  deferred `publish`) has had a chance to run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function collect(reg: RelaySessionRegistry): { changes: PortChange[]; stop: () => void } {
  const changes: PortChange[] = [];
  const off = reg.subscribe((c) => changes.push(c));
  return { changes, stop: off };
}

describe('fromSessionBroker / createSessionRegistry', () => {
  it('maps a fresh escalation to an InterventionDto with context and hasScreenshot, before resolution', async () => {
    const { broker } = fixture();
    const reg = fromSessionBroker(broker);
    const { id } = await escalateSample(broker);

    const dto = reg.getIntervention(id);
    expect(dto).toBeDefined();
    expect(dto?.status).toBe('open');
    expect(dto?.hasScreenshot).toBe(true);
    expect(dto?.context).toEqual({
      expected: 'Member profile page for member 90001 (Profile tab, savings and checking balances).',
      observed: 'Access Denied: your role does not permit viewing this member.',
    });
    expect(dto?.captureMode).toBe('none');
    expect(dto?.humanActions).toEqual([]);
    expect(dto?.timeline).toHaveLength(1);
    expect(dto?.timeline[0]).toMatchObject({ from: 'automation', to: 'paused', by: 'automation' });
    expect(dto?.lease).toBeUndefined(); // not human_active yet
    expect(dto?.resolution).toBeUndefined();

    await reg.abort(id, 'test-operator');
  });

  it('subscribe() delivers a deferred "created" PortChange whose intervention view already carries context (the store-notifies-before-siderecord race)', async () => {
    const { broker } = fixture();
    const reg = fromSessionBroker(broker);
    const { changes } = collect(reg);

    const { id } = await escalateSample(broker);
    await flush();

    const created = changes.find((c) => c.type === 'intervention' && c.change === 'created');
    expect(created).toBeDefined();
    const dto = reg.getIntervention(id);
    expect(dto?.context).toBeDefined();

    await reg.abort(id, 'test-operator');
  });

  it('publishes a "control" change on take, with heldBy/lease/timeline updated', async () => {
    const { broker } = fixture();
    const reg = fromSessionBroker(broker, { leaseMs: 60_000 });
    const { changes } = collect(reg);

    const { id } = await escalateSample(broker);
    changes.length = 0;

    const dto = await reg.take(id, 'alice');
    expect(dto.status).toBe('human_active');
    expect(dto.heldBy).toBe('alice');
    expect(dto.lease).toBeDefined();
    expect(dto.lease?.ms).toBe(60_000);
    expect(dto.timeline).toHaveLength(2);
    expect(dto.timeline[1]).toMatchObject({ from: 'paused', to: 'human', by: 'alice' });

    await flush();
    const control = changes.find((c) => c.type === 'control');
    expect(control).toMatchObject({ type: 'control', from: 'paused', to: 'human', by: 'alice', interventionId: id });

    await reg.abort(id, 'alice');
  });

  it('heldBy is cleared once control leaves human (handback), and lease is no longer present', async () => {
    const { broker } = fixture();
    const reg = fromSessionBroker(broker);
    const { id } = await escalateSample(broker);
    await reg.take(id, 'alice');

    const result = await reg.handBack(id, { by: 'alice', resumeFrom: 'next_step', notes: 'done' });
    expect(result.resumeFrom).toBe('next_step');
    expect(result.notes).toBe('done');
    expect(result.by).toBe('alice');

    const dto = reg.getIntervention(id);
    expect(dto?.status).toBe('resolved');
    expect(dto?.heldBy).toBeUndefined();
    expect(dto?.lease).toBeUndefined();
    expect(dto?.resolution).toEqual({ by: 'alice', at: expect.any(String), notes: 'done', resumeFrom: 'next_step' });
    expect(dto?.resolution).not.toHaveProperty('humanActions');

    broker.resumed(id);
  });

  it('handBack resolves the original escalate() promise with the same resumeFrom/notes', async () => {
    const { broker } = fixture();
    const reg = fromSessionBroker(broker);
    const { id, resolution } = await escalateSample(broker);
    await reg.take(id, 'alice');

    await reg.handBack(id, { by: 'alice', resumeFrom: 'current_step', notes: 'retry please' });
    const awaited = await resolution;
    expect(awaited.resumeFrom).toBe('current_step');
    expect(awaited.notes).toBe('retry please');
    broker.resumed(id);
  });

  it('abort resolves the escalate() promise with resumeFrom "abort"', async () => {
    const { broker } = fixture();
    const reg = fromSessionBroker(broker);
    const { id, resolution } = await escalateSample(broker);

    const result = await reg.abort(id, 'bob', 'giving up');
    expect(result.resumeFrom).toBe('abort');
    const awaited = await resolution;
    expect(awaited.resumeFrom).toBe('abort');
    expect(awaited.by).toBe('bob');
  });

  it('heartbeat renews the lease (anchorAt moves) and publishes a "heartbeat" change', async () => {
    const { broker } = fixture();
    const reg = fromSessionBroker(broker, { leaseMs: 100_000 });
    const { changes } = collect(reg);
    const { id } = await escalateSample(broker);
    await reg.take(id, 'alice');
    const before = reg.getIntervention(id)?.lease?.anchorAt;
    changes.length = 0;

    await new Promise((r) => setTimeout(r, 5));
    const { at, intervention } = reg.heartbeat(id);
    expect(intervention.lease?.anchorAt).toBe(at);
    expect(intervention.lease?.anchorAt).not.toBe(before);

    await flush();
    const hb = changes.find((c) => c.type === 'heartbeat');
    expect(hb).toMatchObject({ type: 'heartbeat', interventionId: id, at });

    await reg.abort(id, 'alice');
  });

  it('heartbeat is a PortConflictError (409-mappable) when the intervention is not currently human', async () => {
    const { broker } = fixture();
    const reg = fromSessionBroker(broker);
    const { id } = await escalateSample(broker);

    expect(() => reg.heartbeat(id)).toThrow(PortConflictError);
    try {
      reg.heartbeat(id);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PortConflictError);
      expect((err as PortConflictError).state).toBe('paused');
    }

    await reg.abort(id, 'alice');
  });

  it('take/handBack/abort/heartbeat on an unknown id throw PortNotFoundError', async () => {
    const { broker } = fixture();
    const reg = fromSessionBroker(broker);
    await expect(reg.take('nope', 'alice')).rejects.toBeInstanceOf(PortNotFoundError);
    await expect(reg.handBack('nope', { by: 'alice', resumeFrom: 'current_step' })).rejects.toBeInstanceOf(PortNotFoundError);
    await expect(reg.abort('nope', 'alice')).rejects.toBeInstanceOf(PortNotFoundError);
    expect(() => reg.heartbeat('nope')).toThrow(PortNotFoundError);
    await expect(reg.liveScreenshot('nope')).rejects.toBeInstanceOf(PortNotFoundError);
  });

  it('take twice maps IllegalControlTransitionError to PortConflictError with the state', async () => {
    const { broker } = fixture();
    const reg = fromSessionBroker(broker);
    const { id } = await escalateSample(broker);
    await reg.take(id, 'alice');
    try {
      await reg.take(id, 'bob');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PortConflictError);
      expect((err as PortConflictError).operation).toBe('takeControl');
      expect((err as PortConflictError).state).toBe('human');
    }
    await reg.abort(id, 'alice');
  });

  it('publishes an "actions" change for a captured action via onHumanAction, with no timer involved', async () => {
    const { broker, capture } = fixture();
    const reg = fromSessionBroker(broker);
    const { changes } = collect(reg);
    const { id } = await escalateSample(broker);
    await reg.take(id, 'alice');
    changes.length = 0;

    capture.emit(sampleAction({ type: 'click' }));
    await flush();

    const actionsChange = changes.find((c) => c.type === 'intervention' && c.change === 'actions');
    expect(actionsChange).toMatchObject({ type: 'intervention', change: 'actions', interventionId: id, runId: broker.runId });
    expect(reg.getIntervention(id)?.humanActions).toHaveLength(1);

    await reg.handBack(id, { by: 'alice', resumeFrom: 'current_step' });
    broker.resumed(id);
  });

  it('unregister stops publishing captured-action changes for that run', async () => {
    const { broker, capture } = fixture();
    const reg = registry([broker]);
    const { changes } = collect(reg);
    const { id } = await escalateSample(broker);
    await reg.take(id, 'alice');
    await flush();
    changes.length = 0;

    reg.unregister(broker.runId);
    capture.emit(sampleAction({ type: 'click' }));
    await flush();

    expect(changes.some((c) => c.type === 'intervention' && c.change === 'actions')).toBe(false);

    // Drives the broker directly, since the registry no longer knows about it; capture must
    // still be running independently of the (now unregistered) adapter.
    await broker.handBack(id, { by: 'alice', resumeFrom: 'current_step' });
    broker.resumed(id);
  });

  it('lease defaults to broker.leaseMs when no leaseMs option is given anywhere', async () => {
    const { broker } = fixture({ interventionLeaseMs: 12_345 });
    const reg = fromSessionBroker(broker);
    expect(reg.runs()[0]?.leaseMs).toBe(12_345);

    const { id } = await escalateSample(broker);
    await reg.take(id, 'alice');
    expect(reg.getIntervention(id)?.lease?.ms).toBe(12_345);

    await reg.abort(id, 'alice');
  });

  it('register-level leaseMs overrides the registry-level default, which overrides broker.leaseMs', async () => {
    const a = fixture({ interventionLeaseMs: 12_345 });
    const b = fixture({ interventionLeaseMs: 12_345 });
    const reg = registry([], { leaseMs: 60_000 });
    reg.register(a.broker); // no override here: falls back to the registry-level default (60000), not broker.leaseMs (12345)
    reg.register(b.broker, { leaseMs: 5_000 }); // register-level override beats both

    expect(reg.controlToken(a.broker.runId)?.leaseMs).toBe(60_000);
    expect(reg.controlToken(b.broker.runId)?.leaseMs).toBe(5_000);
  });

  it('escalationScreenshot returns the PNG bytes, and undefined for an unknown id or a missing file', async () => {
    const { broker } = fixture();
    const reg = fromSessionBroker(broker);
    const { id } = await escalateSample(broker);

    const png = await reg.escalationScreenshot(id);
    expect(png).toBeDefined();
    expect(Buffer.from(png as Uint8Array).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    expect(await reg.escalationScreenshot('does-not-exist')).toBeUndefined();
    await reg.abort(id, 'alice'); // ends this broker's run entirely (abort is run-terminal); the rest needs a fresh broker

    const other = fixture();
    const otherReg = fromSessionBroker(other.broker);
    const noShot = await escalateSample(other.broker, { screenshotPng: undefined, currentUrl: 'http://cu-core.local/x' });
    // FakeSurface may or may not answer surface.screenshot(); either way, the DTO's own
    // hasScreenshot flag must agree with whether escalationScreenshot() can produce bytes.
    const dto = otherReg.getIntervention(noShot.id);
    const shot = await otherReg.escalationScreenshot(noShot.id);
    expect(dto?.hasScreenshot).toBe(shot !== undefined);

    await otherReg.abort(noShot.id, 'alice'); // clean up the still-pending escalate so nothing dangles past the test
  });

  it('liveScreenshot proxies to the broker for a known run and rejects PortNotFoundError for an unknown one', async () => {
    const { broker } = fixture();
    const reg = fromSessionBroker(broker);
    const png = await reg.liveScreenshot(broker.runId);
    expect(Buffer.from(png).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await expect(reg.liveScreenshot('unknown-run')).rejects.toBeInstanceOf(PortNotFoundError);
  });

  it('runs() / controlToken() report state, holder, capabilityId/goal from the newest intervention, and leaseMs', async () => {
    const { broker } = fixture();
    const reg = fromSessionBroker(broker, { leaseMs: 12_345 });
    expect(reg.runs()).toHaveLength(1);
    expect(reg.controlToken(broker.runId)).toMatchObject({ runId: broker.runId, state: 'automation', holder: 'automation', leaseMs: 12_345 });

    const { id } = await escalateSample(broker, { capabilityId: 'lookup-member-savings-balance' });
    const run = reg.controlToken(broker.runId);
    expect(run?.state).toBe('paused');
    expect(run?.interventionId).toBe(id);
    expect(run?.capabilityId).toBe('lookup-member-savings-balance');

    expect(reg.controlToken('unknown-run')).toBeUndefined();
    await reg.abort(id, 'alice');
  });

  it('listInterventions sorts newest first (across brokers) and filters by status', async () => {
    // A broker only ever has one live intervention at a time (escalate() requires state
    // 'automation', and abort() ends the whole run), so two OPEN interventions at once means two
    // brokers -- exactly the multi-run scenario listInterventions is for.
    const a = fixture();
    const b = fixture();
    const reg = registry([a.broker, b.broker]);
    const first = await escalateSample(a.broker);
    await reg.abort(first.id, 'alice');
    // createdAt has millisecond resolution: on a fast machine both escalations can land in the same
    // millisecond, which makes "newest first" a tie. Wait for the clock to pass the first one.
    const firstAt = Date.parse(reg.listInterventions()[0]!.createdAt);
    while (Date.now() <= firstAt) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = await escalateSample(b.broker);

    const all = reg.listInterventions();
    expect(all.map((i) => i.id)).toEqual([second.id, first.id]);

    const open = reg.listInterventions({ status: 'open' });
    expect(open.map((i) => i.id)).toEqual([second.id]);
    const abandoned = reg.listInterventions({ status: 'abandoned' });
    expect(abandoned.map((i) => i.id)).toEqual([first.id]);

    await reg.abort(second.id, 'alice');
  });

  it('two brokers registered on one registry are routed independently', async () => {
    const a = fixture();
    const b = fixture();
    const reg = registry([a.broker, b.broker]);

    const escA = await escalateSample(a.broker);
    const escB = await escalateSample(b.broker);

    expect(reg.getIntervention(escA.id)?.runId).toBe(a.broker.runId);
    expect(reg.getIntervention(escB.id)?.runId).toBe(b.broker.runId);
    expect(reg.runs()).toHaveLength(2);
    expect(reg.listInterventions()).toHaveLength(2);

    await reg.take(escA.id, 'alice');
    expect(reg.controlToken(a.broker.runId)?.state).toBe('human');
    expect(reg.controlToken(b.broker.runId)?.state).toBe('paused');

    await reg.abort(escA.id, 'alice');
    await reg.abort(escB.id, 'alice');
  });

  it('seeds a synthetic timeline entry for an intervention that existed before registration', async () => {
    const { broker } = fixture();
    // Escalate BEFORE the adapter ever subscribes, simulating a broker that already had open work
    // when Relay attached to it.
    const idPromise = nextInterventionId(broker);
    const resolution = broker.escalate({
      runId: broker.runId,
      runKind: 'replay',
      reason: { code: 'stuck', message: 'pre-existing' },
      // Explicit, so escalate() never awaits surface.screenshot()/currentUrl() internally: keeps
      // its whole synchronous body (including releasing the transition lock) in one tick.
      screenshotPng: FAKE_PNG,
      currentUrl: 'http://cu-core.local/members/90001',
    });
    const id = await idPromise;
    await flush(); // let escalate()'s transition lock release before this test drives another transition

    const reg = fromSessionBroker(broker);
    const dto = reg.getIntervention(id);
    expect(dto?.timeline).toHaveLength(1);
    expect(dto?.timeline[0]).toMatchObject({ from: 'automation', to: 'paused', by: 'automation' });

    await reg.abort(id, 'alice');
    await resolution;
  });

  it('unregister stops forwarding events for that run and drops it from runs()/listInterventions()', async () => {
    const { broker } = fixture();
    const reg = registry([broker]);
    const { changes } = collect(reg);
    const { id } = await escalateSample(broker);
    await flush();
    changes.length = 0;

    reg.unregister(broker.runId);
    expect(reg.runs()).toHaveLength(0);
    expect(reg.getIntervention(id)).toBeUndefined();

    await broker.abort(id, 'alice'); // drives the broker directly since the registry no longer knows it
    await flush();
    expect(changes).toHaveLength(0);
  });

  it('dispose() unsubscribes everything (idempotent)', async () => {
    const { broker, capture } = fixture();
    const reg = fromSessionBroker(broker);
    const { id } = await escalateSample(broker);
    await reg.take(id, 'alice');

    reg.dispose();
    reg.dispose(); // idempotent

    capture.emit(sampleAction());
    await flush();
    // No crash, and listInterventions() on the disposed registry reports nothing (unregistered).
    expect(reg.listInterventions()).toHaveLength(0);

    await broker.handBack(id, { by: 'alice', resumeFrom: 'current_step' });
    broker.resumed(id);
  });

  it('a throwing subscriber does not break a transition or other subscribers', async () => {
    const { broker } = fixture();
    const reg = fromSessionBroker(broker);
    reg.subscribe(() => {
      throw new Error('boom');
    });
    const { changes } = collect(reg);

    const { id } = await escalateSample(broker);
    await reg.take(id, 'alice'); // must not throw despite the bad listener above
    await flush();
    expect(changes.length).toBeGreaterThan(0);

    await reg.abort(id, 'alice');
  });
});

describe('register(broker, { redact }): a per-run redactor', () => {
  it('redacts DTO content (reason, context, resolution notes) but never the ids, status or lease the UI relies on', async () => {
    const { broker } = fixture();
    const { id, resolution } = await escalateSample(broker, {
      reason: { code: 'unrecoverable_condition', message: 'member MBR-1234 is locked' },
      context: { observed: 'MBR-1234 locked' },
    });
    // Deliberately hostile: also rewrites any string containing the run or intervention id.
    const redact = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value).split(id).join('[ID]').split(broker.runId).join('[RUN]').replace(/MBR-[0-9]{4}/g, '[REDACTED:member]'));
    const reg = registry();
    reg.register(broker, { redact });

    const dto = reg.getIntervention(id);
    expect(dto?.id).toBe(id);
    expect(dto?.runId).toBe(broker.runId);
    expect(dto?.status).toBe('open');
    expect(dto?.reason.message).toBe('member [REDACTED:member] is locked');
    expect(dto?.context).toEqual({ observed: '[REDACTED:member] locked' });
    expect(reg.listInterventions()[0]?.reason.message).toBe('member [REDACTED:member] is locked');
    expect(reg.runs()[0]?.runId).toBe(broker.runId);

    const taken = await reg.take(id, 'alice');
    expect(taken.id).toBe(id);
    expect(taken.lease).toBeDefined();
    const result = await reg.handBack(id, { by: 'alice', resumeFrom: 'next_step', notes: 'unlocked MBR-1234' });
    expect(result.interventionId).toBe(id);
    expect(result.notes).toBe('unlocked [REDACTED:member]');
    await resolution;
  });

  it('with the run redactor, a value that also occurs in the holder, ids and timestamps leaves them intact', async () => {
    const { broker } = fixture();
    const year = new Date().toISOString().slice(0, 4);
    const { id, resolution } = await escalateSample(broker);
    const reg = registry();
    reg.register(broker, { redact: createRunRedactor({ values: () => ['alice', 'member', year] }) });

    const open = reg.getIntervention(id);
    expect(open?.capabilityId).toBe('lookup-member-savings-balance');
    expect(open?.stepId).toBe('open-member');
    expect(open?.currentUrl).toBe('http://cu-core.local/[REDACTED]s/90001');
    expect(reg.runs()[0]?.capabilityId).toBe('lookup-member-savings-balance');

    const taken = await reg.take(id, 'alice');
    expect(taken.heldBy).toBe('alice');
    expect(reg.getIntervention(id)?.heldBy).toBe('alice');
    const ts = new Date().toISOString();
    broker.recordHumanAction(id, sampleAction({ ts, target: { tag: 'button', name: 'alice member' } }), 'scripted-operator');
    const withAction = reg.getIntervention(id);
    expect(withAction?.humanActions[0]?.ts).toBe(ts);
    expect(withAction?.humanActions[0]?.target.name).toBe('[REDACTED] [REDACTED]');

    await reg.handBack(id, { by: 'alice', resumeFrom: 'next_step', notes: 'alice fixed the member' });
    const done = reg.getIntervention(id);
    expect(done?.resolution?.by).toBe('alice');
    expect(done?.resolution?.at).toBe(broker.interventions.get(id)?.resolution?.at);
    expect(done?.resolution?.notes).toBe('[REDACTED] fixed the [REDACTED]');
    expect(done?.createdAt).toBe(broker.interventions.get(id)?.createdAt);
    await resolution;
  });

  it('a run registered without one is passed through unchanged', async () => {
    const { broker } = fixture();
    const { id } = await escalateSample(broker, { reason: { code: 'unrecoverable_condition', message: 'member MBR-1234 is locked' } });
    const reg = registry([broker]);
    expect(reg.getIntervention(id)?.reason.message).toBe('member MBR-1234 is locked');
    await broker.abort(id, 'alice');
  });
});
