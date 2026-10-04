/**
 * Unit tests for the `operator` CLI command core (`runOperatorCommand`). `--demo`'s injectable
 * `deps.demo` means no test here ever starts a real operator server (which never stops on its
 * own -- `runOperatorDemo` only returns once a human takes control, so it is unsuitable to await
 * directly in a test).
 */
import { describe, expect, it, vi } from 'vitest';
import { runOperatorCommand } from './operator.js';
import { runOperatorDemo } from './operator-demo.js';
import { CRASH_EXIT_CODE } from '../exit-code.js';

describe('runOperatorCommand', () => {
  it('exits non-zero and explains itself when --demo is not passed', async () => {
    const printError = vi.fn();
    const demo = vi.fn();
    const exitCode = await runOperatorCommand({ port: 4300 }, { demo, printError });
    expect(exitCode).toBe(CRASH_EXIT_CODE);
    expect(demo).not.toHaveBeenCalled();
    expect(printError).toHaveBeenCalledTimes(1);
    expect(printError.mock.calls[0]?.[0]).toContain('cannot attach to another process');
  });

  it('runs the injected demo function and exits 0 with --demo', async () => {
    const demo = vi.fn(async () => undefined);
    const exitCode = await runOperatorCommand({ demo: true, port: 4321 }, { demo });
    expect(exitCode).toBe(0);
    expect(demo).toHaveBeenCalledWith({ port: 4321 });
  });
});

describe('operator module', () => {
  it('exports runOperatorDemo', () => {
    expect(typeof runOperatorDemo).toBe('function');
  });
});
