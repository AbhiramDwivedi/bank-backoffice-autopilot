/**
 * Red team: a sensitive output (OutputSpec.sensitive -- read from a masked element at discovery)
 * is returned to the caller but never persisted: not in result.json, events.jsonl (including the
 * enforcing surface's policy events, which quote action targets), DOM snapshots, or a failure's
 * `observed` text. Same grep-the-run-directory style as rundir-leak.redteam.test.ts.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunLogger, newRunId } from '../evidence/index.js';
import { createPolicyGuard, withPolicy } from '../policy/index.js';
import { DEFAULT_POLICY_PATH, loadPolicy } from '../policy/load.js';
import { REDACTED_VALUE, type Capability } from '../schema/index.js';
import { createCuCoreScenario } from '../surface/fake-scenarios/cu-core.js';
import { FakeSurface } from '../surface/fake/surface.js';
import { replayCapability } from './replay.js';
import { BASE_A, MOCK_PASSWORD, MOCK_USER, loadExample, makeFakeClock } from './test-helpers.js';

const BALANCE_FORMS = ['$1,234.56', '1,234.56', '1234.56'];
const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function assertClean(dir: string, needles: readonly string[]): void {
  for (const f of walk(dir)) {
    const text = readFileSync(f).toString('latin1');
    for (const n of needles) expect(text, `${n} leaked into ${path.relative(dir, f)}`).not.toContain(n);
  }
}

function sensitiveCapability(): Capability {
  const cap = structuredClone(loadExample());
  cap.outputs.savingsBalance = { ...cap.outputs.savingsBalance!, sensitive: true };
  return cap;
}

/** cu-core with the savings balance masked (as a masking surface reports it), optionally drifted. */
function surface(balanceText?: string): FakeSurface {
  const sc = createCuCoreScenario();
  for (const screen of Object.values(sc.screens)) {
    screen.elements = screen.elements.map((e) =>
      e.id === 'savingsBalance' ? { ...e, masked: 'savings_balance', ...(balanceText !== undefined ? { text: balanceText, name: balanceText } : {}) } : e,
    );
  }
  return new FakeSurface(sc, { clock: makeFakeClock() });
}

async function run(cap: Capability, raw: FakeSurface) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'sensitive-output-'));
  tempDirs.push(rootDir);
  const logger = createRunLogger({ runId: newRunId(), runKind: 'replay', rootDir });
  const policy = loadPolicy(DEFAULT_POLICY_PATH);
  const guard = createPolicyGuard(policy);
  // The enforcing surface's decisions go straight to the run logger, as compose() wires them.
  const guarded = withPolicy(raw, guard, { runKind: 'replay', onDecision: (e) => logger.event({ kind: 'policy', data: { source: 'enforcing-surface', ...e } }) });
  const result = await replayCapability({
    capability: cap,
    inputs: { memberId: '12345' },
    surface: guarded,
    baseUrl: BASE_A,
    policy: guard,
    logger,
    secret: (env) => ({ MOCK_USER, MOCK_PASSWORD })[env],
    clock: makeFakeClock(),
    stepTimeoutMs: 2000,
  });
  return { result, dir: logger.dir };
}

describe('sensitive outputs in replay', () => {
  it('success: the caller gets the value; result.json has [REDACTED]; nothing in the run directory carries it', async () => {
    const { result, dir } = await run(sensitiveCapability(), surface());
    expect(result.kind).toBe('success');
    if (result.kind === 'success') expect(result.outputs.savingsBalance).toBe(1234.56);
    const persisted = JSON.parse(readFileSync(path.join(dir, 'result.json'), 'utf8')) as { outputs: Record<string, unknown> };
    expect(persisted.outputs.savingsBalance).toBe(REDACTED_VALUE);
    expect(persisted.outputs.memberName).toBe('Jane Q. Sample'); // non-sensitive outputs are untouched
    assertClean(dir, BALANCE_FORMS);
    // The policy events did run (and quote targets in the masked view).
    expect(readFileSync(path.join(dir, 'events.jsonl'), 'utf8')).toContain('enforcing-surface');
  });

  it('a parse failure on a sensitive output never quotes the text, in the result, the events or the DOM evidence', async () => {
    const token = 'N/A-ZZTOPSECRET';
    const { result, dir } = await run(sensitiveCapability(), surface(token));
    expect(result.kind).toBe('hard_failure');
    expect(JSON.stringify(result)).not.toContain(token);
    assertClean(dir, [token, token.toLowerCase()]);
  });

  it('a non-sensitive output read from unmasked content is persisted as before (control)', async () => {
    const { result, dir } = await run(structuredClone(loadExample()), new FakeSurface(createCuCoreScenario(), { clock: makeFakeClock() }));
    expect(result.kind).toBe('success');
    const persisted = JSON.parse(readFileSync(path.join(dir, 'result.json'), 'utf8')) as { outputs: Record<string, unknown> };
    expect(persisted.outputs.savingsBalance).toBe(1234.56);
  });

  it('an output the capability does not flag, read from masked content, is treated as sensitive, and a policy event says so', async () => {
    const { result, dir } = await run(structuredClone(loadExample()), surface());
    expect(result.kind).toBe('success');
    if (result.kind === 'success') expect(result.outputs.savingsBalance).toBe(1234.56);
    const persisted = JSON.parse(readFileSync(path.join(dir, 'result.json'), 'utf8')) as { outputs: Record<string, unknown> };
    expect(persisted.outputs.savingsBalance).toBe(REDACTED_VALUE);
    assertClean(dir, BALANCE_FORMS);
    const events = readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    expect(events).toContain('"gate":"screen_mask"');
    expect(events).toContain('"output":"savingsBalance"');
  });
});
