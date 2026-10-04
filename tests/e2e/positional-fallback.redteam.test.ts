/**
 * End-to-end, on the branch ledger: replay never settles an ambiguity by position, and never reads
 * by position when the chain has a named way to find the value.
 *
 * Both capabilities are recorded on a page that shows ONE account holder, and both keep their
 * positional fallbacks, as the record rule allows: the "View statement" button is a static control
 * (its card shows the member number nowhere), and the savings balance sits on the record's own
 * page (the member number is in the URL path). At replay a joint member's page shows TWO holders
 * in the same markup, the other holder first.
 *
 * Before the rule, with the naming locators ambiguous, the chain fell through to the structural
 * css or the bbox, which found whatever sat at the recorded position:
 *  - the click opened the OTHER holder's statement, and the run returned that holder's closing
 *    balance as `success`;
 *  - the read returned the OTHER holder's savings balance as `success`.
 * Now both end as `hard_failure element_not_found` saying two candidates matched, nothing is
 * opened (the server records every statement opened), and no value is returned.
 *
 * One block pins the trade the rule makes: a read whose label is simply gone no longer
 * self-heals through a structural css. It is a typed failure too.
 *
 * The last blocks are the cases where a locator that names the value matches exactly ONE element
 * and that element belongs to another record, so the replay rule above cannot see it. The read's
 * record identity check does (`identity` on the extract, see docs/design/browser-agent.md):
 *  - the other holder is the only one with a "Savings Balance" row: `checkpoint_failed`;
 *  - a name search whose detail panel shows another person: `checkpoint_failed`;
 *  - a read whose container shows no input at record time: no check is recorded, so
 *    `cu validate` warns (`read_without_record_identity`) instead.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { PASSWORD, USER, launchBrowser, policyFor, readEvents, replayOnce, tempRunsDir, type MockServer } from './harness.js';
import { runDiscover } from '@cu/cli/commands/discover';
import { createScriptedLlm, requestText, type ScriptedTurn } from '@cu/core/agent';
import { findRef } from '@cu/core/agent/test-helpers';
import { isPositional, validateCapability, type Capability, type Locator, type ReplayResult, type Step } from '@cu/core/schema';
import { DEFAULT_POLICY_FILE } from '@cu/cli/runtime';
import { LEDGER_MEMBERS, LEDGER_PEOPLE, startLedger, type Ledger } from '../fixtures/ledger/server.js';

const member = (id: string) => LEDGER_MEMBERS.find((m) => m.id === id)!;
const money = (s: string | null): number => Number((s ?? '').replace(/[$,]/g, ''));

/** Find a statement and read its closing balance. Recorded for 1001, who holds the account alone. */
const statementScript = (): ScriptedTurn[] => [
  (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Statement search' }), source: 'input', value: 'member', why: 'Enter the member number', expect: '' } }),
  (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'Find' }), why: 'Find the statements', expect: 'View statement' } }),
  (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'View statement' }), why: 'Open the statement', expect: 'Closing balance' } }),
  (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'cell', nameIncludes: member('1001').closing }), output: 'closingBalance', parse: 'currency', why: 'Read the closing balance' } }),
  { tool: 'done', input: { success_text: 'Closing balance', summary: 'Read the closing balance.' } },
];

/** Open a member's own page and read the savings balance. Recorded for 1001. */
const balanceScript = (): ScriptedTurn[] => [
  (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Member number' }), source: 'input', value: 'member', why: 'Enter the member number', expect: '' } }),
  (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'Open' }), why: 'Open the member', expect: 'Savings Balance' } }),
  (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'cell', nameIncludes: member('1001').savings ?? '' }), output: 'savingsBalance', parse: 'currency', why: 'Read the savings balance' } }),
  { tool: 'done', input: { success_text: 'Savings Balance', summary: 'Read the savings balance.' } },
];

/** Search people by name and read the balance of the detail panel. Recorded for "Smithers": one result. */
const peopleScript = (): ScriptedTurn[] => [
  (req) => ({ tool: 'type', input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes: 'Name' }), source: 'input', value: 'query', why: 'Enter the name', expect: '' } }),
  (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'button', nameIncludes: 'Look up' }), why: 'Look up the person', expect: 'Balance' } }),
  (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'cell', nameIncludes: LEDGER_PEOPLE[1]!.balance }), output: 'balance', parse: 'currency', why: 'Read the balance' } }),
  { tool: 'done', input: { success_text: 'Balance', summary: 'Read the balance.' } },
];

function asTarget(ledger: Ledger): MockServer {
  return { tenant: 'a', baseUrl: ledger.baseUrl, requests: ledger.requests, setFaults: async () => undefined, reset: async () => undefined, close: () => ledger.close() };
}

async function discovered(browser: Browser, ledger: Ledger, id: string, output: string, script: ScriptedTurn[], opts: { input?: string; entry?: string } = {}): Promise<Capability> {
  const runsDir = tempRunsDir('positional-discover-');
  const artifactPath = path.join(runsDir, `${id}.json`);
  const progress: string[] = [];
  const outcome = await runDiscover(
    {
      goal: `Do ${id} for a member.`,
      input: [opts.input ?? 'member=1001'],
      sensitive: [],
      output: [output],
      secret: [],
      id,
      out: artifactPath,
      entry: opts.entry ?? '/',
      vendor: 'Demo vendor',
      product: 'Branch Ledger',
      operatorPort: 0,
      autoOperator: 'none',
      policy: DEFAULT_POLICY_FILE,
      runsDir,
      headless: true,
      baseUrl: ledger.baseUrl,
    },
    { llm: createScriptedLlm(script), browser, policy: policyFor(ledger.baseUrl), print: (l) => progress.push(l) },
  );
  expect(outcome.exitCode, `discover did not succeed:\n${progress.join('\n')}`).toBe(0);
  return JSON.parse(readFileSync(artifactPath, 'utf8')) as Capability;
}

const stepNamed = (cap: Capability, name: string): Step => {
  const s = cap.steps.find((x) => x.name === name);
  if (!s) throw new Error(`no step "${name}" in ${cap.steps.map((x) => x.name).join(', ')}`);
  return s;
};
const locatorsOf = (s: Step): Locator[] => ('target' in s.action ? s.action.target.locators : []);

describe('replay never settles an ambiguity by position (branch ledger, scripted LLM, no network)', () => {
  let browser: Browser;
  const ledgers: Ledger[] = [];
  async function ledger(): Promise<Ledger> {
    const l = await startLedger();
    ledgers.push(l);
    return l;
  }
  async function replay(cap: Capability, on: Ledger, memberId: string, name = 'member'): Promise<{ result: ReplayResult; events: ReturnType<typeof readEvents> }> {
    const run = await replayOnce({ browser, mock: asTarget(on), capability: cap, inputs: { [name]: memberId }, runsDir: tempRunsDir('positional-replay-'), autoOperator: 'abort', stepTimeoutMs: 3_000 });
    return { result: run.result, events: readEvents(run.runDir) };
  }

  beforeAll(async () => {
    // The ledger has no sign-in. `discover` still loads its default credential names before it
    // starts, so they must be set; no step binds them.
    process.env.MOCK_USER ??= USER;
    process.env.MOCK_PASSWORD ??= PASSWORD;
    browser = await launchBrowser();
  });

  afterAll(async () => {
    for (const l of ledgers) await l.close();
    await browser?.close();
  });

  describe('a control unique at record time, repeated at replay (a click)', () => {
    let cap: Capability;
    beforeAll(async () => {
      cap = await discovered(browser, await ledger(), 'read-statement-balance', 'closingBalance:number', statementScript());
    }, 120_000);

    it('is recorded as a static control: its own name first, then positional fallbacks', () => {
      const locs = locatorsOf(stepNamed(cap, 'Open the statement'));
      expect(isPositional(locs[0]!), JSON.stringify(locs)).toBe(false);
      expect(JSON.stringify(locs[0]!.strategy)).toContain('View statement');
      expect(locs.some(isPositional), JSON.stringify(locs)).toBe(true);
    });

    it('replays for the member it was recorded with, and for another who holds an account alone', async () => {
      for (const id of ['1001', '3003']) {
        const l = await ledger();
        const { result } = await replay(cap, l, id);
        expect(result.kind, JSON.stringify(result)).toBe('success');
        if (result.kind === 'success') expect(result.outputs.closingBalance).toBe(money(member(id).closing));
        expect(l.statementViews).toEqual([id]);
      }
    }, 120_000);

    it('two "View statement" buttons at replay: element_not_found naming 2 candidates, and NO statement is opened', async () => {
      const l = await ledger();
      // 2002's page lists the other holder (3003) first, in the same markup.
      const { result, events } = await replay(cap, l, '2002');

      expect(result.kind, JSON.stringify(result)).toBe('hard_failure');
      if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
      expect(result.code).toBe('element_not_found');
      expect(result.stepName).toBe('Open the statement');
      expect(result.message).toMatch(/2 candidates matched the \w+ locator/);
      expect(result.message).toMatch(/does not settle an ambiguity by position/);
      // Before the rule: the structural css found the first card's button, 3003's statement was
      // opened, and the run returned 3003's closing balance for member 2002 as a success.
      expect(l.statementViews).toEqual([]);
      expect('outputs' in result).toBe(false);
      expect(JSON.stringify(result)).not.toContain(String(money(member('3003').closing)));
      expect(events.some((e) => e.kind === 'action_result' && e.stepId === result.stepId)).toBe(false);
    }, 60_000);
  });

  describe("a record's own page that also lists another record (a read)", () => {
    let cap: Capability;
    beforeAll(async () => {
      cap = await discovered(browser, await ledger(), 'read-savings-balance', 'savingsBalance:number', balanceScript());
    }, 120_000);

    it("is recorded on the record's own page: its label anchor first, then positional fallbacks", () => {
      const locs = locatorsOf(stepNamed(cap, 'Read the savings balance'));
      expect(locs[0]!.strategy, JSON.stringify(locs)).toMatchObject({ kind: 'relative', anchor: { text: 'Savings Balance' }, relation: 'right-of' });
      expect(locs.slice(1).length, JSON.stringify(locs)).toBeGreaterThan(0);
      expect(locs.slice(1).every(isPositional), JSON.stringify(locs)).toBe(true);
    });

    it('replays for another member who holds an account alone, at depth zero', async () => {
      const l = await ledger();
      const { result } = await replay(cap, l, '3003');
      expect(result.kind, JSON.stringify(result)).toBe('success');
      if (result.kind !== 'success') throw new Error('expected success');
      expect(result.outputs.savingsBalance).toBe(money(member('3003').savings));
      expect(result.locatorReport.every((e) => e.fallbackDepth === 0), JSON.stringify(result.locatorReport)).toBe(true);
    }, 60_000);

    it.each([
      ['2002', 'first'],
      ['5005', 'after'],
    ])("member %s's page lists another holder %s: element_not_found naming 2 candidates, and no balance is returned", async (id) => {
      const l = await ledger();
      const { result } = await replay(cap, l, id);

      expect(result.kind, JSON.stringify(result)).toBe('hard_failure');
      if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
      expect(result.code).toBe('element_not_found');
      expect(result.stepName).toBe('Read the savings balance');
      expect(result.message).toMatch(/2 candidates matched the relative locator/);
      expect(result.observed).toMatch(/ambiguous anchor: 2 matches/);
      // Before the rule: for 2002 the fallback read the first card, and the run returned 3003's
      // savings balance for member 2002 as a success.
      expect('outputs' in result).toBe(false);
      expect(JSON.stringify(result)).not.toContain(String(money(member('3003').savings)));
    }, 60_000);

    it('the label is no longer beside the value: the read does not self-heal by position (the trade this rule makes)', async () => {
      const l = await ledger();
      // 4004's savings row is labelled "Share Balance" (a note on the page still says "Savings
      // Balance"), and the recorded structural css still matches the value cell. Before the rule
      // the run returned that cell as a success: right here, and unverifiable.
      const { result } = await replay(cap, l, '4004');

      expect(result.kind, JSON.stringify(result)).toBe('hard_failure');
      if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
      expect(result.code).toBe('element_not_found');
      expect(result.stepName).toBe('Read the savings balance');
      expect(result.message).toMatch(/a positional fallback \((css|bbox) at depth \d\) was not used for a read/);
      expect('outputs' in result).toBe(false);
      expect(JSON.stringify(result)).not.toContain(String(money(member('4004').savings)));
    }, 60_000);

    it("records the read's identity: the card must show the member number, by input name", () => {
      const step = stepNamed(cap, 'Read the savings balance');
      if (step.action.type !== 'extract') throw new Error('expected an extract');
      expect(step.action.identity).toEqual({ input: 'member', within: 'container' });
      expect(JSON.stringify(cap)).not.toContain('1001');
    });

    it('only the other holder has a savings row: the label names their balance, and replay refuses it (checkpoint_failed)', async () => {
      const l = await ledger();
      // 6006 has no savings account; the page lists 3003 after them, with a "Savings Balance" row.
      // The label anchor matches exactly once, at depth zero: nothing is ambiguous and no fallback
      // is involved, so the replay rule does not apply. The card the value sits in shows 3003, not
      // 6006, so the identity check fails the step. Before it, the run succeeded with 3003's balance.
      const { result } = await replay(cap, l, '6006');

      expect(result.kind, JSON.stringify(result)).toBe('hard_failure');
      if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
      expect(result.code).toBe('checkpoint_failed');
      expect(result.stepName).toBe('Read the savings balance');
      expect(result.message).toMatch(/does not show input "member"/);
      expect('outputs' in result).toBe(false);
      for (const text of [result.message, result.expected]) {
        expect(text).not.toContain('6006'); // the input's value is never quoted
        expect(text).not.toContain(String(money(member('3003').savings)));
      }
    }, 60_000);
  });

  describe('a read whose container shows no input at record time (a search whose result shows only a name)', () => {
    let cap: Capability;
    beforeAll(async () => {
      cap = await discovered(browser, await ledger(), 'read-statement-balance-warned', 'closingBalance:number', statementScript());
    }, 120_000);

    it('records no identity check, and cu validate warns about the read (read_without_record_identity)', () => {
      const step = stepNamed(cap, 'Read the closing balance');
      if (step.action.type !== 'extract') throw new Error('expected an extract');
      expect(step.action.identity).toBeUndefined();
      const v = validateCapability(cap);
      if (!v.ok) throw new Error(JSON.stringify(v.issues));
      const warned = v.warnings.filter((w) => w.code === 'read_without_record_identity');
      expect(warned.map((w) => w.path), JSON.stringify(v.warnings)).toEqual([['steps', cap.steps.indexOf(step), 'action']]);
    });

    it('still replays for the member it was recorded with: nothing that would fail is checked', async () => {
      const l = await ledger();
      const { result } = await replay(cap, l, '1001');
      expect(result.kind, JSON.stringify(result)).toBe('success');
    }, 60_000);
  });

  describe('a name search with a detail panel (a read of the panel)', () => {
    let cap: Capability;
    beforeAll(async () => {
      cap = await discovered(browser, await ledger(), 'read-person-balance', 'balance:number', peopleScript(), { input: 'query=Smithers', entry: '/people' });
    }, 120_000);

    it("records the panel's balance through its own label, and the identity check on the input", () => {
      const step = stepNamed(cap, 'Read the balance');
      if (step.action.type !== 'extract') throw new Error('expected an extract');
      expect(step.action.identity).toEqual({ input: 'query', within: 'container' });
      expect(step.action.target.locators[0]!.strategy).toMatchObject({ kind: 'relative', anchor: { text: 'Balance' }, relation: 'right-of' });
      expect(JSON.stringify(cap)).not.toContain('Smithers');
    });

    it('replays for the name it was recorded with: the panel shows it', async () => {
      const l = await ledger();
      const { result } = await replay(cap, l, 'Smithers', 'query');
      expect(result.kind, JSON.stringify(result)).toBe('success');
      if (result.kind === 'success') expect(result.outputs.balance).toBe(75.25);
    }, 60_000);

    it('"Smith" lists Jane Smith and Al Smithers with Al\'s panel open: replay refuses it instead of returning Al\'s balance', async () => {
      const l = await ledger();
      // Before the check: the "Balance" label matched once, in Al's panel, and the run returned
      // 75.25 for the query "Smith" as a success. "Smith" is not a whole word of "Al Smithers".
      const { result } = await replay(cap, l, 'Smith', 'query');

      expect(result.kind, JSON.stringify(result)).toBe('hard_failure');
      if (result.kind !== 'hard_failure') throw new Error('expected hard_failure');
      expect(result.code).toBe('checkpoint_failed');
      expect(result.stepName).toBe('Read the balance');
      expect(result.message).toMatch(/does not show input "query"/);
      expect('outputs' in result).toBe(false);
      for (const text of [result.message, result.expected]) {
        expect(text).not.toContain('Smith'); // the input's value is never quoted
        expect(text).not.toContain('75.25');
      }
    }, 60_000);

    it('"Jane" lists only Jane Smith, whose panel is open and shows "Jane": the read passes', async () => {
      const l = await ledger();
      const { result } = await replay(cap, l, 'Jane', 'query');
      expect(result.kind, JSON.stringify(result)).toBe('success');
      if (result.kind === 'success') expect(result.outputs.balance).toBe(500);
    }, 60_000);
  });
});
