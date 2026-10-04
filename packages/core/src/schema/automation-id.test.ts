/**
 * The `automation_id` locator kind (a native toolkit's developer-assigned identifier, UIA
 * AutomationId on Windows): valid in a capability, bound like any other templated locator text, and
 * scanned for leaked record-time values as a substring, like a css selector (an id such as
 * `rowMember12345` glues a record value to other characters).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bindDescriptor } from './template.js';
import { validateCapability } from './validate.js';
import type { Capability, TargetDescriptor } from './index.js';

const EXAMPLE = new URL('../../../../artifacts/examples/lookup-member-savings-balance.example.json', import.meta.url);

function example(): Capability {
  const parsed = validateCapability(JSON.parse(readFileSync(EXAMPLE, 'utf8')));
  if (!parsed.ok) throw new Error('fixture: the example artifact does not validate');
  return structuredClone(parsed.capability);
}

function firstTargetStep(cap: Capability): { target: TargetDescriptor } {
  const step = cap.steps.find((s) => 'target' in s.action);
  if (!step || !('target' in step.action)) throw new Error('fixture: no targeted step');
  return step.action;
}

describe('automation_id locators', () => {
  it('validate as the first locator of a chain', () => {
    const cap = example();
    const action = firstTargetStep(cap);
    action.target.locators = [{ strategy: { kind: 'automation_id', id: 'txtUserId' }, confidence: 0.95, source: 'inferred' }, ...action.target.locators];
    const result = validateCapability(cap);
    expect(result.ok, JSON.stringify(!result.ok && result.issues)).toBe(true);
  });

  it('reject an empty id', () => {
    const cap = example();
    firstTargetStep(cap).target.locators = [{ strategy: { kind: 'automation_id', id: '' }, confidence: 0.95, source: 'inferred' }];
    expect(validateCapability(cap).ok).toBe(false);
  });

  it('bind input placeholders in the id', () => {
    const bound = bindDescriptor(
      { description: 'row', frame: [], locators: [{ strategy: { kind: 'automation_id', id: 'row{input.memberId}' }, confidence: 0.9, source: 'inferred' }] },
      { baseUrl: 'desktop://tellerworkstation', inputs: { memberId: '12345' } },
    );
    expect(bound.locators[0]!.strategy).toEqual({ kind: 'automation_id', id: 'row12345' });
  });

  it('are scanned for a glued record-time value as a substring', () => {
    const cap = example();
    firstTargetStep(cap).target.locators = [{ strategy: { kind: 'automation_id', id: 'rowMember98765' }, confidence: 0.9, source: 'inferred' }];
    const result = validateCapability(cap, { knownValues: ['98765'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.code === 'output_value_in_artifact' && i.path.at(-1) === 'id')).toBe(true);
  });
});
