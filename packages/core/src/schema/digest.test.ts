/**
 * The capability content digest (digest.ts) and the read-only declaration's validation rule.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Capability } from './index.js';
import { canonicalJson, capabilityDigest } from './digest.js';
import { validateCapability } from './validate.js';

const SHIPPED = new URL('../../../../artifacts/lookup-member-savings-balance.json', import.meta.url);
const shipped = (): Capability => JSON.parse(readFileSync(SHIPPED, 'utf8')) as Capability;

describe('canonicalJson', () => {
  it('sorts keys at every depth, keeps array order, and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson([undefined, null, 'x'])).toBe('[null,null,"x"]');
  });
});

describe('capabilityDigest', () => {
  it('is stable across key order and ignores status, version and provenance (what an approval rewrites)', () => {
    const cap = shipped();
    const reordered = Object.fromEntries(Object.entries(cap).reverse());
    expect(capabilityDigest(reordered)).toBe(capabilityDigest(cap));
    const approved = { ...cap, status: 'draft', version: '9.9.9', provenance: { ...cap.provenance, notes: 'different' } };
    expect(capabilityDigest(approved)).toBe(capabilityDigest(cap));
    expect(capabilityDigest(cap)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes when anything replay does changes', () => {
    const cap = shipped();
    expect(capabilityDigest({ ...cap, steps: cap.steps.filter((s) => s.id !== 's04') })).not.toBe(capabilityDigest(cap));
    expect(capabilityDigest({ ...cap, readOnly: true })).not.toBe(capabilityDigest(cap));
  });
});

describe('validateCapability: readOnly', () => {
  it('accepts the declaration on a capability with nothing irreversible', () => {
    const res = validateCapability({ ...shipped(), readOnly: true });
    expect(res.ok).toBe(true);
  });

  it('rejects readOnly: true on a capability with an irreversible step', () => {
    const cap = shipped();
    const res = validateCapability({
      ...cap,
      readOnly: true,
      riskLevel: 'irreversible',
      steps: cap.steps.map((s) => (s.id === 's05' ? { ...s, risk: 'irreversible' } : s)),
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.issues.find((i) => i.code === 'read_only_irreversible')?.message).toContain('step "s05" is irreversible');
  });

  it('only accepts the literal true', () => {
    expect(validateCapability({ ...shipped(), readOnly: false }).ok).toBe(false);
  });
});
