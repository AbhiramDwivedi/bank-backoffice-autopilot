import { describe, expect, it } from 'vitest';
import { parseToolCall, TOOL_DEFS } from './tools.js';

describe('TOOL_DEFS schemas', () => {
  it('is non-empty and covers every tool name', () => {
    const names = TOOL_DEFS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'click',
        'declare_outcome',
        'dismiss_dialog',
        'dismiss_interstitial',
        'done',
        'extract',
        'navigate',
        'press',
        'select',
        'stuck',
        'type',
      ].sort(),
    );
  });

  for (const def of TOOL_DEFS) {
    it(`"${def.name}" schema is strict-compatible`, () => {
      expect(def.description.length).toBeGreaterThan(0);
      const schema = def.input_schema as {
        type: string;
        additionalProperties: boolean;
        properties: Record<string, unknown>;
        required: string[];
        $schema?: unknown;
      };
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      const propertyNames = Object.keys(schema.properties).sort();
      expect(schema.required.slice().sort()).toEqual(propertyNames);
      expect(schema.$schema).toBeUndefined();
    });
  }
});

describe('parseToolCall: valid inputs', () => {
  it('click', () => {
    const result = parseToolCall({ name: 'click', input: { ref: 'e1', why: 'Open the form', expect: '' } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.call).toEqual({ tool: 'click', ref: 'e1', why: 'Open the form', expect: '' });
  });

  it('type with source input', () => {
    const result = parseToolCall({
      name: 'type',
      input: { ref: 'e2', source: 'input', value: 'accountId', why: 'Enter the search value', expect: 'Results' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.call).toEqual({
        tool: 'type',
        ref: 'e2',
        source: 'input',
        value: 'accountId',
        why: 'Enter the search value',
        expect: 'Results',
      });
    }
  });

  it('type with source secret', () => {
    const result = parseToolCall({
      name: 'type',
      input: { ref: 'e3', source: 'secret', value: 'MOCK_PASSWORD', why: 'Enter the password', expect: '' },
    });
    expect(result.ok).toBe(true);
  });

  it('select', () => {
    const result = parseToolCall({
      name: 'select',
      input: { ref: 'e4', source: 'literal', value: 'Savings', why: 'Choose the account type', expect: '' },
    });
    expect(result.ok).toBe(true);
  });

  it('press', () => {
    const result = parseToolCall({ name: 'press', input: { key: 'Enter', why: 'Submit the search', expect: 'Results' } });
    expect(result.ok).toBe(true);
  });

  it('navigate', () => {
    const result = parseToolCall({
      name: 'navigate',
      input: { url: 'http://localhost:4173/workstation', why: 'Open the entry page', expect: '' },
    });
    expect(result.ok).toBe(true);
  });

  it('dismiss_dialog', () => {
    const result = parseToolCall({ name: 'dismiss_dialog', input: { accept: true, why: 'Accept the confirmation' } });
    expect(result.ok).toBe(true);
  });

  it('dismiss_interstitial', () => {
    const result = parseToolCall({
      name: 'dismiss_interstitial',
      input: { ref: 'e5', trigger_text: 'Scheduled downtime notice', title: 'System Maintenance Notice', why: 'Close the notice' },
    });
    expect(result.ok).toBe(true);
  });

  it('dismiss_interstitial with an empty title (the model found no heading)', () => {
    const result = parseToolCall({
      name: 'dismiss_interstitial',
      input: { ref: 'e5', trigger_text: 'Scheduled downtime notice', title: '', why: 'Close the notice' },
    });
    expect(result.ok).toBe(true);
  });

  it('extract', () => {
    const result = parseToolCall({
      name: 'extract',
      input: { ref: 'e6', output: 'balance', parse: 'currency', why: 'Read the balance' },
    });
    expect(result.ok).toBe(true);
  });

  it('declare_outcome with returns', () => {
    const result = parseToolCall({
      name: 'declare_outcome',
      input: {
        name: 'record_not_found',
        description: 'The lookup found no matching record.',
        detector_text: 'No matching record.',
        returns: [{ output: 'message', ref: 'e7', parse: 'text', description: 'The message shown.' }],
      },
    });
    expect(result.ok).toBe(true);
  });

  it('declare_outcome with empty returns', () => {
    const result = parseToolCall({
      name: 'declare_outcome',
      input: { name: 'validation_error', description: 'Bad input.', detector_text: 'Please correct the errors below.', returns: [] },
    });
    expect(result.ok).toBe(true);
  });

  it('done', () => {
    const result = parseToolCall({ name: 'done', input: { success_text: 'Account Summary', summary: 'Looked up the balance.' } });
    expect(result.ok).toBe(true);
  });

  it('stuck', () => {
    const result = parseToolCall({ name: 'stuck', input: { reason: 'No control on screen advances the goal.' } });
    expect(result.ok).toBe(true);
  });
});

describe('parseToolCall: invalid inputs are rejected with a readable error', () => {
  it('unknown tool name', () => {
    const result = parseToolCall({ name: 'teleport', input: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown tool/i);
  });

  it('missing required field', () => {
    const result = parseToolCall({ name: 'click', input: { ref: 'e1', why: 'Open the form' } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
      expect(result.error).toMatch(/expect/);
    }
  });

  it('wrong type', () => {
    const result = parseToolCall({ name: 'dismiss_dialog', input: { accept: 'yes', why: 'Accept it' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/accept/);
  });

  it('bad enum value', () => {
    const result = parseToolCall({
      name: 'type',
      input: { ref: 'e1', source: 'env', value: 'X', why: 'Type it', expect: '' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/source/);
  });

  it('unidentifier output name', () => {
    const result = parseToolCall({
      name: 'extract',
      input: { ref: 'e1', output: 'not an identifier', parse: 'text', why: 'Read it' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/output/);
  });

  it('additional/unknown property is rejected', () => {
    const result = parseToolCall({
      name: 'stuck',
      input: { reason: 'x', extra: 'not allowed' },
    });
    expect(result.ok).toBe(false);
  });

  it('empty required string is rejected', () => {
    const result = parseToolCall({ name: 'stuck', input: { reason: '' } });
    expect(result.ok).toBe(false);
  });
});
