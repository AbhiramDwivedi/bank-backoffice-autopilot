/**
 * No secret or sensitive value ever reaches the model, the transcript, the event log, the result
 * file, or the recorded capability, in any case or encoding variant (docs/design/agent.md,
 * "Safety" / "Known limits").
 *
 * Runs `discover()` with the scripted LLM (`scripted-llm.ts`) against `FakeSurface` (cu-core) and
 * inspects every message the fake LLM ever received (`llm.requests`, via `requestText`), the
 * transcript file, the events log, and the recorded capability, for:
 *   - the secret login credentials (bound via `{kind:'secret', env}`),
 *   - a `sensitive: true` input's concrete value, shown to the model only as `<sensitive:name>`,
 *   - a `type` step's recorded action `value` binding, which must be `{kind:'input', name:...}` /
 *     `{kind:'secret', env:...}`, never the literal typed value,
 *   - a failure message that echoes the sensitive value back in a different case: the scrubber
 *     must catch an upcased or downcased echo, not just an exact match.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discover } from './discover.js';
import { createScriptedLlm, requestText, type ScriptedTurn } from './scripted-llm.js';
import type { DiscoverOptions, InputDecl, PolicyGuardLike } from './types.js';
import { createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';
import { createRunLogger, newRunId } from '../evidence/index.js';
import { DEFAULT_POLICY_PATH, loadPolicy } from '../policy/load.js';
import { findRef, readJsonlFile, readTextFile } from './test-helpers.js';

const BASE_URL = 'http://localhost:4173';
const ENTRY_URL = `${BASE_URL}/login`;
const NOTICE_TEXT = 'System Maintenance Notice';
const RESULT_TEXT_12345 = '12345 Jane Q. Sample 08/15/2004 Active';
const DEFAULT_POLICY = loadPolicy(DEFAULT_POLICY_PATH);
const SECRET_VALUES: Record<string, string> = { MOCK_USER: 'operator1', MOCK_PASSWORD: 'demo-pass-123' };

// Deliberately awkward test value (space, '&', '/', mixed case) so base64, URL-encoding,
// HTML-entity-encoding, and case-folding all actually differ from the raw value.
const SENSITIVE_VALUE = 'AcctNum 42&Test/07';

function allowGuard(): PolicyGuardLike {
  return {
    checkAction: () => ({ decision: 'allow', reason: 'ok', risk: 'read' }),
    checkUrl: () => ({ allowed: true, reason: 'ok' }),
  };
}

function makeInputs(overrides: Record<string, InputDecl> = {}): Record<string, InputDecl> {
  return {
    memberId: { value: '12345', sensitive: false, description: 'The member ID to look up.', type: 'string' },
    ...overrides,
  };
}

function makeLogger() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-leak-test-'));
  tmpDirs.push(dir);
  const runId = newRunId();
  const logger = createRunLogger({ runId, runKind: 'discovery', rootDir: dir });
  return { dir, runId, logger };
}

function baseOptions(logger: ReturnType<typeof makeLogger>['logger'], llm: DiscoverOptions['llm'], overrides: Partial<DiscoverOptions> = {}): DiscoverOptions {
  return {
    goal: 'Log in, look up member 12345 and read their current savings balance.',
    target: { baseUrl: BASE_URL, entryUrl: ENTRY_URL },
    app: { vendor: 'Acme Core Systems', product: 'CU Core Workstation', surface: 'web' },
    inputs: makeInputs(),
    surface: createCuCoreSurface(),
    policy: DEFAULT_POLICY,
    guard: allowGuard(),
    logger,
    llm,
    secretEnvNames: ['MOCK_USER', 'MOCK_PASSWORD'],
    secrets: (env) => SECRET_VALUES[env],
    expectTimeoutMs: 150,
    ...overrides,
  };
}

function typeSecret(nameIncludes: string, env: string, why: string): ScriptedTurn {
  return (req) => ({
    tool: 'type',
    input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes }), source: 'secret', value: env, why, expect: '' },
  });
}

function typeInput(nameIncludes: string, inputName: string, why: string, expect = ''): ScriptedTurn {
  return (req) => ({
    tool: 'type',
    input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes }), source: 'input', value: inputName, why, expect },
  });
}

function clickByRoleName(role: string, nameIncludes: string, why: string, expect = ''): ScriptedTurn {
  return (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role, nameIncludes }), why, expect } });
}

function dismissInterstitial(triggerText: string, why: string, title: string = triggerText): ScriptedTurn {
  return (req) => ({
    tool: 'dismiss_interstitial',
    input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: 'OK' }), trigger_text: triggerText, title, why },
  });
}

function extractField(nameIncludes: string, output: string, parse: 'text' | 'number' | 'currency', why: string): ScriptedTurn {
  return (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'cell', nameIncludes }), output, parse, why } });
}

function doneTurn(successText: string, summary: string): ScriptedTurn {
  return { tool: 'done', input: { success_text: successText, summary } };
}

function stuckTurn(reason: string): ScriptedTurn {
  return { tool: 'stuck', input: { reason } };
}

function loginAndDismissTurns(): ScriptedTurn[] {
  return [
    typeSecret('User ID', 'MOCK_USER', 'Enter the user ID'),
    typeSecret('Password', 'MOCK_PASSWORD', 'Enter the password'),
    clickByRoleName('button', 'login', 'Sign on', NOTICE_TEXT),
    dismissInterstitial(NOTICE_TEXT, 'Dismiss the maintenance notice'),
  ];
}

function encodingVariants(raw: string): { label: string; value: string }[] {
  const b64 = Buffer.from(raw, 'utf8').toString('base64');
  const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const urlEnc = encodeURIComponent(raw);
  const urlEncPlus = urlEnc.replace(/%20/g, '+');
  const htmlEntity = raw.replace(/&/g, '&amp;');
  const variants = [
    { label: 'raw', value: raw },
    { label: 'base64 (std)', value: b64 },
    { label: 'base64 (url-safe)', value: b64url },
    { label: 'URL-encoded', value: urlEnc },
    { label: 'URL-encoded (+-for-space)', value: urlEncPlus },
    { label: 'HTML-entity-encoded', value: htmlEntity },
    { label: 'uppercase', value: raw.toUpperCase() },
    { label: 'lowercase', value: raw.toLowerCase() },
  ];
  const seen = new Set<string>();
  return variants.filter((v) => v.value.length >= 3 && !seen.has(v.value) && seen.add(v.value));
}

function assertNoneLeakIn(haystacks: { label: string; text: string }[], variants: { label: string; value: string }[]): void {
  for (const { label: needleLabel, value } of variants) {
    for (const { label: haystackLabel, text } of haystacks) {
      expect(text, `${needleLabel} (${JSON.stringify(value)}) leaked into ${haystackLabel}`).not.toContain(value);
    }
  }
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('discovery agent -- no secret/sensitive value reaches the model, transcript, evidence or capability, in any encoding', () => {
  it('happy path: the sensitive input is shown to the model only as <sensitive:...>, and the recorded step binds {kind:"input"}, never the literal', async () => {
    const { logger } = makeLogger();
    const llm = createScriptedLlm([
      ...loginAndDismissTurns(),
      typeInput('Member ID', 'memberId', 'Enter the member ID'),
      typeInput('Last Name', 'acctSensitive', 'Enter the sensitive account lookup token'),
      clickByRoleName('clickable', 'Search', 'Search for the member', RESULT_TEXT_12345),
      clickByRoleName('clickable', '12345', 'Open the matching result', 'Savings Balance'),
      extractField('$1,234.56', 'savingsBalance', 'currency', 'Read the savings balance'),
      doneTurn('Savings Balance', "Read the member's savings balance."),
    ]);
    const opts = baseOptions(logger, llm, {
      inputs: makeInputs({ acctSensitive: { value: SENSITIVE_VALUE, sensitive: true, description: 'Sensitive account lookup token (test).', type: 'string' } }),
    });
    const result = await discover(opts);
    expect(result.status).toBe('success');

    const cap = result.capability;
    if (cap === undefined) throw new Error(`expected a capability; issues: ${JSON.stringify(result.issues)}`);
    const acctStep = cap.steps.find((s) => s.action.type === 'type' && s.action.value.kind === 'input' && s.action.value.name === 'acctSensitive');
    expect(acctStep, 'expected a recorded step binding acctSensitive as an {input.x} reference').toBeDefined();
    // Sanity: JSON.stringify of the WHOLE step never contains the raw value either.
    expect(JSON.stringify(acctStep)).not.toContain(SENSITIVE_VALUE);

    const variants = encodingVariants(SENSITIVE_VALUE);
    const promptTexts = llm.requests.map((req, i) => ({ label: `llm request #${i}`, text: requestText(req) }));
    assertNoneLeakIn(promptTexts, variants);

    // The INPUTS listing shows the generic `<sensitive>` marker (matching the existing
    // convention -- see discover.test.ts's "prompt redaction of sensitive inputs" test)...
    expect(requestText(llm.requests[0]!)).toContain('acctSensitive (string, sensitive): Sensitive account lookup token (test). = <sensitive>');
    // ...and the named `<sensitive:acctSensitive>` placeholder must actually appear once the
    // value is typed and echoed back in the observation (proves the value-substitution path ran
    // at all, not just an absence that could be a vacuous pass).
    expect(llm.requests.some((r) => requestText(r).includes('<sensitive:acctSensitive>'))).toBe(true);

    for (const file of ['transcript.jsonl', 'events.jsonl', 'result.json', 'capability.json']) {
      const filePath = path.join(logger.dir, file);
      if (!existsSync(filePath)) continue;
      const text = readTextFile(filePath);
      assertNoneLeakIn([{ label: file, text }], variants);
    }
  });

  it('a legacy-host error message echoing the sensitive value back in UPPERCASE must not leak into the model, transcript or events', async () => {
    const { logger } = makeLogger();
    const surface = createCuCoreSurface();
    surface.inject({
      kind: 'act_error',
      match: { actionType: 'click', targetId: 'search' },
      code: 'app_error',
      message: `Legacy host rejected lookup for account "${SENSITIVE_VALUE}" (normalized: "${SENSITIVE_VALUE.toUpperCase()}").`,
    });
    const llm = createScriptedLlm(
      [
        ...loginAndDismissTurns(),
        typeInput('Member ID', 'memberId', 'Enter the member ID'),
        typeInput('Last Name', 'acctSensitive', 'Enter the sensitive account lookup token'),
        clickByRoleName('clickable', 'Search', 'Search for the member', ''),
        stuckTurn('test: stopping after the injected legacy-host failure'),
      ],
      { onExhausted: 'throw' },
    );
    const opts = baseOptions(logger, llm, {
      surface,
      inputs: makeInputs({ acctSensitive: { value: SENSITIVE_VALUE, sensitive: true, description: 'Sensitive account lookup token (test).', type: 'string' } }),
    });
    const result = await discover(opts);
    expect(result.status).toBe('stuck');

    const variants = encodingVariants(SENSITIVE_VALUE);
    const promptTexts = llm.requests.map((req, i) => ({ label: `llm request #${i}`, text: requestText(req) }));
    assertNoneLeakIn(promptTexts, variants);

    const events = readJsonlFile(path.join(logger.dir, 'events.jsonl'));
    assertNoneLeakIn([{ label: 'events.jsonl', text: JSON.stringify(events) }], variants);

    for (const file of ['transcript.jsonl', 'result.json']) {
      const filePath = path.join(logger.dir, file);
      if (!existsSync(filePath)) continue;
      assertNoneLeakIn([{ label: file, text: readTextFile(filePath) }], variants);
    }
  });
});
