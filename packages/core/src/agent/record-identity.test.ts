/**
 * Recording a read's identity check (recorder.ts `identityFor`): when the text of the value's
 * record container shows a run input's value, the extract records the input's NAME and the scope,
 * never the value. With nothing shown, nothing is recorded.
 */
import { describe, expect, it } from 'vitest';
import type { TargetDescriptor } from '../schema/index.js';
import { createRecorder } from './recorder.js';

const BASE_URL = 'http://localhost:4173';
const decl = (value: string, sensitive = false) => ({ value, sensitive, description: 'An input', type: 'string' as const });
const target: TargetDescriptor = {
  description: 'cell right of "Savings Balance"',
  frame: [],
  locators: [{ strategy: { kind: 'relative', anchor: { text: 'Savings Balance' }, relation: 'right-of', tag: 'td' }, confidence: 0.5, source: 'inferred' }],
};

describe('identityFor', () => {
  it('records the input whose value the container shows, by name, with the scope', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: { memberId: decl('12345') } });
    expect(recorder.identityFor({ scope: 'container', text: 'Member Name Jane Member ID 12345 Savings Balance $1.00' })).toEqual({ input: 'memberId', within: 'container' });
    expect(recorder.identityFor({ scope: 'page', text: 'Member 12345' })).toEqual({ input: 'memberId', within: 'page' });
  });

  it('records nothing when the container does not show the input, or shows it only inside a longer token', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: { memberId: decl('12345'), name: decl('Smith') } });
    expect(recorder.identityFor({ scope: 'container', text: 'Jane Doe Savings Balance $1.00' })).toBeUndefined();
    expect(recorder.identityFor({ scope: 'container', text: 'Member 123456 Al Smithers' })).toBeUndefined();
  });

  it('never uses a sensitive input, or a value shorter than three characters', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: { ssn: decl('987-65-4321', true), branch: decl('NY') } });
    expect(recorder.identityFor({ scope: 'container', text: 'SSN 987-65-4321 branch NY' })).toBeUndefined();
  });

  it('prefers the input a recorded step drove first', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: { status: decl('Active'), memberId: decl('12345') } });
    recorder.recordStep({
      action: { type: 'type', target, value: { kind: 'input', name: 'memberId' } },
      why: 'Enter the member ID',
      risk: 'reversible',
    });
    recorder.recordStep({
      action: { type: 'type', target, value: { kind: 'input', name: 'status' } },
      why: 'Filter by status',
      risk: 'reversible',
    });
    expect(recorder.identityFor({ scope: 'container', text: 'Active 12345' })?.input).toBe('memberId');
  });

  it('is carried on the recorded extract step, which stores the input name and never its value', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: { memberId: decl('12345') } });
    const identity = recorder.identityFor({ scope: 'container', text: 'Member ID 12345 Savings Balance $1.00' });
    const step = recorder.recordStep({
      action: { type: 'extract', target, output: 'savingsBalance', parse: 'currency', ...(identity ? { identity } : {}) },
      why: 'Read the savings balance',
      risk: 'read',
    });
    if (step.action.type !== 'extract') throw new Error('expected an extract');
    expect(step.action.identity).toEqual({ input: 'memberId', within: 'container' });
    expect(JSON.stringify(step)).not.toContain('12345');
  });
});
