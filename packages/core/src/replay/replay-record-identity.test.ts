/**
 * The record identity check on a read (`identity` on an extract step): after the target is found
 * and before the value is returned, the declared input's value must be visible in the value's
 * record container. A value from another record ends the step as a typed `checkpoint_failed`; an
 * old capability without the field behaves exactly as before.
 */
import { describe, expect, it } from 'vitest';
import { validateCapability, type Capability } from '../schema/index.js';
import type { RecordTextResult, Surface } from '../surface/index.js';
import { createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';
import { loadExample, makeFakeClock, runReplay } from './test-helpers.js';

/** The example capability with an identity check on the savings balance read (s09). */
function withIdentity(identity: { input: string; within: 'container' | 'page' } | undefined): Capability {
  const cap = structuredClone(loadExample());
  const step = cap.steps.find((s) => s.id === 's09')!;
  if (step.action.type !== 'extract') throw new Error('s09 is not an extract');
  if (identity !== undefined) step.action.identity = identity;
  const v = validateCapability(cap);
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  return v.capability;
}

/** `raw` with its `readRecordText` replaced (or removed, when `undefined`); every other member is the real one. */
function withRecordText(raw: Surface, replacement: Surface['readRecordText']): Surface {
  return new Proxy(raw, {
    get(target, prop) {
      if (prop === 'readRecordText') return replacement;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe('replay: record identity on a read', () => {
  it('returns the value when the container shows the input', async () => {
    const { result, events } = await runReplay({ capability: withIdentity({ input: 'memberId', within: 'container' }) });

    expect(result.kind, JSON.stringify(result)).toBe('success');
    const read = events.find((e) => e.kind === 'action_result' && e.stepId === 's09');
    expect(read?.data).toMatchObject({ ok: true, identity: 'verified' });
  });

  it('a page-scoped check reads the whole screen', async () => {
    const { result } = await runReplay({ capability: withIdentity({ input: 'memberId', within: 'page' }) });
    expect(result.kind, JSON.stringify(result)).toBe('success');
  });

  it("fails the step as checkpoint_failed when the value's container does not show the input, and returns no value", async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    // The profile table now shows another member's id: the cells are still found by their labels,
    // but they belong to another record.
    surface.inject({ kind: 'drift', elementId: 'memberIdValue', patch: { name: '99999', text: '99999' } });

    const { result, events } = await runReplay({ capability: withIdentity({ input: 'memberId', within: 'container' }), surface, clock });

    expect(result.kind, JSON.stringify(result)).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('checkpoint_failed');
    expect(result.stepId).toBe('s09');
    expect(result.expected).toBe('the record container of "savingsBalance" shows input "memberId"');
    expect(result.message).toMatch(/does not show input "memberId"/);
    expect('outputs' in result).toBe(false);
    // The input's value is compared, never reported.
    for (const text of [result.expected, result.message]) expect(text).not.toContain('12345');
    expect(JSON.stringify(events.filter((e) => e.kind === 'action_result' && e.stepId === 's09'))).not.toContain('12345');
  });

  it('an old capability without the field returns the same value from the same page', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    surface.inject({ kind: 'drift', elementId: 'memberIdValue', patch: { name: '99999', text: '99999' } });

    const { result } = await runReplay({ capability: withIdentity(undefined), surface, clock });

    expect(result.kind, JSON.stringify(result)).toBe('success');
  });

  it('a surface that cannot read a container skips the check, and the event says so', async () => {
    const clock = makeFakeClock();
    const raw = createCuCoreSurface({ clock });
    raw.inject({ kind: 'drift', elementId: 'memberIdValue', patch: { name: '99999', text: '99999' } });
    const bare = withRecordText(raw, undefined);

    const { result, events } = await runReplay({ capability: withIdentity({ input: 'memberId', within: 'container' }), surface: bare, clock });

    expect(result.kind, JSON.stringify(result)).toBe('success');
    const read = events.find((e) => e.kind === 'action_result' && e.stepId === 's09');
    expect(read?.data).toMatchObject({ identity: 'skipped' });
  });

  it('a surface that refuses the read fails the step with its own code, never a pass', async () => {
    const clock = makeFakeClock();
    const raw = createCuCoreSurface({ clock });
    const refusing = withRecordText(raw, () => Promise.resolve<RecordTextResult>({ ok: false, error: { code: 'element_not_found', message: 'stale ref' } }));

    const { result } = await runReplay({ capability: withIdentity({ input: 'memberId', within: 'container' }), surface: refusing, clock });

    expect(result.kind, JSON.stringify(result)).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('element_not_found');
    expect(result.stepId).toBe('s09');
  });

  it('a value with no container now, though it had one when recorded, fails typed', async () => {
    const clock = makeFakeClock();
    const raw = createCuCoreSurface({ clock });
    const noContainer = withRecordText(raw, (...args) => raw.readRecordText(...args).then((r): RecordTextResult => (r.ok ? { ...r, scope: 'page' } : r)));

    const { result } = await runReplay({ capability: withIdentity({ input: 'memberId', within: 'container' }), surface: noContainer, clock });

    expect(result.kind, JSON.stringify(result)).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
    expect(result.code).toBe('checkpoint_failed');
    expect(result.message).toMatch(/no longer sits in a record container/);
  });
});
