/**
 * A sensitive value in the top-level URL at escalation time (a GET search form, a deep link built
 * from an input) must never reach `events.jsonl`, `interventions/*.json`, or `broker.views()` --
 * raw, URL-encoded, or in another case. Each layer is covered on its own:
 *
 *   1. replay's escalation request (`buildEscalationRequest`) scrubs `currentUrl` with the run's
 *      scrubber, even under a broker that knows none of the run's values;
 *   2. the broker scrubs its registered secret values out of a `currentUrl` it reads from the
 *      surface itself, out of the request's reason/goal/context, and out of a human action's URL;
 *   3. the full run wiring (one run redactor, from `createRunRedactor`, on the logger and the
 *      broker) keeps them out too.
 *
 * Plus: a pattern only the policy adds reaches the intervention file and the broker's own events
 * through `SessionBrokerOptions.redactor`, not only the logger's.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateCapability, type Step, type TargetDescriptor } from '../schema/index.js';
import { createRunLogger, createRunRedactor, newRunId } from '../evidence/index.js';
import { createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';
import type { FakeSurface } from '../surface/index.js';
import { replayCapability } from '../replay/replay.js';
import { BASE_A, MOCK_PASSWORD, MOCK_USER, loadExample, makeFakeClock } from '../replay/test-helpers.js';
import { createSessionBroker } from './broker.js';
import type { SessionBroker } from './broker-api.js';

// A space, an ampersand, a slash and the characters form encoding treats differently from
// encodeURIComponent (an apostrophe, parentheses, an exclamation mark), in mixed case: every URL
// encoding, the HTML-escaped form and case-folding each produce a string different from the raw value.
const SENSITIVE_VALUE = "O'Brien (1)&Summer2024!/07";

/** The value as a browser form-encodes it into a query string (`URLSearchParams`). */
function formEncoded(raw: string): string {
  return new URLSearchParams({ x: raw }).toString().slice(2);
}

function leakVariants(raw: string): string[] {
  const enc = encodeURIComponent(raw);
  const forms = [raw, enc, enc.replace(/%20/g, '+'), formEncoded(raw), raw.replace(/&/g, '&amp;'), Buffer.from(raw, 'utf8').toString('base64')];
  return [...new Set(forms.flatMap((f) => [f, f.toUpperCase(), f.toLowerCase()]))];
}

/** Every file under `dir`, as utf8 and latin1 text (a PNG is still scanned byte for byte). */
function runDirText(dir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const buf = readFileSync(full);
        out.push({ file: path.relative(dir, full), text: `${buf.toString('utf8')}\n${buf.toString('latin1')}` });
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

function expectNoLeak(label: string, text: string, raw: string): void {
  for (const v of leakVariants(raw)) expect(text, `${JSON.stringify(v)} leaked into ${label}`).not.toContain(v);
}

function expectRunClean(broker: SessionBroker, runDir: string, raw: string): void {
  expectNoLeak('broker.views()', JSON.stringify(broker.views()), raw);
  const files = runDirText(runDir);
  expect(files.some((f) => f.file === 'events.jsonl')).toBe(true);
  expect(files.some((f) => f.file.startsWith(`interventions${path.sep}`))).toBe(true);
  for (const f of files) expectNoLeak(f.file, f.text, raw);
}

/** The surface reports a top-level URL carrying the value percent-encoded, with `+` for space,
 *  form-encoded (as a GET form submits it) and raw. */
function withLeakyUrl(surface: FakeSurface): FakeSurface {
  const enc = encodeURIComponent(SENSITIVE_VALUE);
  surface.currentUrl = () => Promise.resolve(`${BASE_A}/members/search?acct=${enc}&q=${enc.replace(/%20/g, '+')}&f=${formEncoded(SENSITIVE_VALUE)}&echo=${SENSITIVE_VALUE}`);
  return surface;
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'escalation-url-leak-'));
  tempDirs.push(dir);
  return dir;
}

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

/** The example capability plus a sensitive input typed after s05, then a Search click that escalates. */
function escalatingCapability() {
  const cap = structuredClone(loadExample());
  cap.inputs.acctNumber = { type: 'string', description: 'Sensitive account number (redteam test).', required: true, sensitive: true };
  const at = cap.steps.findIndex((s) => s.id === 's05');
  if (at === -1) throw new Error('test: example capability has no step s05');
  const typeAcct: Step = {
    id: 'sAcct',
    name: 'Enter account number (redteam test)',
    risk: 'read',
    action: { type: 'type', target: LAST_NAME_TARGET, value: { kind: 'input', name: 'acctNumber' }, clear: true },
  };
  const clickSearch: Step = {
    id: 'sSearch',
    name: 'Click search (redteam test, fails and escalates)',
    risk: 'read',
    onFailure: 'escalate',
    action: { type: 'click', target: SEARCH_TARGET },
  };
  cap.steps.splice(at + 1, 0, typeAcct, clickSearch);
  const validated = validateCapability(cap);
  if (!validated.ok) throw new Error(`test capability invalid: ${JSON.stringify(validated.issues)}`);
  return validated.capability;
}

/** Replays until the escalation is raised, runs `whileOpen` against it, then aborts and settles the run. */
async function replayToEscalation(
  broker: SessionBroker,
  surface: FakeSurface,
  logger: ReturnType<typeof createRunLogger>,
  whileOpen: (interventionId: string) => void,
): Promise<void> {
  surface.inject({ kind: 'act_error', match: { actionType: 'click', targetId: 'search' }, code: 'app_error', message: 'Search failed.' });
  const clock = makeFakeClock();
  const run = replayCapability({
    capability: escalatingCapability(),
    inputs: { memberId: '12345', acctNumber: SENSITIVE_VALUE },
    surface: broker.surface,
    baseUrl: BASE_A,
    logger,
    escalate: (req) => broker.escalate(req),
    clock,
    secret: (env) => ({ MOCK_USER, MOCK_PASSWORD })[env],
  });
  let id: string | undefined;
  for (let i = 0; i < 400 && id === undefined; i++) {
    id = broker.views().find((v) => v.intervention.status === 'open')?.intervention.id;
    if (id === undefined) await new Promise((r) => setTimeout(r, 5));
  }
  if (id === undefined) throw new Error('test: escalation never raised an intervention');
  whileOpen(id);
  await broker.abort(id, 'test-operator');
  const result = await run;
  expect(result.kind).toBe('escalated');
}

describe('a sensitive value in the top-level URL at escalation time', () => {
  it("replay's escalation request scrubs currentUrl, even under a broker that knows none of the run's values", async () => {
    const surface = withLeakyUrl(createCuCoreSurface({ clock: makeFakeClock() }));
    const logger = createRunLogger({ runId: newRunId(), runKind: 'replay', rootDir: tempRoot() });
    const broker = createSessionBroker({ surface, logger, runId: logger.runId, runKind: 'replay', capture: null });
    try {
      await replayToEscalation(broker, surface, logger, (id) => {
        // The URL is there, with the value replaced: scrubbed, not dropped.
        expect(broker.view(id).intervention.currentUrl).toContain('/members/search?acct=');
      });
      expectRunClean(broker, logger.dir, SENSITIVE_VALUE);
    } finally {
      broker.dispose();
    }
  });

  it('the full run wiring (one run redactor on logger and broker, run values on the broker) keeps it out of every sink', async () => {
    const surface = withLeakyUrl(createCuCoreSurface({ clock: makeFakeClock() }));
    const values = (): string[] => [SENSITIVE_VALUE, MOCK_PASSWORD];
    const redactor = createRunRedactor({ values });
    const logger = createRunLogger({ runId: newRunId(), runKind: 'replay', rootDir: tempRoot(), redactor });
    const broker = createSessionBroker({ surface, logger, runId: logger.runId, runKind: 'replay', capture: null, secretValues: values, redactor });
    try {
      await replayToEscalation(broker, surface, logger, () => undefined);
      expectRunClean(broker, logger.dir, SENSITIVE_VALUE);
      expectRunClean(broker, logger.dir, MOCK_PASSWORD);
    } finally {
      broker.dispose();
    }
  });

  it("the broker scrubs a surface-read currentUrl, the request's text fields, and a human action's URL", async () => {
    const surface = withLeakyUrl(createCuCoreSurface());
    const logger = createRunLogger({ runId: newRunId(), runKind: 'replay', rootDir: tempRoot() });
    const broker = createSessionBroker({
      surface,
      logger,
      runId: logger.runId,
      runKind: 'replay',
      capture: null,
      secretValues: () => [SENSITIVE_VALUE],
    });
    try {
      const pending = broker.escalate({
        runId: logger.runId,
        runKind: 'replay',
        goal: `find ${SENSITIVE_VALUE}`,
        reason: { code: 'unrecoverable_condition', message: `no match for ${SENSITIVE_VALUE.toUpperCase()}` },
        context: { observed: `searched ${encodeURIComponent(SENSITIVE_VALUE)}` },
      });
      const id = broker.token.interventionId;
      if (id === undefined) throw new Error('test: no intervention reserved');
      for (let i = 0; i < 200 && broker.interventions.get(id) === undefined; i++) await new Promise((r) => setTimeout(r, 5));

      await broker.takeControl(id, 'alice');
      broker.recordHumanAction(
        id,
        { ts: new Date().toISOString(), type: 'navigate', frame: [], target: {}, url: `${BASE_A}/members/search?acct=${formEncoded(SENSITIVE_VALUE)}` },
        'scripted-operator',
      );
      expect(broker.view(id).humanActions[0]?.url).toBe(`${BASE_A}/members/search?acct=[REDACTED]`);

      await broker.abort(id, 'alice');
      await pending;
      expectRunClean(broker, logger.dir, SENSITIVE_VALUE);
    } finally {
      broker.dispose();
    }
  });
});

describe('SessionBrokerOptions.redactor', () => {
  it('the same redactor on the logger and the broker redacts each broker event once', async () => {
    const surface = createCuCoreSurface();
    const run = createRunRedactor({ values: () => ['RED'] });
    const inputs: string[] = [];
    const redactor = Object.assign(
      (v: unknown): unknown => {
        inputs.push(JSON.stringify(v));
        return run(v);
      },
      { html: run.html },
    );
    const logger = createRunLogger({ runId: newRunId(), runKind: 'replay', rootDir: tempRoot(), redactor });
    const broker = createSessionBroker({ surface, logger, runId: logger.runId, runKind: 'replay', capture: null, redactor });
    try {
      const pending = broker.escalate({ runId: logger.runId, runKind: 'replay', reason: { code: 'unrecoverable_condition', message: 'red light' } });
      const id = broker.token.interventionId;
      if (id === undefined) throw new Error('test: no intervention reserved');
      for (let i = 0; i < 200 && broker.interventions.get(id) === undefined; i++) await new Promise((r) => setTimeout(r, 5));
      await broker.abort(id, 'alice');
      await pending;
      // Every call saw raw data: nothing the redactor had already redacted came back through it.
      expect(inputs.some((i) => i.includes('red light'))).toBe(true);
      expect(inputs.filter((i) => i.includes('[REDACTED]'))).toEqual([]);
      const events = readFileSync(path.join(logger.dir, 'events.jsonl'), 'utf8');
      expect(events).toContain('[REDACTED] light');
    } finally {
      broker.dispose();
    }
  });

  it('a policy-added pattern reaches the intervention file and the escalation event, not only the logger', async () => {
    const surface = createCuCoreSurface();
    // The logger knows only the default patterns; the broker gets the run redactor with the policy's.
    const logger = createRunLogger({ runId: newRunId(), runKind: 'replay', rootDir: tempRoot() });
    const redactor = createRunRedactor({ patterns: [{ name: 'member', regex: 'MBR-[0-9]{4}' }] });
    const broker = createSessionBroker({ surface, logger, runId: logger.runId, runKind: 'replay', capture: null, redactor });
    try {
      const pending = broker.escalate({ runId: logger.runId, runKind: 'replay', reason: { code: 'unrecoverable_condition', message: 'member MBR-1234 is locked' } });
      const id = broker.token.interventionId;
      if (id === undefined) throw new Error('test: no intervention reserved');
      for (let i = 0; i < 200 && broker.interventions.get(id) === undefined; i++) await new Promise((r) => setTimeout(r, 5));
      await broker.abort(id, 'alice');
      await pending;

      const record = readFileSync(path.join(logger.dir, 'interventions', `${id}.json`), 'utf8');
      expect(record).toContain('member [REDACTED:member] is locked');
      expect(record).not.toContain('MBR-1234');
      const events = readFileSync(path.join(logger.dir, 'events.jsonl'), 'utf8');
      expect(events).toContain('[REDACTED:member]');
      expect(events).not.toContain('MBR-1234');
    } finally {
      broker.dispose();
    }
  });
});
