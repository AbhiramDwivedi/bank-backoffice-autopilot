/**
 * `cu catalog invoke` wiring: `--operator-port` is validated, the CLI's stderr logger reaches
 * `Catalog.invoke`, and an interrupted run exits 130 rather than the crash code. The catalog is
 * mocked: nothing here launches a browser or a console.
 */
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../catalog/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../catalog/index.js')>()),
  loadCatalog: () => ({ entries: () => [], skipped: () => [], get: () => undefined, toToolDefinitions: () => [], invoke: invokeMock }),
}));

const { InterruptedError } = await import('../runtime/index.js');
const { registerCatalog } = await import('./catalog.js');
const { READ_ONLY_NOTE } = await import('./replay.js');

async function runCli(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.option('--policy <path>').option('--runs-dir <dir>').option('--headless').option('--headed').option('--base-url <url>').option('--tenant <t>');
  registerCatalog(program);
  await program.parseAsync(['node', 'cu', ...args]);
}

let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  invokeMock.mockReset();
  stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  process.exitCode = undefined;
});

afterEach(() => {
  stderr.mockRestore();
  process.exitCode = undefined;
});

describe('cu catalog invoke', () => {
  it('exits 130 (not 1) when the run is interrupted', async () => {
    invokeMock.mockRejectedValueOnce(new InterruptedError('SIGINT'));
    await runCli(['catalog', 'invoke', 'cap-a', '--input', 'memberId=12345', '--auto-operator', 'abort']);
    expect(process.exitCode).toBe(130);
    expect(stderr.mock.calls.map((c: unknown[]) => String(c[0]))).toContain('cu catalog invoke: interrupted by SIGINT; no result reported');
  });

  it('passes a log function and a parsed --operator-port to Catalog.invoke', async () => {
    invokeMock.mockRejectedValueOnce(new Error('stop here'));
    await runCli(['catalog', 'invoke', 'cap-a', '--operator-port', '4451']);
    const opts = invokeMock.mock.calls[0]?.[2] as { log?: unknown; operator?: unknown };
    expect(typeof opts.log).toBe('function');
    expect(opts.operator).toEqual({ port: 4451 });
    expect(process.exitCode).toBe(1);
  });

  it('--read-only reaches Catalog.invoke as the run-level assertion, with the same note replay prints; without the flag none is made', async () => {
    invokeMock.mockRejectedValue(new Error('stop here'));
    await runCli(['catalog', 'invoke', 'cap-a', '--read-only']);
    expect(stderr.mock.calls.map((c: unknown[]) => String(c[0]))).toContain(READ_ONLY_NOTE);
    stderr.mockClear();
    await runCli(['catalog', 'invoke', 'cap-a']);
    expect(stderr.mock.calls.map((c: unknown[]) => String(c[0]))).not.toContain(READ_ONLY_NOTE);
    expect(invokeMock.mock.calls[0]?.[2]).toMatchObject({ readOnly: true });
    expect(invokeMock.mock.calls[1]?.[2]).not.toHaveProperty('readOnly');
  });

  it('rejects a non-numeric --operator-port before invoking anything', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(runCli(['catalog', 'invoke', 'cap-a', '--operator-port', 'abc'])).rejects.toThrow(/must be an integer port number \(0-65535\)/);
    } finally {
      write.mockRestore();
    }
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
