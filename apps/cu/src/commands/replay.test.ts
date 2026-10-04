/**
 * `cu replay` under Ctrl-C: `runReplay` rejecting with an `InterruptedError` (runWithShutdown,
 * apps/cu/src/runtime/lifecycle.ts) ends the command with exit code 130 and no result, and a
 * `--times` series stops instead of starting the next run. `runReplay` and Chromium are mocked:
 * nothing here launches a browser or a console.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplayResult } from '@cu/core/schema';

// The command loads the artifact's credentials itself, before runReplay (mocked here) or a browser;
// the CLI's loadEnv() supplies these demo defaults in real use.
process.env.MOCK_USER ??= 'operator1';
process.env.MOCK_PASSWORD ??= 'demo-pass-123';

const runReplayMock = vi.hoisted(() => vi.fn());
const browserClose = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../runtime/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime/index.js')>();
  return { ...actual, runReplay: runReplayMock };
});
vi.mock('playwright', () => ({ chromium: { launch: vi.fn(async () => ({ close: browserClose })) } }));

const { InterruptedError } = await import('../runtime/index.js');
const { registerReplay } = await import('./replay.js');

const EXAMPLE = path.resolve('artifacts/examples/lookup-member-savings-balance.example.json');

function success(runId: string): ReplayResult {
  return {
    runId,
    capabilityId: 'lookup-member-savings-balance',
    capabilityVersion: '1.0.0',
    stepsExecuted: 1,
    durationMs: 1,
    locatorReport: [],
    recoveries: [],
    kind: 'success',
    outputs: {},
  };
}

async function runCli(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.option('--policy <path>').option('--runs-dir <dir>').option('--headless').option('--headed').option('--base-url <url>').option('--tenant <t>');
  registerReplay(program);
  await program.parseAsync(['node', 'cu', ...args]);
}

let runsDir: string;
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-cmd-test-'));
  runReplayMock.mockReset();
  browserClose.mockClear();
  stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  process.exitCode = undefined;
});

afterEach(() => {
  stdout.mockRestore();
  stderr.mockRestore();
  process.exitCode = undefined;
  fs.rmSync(runsDir, { recursive: true, force: true });
});

const stderrLines = (): string[] => stderr.mock.calls.map((c: unknown[]) => String(c[0]));

describe('cu replay: Ctrl-C', () => {
  it('a single run that is interrupted exits 130 and prints no result', async () => {
    runReplayMock.mockRejectedValueOnce(new InterruptedError('SIGINT'));

    await runCli(['--runs-dir', runsDir, 'replay', EXAMPLE, '--input', 'memberId=12345', '--auto-operator', 'abort']);

    expect(process.exitCode).toBe(130);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderrLines()).toContain('cu replay: interrupted by SIGINT; no result reported');
  });

  it('--times stops the series at the interrupted run, closes the browser, and exits 130 (not the earlier runs\' exit code)', async () => {
    runReplayMock
      .mockResolvedValueOnce({ result: success('run_1'), runDir: 'r1', controlState: 'automation' })
      .mockRejectedValueOnce(new InterruptedError('SIGINT'))
      .mockResolvedValue({ result: success('run_n'), runDir: 'rn', controlState: 'automation' });

    await runCli(['--runs-dir', runsDir, 'replay', EXAMPLE, '--input', 'memberId=12345', '--auto-operator', 'abort', '--times', '5']);

    expect(runReplayMock).toHaveBeenCalledTimes(2);
    expect(browserClose).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(130);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderrLines()).toContain('cu replay: stopped after 1 of 5 runs completed');
  });

  it('a non-interrupt error still propagates', async () => {
    runReplayMock.mockRejectedValueOnce(new Error('boom'));
    await expect(runCli(['--runs-dir', runsDir, 'replay', EXAMPLE, '--input', 'memberId=12345', '--auto-operator', 'abort'])).rejects.toThrow('boom');
  });
});

describe('cu replay: --operator-port', () => {
  it('rejects a non-numeric port before anything runs', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(runCli(['replay', EXAMPLE, '--operator-port', 'abc'])).rejects.toThrow(/must be an integer port number \(0-65535\)/);
    } finally {
      write.mockRestore();
    }
    expect(runReplayMock).not.toHaveBeenCalled();
  });

  it('passes a valid port through to runReplay', async () => {
    runReplayMock.mockResolvedValueOnce({ result: success('run_1'), runDir: 'r1', controlState: 'automation' });
    await runCli(['--runs-dir', runsDir, 'replay', EXAMPLE, '--input', 'memberId=12345', '--auto-operator', 'abort', '--operator-port', '4450']);
    expect(runReplayMock.mock.calls[0]?.[0]).toMatchObject({ operator: { port: 4450 } });
  });
});

describe('cu replay: --read-only', () => {
  it('passes the run-level assertion to runReplay and says on stderr that nothing verifies it', async () => {
    runReplayMock.mockResolvedValueOnce({ result: success('run_1'), runDir: 'r1', controlState: 'automation' });
    await runCli(['--runs-dir', runsDir, 'replay', EXAMPLE, '--input', 'memberId=12345', '--auto-operator', 'abort', '--read-only']);
    expect(runReplayMock.mock.calls[0]?.[0]).toMatchObject({ readOnly: true });
    expect(stderrLines().some((l) => l.startsWith('note: --read-only asserts, for this run only,'))).toBe(true);
  });

  it('without the flag no assertion is made', async () => {
    runReplayMock.mockResolvedValueOnce({ result: success('run_1'), runDir: 'r1', controlState: 'automation' });
    await runCli(['--runs-dir', runsDir, 'replay', EXAMPLE, '--input', 'memberId=12345', '--auto-operator', 'abort']);
    expect(runReplayMock.mock.calls[0]?.[0]).not.toHaveProperty('readOnly');
    expect(stderrLines().some((l) => l.includes('--read-only'))).toBe(false);
  });
});

describe('cu replay: deprecated capability', () => {
  function writeDeprecated(): string {
    const cap = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8')) as Record<string, unknown>;
    cap.status = 'deprecated';
    const file = path.join(runsDir, 'deprecated.json');
    fs.writeFileSync(file, JSON.stringify(cap), 'utf8');
    return file;
  }

  it.each([[[] as string[]], [['--approve']]])('is refused before anything runs (extra args %j)', async (extra) => {
    const file = writeDeprecated();
    await runCli(['--runs-dir', runsDir, 'replay', file, '--input', 'memberId=12345', '--auto-operator', 'abort', ...extra]);

    expect(runReplayMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stderrLines().some((l) => /^cu replay: capability "lookup-member-savings-balance" is deprecated \(version .+\); refusing to replay it$/.test(l))).toBe(true);
    expect(stderrLines().some((l) => l.includes('--approve is treating'))).toBe(false);
  });
});
