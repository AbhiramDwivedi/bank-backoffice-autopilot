/**
 * `read_without_record_identity` (warning) and the `identity` field of an extract step.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateCapability, type Capability } from './index.js';

const EXAMPLE = new URL('../../../../artifacts/examples/lookup-member-savings-balance.example.json', import.meta.url);
const load = (): Capability => JSON.parse(readFileSync(EXAMPLE, 'utf8')) as Capability;
const warned = (cap: Capability): (string | number)[][] => {
  const v = validateCapability(cap);
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  return v.warnings.filter((w) => w.code === 'read_without_record_identity').map((w) => w.path);
};
const extractIndexes = (cap: Capability): number[] => cap.steps.flatMap((s, i) => (s.action.type === 'extract' ? [i] : []));

describe('read_without_record_identity', () => {
  it('warns for each read that follows an input-driven step and has no identity check', () => {
    const cap = load();
    expect(warned(cap)).toEqual(extractIndexes(cap).map((i) => ['steps', i, 'action']));
  });

  it('is silent once the reads carry an identity check', () => {
    const cap = load();
    for (const i of extractIndexes(cap)) {
      const a = cap.steps[i]!.action;
      if (a.type === 'extract') a.identity = { input: 'memberId', within: 'container' };
    }
    expect(warned(cap)).toEqual([]);
  });

  it('is silent when every input is sensitive (nothing names a record)', () => {
    const cap = load();
    for (const spec of Object.values(cap.inputs)) {
      spec.sensitive = true;
      delete spec.example;
    }
    expect(warned(cap)).toEqual([]);
  });

  it('is silent for a read that comes before every input-driven step', () => {
    const cap = load();
    const first = extractIndexes(cap)[0]!;
    const moved = structuredClone(cap);
    delete moved.auth;
    const [read] = moved.steps.splice(first, 1);
    moved.steps.splice(0, 0, read!);
    const v = validateCapability(moved);
    if (!v.ok) throw new Error(JSON.stringify(v.issues));
    expect(v.warnings.filter((w) => w.code === 'read_without_record_identity').map((w) => w.path)).not.toContainEqual(['steps', 0, 'action']);
  });
});

describe('extract identity', () => {
  it('must name a declared input', () => {
    const cap = load();
    const i = extractIndexes(cap)[0]!;
    const a = cap.steps[i]!.action;
    if (a.type !== 'extract') throw new Error('expected an extract');
    a.identity = { input: 'nobody', within: 'container' };
    const v = validateCapability(cap);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.issues.map((x) => [x.code, x.path.join('.')])).toContainEqual(['unknown_input', `steps.${i}.action.identity.input`]);
  });

  it('refuses an unknown scope and extra keys (the value of an input is never stored)', () => {
    const cap = load();
    const i = extractIndexes(cap)[0]!;
    const raw = structuredClone(cap) as unknown as { steps: { action: Record<string, unknown> }[] };
    raw.steps[i]!.action.identity = { input: 'memberId', within: 'region' };
    expect(validateCapability(raw).ok).toBe(false);
    raw.steps[i]!.action.identity = { input: 'memberId', within: 'container', value: '12345' };
    expect(validateCapability(raw).ok).toBe(false);
  });
});
