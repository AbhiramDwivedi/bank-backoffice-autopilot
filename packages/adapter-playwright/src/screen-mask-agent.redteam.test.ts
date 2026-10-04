/**
 * Red team, real surface + discovery agent (scripted LLM): masked on-screen values never reach the
 * model, the transcript, the evidence or the capability, through the agent-side paths the fake
 * surface cannot prove:
 *  - `extract` on an unmasked container (a clickable notes block) whose full text holds label-
 *    masked values past the observation's text cap: `readText` reports `masked`, so the value is
 *    withheld and the output recorded sensitive;
 *  - no oracle: model-written condition text is evaluated against the masked view only. For a
 *    hidden value V, a correct guess and a wrong guess of the same length produce byte-identical
 *    prompts, tool results, transcript entries, events and capability output, apart from the guess
 *    string itself, through every tool that takes one: `expect` on click / type / select / press /
 *    navigate, `done`, `declare_outcome` (detector, with returns) and `dismiss_interstitial`.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createScriptedLlm, discover, requestText, type LlmRequest, type ScriptedTurn } from '@cu/core/agent';
import { findRef } from '@cu/core/agent/test-helpers';
import { createRunLogger, newRunId } from '@cu/core/evidence';
import { DEFAULT_POLICY_PATH, loadPolicy } from '@cu/core/policy';
import { resolveScreenMask } from '@cu/core/schema';
import { createPlaywrightSurface, type PlaywrightSurface } from './surface.js';
import { startFixtureServer, type FixtureServer } from './test-helpers.js';

let browser: Browser;
let fixtures: FixtureServer;
let surface: PlaywrightSurface | undefined;
const dirs: string[] = [];

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  fixtures = await startFixtureServer();
});
afterAll(async () => {
  await browser.close();
  await fixtures.close();
});
afterEach(async () => {
  await surface?.close();
  surface = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SECRETS = ['413-555-0100', '1 Main St', '413-555-0199', '413-555-01'];

function files(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((e) => {
      const p = path.join(dir, e);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.png') ? [] : [p];
    });
}

async function run(script: ScriptedTurn[], entry = 'mask-container.html') {
  surface = await createPlaywrightSurface({
    browser,
    viewport: { width: 1000, height: 800 },
    screenMask: { config: { ...resolveScreenMask(undefined), maskLabels: ['^phone$', '^address$'] }, textPatterns: [] },
  });
  const root = mkdtempSync(path.join(os.tmpdir(), 'mask-agent-'));
  dirs.push(root);
  const runId = newRunId();
  const logger = createRunLogger({ runId, runKind: 'discovery', rootDir: root });
  const llm = createScriptedLlm(script);
  const result = await discover({
    goal: 'Read the account notes.',
    target: { baseUrl: fixtures.baseUrl, entryUrl: fixtures.url(entry) },
    app: { vendor: 'Acme Core Systems', product: 'CU Core Workstation', surface: 'web' },
    inputs: {},
    surface,
    policy: loadPolicy(DEFAULT_POLICY_PATH),
    guard: { checkAction: () => ({ decision: 'allow', reason: 'ok', risk: 'read' }), checkUrl: () => ({ allowed: true, reason: 'ok' }) },
    logger,
    llm,
    secretEnvNames: [],
    expectTimeoutMs: 300,
  });
  const prompts = llm.requests.map((r) => requestText(r));
  const evidence = files(logger.dir).map((f) => ({ f: path.relative(logger.dir, f), text: readFileSync(f, 'utf8') }));
  await surface.close();
  surface = undefined;
  return { result, prompts, evidence, runId, root };
}

function assertClean(prompts: string[], evidence: { f: string; text: string }[], extra: string[] = []): void {
  for (const v of [...SECRETS, ...extra]) {
    for (const [i, p] of prompts.entries()) expect(p, `LLM request #${i} carries ${v}`).not.toContain(v);
    for (const { f, text } of evidence) expect(text, `${path.basename(f)} carries ${v}`).not.toContain(v);
  }
}

describe('screen masking: the agent never learns, records or persists masked content', () => {
  it('extract from an unmasked container whose full text holds masked values: withheld from the model, recorded sensitive', async () => {
    const { result, prompts, evidence } = await run([
      (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: 'Customer notes' }), output: 'notes', parse: 'text', why: 'Read the notes' } }),
      { tool: 'done', input: { success_text: 'Account notes', summary: 'Read the notes.' } },
    ]);
    expect(result.status, JSON.stringify([result.reason, result.issues])).toBe('success');
    expect(String(result.outputs?.notes)).toContain('413-555-0100'); // the caller gets the real text
    expect(result.capability?.outputs.notes?.sensitive).toBe(true);
    expect(prompts.some((p) => p.includes('Extracted notes; the value is withheld because the field is masked.'))).toBe(true);
    assertClean(prompts, evidence);
    expect(JSON.stringify(result.capability)).not.toContain('413-555-0100');
  });
});

// --- No oracle: a correct guess and a wrong guess are indistinguishable ---------------------------

/** The hidden value (the Address cell under the `^address$` label rule) and a wrong guess of the same length. */
const HIDDEN = '1 Main St';
const WRONG = '2 Oak Ave';

/**
 * Everything one run produced, with the guess replaced by `<GUESS>` and run-specific noise (ids,
 * clocks, durations, temp paths, screenshot hashes) normalized. Nothing else is touched: any other
 * difference between two runs is a difference the model or a reader of the evidence could see.
 */
function normalized(r: Awaited<ReturnType<typeof run>>, guess: string): string {
  const scrub = (s: string): string =>
    s
      .split(guess)
      .join('<GUESS>')
      .split(r.runId)
      .join('<RUN>')
      .split(r.root)
      .join('<ROOT>')
      .split(r.root.replace(/\\/g, '\\\\'))
      .join('<ROOT>')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<TS>')
      .replace(/"(\w*(?:[Mm]s|At|ts|Ts|[Dd]uration\w*|elapsed\w*|latency\w*))":\s*-?[\d.]+/g, '"$1":<N>')
      .replace(/\b[0-9a-f]{40,64}\b/g, '<HASH>')
      .replace(/(int|evt|step|shot)_[A-Za-z0-9_-]{6,}/g, '$1_<ID>');
  const capability = r.result.capability ? JSON.stringify({ ...r.result.capability, id: '<ID>' }) : 'none';
  return [
    `status=${r.result.status}`,
    `reason=${r.result.reason ?? ''}`,
    `issues=${JSON.stringify(r.result.issues ?? [])}`,
    `outputs=${JSON.stringify(r.result.outputs ?? {})}`,
    `capability=${capability}`,
    ...r.prompts.map((p, i) => `--- prompt ${i}\n${p}`),
    ...r.evidence.map((e) => `--- file ${e.f}\n${e.text}`),
  ]
    .map(scrub)
    .join('\n');
}

/** Line-level first difference, for a readable failure. */
function firstDifference(a: string, b: string): string {
  const la = a.split('\n');
  const lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return `line ${i}:\n  correct: ${la[i]?.slice(0, 400)}\n  wrong:   ${lb[i]?.slice(0, 400)}`;
  }
  return 'identical';
}

type Probe = (guess: string) => ScriptedTurn[];

const stop: ScriptedTurn = { tool: 'stuck', input: { reason: 'test: stop after the probe' } };
const ref = (req: LlmRequest, q: Parameters<typeof findRef>[1]): string => findRef(requestText(req), q);

const PROBES: Record<string, Probe> = {
  'click expect': (g) => [(req) => ({ tool: 'click', input: { ref: ref(req, { role: 'button', nameIncludes: 'Continue' }), why: 'Continue', expect: g } }), stop],
  // The hidden value is on the page BEFORE this action: the optimizer's vacuous-expectation
  // pre-check (`preActVisibility`) runs on it, and must see only the masked view.
  'click expect, already on the page before the action (vacuous pre-check)': (g) => [
    (req) => ({ tool: 'click', input: { ref: ref(req, { role: 'link', nameIncludes: 'Top' }), why: 'Back to the top', expect: g } }),
    stop,
  ],
  'type expect': (g) => [
    (req) => ({ tool: 'type', input: { ref: ref(req, { nameIncludes: 'Search' }), source: 'literal', value: 'abc', why: 'Search', expect: g } }),
    stop,
  ],
  'select expect': (g) => [(req) => ({ tool: 'select', input: { ref: ref(req, { nameIncludes: 'State' }), source: 'literal', value: 'NY', why: 'Pick a state', expect: g } }), stop],
  'press expect': (g) => [{ tool: 'press', input: { key: 'Tab', why: 'Move on', expect: g } }, stop],
  'navigate expect': (g) => [{ tool: 'navigate', input: { url: fixtures.url('mask-oracle.html'), why: 'Reload the summary', expect: g } }, stop],
  done: (g) => [{ tool: 'done', input: { success_text: g, summary: 'Finished.' } }, stop],
  'declare_outcome detector + returns': (g) => [
    (req) => ({
      tool: 'declare_outcome',
      input: {
        name: 'probe',
        description: 'probe',
        detector_text: g,
        returns: [{ output: 'balance', ref: ref(req, { textIncludes: '100.00' }), parse: 'text', description: 'the balance' }],
      },
    }),
    stop,
  ],
  dismiss_interstitial: (g) => [
    (req) => ({ tool: 'dismiss_interstitial', input: { ref: ref(req, { role: 'button', nameIncludes: 'Continue' }), trigger_text: g, title: '', why: 'Dismiss' } }),
    stop,
  ],
};

describe('screen masking: no oracle on hidden content (correct guess vs wrong guess, same length)', () => {
  it('the hidden value is on the real page and absent from the masked view', async () => {
    const { prompts } = await run([stop], 'mask-oracle.html');
    expect(prompts[0]).toContain('[MASKED:address]');
    expect(prompts[0]).not.toContain(HIDDEN);
    expect(HIDDEN.length).toBe(WRONG.length);
  });

  for (const [name, probe] of Object.entries(PROBES)) {
    it(`${name}: byte-identical apart from the guess`, async () => {
      const correct = await run(probe(HIDDEN), 'mask-oracle.html');
      const wrong = await run(probe(WRONG), 'mask-oracle.html');
      const a = normalized(correct, HIDDEN);
      const b = normalized(wrong, WRONG);
      expect(a === b, firstDifference(a, b)).toBe(true);
      // And the guess was actually evaluated as "not visible" (the probe reached the condition).
      expect(a).not.toContain('Refused');
    }, 60_000);
  }
});
