/**
 * CLI smoke test via a real child process. Spawns `process.execPath [tsx cli.mjs,
 * apps/cu/src/index.ts, ...]` directly, not through `npx` or a shell, to avoid Windows
 * shell-quoting issues, against the real mock app started in-process by this test (harness
 * `startMock`); the child talks to it over plain HTTP.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXAMPLE_ARTIFACT, PASSWORD, startMock, tempRunsDir, writePolicyFile, type MockServer } from './harness.js';

const TSX_CLI = path.resolve('node_modules/tsx/dist/cli.mjs');
const CU_CLI = path.resolve('apps/cu/src/index.ts');

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<CliResult> {
  return runCliWithEnv(args, {});
}

function runCliWithEnv(args: string[], extraEnv: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, CU_CLI, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, MOCK_PASSWORD: PASSWORD, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('cli e2e: child process smoke', () => {
  let mock: MockServer;
  let runsDir: string;
  let policyFile: string;

  beforeAll(async () => {
    mock = await startMock('a');
    runsDir = tempRunsDir();
    policyFile = writePolicyFile(runsDir, mock.baseUrl);
  });

  afterAll(async () => {
    await mock.close();
  });

  /** Every CLI invocation in this suite is wrapped so the password-leak check is never skipped. */
  async function runCliChecked(args: string[]): Promise<CliResult> {
    const res = await runCli(args);
    expect(res.stdout).not.toContain(PASSWORD);
    expect(res.stderr).not.toContain(PASSWORD);
    return res;
  }

  it('validate: the reference example artifact is valid (exit 0, stdout mentions valid)', async () => {
    const res = await runCliChecked(['validate', EXAMPLE_ARTIFACT]);
    expect(res.code).toBe(0);
    expect(res.stdout.toLowerCase()).toContain('valid');
  }, 30_000);

  it('validate: a malformed artifact is invalid (exit 1)', async () => {
    const tmp = path.join(runsDir, 'invalid.json');
    fs.writeFileSync(tmp, JSON.stringify({ notACapability: true }));
    const res = await runCliChecked(['validate', tmp]);
    expect(res.code).toBe(1);
  }, 30_000);

  it(
    'replay: memberId 12345 -> exit 0, success, savingsBalance 1234.56, --json stdout is ONLY the JSON, result.json on disk',
    async () => {
      const res = await runCliChecked([
        'replay',
        EXAMPLE_ARTIFACT,
        '--input',
        'memberId=12345',
        '--json',
        '--base-url',
        mock.baseUrl,
        '--policy',
        policyFile,
        '--runs-dir',
        runsDir,
        '--operator-port',
        '0',
      ]);
      expect(res.code).toBe(0);
      const result = JSON.parse(res.stdout) as { kind: string; runId: string; outputs?: Record<string, unknown> };
      expect(result.kind).toBe('success');
      expect(result.outputs?.savingsBalance).toBe(1234.56);
      expect(fs.existsSync(path.join(runsDir, result.runId, 'result.json'))).toBe(true);
    },
    60_000,
  );

  it(
    'replay: memberId 99999 -> exit 3, business_outcome member_not_found',
    async () => {
      const res = await runCliChecked([
        'replay',
        EXAMPLE_ARTIFACT,
        '--input',
        'memberId=99999',
        '--json',
        '--base-url',
        mock.baseUrl,
        '--policy',
        policyFile,
        '--runs-dir',
        runsDir,
        '--operator-port',
        '0',
      ]);
      expect(res.code).toBe(3);
      const result = JSON.parse(res.stdout) as { kind: string; name?: string };
      expect(result.kind).toBe('business_outcome');
      expect(result.name).toBe('member_not_found');
    },
    60_000,
  );

  it('replay --credentials file:<missing> -> exit 1 before any browser, naming the provider, no run directory', async () => {
    const credsDir = tempRunsDir('cli-creds-');
    const res = await runCliChecked([
      'replay',
      EXAMPLE_ARTIFACT,
      '--input',
      'memberId=12345',
      '--base-url',
      mock.baseUrl,
      '--policy',
      policyFile,
      '--runs-dir',
      credsDir,
      '--operator-port',
      '0',
      '--credentials',
      `file:${path.join(credsDir, 'no-such-creds.json')}`,
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('credentials (file:');
    expect(res.stderr).toContain('no browser launched');
    expect(fs.readdirSync(credsDir)).toEqual([]);
  }, 30_000);

  it('replay with CU_CREDENTIALS=exec:<helper> binds the example login from the helper', async () => {
    const helperDir = tempRunsDir('cli-helper-');
    const helper = path.join(helperDir, 'helper.mjs');
    fs.writeFileSync(
      helper,
      `let i='';process.stdin.on('data',(d)=>{i+=d;});process.stdin.on('end',()=>{const {names}=JSON.parse(i);` +
        `const all={MOCK_USER:'operator1',MOCK_PASSWORD:${JSON.stringify(PASSWORD)}};const o={};for(const n of names)o[n]=all[n];process.stdout.write(JSON.stringify(o));});`,
    );
    const res = await runCliWithEnv(
      ['replay', EXAMPLE_ARTIFACT, '--input', 'memberId=12345', '--json', '--base-url', mock.baseUrl, '--policy', policyFile, '--runs-dir', runsDir, '--operator-port', '0'],
      // MOCK_* deliberately empty: the values can only come from the helper.
      { CU_CREDENTIALS: `exec:"${process.execPath}" "${helper}"`, MOCK_USER: '', MOCK_PASSWORD: '' },
    );
    expect(res.stdout).not.toContain(PASSWORD);
    expect(res.stderr).not.toContain(PASSWORD);
    expect(res.code, res.stderr).toBe(0);
    expect((JSON.parse(res.stdout) as { kind: string }).kind).toBe('success');
  }, 60_000);

  it('catalog tools: prints a JSON array of Anthropic tool definitions', async () => {
    const res = await runCliChecked(['catalog', 'tools', '--dir', 'artifacts']);
    expect(res.code).toBe(0);
    const tools = JSON.parse(res.stdout) as { name: string }[];
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.some((t) => t.name === 'lookup-member-savings-balance')).toBe(true);
  }, 30_000);
});
