import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { controlStateLabel, secretEnvNamesOf, sensitiveOutputNamesOf } from './run-replay.js';

describe('sensitiveOutputNamesOf', () => {
  it('collects sensitive outputs and sensitive business-outcome returns; tolerates junk', () => {
    const cap = {
      outputs: { savingsBalance: { type: 'number', description: 'x', sensitive: true }, memberName: { type: 'string', description: 'y' } },
      businessOutcomes: [{ name: 'overdrawn', returns: { amount: { type: 'number', description: 'z', sensitive: true } } }, null],
    };
    expect(sensitiveOutputNamesOf(cap).sort()).toEqual(['amount', 'savingsBalance']);
    expect(sensitiveOutputNamesOf(null)).toEqual([]);
    expect(sensitiveOutputNamesOf({ outputs: 'nope' })).toEqual([]);
  });
});

describe('secretEnvNamesOf', () => {
  it('collects every secret binding env name in the example artifact', () => {
    const raw: unknown = JSON.parse(fs.readFileSync('artifacts/examples/lookup-member-savings-balance.example.json', 'utf8'));
    expect(secretEnvNamesOf(raw).sort()).toEqual(['MOCK_PASSWORD', 'MOCK_USER']);
  });

  it("loads only what the run's tenant needs: a secret in another tenant's override is not demanded", () => {
    const cap = JSON.parse(fs.readFileSync('artifacts/examples/lookup-member-savings-balance.example.json', 'utf8')) as {
      overrides: { tenant: string; extraSteps?: unknown[] }[];
      steps: { id: string; action: { target?: unknown } }[];
    };
    const target = cap.steps[1]!.action.target;
    cap.overrides[0]!.extraSteps = [
      {
        afterStepId: 's03',
        step: { id: 's03b', name: 'Enter the branch PIN', action: { type: 'type', target, value: { kind: 'secret', env: 'BRANCH_PIN' } }, risk: 'reversible' },
      },
    ];
    const tenant = cap.overrides[0]!.tenant;
    expect(secretEnvNamesOf(cap).sort()).toEqual(['MOCK_PASSWORD', 'MOCK_USER']);
    expect(secretEnvNamesOf(cap, tenant).sort()).toEqual(['BRANCH_PIN', 'MOCK_PASSWORD', 'MOCK_USER']);
  });

  it('returns nothing for a non-object artifact', () => {
    expect(secretEnvNamesOf(null)).toEqual([]);
    expect(secretEnvNamesOf('x')).toEqual([]);
  });
});

describe('controlStateLabel', () => {
  it('reports the token state as-is when the broker was never terminated', () => {
    expect(controlStateLabel({ terminated: false, token: { state: 'automation' } })).toBe('automation');
    expect(controlStateLabel({ terminated: false, token: { state: 'human' } })).toBe('human');
  });

  it("reports 'terminated' once the broker is terminated, even though the token itself stays 'paused' (abort() is terminal but ControlState has no terminal member -- docs/design/handoff.md)", () => {
    expect(controlStateLabel({ terminated: true, token: { state: 'paused' } })).toBe('terminated');
  });
});
