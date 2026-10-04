import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Capability } from './capability.js';
import { validateCapability } from './validate.js';
import type { LocatorStrategy, TargetDescriptor } from './locator.js';
import type { Action } from './action.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const exampleRaw = readFileSync(path.join(here, '../../../../artifacts/examples/lookup-member-savings-balance.example.json'), 'utf8');
const exampleJson: unknown = JSON.parse(exampleRaw);

/** Every action shape that carries a `target: TargetDescriptor`. */
function actionTarget(action: Action): TargetDescriptor | undefined {
  switch (action.type) {
    case 'click':
    case 'type':
    case 'select':
    case 'extract':
      return action.target;
    default:
      return undefined;
  }
}

describe('lookup-member-savings-balance example capability', () => {
  it('parses as a valid Capability', () => {
    const result = Capability.safeParse(exampleJson);
    if (!result.success) {
      // Surface the zod issues directly in the test failure output for debuggability.
      throw new Error(JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it('passes validateCapability with no issues', () => {
    const result = validateCapability(exampleJson);
    if (!result.ok) {
      throw new Error(JSON.stringify(result.issues, null, 2));
    }
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('never contains the mock password, or an SSN- or card-number-like literal', () => {
    expect(exampleRaw.includes('demo-pass-123')).toBe(false);
    expect(/\b\d{3}-\d{2}-\d{4}\b/.test(exampleRaw)).toBe(false); // SSN shape: 123-45-6789
    expect(/\b\d{13,16}\b/.test(exampleRaw)).toBe(false); // card-number-like run of digits
  });

  it('binds every secret via MOCK_USER or MOCK_PASSWORD only', () => {
    const cap = Capability.parse(exampleJson);
    const secretEnvs: string[] = [];
    for (const step of cap.steps) {
      const action = step.action;
      if ((action.type === 'type' || action.type === 'select') && action.value.kind === 'secret') {
        secretEnvs.push(action.value.env);
      }
    }
    expect(secretEnvs.length).toBeGreaterThan(0);
    for (const env of secretEnvs) {
      expect(['MOCK_USER', 'MOCK_PASSWORD']).toContain(env);
    }
  });

  it('never types a literal value into a target that looks like a password field', () => {
    const cap = Capability.parse(exampleJson);
    for (const step of cap.steps) {
      const action = step.action;
      if (action.type === 'type' && action.value.kind === 'literal') {
        expect(action.target.description.toLowerCase()).not.toMatch(/pass(word|code)/);
      }
    }
  });

  it('gives every locator chain at least 2 locators, or ends the chain with bbox', () => {
    const cap = Capability.parse(exampleJson);
    const targets: TargetDescriptor[] = [];

    const collectFromCondition = (cond: unknown): void => {
      if (cond === null || typeof cond !== 'object') return;
      const c = cond as { kind?: string; target?: TargetDescriptor; of?: unknown[] };
      if ((c.kind === 'element_visible' || c.kind === 'element_absent') && c.target) targets.push(c.target);
      if (Array.isArray(c.of)) c.of.forEach(collectFromCondition);
      if (c.kind === 'not' && 'of' in c) collectFromCondition((c as { of: unknown }).of);
    };

    for (const step of cap.steps) {
      const t = actionTarget(step.action);
      if (t) targets.push(t);
      if (step.precondition) collectFromCondition(step.precondition);
      if (step.postcondition) collectFromCondition(step.postcondition);
    }
    for (const rule of cap.recoveryRules) {
      for (const action of rule.actions) {
        const t = actionTarget(action);
        if (t) targets.push(t);
      }
      collectFromCondition(rule.trigger);
    }
    for (const outcome of cap.businessOutcomes) {
      collectFromCondition(outcome.detector);
      for (const extract of outcome.extract ?? []) targets.push(extract.target);
    }
    for (const override of cap.overrides ?? []) {
      for (const patch of override.stepPatches) {
        if (patch.target) targets.push(patch.target);
      }
    }

    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      const last: LocatorStrategy = target.locators[target.locators.length - 1]!.strategy;
      const ok = target.locators.length >= 2 || last.kind === 'bbox';
      expect(ok).toBe(true);
    }
  });

  it('patches an existing step in its one tenant override', () => {
    const cap = Capability.parse(exampleJson);
    const stepIds = new Set(cap.steps.map((s) => s.id));
    expect(cap.overrides).toBeDefined();
    expect(cap.overrides!.length).toBeGreaterThan(0);
    for (const override of cap.overrides!) {
      expect(override.stepPatches.length).toBeGreaterThan(0);
      for (const patch of override.stepPatches) {
        expect(stepIds.has(patch.stepId)).toBe(true);
      }
    }
  });
});
