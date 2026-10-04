/**
 * The CLI's judge factory (risk-judge.ts) and its wiring into `runDiscover`: `--risk-judge`
 * resolution against the environment, the start-of-run banner, the "judge is down" line, and the
 * run-summary line. Adapters are replaced by fakes; nothing here touches a network.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmClient } from '@cu/core/agent';
import type { RiskJudge } from '@cu/core/policy';
import { DEFAULT_POLICY_PATH, loadPolicy } from '@cu/core/policy';
import type { Surface } from '@cu/core/surface';
import { resolveRiskJudge, riskJudgeBanner, riskJudgeUnavailableLine, type RiskJudgeFactories } from './risk-judge.js';
import { runDiscover, type RunDiscoverOptions } from './discover.js';

const fake = (id: string): RiskJudge => ({ id, judge: async () => ({ risk: 'read', pIrreversible: 0 }) });
const FACTORIES: RiskJudgeFactories = { jev: () => fake('jev:jev-latest'), anthropic: () => fake('anthropic:claude-haiku-4-5-20251001') };

describe('resolveRiskJudge', () => {
  it('auto prefers Claude when its key is set, then Jev, then none', () => {
    expect(resolveRiskJudge('auto', { TYPESAFE_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' }, FACTORIES)).toMatchObject({ ok: true, label: 'anthropic:claude-haiku-4-5-20251001' });
    expect(resolveRiskJudge('auto', { ANTHROPIC_API_KEY: 'a' }, FACTORIES)).toMatchObject({ ok: true, label: 'anthropic:claude-haiku-4-5-20251001' });
    expect(resolveRiskJudge('auto', { TYPESAFE_API_KEY: 'k' }, FACTORIES)).toMatchObject({ ok: true, label: 'jev:jev-latest' });
    // A blank key is not a key.
    expect(resolveRiskJudge('auto', { TYPESAFE_API_KEY: 'k', ANTHROPIC_API_KEY: ' ' }, FACTORIES)).toMatchObject({ ok: true, label: 'jev:jev-latest' });
    const none = resolveRiskJudge('auto', { TYPESAFE_API_KEY: ' ' }, FACTORIES);
    expect(none).toMatchObject({ ok: true, label: 'off (no ANTHROPIC_API_KEY or TYPESAFE_API_KEY set: lexical patterns only)' });
    expect(none.ok && none.judge).toBeUndefined();
  });

  it('auto with both keys never builds the Jev adapter: the default adds no second vendor', () => {
    const built: string[] = [];
    const counting: RiskJudgeFactories = {
      jev: () => (built.push('jev'), fake('jev:jev-latest')),
      anthropic: () => (built.push('anthropic'), fake('anthropic:claude-haiku-4-5-20251001')),
    };
    resolveRiskJudge('auto', { TYPESAFE_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' }, counting);
    expect(built).toEqual(['anthropic']);
  });

  it('jev still selects Jev explicitly, whatever other key is set', () => {
    expect(resolveRiskJudge('jev', { TYPESAFE_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' }, FACTORIES)).toMatchObject({ ok: true, label: 'jev:jev-latest' });
    expect(resolveRiskJudge('anthropic', { TYPESAFE_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' }, FACTORIES)).toMatchObject({ ok: true, label: 'anthropic:claude-haiku-4-5-20251001' });
  });

  it('an explicit adapter without its key is a refusal, not a silent downgrade', () => {
    expect(resolveRiskJudge('jev', { ANTHROPIC_API_KEY: 'a' }, FACTORIES)).toEqual({ ok: false, error: '--risk-judge jev needs TYPESAFE_API_KEY to be set' });
    expect(resolveRiskJudge('anthropic', { TYPESAFE_API_KEY: 'k' }, FACTORIES)).toMatchObject({ ok: false });
  });

  it('off never builds a judge', () => {
    const r = resolveRiskJudge('off', { TYPESAFE_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' }, FACTORIES);
    expect(r.ok && r.judge).toBeUndefined();
  });

  it('the real factories never put a key in the label', () => {
    const r = resolveRiskJudge('jev', { TYPESAFE_API_KEY: 'ts-secret-value-123' });
    expect(r.ok && r.label).toBe('jev:jev-latest');
    expect(JSON.stringify(r)).not.toContain('ts-secret-value-123');
  });
});

describe('banner and unavailable line', () => {
  const policy = loadPolicy(DEFAULT_POLICY_PATH);

  it('names the judge and how the policy applies it', () => {
    expect(riskJudgeBanner({ judge: fake('jev:jev-latest'), label: 'jev:jev-latest' }, policy)).toBe(
      'risk judge: jev:jev-latest (enforce, irreversible at p >= 0.5, fail_closed, 5000ms)',
    );
    expect(riskJudgeBanner({ label: 'off (--risk-judge off: lexical patterns only)' }, policy)).toBe('risk judge: off (--risk-judge off: lexical patterns only)');
    const off = { ...policy, risk: { ...policy.risk, judge: { mode: 'off' as const, irreversibleThreshold: 0.5, onError: 'fail_closed' as const, timeoutMs: 5000 } } };
    expect(riskJudgeBanner({ judge: fake('x'), label: 'x' }, off)).toContain('policy risk.judge.mode is off');
  });

  it('tells the operator the judge is down and how to proceed lexical-only', () => {
    const line = riskJudgeUnavailableLine({ judge: 'jev:jev-latest', reason: 'JevJudgeError: jev: HTTP 529 overloaded', onError: 'fail_closed' });
    expect(line).toContain('unavailable');
    expect(line).toContain('escalates to a human');
    expect(line).toContain('--risk-judge off');
  });
});

// ---------------------------------------------------------------------------------------------
// runDiscover wiring
// ---------------------------------------------------------------------------------------------

function baseOptions(overrides: Partial<RunDiscoverOptions> = {}): RunDiscoverOptions {
  return {
    goal: 'Look up a member.',
    input: ['memberId=12345'],
    sensitive: [],
    output: ['savingsBalance:number'],
    id: 'discover-risk-judge-unit-test',
    entry: '/login',
    vendor: 'Acme Core Systems',
    product: 'CU Core Workstation',
    operatorPort: 0,
    autoOperator: 'abort',
    policy: 'policies/default.yaml',
    runsDir: 'runs',
    headless: true,
    baseUrl: 'http://localhost:4173',
    ...overrides,
  };
}

function stubSurface(): Surface {
  const png = Buffer.alloc(0);
  return {
    observe: async () => ({ url: 'http://localhost:4173/login', title: 'stub', screenshotPng: png, elements: [], frames: [], textDigest: '' }),
    resolve: async () => ({ found: false, tried: [] }),
    act: async () => ({ ok: true }),
    readText: async () => ({ ok: true, text: '' }),
    check: async () => false,
    waitFor: async () => false,
    screenshot: async () => png,
    domSnapshot: async () => '',
    currentUrl: async () => 'http://localhost:4173/login',
    close: async () => undefined,
  };
}

function stuckLlm(): LlmClient {
  return {
    model: 'stub',
    complete: async () => ({
      content: [{ type: 'tool_use', id: 'toolu_stub', name: 'stuck', input: { reason: 'stub' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 0, outputTokens: 0 },
      model: 'stub',
    }),
  };
}

describe('runDiscover: risk judge wiring', () => {
  const saved = { ...process.env };
  let runsDir: string;

  beforeEach(() => {
    runsDir = mkdtempSync(path.join(os.tmpdir(), 'discover-judge-runs-'));
    process.env.MOCK_USER ??= 'operator1';
    process.env.MOCK_PASSWORD ??= 'demo-pass-123';
  });

  afterEach(() => {
    process.env = { ...saved };
    rmSync(runsDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('an injected judge is announced at start and reported in the run summary', async () => {
    const lines: string[] = [];
    const reported: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l: unknown) => void reported.push(String(l)));
    const result = await runDiscover(baseOptions({ runsDir }), { llm: stuckLlm(), judge: fake('fake-judge'), surface: stubSurface(), print: (l) => lines.push(l) });
    expect(result.exitCode).toBe(2);
    expect(lines).toContain('discover: risk judge: fake-judge (enforce, irreversible at p >= 0.5, fail_closed, 5000ms)');
    expect(reported.some((l) => l.startsWith('risk judge calls: 0 (fake-judge, enforce;'))).toBe(true);
  });

  it('an injected LLM without an injected judge runs lexical-only (existing tests keep their behaviour)', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runDiscover(baseOptions({ runsDir }), { llm: stuckLlm(), surface: stubSurface(), print: (l) => lines.push(l) });
    expect(lines).toContain('discover: risk judge: off (no judge injected)');
  });

  it('--risk-judge jev without TYPESAFE_API_KEY refuses to start before any browser is launched', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
    delete process.env.TYPESAFE_API_KEY;
    const lines: string[] = [];
    const result = await runDiscover(baseOptions({ runsDir, riskJudge: 'jev' }), { print: (l) => lines.push(l) });
    expect(result).toEqual({ exitCode: 1, runDir: '' });
    expect(lines.some((l) => l.includes('--risk-judge jev needs TYPESAFE_API_KEY'))).toBe(true);
    expect(existsSync(runsDir) ? readdirSync(runsDir) : []).toEqual([]);
  });
});
