/**
 * The CLI's credential flags and their fail-fast behaviour:
 * - `--credentials <spec>` / `CU_CREDENTIALS` are a plain string resolved only by commands that bind
 *   credentials; a bad spec is rejected without echoing any of it, through the real CLI too.
 * - `discover --secret NAME` (repeatable) replaces the default MOCK_USER/MOCK_PASSWORD list.
 * - A missing credential stops `discover` and `runReplay` before a Relay console, a browser or a
 *   run directory exists, naming the missing names and the provider, never a value.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { Command, Option } from 'commander';
import { credentialSet, envCredentialProvider, type CredentialProvider } from '@cu/core/credentials';
import { createCuCoreSurface } from '@cu/core/surface';
import { CredentialSpecError, credentialProviderOf, globalsOf } from './globals.js';
import { DEFAULT_SECRET_NAMES, forbiddenValues, leakedLabels, runDiscover, type RunDiscoverOptions } from './commands/discover.js';
import { CredentialsUnavailableError, runReplay } from './runtime/index.js';
import { loadCatalog } from './catalog/index.js';

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** The root program's --credentials option, exactly as apps/cu/src/index.ts declares it (no argParser). */
function program(): Command {
  const p = new Command().exitOverride();
  p.addOption(new Option('--credentials <spec>').env('CU_CREDENTIALS'));
  p.command('probe').action(() => undefined);
  return p;
}

function providerAfterParsing(args: string[], env: string | undefined): CredentialProvider {
  const saved = process.env.CU_CREDENTIALS;
  if (env === undefined) delete process.env.CU_CREDENTIALS;
  else process.env.CU_CREDENTIALS = env;
  try {
    const p = program();
    let seen: CredentialProvider | undefined;
    p.commands[0]!.action((_o: unknown, cmd: Command) => {
      seen = credentialProviderOf(globalsOf(cmd));
    });
    p.parse(['node', 'cu', ...args, 'probe']);
    if (seen === undefined) throw new Error('probe action did not run');
    return seen;
  } finally {
    if (saved === undefined) delete process.env.CU_CREDENTIALS;
    else process.env.CU_CREDENTIALS = saved;
  }
}

const TSX_CLI = path.resolve('node_modules/tsx/dist/cli.mjs');
const CU_CLI = path.resolve('apps/cu/src/index.ts');
const EXAMPLE = 'artifacts/examples/lookup-member-savings-balance.example.json';

/** The real CLI in a child process (no shell); returns exit code and both streams. */
function runCli(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, CU_CLI, ...args], { cwd: process.cwd(), env: { ...process.env, ...env }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('--credentials / CU_CREDENTIALS', () => {
  it('defaults to the env provider', () => {
    expect(providerAfterParsing([], undefined).id).toBe('env');
  });

  it('parses file: and exec: specs into those providers', () => {
    expect(providerAfterParsing(['--credentials', 'file:/somewhere/creds.json'], undefined).id).toBe('file:/somewhere/creds.json');
    expect(providerAfterParsing(['--credentials', 'exec:helper --token abc123'], undefined).id).toBe('exec:helper');
  });

  it('reads CU_CREDENTIALS when the flag is absent, and the flag wins over it', () => {
    expect(providerAfterParsing([], 'exec:from-env-helper').id).toBe('exec:from-env-helper');
    expect(providerAfterParsing(['--credentials', 'env'], 'exec:from-env-helper').id).toBe('env');
  });

  it('rejects an unknown spec with a CredentialSpecError that quotes none of it', () => {
    expect(() => credentialProviderOf({ credentialsSpec: 'vault:secret/path?token=hunter2' })).toThrow(CredentialSpecError);
    expect(() => credentialProviderOf({ credentialsSpec: 'vault:secret/path?token=hunter2' })).toThrow(/env \| file:<path> \| exec:<command>/);
    expect(() => credentialProviderOf({ credentialsSpec: 'vault:secret/path?token=hunter2' })).not.toThrow(/hunter2|vault/);
  });
});

describe('a malformed spec through the real CLI (commander included)', () => {
  it('--credentials with a token and a quoting typo: exit 1, the spec is not on stderr', async () => {
    const res = await runCli(['replay', EXAMPLE, '--input', 'memberId=12345', '--credentials', 'exec:helper "tok=SECRET-TOKEN-1'], {});
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('--credentials / CU_CREDENTIALS: credentials spec "exec:": unterminated double quote');
    expect(res.stderr + res.stdout).not.toContain('SECRET-TOKEN-1');
  }, 30_000);

  it('CU_CREDENTIALS with a token and a quoting typo: exit 1, the spec is not on stderr', async () => {
    const res = await runCli(['replay', EXAMPLE, '--input', 'memberId=12345'], { CU_CREDENTIALS: 'exec:op read "op://vault/item?token=ABC123SECRET' });
    expect(res.code).toBe(1);
    expect(res.stderr + res.stdout).not.toContain('ABC123SECRET');
    expect(res.stderr + res.stdout).not.toContain('op://vault');
  }, 30_000);

  it('a malformed CU_CREDENTIALS does not break commands that bind no credentials (validate)', async () => {
    const res = await runCli(['validate', EXAMPLE], { CU_CREDENTIALS: 'ghp_PastedTokenNoColon' });
    expect(res.code).toBe(0);
    expect(res.stderr + res.stdout).not.toContain('PastedToken');
  }, 30_000);
});

describe('replay loads credentials before --fault touches the app and before --times launches a browser', () => {
  // No mock app runs and Playwright gets an empty browsers dir: without the early load, --fault
  // would fail on its POST ("--fault setup failed") and --times on chromium.launch, not on credentials.
  const missing = (): string => `file:${path.join(tempDir('cred-missing-'), 'none.json')}`;
  const noBrowsers = (): Record<string, string> => ({ PLAYWRIGHT_BROWSERS_PATH: tempDir('no-browsers-') });

  it('--fault: refuses on the credentials, the fault endpoint is never called', async () => {
    const res = await runCli(['replay', EXAMPLE, '--input', 'memberId=12345', '--fault', '{"failSearch":true}', '--credentials', missing()], noBrowsers());
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('refusing to start (no browser launched)');
    expect(res.stderr).not.toContain('--fault setup failed');
    expect(res.stderr).not.toContain('fault injected');
  }, 30_000);

  it('--times 2: refuses on the credentials before any browser launch', async () => {
    const res = await runCli(['replay', EXAMPLE, '--input', 'memberId=12345', '--times', '2', '--credentials', missing()], noBrowsers());
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('refusing to start (no browser launched)');
    expect(res.stderr).not.toMatch(/Executable doesn't exist|browserType\.launch/);
  }, 30_000);
});

function discoverOptions(overrides: Partial<RunDiscoverOptions>): RunDiscoverOptions {
  return {
    goal: 'Look up member 12345.',
    input: ['memberId=12345'],
    sensitive: [],
    output: ['memberName:string'],
    id: 'credentials-cli-unit-test',
    entry: '/login',
    vendor: 'Acme Core Systems',
    product: 'CU Core Workstation',
    operatorPort: 0,
    autoOperator: 'abort',
    policy: 'policies/default.yaml',
    runsDir: tempDir('cred-cli-runs-'),
    headless: true,
    baseUrl: 'http://localhost:4173',
    ...overrides,
  };
}

describe('discover --secret and the credential preflight', () => {
  it('keeps the mock names as the default list', () => {
    expect(DEFAULT_SECRET_NAMES).toEqual(['MOCK_USER', 'MOCK_PASSWORD']);
  });

  it('--secret replaces the default list: the run asks the provider for exactly those names', async () => {
    let asked: readonly string[] = [];
    const spy: CredentialProvider = {
      id: 'spy',
      load: (names) => {
        asked = names;
        return Promise.resolve({ ok: true, set: credentialSet({}) });
      },
    };
    const lines: string[] = [];
    const opts = discoverOptions({ secret: ['APP_USER', 'APP_TOKEN', 'APP_USER'], credentials: spy });
    const result = await runDiscover(opts, { print: (l) => lines.push(l) });
    expect(asked).toEqual(['APP_USER', 'APP_TOKEN']);
    expect(result).toEqual({ exitCode: 1, runDir: '' });
    expect(lines.join('\n')).toContain('credentials (spy): not set: APP_USER, APP_TOKEN; refusing to start (no browser launched)');
    expect(fs.readdirSync(opts.runsDir)).toEqual([]);
  });

  it('a missing credential fails before the API-key check, the console or a run directory, and prints no value', async () => {
    const lines: string[] = [];
    const opts = discoverOptions({ credentials: envCredentialProvider({ MOCK_USER: 'present-user-value' }) });
    const result = await runDiscover(opts, { print: (l) => lines.push(l) });
    expect(result).toEqual({ exitCode: 1, runDir: '' });
    const out = lines.join('\n');
    expect(out).toContain('credentials (env): not set: MOCK_PASSWORD');
    expect(out).not.toContain('present-user-value');
    expect(out).not.toContain('ANTHROPIC_API_KEY');
    expect(fs.readdirSync(opts.runsDir)).toEqual([]);
  });

  it('an invalid --secret name is refused by name', async () => {
    const lines: string[] = [];
    const result = await runDiscover(discoverOptions({ secret: ['lower_case'] }), { print: (l) => lines.push(l) });
    expect(result.exitCode).toBe(1);
    expect(lines.join('\n')).toContain('not a valid credential name');
  });

  it('a leak refusal names the credential or input, never the value', () => {
    const creds = credentialSet({ APP_TOKEN: 'tok-123-secret', APP_USER: 'someone' });
    const labels = leakedLabels('{"x": "has tok-123-secret inside"}', { acct: { value: 'acct-99', sensitive: true, description: 'd', type: 'string' } }, creds);
    expect(labels).toEqual(['credential APP_TOKEN']);
    expect(labels.join()).not.toContain('tok-123');
  });

  it('the leak scan covers every loaded credential (3+ chars), whatever its name', () => {
    const forbidden = forbiddenValues({ x: { value: 'sens-val', sensitive: true, description: 'd', type: 'string' } }, credentialSet({ APP_TOKEN: 'tok-123', PIN: '42' }));
    expect(forbidden.sort()).toEqual(['sens-val', 'tok-123']);
  });
});

describe('runReplay: credentials are loaded before anything starts', () => {
  it('throws CredentialsUnavailableError naming the missing names and provider; no console, no run directory', async () => {
    const runsDir = tempDir('cred-replay-runs-');
    let consoleStarted = false;
    const capability = JSON.parse(fs.readFileSync('artifacts/examples/lookup-member-savings-balance.example.json', 'utf8')) as unknown;
    const run = runReplay({
      capability,
      inputs: { memberId: '12345' },
      policyPath: 'policies/default.yaml',
      runsDir,
      baseUrl: 'http://localhost:4173',
      headless: true,
      autoOperator: 'none',
      operator: { port: 0 },
      surface: createCuCoreSurface(),
      startConsole: () => {
        consoleStarted = true;
        return Promise.reject(new Error('should not start'));
      },
      credentials: envCredentialProvider({ MOCK_USER: 'present-user-value' }),
    });
    await expect(run).rejects.toBeInstanceOf(CredentialsUnavailableError);
    await expect(run).rejects.toThrow('credentials (env): not set: MOCK_PASSWORD; refusing to start (no browser launched)');
    await run.catch((err: CredentialsUnavailableError) => {
      expect(err.failure).toMatchObject({ code: 'missing', providerId: 'env', names: ['MOCK_PASSWORD'] });
      expect(JSON.stringify(err.failure)).not.toContain('present-user-value');
    });
    expect(consoleStarted).toBe(false);
    expect(fs.readdirSync(runsDir)).toEqual([]);
  });

  it('catalog invoke fails the same way, before a console or a run directory', async () => {
    const runsDir = tempDir('cred-catalog-runs-');
    const cat = loadCatalog('artifacts');
    const invoked = cat.invoke('lookup-member-savings-balance', { memberId: '12345' }, {
      baseUrl: 'http://localhost:4173',
      policyPath: 'policies/default.yaml',
      runsDir,
      surface: createCuCoreSurface(),
      operator: { port: 0 },
      credentials: envCredentialProvider({}),
    });
    await expect(invoked).rejects.toBeInstanceOf(CredentialsUnavailableError);
    expect(fs.readdirSync(runsDir)).toEqual([]);
  });
});
