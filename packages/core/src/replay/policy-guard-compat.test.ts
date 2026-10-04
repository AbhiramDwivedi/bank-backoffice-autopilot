/**
 * The replay engine codes against PolicyGuardLike (types.ts) so it compiles independently of the
 * concrete policy implementation. This pins the seam: the real createPolicyGuard(policy) must
 * stay assignable to it, and the example capability must replay cleanly under the default policy.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunLogger } from '../evidence/index.js';
import { createPolicyGuard } from '../policy/guard.js';
import { DEFAULT_POLICY_PATH, loadPolicy } from '../policy/load.js';
import { createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';
import { replayCapability, type PolicyGuardLike } from './index.js';

const EXAMPLE = new URL('../../../../artifacts/examples/lookup-member-savings-balance.example.json', import.meta.url);
const SECRETS: Record<string, string> = { MOCK_USER: 'operator1', MOCK_PASSWORD: 'demo-pass-123' };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('real policy guard vs PolicyGuardLike', () => {
  it('createPolicyGuard(default policy) is a PolicyGuardLike and the example replays under it', async () => {
    const guard: PolicyGuardLike = createPolicyGuard(loadPolicy(DEFAULT_POLICY_PATH));
    const rootDir = mkdtempSync(path.join(os.tmpdir(), 'replay-guard-'));
    dirs.push(rootDir);
    const logger = createRunLogger({ runId: 'run_20260925_guard001', runKind: 'replay', rootDir });
    const result = await replayCapability({
      capability: JSON.parse(readFileSync(EXAMPLE, 'utf8')),
      inputs: { memberId: '12345' },
      surface: createCuCoreSurface(),
      baseUrl: 'http://localhost:4173',
      policy: guard,
      logger,
      secret: (env) => SECRETS[env],
    });
    expect(result).toMatchObject({ kind: 'success', outputs: { savingsBalance: 1234.56 } });
    const events = readFileSync(path.join(logger.dir, 'events.jsonl'), 'utf8');
    expect(events).toContain('"kind":"policy"');
    expect(events).not.toContain('"decision":"deny"');
  });

  it('a navigate outside the allowlist is a policy_violation under the real guard', async () => {
    const cap = JSON.parse(readFileSync(EXAMPLE, 'utf8')) as { steps: { action: { url?: string } }[] };
    const guard: PolicyGuardLike = createPolicyGuard(loadPolicy(DEFAULT_POLICY_PATH));
    const rootDir = mkdtempSync(path.join(os.tmpdir(), 'replay-guard-'));
    dirs.push(rootDir);
    const logger = createRunLogger({ runId: 'run_20260925_guard002', runKind: 'replay', rootDir });
    const result = await replayCapability({
      capability: cap,
      inputs: { memberId: '12345' },
      surface: createCuCoreSurface(),
      baseUrl: 'http://evil.example.com',
      policy: guard,
      logger,
      secret: (env) => SECRETS[env],
    });
    expect(result).toMatchObject({ kind: 'hard_failure', code: 'policy_violation', stepId: 's01' });
  });
});
