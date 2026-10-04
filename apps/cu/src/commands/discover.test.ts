/**
 * Unit tests for the `discover` CLI command core (`runDiscover`) and its pure flag-parsing
 * helpers. No real browser is launched and no network call is made anywhere in this file: see
 * tests/e2e/discover.test.ts for the end-to-end run against the real mock app with a scripted
 * LLM and a real (headless) Playwright surface.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { entryPathError, parseInputDecls, parseOutputDecls, runDiscover, type RunDiscoverOptions } from './discover.js';
import { createScriptedLlm, requestText, type LlmClient } from '@cu/core/agent';
import type { ObservedElement, Surface, SurfaceAction } from '@cu/core/surface';
import type { Policy } from '@cu/core/schema';

// runDiscover's secret preflight runs before the API-key gate; the CLI's loadEnv() supplies these
// demo defaults in real use, so give the tests the same environment on a clean machine.
process.env.MOCK_USER ??= 'operator1';
process.env.MOCK_PASSWORD ??= 'demo-pass-123';

// ---------------------------------------------------------------------------------------------
// parseInputDecls / parseOutputDecls
// ---------------------------------------------------------------------------------------------

describe('parseInputDecls', () => {
  it('builds a string InputDecl per name=value pair, sensitive flag from --sensitive', () => {
    const decls = parseInputDecls(['memberId=12345', 'lastName=Sample'], ['lastName']);
    expect(Object.keys(decls)).toEqual(['memberId', 'lastName']);
    expect(decls.memberId).toEqual({ value: '12345', sensitive: false, description: '"memberId" (supplied on the command line)', type: 'string' });
    expect(decls.lastName?.sensitive).toBe(true);
    // Always 'string', even for an all-digit value -- the CLI never guesses a numeric type.
    expect(decls.memberId?.type).toBe('string');
  });

  it('rejects a --sensitive name with no matching --input', () => {
    expect(() => parseInputDecls(['memberId=12345'], ['password'])).toThrow(/--sensitive password does not match/);
  });

  it('rejects a malformed name=value pair', () => {
    expect(() => parseInputDecls(['not-a-pair'], [])).toThrow(/--input expects name=value/);
  });

  it('rejects an input name that is not a valid identifier', () => {
    expect(() => parseInputDecls(['member-id=12345'], [])).toThrow(/not a valid identifier/);
  });
});

describe('parseOutputDecls', () => {
  it('builds a typed OutputDecl per name:type pair', () => {
    const decls = parseOutputDecls(['savingsBalance:number', 'memberName:string', 'isActive:boolean']);
    expect(decls.savingsBalance).toEqual({ type: 'number', description: '"savingsBalance" (declared on the command line)' });
    expect(decls.memberName?.type).toBe('string');
    expect(decls.isActive?.type).toBe('boolean');
  });

  it('rejects an unknown type', () => {
    expect(() => parseOutputDecls(['savingsBalance:currency'])).toThrow(/type must be one of string\|number\|boolean/);
  });

  it('rejects a pair with no colon', () => {
    expect(() => parseOutputDecls(['savingsBalance'])).toThrow(/expects name:type/);
  });

  it('rejects an output name that is not a valid identifier', () => {
    expect(() => parseOutputDecls(['savings-balance:number'])).toThrow(/not a valid identifier/);
  });
});

// ---------------------------------------------------------------------------------------------
// runDiscover: flag validation and the missing-API-key fail-fast path.
// ---------------------------------------------------------------------------------------------

function baseOptions(overrides: Partial<RunDiscoverOptions> = {}): RunDiscoverOptions {
  return {
    goal: 'Log in, look up member 12345 and read their current savings balance.',
    input: ['memberId=12345'],
    sensitive: [],
    output: ['savingsBalance:number', 'memberName:string'],
    // Not an id under artifacts/: the default output path must not exist, or runDiscover refuses
    // to start (see the overwrite tests below).
    id: 'discover-cli-unit-test',
    entry: '/login',
    vendor: 'Acme Core Systems',
    product: 'CU Core Workstation',
    operatorPort: 0,
    autoOperator: 'none',
    policy: 'policies/default.yaml',
    runsDir: 'runs',
    headless: true,
    baseUrl: 'http://localhost:4173',
    ...overrides,
  };
}

const silence = (): void => {
  /* swallow progress lines in these tests */
};

describe('entryPathError', () => {
  it('accepts URL paths, a path without its leading slash, and "" (the base URL itself)', () => {
    for (const ok of ['/login', '/', 'login', '', '/members/search?x=1', '//login']) expect(entryPathError(ok), ok).toBeUndefined();
  });

  it('rejects what Git Bash makes of a leading-slash argument, and other filesystem paths', () => {
    for (const bad of ['C:/Program Files/Git/', 'C:/Program Files/Git/login', 'c:\\tmp', 'D:', '\\login', 'login\\x']) {
      expect(entryPathError(bad), bad).toMatch(/filesystem path.*MSYS_NO_PATHCONV=1/s);
    }
  });

  it('rejects a full URL: the origin belongs in --base-url', () => {
    expect(entryPathError('https://example.test/login')).toMatch(/full URL/);
  });
});

describe('runDiscover: flag validation (no resources touched)', () => {
  it('rejects an --id that is not kebab-case', async () => {
    const result = await runDiscover(baseOptions({ id: 'Not_Kebab' }), { print: silence });
    expect(result).toEqual({ exitCode: 1, runDir: '' });
  });

  it('rejects a run with no --input', async () => {
    const result = await runDiscover(baseOptions({ input: [] }), { print: silence });
    expect(result).toEqual({ exitCode: 1, runDir: '' });
  });

  it('rejects a run with no --output', async () => {
    const result = await runDiscover(baseOptions({ output: [] }), { print: silence });
    expect(result).toEqual({ exitCode: 1, runDir: '' });
  });

  it('rejects a --sensitive name with no matching --input', async () => {
    const result = await runDiscover(baseOptions({ sensitive: ['password'] }), { print: silence });
    expect(result).toEqual({ exitCode: 1, runDir: '' });
  });

  it('rejects an --extend path that does not exist', async () => {
    const result = await runDiscover(baseOptions({ extend: path.join(os.tmpdir(), 'does-not-exist-1234.json') }), { print: silence });
    expect(result).toEqual({ exitCode: 1, runDir: '' });
  });

  it('rejects --allow-unattended-irreversible without --auto-operator approve', async () => {
    const lines: string[] = [];
    const result = await runDiscover(baseOptions({ allowUnattendedIrreversible: true, autoOperator: 'none' }), { print: (l) => lines.push(l) });
    expect(result).toEqual({ exitCode: 1, runDir: '' });
    expect(lines).toContain('discover: --allow-unattended-irreversible only applies with --auto-operator approve');
  });

  it('rejects an --entry that Git Bash turned into a Windows path, before composing anything, and says how to fix it', async () => {
    const lines: string[] = [];
    const llm: LlmClient = {
      model: 'none',
      complete: () => Promise.reject(new Error('no model call may happen')),
    };
    // What `--entry /` reaches the program as under Git Bash.
    const result = await runDiscover(baseOptions({ entry: 'C:/Program Files/Git/' }), { print: (l) => lines.push(l), llm });
    expect(result).toEqual({ exitCode: 1, runDir: '' });
    const message = lines.join('\n');
    expect(message).toContain('"C:/Program Files/Git/" is a filesystem path');
    expect(message).toContain('MSYS_NO_PATHCONV=1');
    expect(message).toContain('--entry login');
  });

  it('rejects an --extend file that is not a valid capability', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'discover-cli-test-'));
    try {
      const badArtifact = path.join(dir, 'bad.json');
      writeFileSync(badArtifact, JSON.stringify({ not: 'a capability' }));
      const result = await runDiscover(baseOptions({ extend: badArtifact }), { print: silence });
      expect(result).toEqual({ exitCode: 1, runDir: '' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runDiscover: missing ANTHROPIC_API_KEY fails fast without touching the runs dir', () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  let runsDir: string;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    runsDir = mkdtempSync(path.join(os.tmpdir(), 'discover-cli-runs-'));
  });

  afterEach(() => {
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    rmSync(runsDir, { recursive: true, force: true });
  });

  it('exits 1 and never creates a run directory (i.e. never composes / launches a browser)', async () => {
    const lines: string[] = [];
    const result = await runDiscover(baseOptions({ runsDir }), { print: (l) => lines.push(l) });

    expect(result).toEqual({ exitCode: 1, runDir: '' });
    expect(lines.some((l) => l.includes('ANTHROPIC_API_KEY'))).toBe(true);
    // No run directory was created under runsDir: compose() (which mkdir's runs/<runId> before
    // ever constructing a surface) was never reached.
    expect(existsSync(runsDir) ? readdirSync(runsDir) : []).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// A minimal, in-memory Surface stub so deps.llm + deps.surface together can exercise the wiring
// past the API-key gate WITHOUT a real browser or any network I/O (deps.surface makes compose()
// skip createPlaywrightSurface entirely).
// ---------------------------------------------------------------------------------------------

function stubSurface(): Surface {
  const png = Buffer.alloc(0);
  return {
    observe: async () => ({ url: 'http://stub.invalid/', title: 'stub', screenshotPng: png, elements: [], frames: [], textDigest: '' }),
    resolve: async () => ({ found: false, tried: [] }),
    act: async () => ({ ok: true }),
    readText: async () => ({ ok: true, text: '' }),
    check: async () => false,
    waitFor: async () => false,
    screenshot: async () => png,
    domSnapshot: async () => '',
    currentUrl: async () => 'http://stub.invalid/',
    close: async () => undefined,
  };
}

/** Immediately calls the `stuck` tool -- the loop's very first model turn. */
function stuckLlm(): LlmClient {
  return {
    model: 'stub',
    complete: async () => ({
      content: [{ type: 'tool_use', id: 'toolu_stub', name: 'stuck', input: { reason: 'stub: nothing to do' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 0, outputTokens: 0 },
      model: 'stub',
    }),
  };
}

describe('runDiscover: --base-url origin vs. the loaded policy', () => {
  let runsDir: string;

  beforeEach(() => {
    runsDir = mkdtempSync(path.join(os.tmpdir(), 'discover-cli-runs-'));
  });

  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true });
  });

  it('fails fast (exit 1, "cu: origin ... allowedOrigins") and never creates a run directory when --base-url is not in the loaded policy', async () => {
    const lines: string[] = [];
    const result = await runDiscover(baseOptions({ runsDir, baseUrl: 'http://localhost:4193' }), {
      llm: stuckLlm(),
      print: (l) => lines.push(l),
    });

    expect(result).toEqual({ exitCode: 1, runDir: '' });
    expect(lines).toContain('cu: origin http://localhost:4193 is not in policy policies/default.yaml allowedOrigins; add it or pass --policy');
    expect(existsSync(runsDir) ? readdirSync(runsDir) : []).toEqual([]);
  });

  it('an already-loaded deps.policy wins over the on-disk --policy file, mirroring compose()', async () => {
    const lines: string[] = [];
    const scriptedPolicy: Policy = {
      name: 'test',
      allowedOrigins: ['http://localhost:4193'],
      allowedPathPatterns: [],
      deniedPathPatterns: [],
      allowedActions: ['navigate', 'click', 'type', 'select', 'press', 'extract', 'wait', 'dismiss_dialog', 'switch_frame'],
      risk: { irreversibleTextPatterns: [], irreversibleUrlPatterns: [], discoveryMode: 'block', replayRequiresApproved: true },
      redaction: { patterns: [] },
      limits: { maxSteps: 100, maxDurationMs: 600_000, maxLlmCalls: 50 },
    };
    // Still ends 'aborted' (the stuck stub calls the `stuck` tool immediately, and --auto-operator
    // abort resolves that escalation instead of hanging forever waiting on a human) rather than
    // exiting 1 on the origin check -- proving the origin check itself passed under the scripted
    // policy.
    const result = await runDiscover(baseOptions({ runsDir, baseUrl: 'http://localhost:4193', autoOperator: 'abort' }), {
      llm: stuckLlm(),
      surface: stubSurface(),
      policy: scriptedPolicy,
      print: (l) => lines.push(l),
    });

    expect(lines.some((l) => l.startsWith('cu: origin'))).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.result?.status).toBe('aborted');
  });
});

describe('runDiscover: an injected deps.llm bypasses the API-key gate entirely', () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  let runsDir: string;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    runsDir = mkdtempSync(path.join(os.tmpdir(), 'discover-cli-runs-'));
  });

  afterEach(() => {
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    rmSync(runsDir, { recursive: true, force: true });
  });

  it('runs (and ends stuck, via the scripted stub) instead of failing on the missing key', async () => {
    const lines: string[] = [];
    const result = await runDiscover(baseOptions({ runsDir, autoOperator: 'abort' }), {
      llm: stuckLlm(),
      surface: stubSurface(),
      print: (l) => lines.push(l),
    });

    expect(lines.some((l) => l.includes('ANTHROPIC_API_KEY is not set'))).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.result?.status).toBe('aborted');
    expect(result.runDir).not.toBe('');
  });
});

// ---------------------------------------------------------------------------------------------
// The default output path is never overwritten.
// ---------------------------------------------------------------------------------------------

describe('runDiscover: an existing artifacts/<id>.json is never overwritten by default', () => {
  it('refuses to start (exit 1, nothing composed) when artifacts/<id>.json exists and --out was not given', async () => {
    const runsDir = mkdtempSync(path.join(os.tmpdir(), 'discover-cli-runs-'));
    try {
      // The tracked, recorded artifact: exists under artifacts/ in the working directory.
      const target = path.join('artifacts', 'lookup-member-savings-balance.json');
      expect(existsSync(target)).toBe(true);
      const lines: string[] = [];
      const result = await runDiscover(baseOptions({ id: 'lookup-member-savings-balance', runsDir }), {
        llm: stuckLlm(),
        surface: stubSurface(),
        print: (l) => lines.push(l),
      });

      expect(result).toEqual({ exitCode: 1, runDir: '' });
      expect(lines).toContain(
        `discover: ${target} already exists; refusing to overwrite it. Pass --out <path> to write the new capability elsewhere (or --out ${target} to replace it deliberately).`,
      );
      expect(readdirSync(runsDir)).toEqual([]);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  it('an explicit --out skips the check (the run proceeds past flag validation)', async () => {
    const runsDir = mkdtempSync(path.join(os.tmpdir(), 'discover-cli-runs-'));
    try {
      const result = await runDiscover(
        baseOptions({ id: 'lookup-member-savings-balance', out: path.join(runsDir, 'out.json'), runsDir, autoOperator: 'abort' }),
        { llm: stuckLlm(), surface: stubSurface(), print: silence },
      );
      expect(result.exitCode).toBe(2);
      expect(result.result?.status).toBe('aborted');
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// --auto-operator approve never confirms an irreversible action unless explicitly allowed.
// ---------------------------------------------------------------------------------------------

/** A page with one irreversible-looking button ("Confirm Transfer"); records every action run on it. */
function transferSurface(acted: SurfaceAction[]): Surface {
  const base = stubSurface();
  const button: ObservedElement = {
    ref: 'e1',
    role: 'button',
    name: 'Confirm Transfer',
    text: 'Confirm Transfer',
    tag: 'button',
    bbox: { x: 0, y: 0, w: 100, h: 20 },
    frame: [],
    enabled: true,
    descriptor: {
      description: 'Confirm Transfer button',
      frame: [],
      locators: [{ strategy: { kind: 'role', role: 'button', name: 'Confirm Transfer' }, confidence: 0.9, source: 'inferred' }],
    },
  };
  return {
    ...base,
    observe: async () => ({
      url: 'http://localhost:4173/transfer',
      title: 'transfer',
      screenshotPng: Buffer.alloc(0),
      elements: [button],
      frames: [],
      textDigest: 'Confirm Transfer',
    }),
    currentUrl: async () => 'http://localhost:4173/transfer',
    act: async (action: SurfaceAction) => {
      acted.push(action);
      return { ok: true };
    },
  };
}

const transferPolicy: Policy = {
  name: 'test',
  allowedOrigins: ['http://localhost:4173'],
  allowedPathPatterns: [],
  deniedPathPatterns: [],
  allowedActions: ['navigate', 'click', 'type', 'select', 'press', 'extract', 'wait', 'dismiss_dialog', 'switch_frame'],
  risk: { irreversibleTextPatterns: ['^(confirm|transfer)\\b'], irreversibleUrlPatterns: [], discoveryMode: 'escalate', replayRequiresApproved: true },
  redaction: { patterns: [] },
  limits: { maxSteps: 100, maxDurationMs: 600_000, maxLlmCalls: 50 },
};

describe('runDiscover: --auto-operator approve and irreversible actions', () => {
  let runsDir: string;

  beforeEach(() => {
    runsDir = mkdtempSync(path.join(os.tmpdir(), 'discover-cli-runs-'));
  });

  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true });
  });

  const clickConfirm = { tool: 'click', input: { ref: 'e1', why: 'confirm the transfer', expect: '' } };

  it('without --allow-unattended-irreversible, refuses the irreversible click (discoveryMode block) instead of approving it', async () => {
    const acted: SurfaceAction[] = [];
    const lines: string[] = [];
    const llm = createScriptedLlm([clickConfirm]);
    const result = await runDiscover(baseOptions({ runsDir, autoOperator: 'approve' }), {
      llm,
      surface: transferSurface(acted),
      policy: transferPolicy,
      print: (l) => lines.push(l),
    });

    expect(acted.filter((a) => a.type === 'click')).toEqual([]);
    expect(requestText(llm.requests[1]!)).toContain('Refused: this action is irreversible');
    expect(lines.some((l) => l.includes('[operator]') && l.includes('risky_action_confirmation'))).toBe(false);
    expect(lines).toContain('discover: --auto-operator approve refuses irreversible actions in this run (pass --allow-unattended-irreversible to let it confirm them).');
    // The script then runs out and calls `stuck`, which approve mode aborts.
    expect(result.result?.status).toBe('aborted');
  });

  it('with --allow-unattended-irreversible, the scripted operator confirms it and the click runs', async () => {
    const acted: SurfaceAction[] = [];
    const lines: string[] = [];
    const llm = createScriptedLlm([clickConfirm]);
    await runDiscover(baseOptions({ runsDir, autoOperator: 'approve', allowUnattendedIrreversible: true }), {
      llm,
      surface: transferSurface(acted),
      policy: transferPolicy,
      print: (l) => lines.push(l),
    });

    expect(lines.some((l) => l.includes('[operator]') && l.includes('risky_action_confirmation'))).toBe(true);
    expect(acted.filter((a) => a.type === 'click')).toHaveLength(1);
    expect(requestText(llm.requests[1]!)).not.toContain('Refused: this action is irreversible');
  });
});

// ---------------------------------------------------------------------------------------------
// Ctrl-C that lands after the capability is written reports the written file.
// ---------------------------------------------------------------------------------------------

/** A page with one value cell ("Savings Balance" -> 1234.56) where every success check passes. */
function balanceSurface(): Surface {
  const base = stubSurface();
  const cell: ObservedElement = {
    ref: 'e1',
    role: 'cell',
    name: '1234.56',
    text: '1234.56',
    tag: 'td',
    bbox: { x: 0, y: 0, w: 100, h: 20 },
    frame: [],
    enabled: true,
    descriptor: {
      description: 'cell right of "Savings Balance"',
      frame: [],
      locators: [{ strategy: { kind: 'relative', anchor: { text: 'Savings Balance' }, relation: 'right-of', tag: 'td' }, confidence: 0.8, source: 'inferred' }],
    },
  };
  return {
    ...base,
    observe: async () => ({
      url: 'http://localhost:4173/members',
      title: 'member',
      screenshotPng: Buffer.alloc(0),
      elements: [cell],
      frames: [],
      textDigest: 'Savings Balance 1234.56',
    }),
    currentUrl: async () => 'http://localhost:4173/members',
    readText: async () => ({ ok: true, text: '1234.56' }),
    check: async () => true,
    waitFor: async () => true,
  };
}

describe('runDiscover: Ctrl-C after the capability is written', () => {
  let runsDir: string;

  beforeEach(() => {
    runsDir = mkdtempSync(path.join(os.tmpdir(), 'discover-cli-runs-'));
  });

  afterEach(() => {
    process.exitCode = undefined;
    rmSync(runsDir, { recursive: true, force: true });
  });

  it('exits 130 and names the written capability instead of claiming none was written', async () => {
    const out = path.join(runsDir, 'out.json');
    const lines: string[] = [];
    const llm = createScriptedLlm([
      { tool: 'extract', input: { ref: 'e1', output: 'savingsBalance', parse: 'number', why: 'Read the savings balance' } },
      () => {
        // Ctrl-C while the final model turn is in flight: the run still finishes and writes.
        process.emit('SIGINT', 'SIGINT');
        return { tool: 'done', input: { success_text: 'Savings Balance', summary: 'Read the savings balance.' } };
      },
    ]);
    const result = await runDiscover(baseOptions({ runsDir, out, output: ['savingsBalance:number'], autoOperator: 'abort' }), {
      llm,
      surface: balanceSurface(),
      policy: { ...transferPolicy, risk: { ...transferPolicy.risk, irreversibleTextPatterns: [] } },
      print: (l) => lines.push(l),
    });

    expect(result.exitCode).toBe(130);
    expect(existsSync(out)).toBe(true);
    expect(result.artifactPath).toBe(path.resolve(out));
    expect(lines).toContain(`discover: interrupted by SIGINT; capability written to ${path.resolve(out)}`);
    expect(lines.some((l) => l.includes('no capability written'))).toBe(false);
  });
});
