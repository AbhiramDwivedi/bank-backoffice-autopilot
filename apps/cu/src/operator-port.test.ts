import { describe, expect, it } from 'vitest';
import { DEFAULT_OPERATOR_PORT } from './runtime/index.js';
import { resolveOperatorPortDefault } from './operator-port.js';

describe('resolveOperatorPortDefault', () => {
  it('keeps the well-known port when --headed was given, regardless of --auto-operator', () => {
    expect(resolveOperatorPortDefault({ headed: true, autoOperator: 'none' })).toBe(DEFAULT_OPERATOR_PORT);
    expect(resolveOperatorPortDefault({ headed: true, autoOperator: 'approve' })).toBe(DEFAULT_OPERATOR_PORT);
    expect(resolveOperatorPortDefault({ headed: true, autoOperator: 'abort' })).toBe(DEFAULT_OPERATOR_PORT);
    expect(resolveOperatorPortDefault({ headed: true, autoOperator: 'relogin' })).toBe(DEFAULT_OPERATOR_PORT);
  });

  it("keeps the well-known port when --auto-operator is 'none' (a human uses the console), even headless", () => {
    expect(resolveOperatorPortDefault({ headed: false, autoOperator: 'none' })).toBe(DEFAULT_OPERATOR_PORT);
  });

  it('defaults to ephemeral (0) for a headless run with a scripted operator attached -- no console is needed', () => {
    expect(resolveOperatorPortDefault({ headed: false, autoOperator: 'approve' })).toBe(0);
    expect(resolveOperatorPortDefault({ headed: false, autoOperator: 'abort' })).toBe(0);
    expect(resolveOperatorPortDefault({ headed: false, autoOperator: 'relogin' })).toBe(0);
  });
});
