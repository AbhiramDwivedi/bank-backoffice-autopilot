/**
 * The replay engine's observational `beforeStep` hook: called once per step, before the step acts
 * (after recoveries and the precondition), with a read-only `check` that binds placeholders the
 * way replay does. It must never change the run: a throw is swallowed, and a run with a hook
 * produces the same result as one without.
 */
import { describe, expect, it } from 'vitest';
import { capabilityDigest, type Condition, type Step } from '../schema/index.js';
import { loadExample, runReplay } from './test-helpers.js';
import type { BeforeStepInfo } from './types.js';

describe('replay beforeStep hook', () => {
  it('is called once per step, in order, before the step acts', async () => {
    const seen: string[] = [];
    const { result } = await runReplay({
      beforeStep: (info: BeforeStepInfo) => {
        seen.push(info.step.id);
      },
    });
    expect(result.kind).toBe('success');
    expect(seen).toEqual(loadExample().steps.map((s) => s.id));
  });

  it('check() sees the page as it is BEFORE the step acts', async () => {
    const cap = loadExample();
    // The login page shows "Password:" before anything is typed; after sign-on it is gone.
    const label: Condition = { kind: 'text_visible', text: 'Password:' };
    const observed: Record<string, boolean> = {};
    const { result } = await runReplay({
      capability: cap,
      beforeStep: async ({ step, check }) => {
        observed[step.id] = await check(label);
      },
    });
    expect(result.kind).toBe('success');
    const ids = cap.steps.map((s) => s.id);
    // The second step (on the login page) sees the label before acting.
    expect(observed[ids[1]!]).toBe(true);
    // The last step (on the member page) does not.
    expect(observed[ids[ids.length - 1]!]).toBe(false);
  });

  it('binds {input.x} placeholders with the run inputs before checking, and an unbindable condition is false', async () => {
    const results: boolean[] = [];
    const cap = loadExample();
    const lastId = cap.steps[cap.steps.length - 1]!.id;
    const { result } = await runReplay({
      capability: cap,
      inputs: { memberId: '12345' },
      beforeStep: async ({ step, check }) => {
        if (step.id !== lastId) return;
        results.push(await check({ kind: 'url_matches', pattern: '/members/{input.memberId}', frame: [{ name: 'main' }] }));
        results.push(await check({ kind: 'url_matches', pattern: '/members/{input.nope}', frame: [{ name: 'main' }] }));
      },
    });
    expect(result.kind).toBe('success');
    expect(results).toEqual([true, false]);
  });

  it('logs each check as an observe checkpoint event', async () => {
    const { events } = await runReplay({
      beforeStep: async ({ check }) => {
        await check({ kind: 'text_visible', text: 'Password:' });
      },
    });
    const observes = events.filter((e) => e.kind === 'checkpoint' && (e.data as { phase?: string }).phase === 'observe');
    expect(observes.length).toBe(loadExample().steps.length);
  });

  it('a hook that throws never changes the run', async () => {
    const plain = await runReplay({});
    const hooked = await runReplay({
      beforeStep: () => {
        throw new Error('observer bug');
      },
    });
    expect(hooked.result.kind).toBe(plain.result.kind);
    if (hooked.result.kind === 'success' && plain.result.kind === 'success') {
      expect(hooked.result.outputs).toEqual(plain.result.outputs);
      expect(hooked.result.stepsExecuted).toBe(plain.result.stepsExecuted);
    }
    expect(hooked.events.some((e) => e.kind === 'observation' && (e.data as { beforeStepHook?: string }).beforeStepHook === 'threw')).toBe(true);
  });

  it('a hook that never settles is logged as hung and the run carries on', async () => {
    const { result, events } = await runReplay({
      beforeStepTimeoutMs: 20,
      beforeStep: () => new Promise<void>(() => undefined),
    });
    expect(result.kind).toBe('success');
    expect(events.filter((e) => e.kind === 'observation' && (e.data as { beforeStepHook?: string }).beforeStepHook === 'hung')).toHaveLength(loadExample().steps.length);
  });

  it('gets a frozen copy of the step: it can neither mutate it nor reach the live object', async () => {
    const seen: Readonly<Step>[] = [];
    const { result } = await runReplay({
      beforeStep: ({ step }) => {
        seen.push(step);
        (step as { name: string }).name = 'tampered';
      },
    });
    // Assigning to a frozen object throws in strict mode; the throw is logged and swallowed.
    expect(result.kind).toBe('success');
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(Object.isFrozen(seen[0]!.action)).toBe(true);
    expect(seen[0]!.name).not.toBe('tampered');
  });
});

describe('replay result: capabilityDigest', () => {
  it('stamps the content digest of the replayed capability on the result and in result.json', async () => {
    const cap = loadExample();
    const { result, resultJson } = await runReplay({ capability: cap });
    expect(result.capabilityDigest).toBe(capabilityDigest(cap));
    expect((resultJson as { capabilityDigest?: string }).capabilityDigest).toBe(capabilityDigest(cap));
  });

  it('stamps it on an early failure too (bad inputs), once the capability validated', async () => {
    const cap = loadExample();
    const { result } = await runReplay({ capability: cap, inputs: {} });
    expect(result.kind).toBe('hard_failure');
    expect(result.capabilityDigest).toBe(capabilityDigest(cap));
  });
});
