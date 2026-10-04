/**
 * Grep-the-run-directory check: every evidence file a run writes must be free of any bound
 * secret or sensitive value, in any encoding.
 *
 * Runs a real `replayCapability()` against `FakeSurface` with:
 *   - a secret password bound via `{kind:'secret', env}` (existing login steps of the example
 *     capability),
 *   - a `sensitive: true` input (an account-number-shaped value) typed into a non-password field,
 *   - a step whose action deliberately echoes that sensitive value into a navigate URL (so the
 *     surface's own "no such route" error message embeds it), forcing a `hard_failure` with a
 *     DOM snapshot of the still-filled-in form,
 *   - a second run where a legacy-host-style error message echoes the value back in a DIFFERENT
 *     CASE (uppercase) -- simulating a mainframe-descended app that upcases input -- while the
 *     step escalates, so an `interventions/<id>.json` file is also written to the run dir.
 *
 * Then every file under the run directory is grepped for the secret/sensitive value in: raw form,
 * base64 (standard and url-safe), URL-encoded (`encodeURIComponent` and the `+`-for-space form),
 * HTML-entity-encoded, and upper/lower-case variants.
 *
 * Guarantee under test: no bound secret or sensitive input value reaches `events.jsonl`,
 * `result.json`, `dom/*.html`, or `interventions/*.json`, in any of the above forms.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateCapability, type Step, type TargetDescriptor } from '../schema/index.js';
import { loadPolicy, DEFAULT_POLICY_PATH } from '../policy/load.js';
import { createPolicyGuard, withPolicy } from '../policy/index.js';
import { createRedactor, createRunLogger, newRunId, redactionPatternsFromPolicy } from '../evidence/index.js';
import { createSessionBroker } from '../session/index.js';
import type { Policy } from '../schema/index.js';
import type { Surface } from '../surface/types.js';
import { replayCapability } from './replay.js';
import { createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';
import { BASE_A, MOCK_PASSWORD, MOCK_USER, loadExample, makeFakeClock } from './test-helpers.js';

// An account-number-shaped secret with a space, an ampersand and a slash, in mixed case, so that
// base64 / URL-encoding / HTML-entity-encoding / case-folding all actually produce DIFFERENT
// strings from the raw value (a plain digit string would make every encoding a no-op).
const SENSITIVE_VALUE = 'AcctNum 42&Test/07';

function encodingVariants(raw: string): { label: string; value: string }[] {
  const b64 = Buffer.from(raw, 'utf8').toString('base64');
  const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const urlEnc = encodeURIComponent(raw);
  const urlEncPlus = urlEnc.replace(/%20/g, '+');
  const htmlEntity = raw.replace(/&/g, '&amp;');
  const jsonEscaped = JSON.stringify(raw).slice(1, -1);
  const upper = raw.toUpperCase();
  const lower = raw.toLowerCase();
  const variants = [
    { label: 'raw', value: raw },
    { label: 'base64 (std)', value: b64 },
    { label: 'base64 (url-safe)', value: b64url },
    { label: 'URL-encoded (encodeURIComponent)', value: urlEnc },
    { label: 'URL-encoded (+-for-space)', value: urlEncPlus },
    { label: 'HTML-entity-encoded', value: htmlEntity },
    { label: 'JSON-escaped', value: jsonEscaped },
    { label: 'uppercase', value: upper },
    { label: 'lowercase', value: lower },
  ];
  // De-dupe (short/simple secrets can make several encodings coincide) and drop anything too
  // short to be meaningful (matches the system's own <3-char scrub floor).
  const seen = new Set<string>();
  return variants.filter((v) => v.value.length >= 3 && !seen.has(v.value) && seen.add(v.value));
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** Reads every file under `dir` as both utf8 text and latin1 (byte-preserving) text, so a binary
 *  file (a screenshot PNG) is still scanned for the raw ASCII bytes of a leaked secret. */
function readAllRunDirText(dir: string): { file: string; utf8: string; latin1: string }[] {
  return walkFiles(dir).map((file) => {
    const buf = readFileSync(file);
    return { file, utf8: buf.toString('utf8'), latin1: buf.toString('latin1') };
  });
}

function assertNoneLeak(dir: string, variants: { label: string; value: string }[]): void {
  const files = readAllRunDirText(dir);
  for (const { label, value } of variants) {
    for (const { file, utf8, latin1 } of files) {
      expect(utf8, `${label} (${JSON.stringify(value)}) leaked into ${path.relative(dir, file)} (utf8)`).not.toContain(value);
      expect(latin1, `${label} (${JSON.stringify(value)}) leaked into ${path.relative(dir, file)} (latin1)`).not.toContain(value);
    }
  }
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

const LAST_NAME_TARGET: TargetDescriptor = {
  description: 'Last Name field on the member search form (test-only use).',
  frame: [{ name: 'main' }],
  locators: [{ strategy: { kind: 'label', label: 'Last Name' }, confidence: 0.8, source: 'recorded' }],
};

const SEARCH_TARGET: TargetDescriptor = {
  description: 'Search button on the member search form (test-only use).',
  frame: [{ name: 'main' }],
  locators: [{ strategy: { kind: 'text', text: 'Search', exact: true }, confidence: 0.6, source: 'recorded' }],
};

function buildLeakCapability(): ReturnType<typeof loadExample> {
  const cap = structuredClone(loadExample());
  cap.inputs.acctNumber = {
    type: 'string',
    description: 'Sensitive account number (redteam test).',
    required: true,
    sensitive: true,
  };
  const s05Index = cap.steps.findIndex((s) => s.id === 's05');
  if (s05Index === -1) throw new Error('test: example capability has no step s05');

  const sAcct: Step = {
    id: 'sAcctLeak',
    name: 'Enter account number (redteam test)',
    risk: 'read',
    action: { type: 'type', target: LAST_NAME_TARGET, value: { kind: 'input', name: 'acctNumber' }, clear: true },
  };
  cap.steps.splice(s05Index + 1, 0, sAcct);
  return cap;
}

/**
 * Mirrors the production composition root (apps/cu/src/runtime/compose.ts: raw surface -> withPolicy ->
 * session broker, logger with the policy's redaction patterns) using only the modules it
 * composes, so this test does not depend on the CLI layer. Keep in step with compose().
 */
function composeForTest(policy: Policy, rootDir: string, raw: Surface) {
  const guard = createPolicyGuard(policy);
  const runId = newRunId();
  const logger = createRunLogger({
    runId,
    runKind: 'replay',
    rootDir,
    redactor: createRedactor({ patterns: redactionPatternsFromPolicy(policy.redaction.patterns) }),
  });
  const policySurface = withPolicy(raw, guard, {
    runKind: 'replay',
    onDecision: (e) => {
      try {
        logger.event({ kind: 'policy', data: { source: 'enforcing-surface', ...e } });
      } catch {
        /* logger already finished */
      }
    },
  });
  const broker = createSessionBroker({ surface: policySurface, logger, runId, runKind: 'replay', capture: policySurface.humanCapture ?? raw.humanCapture ?? null });
  return {
    guard,
    logger,
    broker,
    surface: broker.surface,
    escalate: (req: Parameters<typeof broker.escalate>[0]) => broker.escalate(req),
    close: async () => {
      await raw.close();
    },
  };
}

describe('run-dir grep -- secret and sensitive values must never leak, in any encoding', () => {
  it('a navigate step that echoes the sensitive value into its URL: DOM + error message + URL leak paths all clean', async () => {
    const cap = buildLeakCapability();
    const sAcctIndex = cap.steps.findIndex((s) => s.id === 'sAcctLeak');
    const sNavLeak: Step = {
      id: 'sNavLeak',
      name: 'Navigate with account number in the URL (redteam test)',
      risk: 'read',
      // Default onFailure: 'fail' -- no escalation handler needed for this sub-test.
      action: { type: 'navigate', url: '{baseUrl}/members/search?acct={input.acctNumber}' },
    };
    cap.steps.splice(sAcctIndex + 1, 0, sNavLeak);

    const validated = validateCapability(cap);
    if (!validated.ok) throw new Error(`test capability invalid: ${JSON.stringify(validated.issues)}`);

    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    const rootDir = mkdtempSync(path.join(os.tmpdir(), 'rundir-leak-'));
    tempDirs.push(rootDir);


    const runId = newRunId();
    const logger = createRunLogger({ runId, runKind: 'replay', rootDir });

    const result = await replayCapability({
      capability: validated.capability,
      inputs: { memberId: '12345', acctNumber: SENSITIVE_VALUE },
      surface,
      baseUrl: BASE_A,
      logger,
      clock,
      secret: (env) => ({ MOCK_USER, MOCK_PASSWORD })[env],
    });

    expect(result.kind).toBe('hard_failure');
    if (result.kind === 'hard_failure') {
      expect(result.code).toBe('navigation_failed');
      expect(result.evidence.dom).toBeDefined();
    }

    const runDir = logger.dir;
    // Sanity: the run dir actually has evidence files to grep (guards against a vacuous pass).
    expect(existsSync(path.join(runDir, 'events.jsonl'))).toBe(true);
    expect(existsSync(path.join(runDir, 'result.json'))).toBe(true);
    expect(existsSync(path.join(runDir, 'dom'))).toBe(true);
    expect(readdirSync(path.join(runDir, 'dom')).length).toBeGreaterThan(0);

    const variants = [...encodingVariants(SENSITIVE_VALUE), ...encodingVariants(MOCK_PASSWORD), ...encodingVariants(MOCK_USER)];
    assertNoneLeak(runDir, variants);
  });

  it('an escalated run: a legacy-host error message echoing the value back in UPPERCASE must not leak into events or the intervention file either', async () => {
    const cap = buildLeakCapability();
    const sAcctIndex = cap.steps.findIndex((s) => s.id === 'sAcctLeak');
    const sClickLeak: Step = {
      id: 'sClickLeak',
      name: 'Click search (redteam test, triggers an injected case-echoing failure)',
      risk: 'read',
      onFailure: 'escalate',
      action: { type: 'click', target: SEARCH_TARGET },
    };
    cap.steps.splice(sAcctIndex + 1, 0, sClickLeak);

    const validated = validateCapability(cap);
    if (!validated.ok) throw new Error(`test capability invalid: ${JSON.stringify(validated.issues)}`);

    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    // A legacy host that upcases input before echoing it back in a rejection message -- a
    // realistic shape of leak (mainframe-descended core banking systems commonly fold case).
    surface.inject({
      kind: 'act_error',
      match: { actionType: 'click', targetId: 'search' },
      code: 'app_error',
      message: `Legacy host rejected lookup for account "${SENSITIVE_VALUE}" (normalized: "${SENSITIVE_VALUE.toUpperCase()}").`,
    });

    const policy = loadPolicy(DEFAULT_POLICY_PATH);
    const rootDir = mkdtempSync(path.join(os.tmpdir(), 'rundir-leak-escalate-'));
    tempDirs.push(rootDir);

    const c = composeForTest(policy, rootDir, surface);
    try {
      const runPromise = replayCapability({
        capability: validated.capability,
        inputs: { memberId: '12345', acctNumber: SENSITIVE_VALUE },
        surface: c.surface,
        baseUrl: BASE_A,
        policy: c.guard,
        logger: c.logger,
        escalate: c.escalate,
        clock,
        secret: (env) => ({ MOCK_USER, MOCK_PASSWORD })[env],
      });

      // Wait (real wall-clock; the broker's own async bookkeeping doesn't run on the fake clock)
      // for the intervention to be raised, then abort it -- simulating an operator giving up.
      let interventionId: string | undefined;
      for (let i = 0; i < 400 && interventionId === undefined; i++) {
        const open = c.broker.views().find((v) => v.intervention.status === 'open');
        if (open) interventionId = open.intervention.id;
        else await new Promise((r) => setTimeout(r, 5));
      }
      if (interventionId === undefined) throw new Error('test: escalation never raised an intervention');
      await c.broker.abort(interventionId, 'test-operator', 'redteam test: aborting after simulated review');

      const result = await runPromise;
      expect(result.kind).toBe('escalated');
      if (result.kind === 'escalated') expect(result.resolution).toBe('abandoned');

      const runDir = c.logger.dir;
      expect(existsSync(path.join(runDir, 'interventions'))).toBe(true);
      const interventionFiles = readdirSync(path.join(runDir, 'interventions'));
      expect(interventionFiles.length).toBeGreaterThan(0);

      const variants = [...encodingVariants(SENSITIVE_VALUE), ...encodingVariants(MOCK_PASSWORD), ...encodingVariants(MOCK_USER)];
      assertNoneLeak(runDir, variants);
    } finally {
      await c.close();
    }
  });
});
