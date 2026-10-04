/**
 * Recorder -> replay round trip for input-bound URL checkpoints. The scenario's result row always
 * opens member 12345, whatever was searched, standing in for a css/relative fallback locator that
 * clicks the first result row. A capability recorded for 12345 replays fine for 12345; replayed
 * for 67890 it must fail instead of "succeeding" on the wrong member's page: first because the
 * recorder keeps only the input-bound locator of the input-scoped row click, and, where a fallback
 * that matches any row survives anyway, on the URL check.
 */
import { describe, expect, it } from 'vitest';
import type { Capability, Condition, FramePath } from '../schema/index.js';
import { bindCondition, validateCapability } from '../schema/index.js';
import { FakeSurface, el, evaluateCondition, scenario, type ConditionView } from '../surface/index.js';
import { makeFakeClock, runReplay } from '../replay/test-helpers.js';
import { createRecorder } from './recorder.js';

const BASE = 'http://localhost:4173';
const MAIN: FramePath = [{ name: 'main' }];
const MEMBER_URL_CHECK: Condition = { kind: 'url_matches', pattern: '/members/{input.memberId}(?![A-Za-z0-9])', frame: MAIN };

function buildSurface(clock: ReturnType<typeof makeFakeClock>): FakeSurface {
  const built = scenario()
    .screen('search', {
      url: `${BASE}/workstation`,
      title: 'Workstation',
      frames: [{ path: MAIN, url: `${BASE}/members/search` }],
      elements: [
        el({ id: 'memberId', role: 'textbox', name: 'Member ID', label: 'Member ID', tag: 'input', css: ['input[name="memberId"]'], frame: MAIN, bbox: { x: 10, y: 10, w: 100, h: 20 } }),
        el({ id: 'search', role: 'clickable', name: 'Search', text: 'Search', tag: 'div', frame: MAIN, bbox: { x: 10, y: 40, w: 60, h: 20 } }),
      ],
    })
    .on('click', { targetId: 'search' })
    .goto('results')
    .screen('results', {
      url: `${BASE}/workstation`,
      title: 'Workstation',
      frames: [{ path: MAIN, url: `${BASE}/members/search` }],
      elements: [
        el({ id: 'row', role: 'clickable', name: '12345 Jane Q. Sample', text: '12345 Jane Q. Sample', tag: 'tr', css: ['tr.result'], frame: MAIN, bbox: { x: 10, y: 80, w: 400, h: 20 } }),
      ],
    })
    .on('click', { targetId: 'row' })
    .goto('detail')
    .screen('detail', {
      url: `${BASE}/workstation`,
      title: 'Workstation',
      frames: [{ path: MAIN, url: `${BASE}/members/12345` }],
      elements: [el({ id: 'savingsLabel', role: 'cell', name: 'Savings Balance', text: 'Savings Balance', tag: 'td', frame: MAIN, bbox: { x: 10, y: 10, w: 100, h: 20 } })],
    })
    .initial('search')
    .build();
  return new FakeSurface(built, { clock });
}

/** Records the lookup the way the discovery loop does: act on the surface, then hand the recorder
 *  the fresh observation's location before the next step. */
async function recordLookup(): Promise<Capability> {
  const surface = buildSurface(makeFakeClock());
  const recorder = createRecorder({ baseUrl: BASE, inputs: { memberId: { value: '12345', sensitive: false, description: 'Member ID', type: 'string' } } });
  const observeInto = async (): Promise<void> => {
    const obs = await surface.observe();
    recorder.noteLocation({ url: obs.url, frames: obs.frames });
  };

  await observeInto();
  const box = (await surface.observe()).elements.find((e) => e.name === 'Member ID')!;
  await surface.act({ type: 'type', target: { ref: box.ref }, value: '12345', clear: true }, 1000);
  recorder.recordStep({ action: { type: 'type', target: box.descriptor, value: { kind: 'input', name: 'memberId' }, clear: true }, why: 'Enter the member ID', risk: 'read' });
  await observeInto();

  const search = (await surface.observe()).elements.find((e) => e.name === 'Search')!;
  await surface.act({ type: 'click', target: { ref: search.ref } }, 1000);
  recorder.recordStep({ action: { type: 'click', target: search.descriptor }, why: 'Run the search', risk: 'read' });
  await observeInto();

  // The row's own text locator narrows to {input.memberId}; the css fallback matches any row.
  recorder.recordStep({
    action: {
      type: 'click',
      target: {
        description: 'clickable "12345 Jane Q. Sample" (<tr>)',
        frame: MAIN,
        locators: [
          { strategy: { kind: 'text', text: '12345 Jane Q. Sample', tag: 'tr' }, confidence: 0.7, source: 'inferred' },
          { strategy: { kind: 'css', selector: 'tr.result' }, confidence: 0.3, source: 'inferred' },
        ],
      },
    },
    why: 'Open the member record',
    risk: 'read',
    postcondition: { kind: 'text_visible', text: 'Savings Balance', frame: MAIN },
  });
  const row = (await surface.observe()).elements.find((e) => e.name === '12345 Jane Q. Sample')!;
  await surface.act({ type: 'click', target: { ref: row.ref } }, 1000);
  await observeInto();

  recorder.setSuccess({ kind: 'text_visible', text: 'Savings Balance', frame: MAIN }, 'Opened the member record.');
  const built = recorder.build({
    id: 'open-member-record',
    goal: 'Open the member record.',
    app: { vendor: 'Acme Core Systems', product: 'CU Core Workstation', surface: 'web' },
    entryUrl: `${BASE}/workstation`,
    runId: 'run_test_url_checkpoint',
    model: 'test-model',
    discoveredAt: '2026-09-25T00:00:00Z',
  });
  if (!built.ok) throw new Error(`expected ok build, got: ${JSON.stringify(built.issues)}`);
  return built.capability;
}

async function replayFor(capability: Capability, memberId: string) {
  const clock = makeFakeClock();
  return runReplay({ capability, inputs: { memberId }, surface: buildSurface(clock), clock });
}

/** The row click with its input-blind css fallback put back. The recorder drops that fallback
 *  from an input-scoped target (see the first test), so this stands for one it cannot recognize:
 *  a hand-edited artifact, an override, a fallback that matches any row for another reason. The
 *  URL checkpoint is the net under exactly that case. */
function withAnyRowFallback(cap: Capability): Capability {
  return {
    ...cap,
    steps: cap.steps.map((s) =>
      s.id === 's03' && s.action.type === 'click'
        ? {
            ...s,
            action: {
              ...s.action,
              target: { ...s.action.target, locators: [...s.action.target.locators, { strategy: { kind: 'css', selector: 'tr.result' }, confidence: 0.3, source: 'inferred' }] },
            },
          }
        : s,
    ),
  };
}

describe('input-bound URL checkpoint: record then replay (FakeSurface)', () => {
  it('records the row click and success bound to {input.memberId}', async () => {
    const cap = await recordLookup();
    expect(cap.steps[2]!.postcondition).toEqual({ kind: 'all', of: [{ kind: 'text_visible', text: 'Savings Balance', frame: MAIN }, MEMBER_URL_CHECK] });
    expect(cap.success.condition).toEqual({ kind: 'all', of: [{ kind: 'text_visible', text: 'Savings Balance', frame: MAIN }, MEMBER_URL_CHECK] });
    // Searching does not change the main frame URL in this scenario, so the search step gets none.
    expect(cap.steps[1]!.postcondition).toBeUndefined();
    const validated = validateCapability(cap);
    expect(validated.ok && validated.warnings).toEqual([]);
  });

  it('passes for the member it was recorded with', async () => {
    const cap = await recordLookup();
    const { result } = await replayFor(cap, '12345');
    expect(result.kind).toBe('success');
  });

  it('the recorder drops the input-blind css fallback, so another member misses the row instead of opening the recorded one', async () => {
    const cap = await recordLookup();
    const row = cap.steps[2]!.action;
    if (row.type !== 'click') throw new Error('expected a click');
    expect(row.target.locators.map((l) => l.strategy)).toEqual([{ kind: 'text', text: '{input.memberId}', exact: false, tag: 'tr', wholeWord: true }]);
    const { result } = await replayFor(cap, '67890');
    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected a hard failure');
    expect(result.stepId).toBe('s03');
    expect(result.code).toBe('element_not_found');
  });

  it('with a fallback that clicks any row, fails the row click for a different member on the URL check instead of succeeding on the wrong record', async () => {
    const cap = withAnyRowFallback(await recordLookup());
    const { result } = await replayFor(cap, '67890');
    expect(result.kind).toBe('hard_failure');
    if (result.kind !== 'hard_failure') throw new Error('expected a hard failure');
    expect(result.stepId).toBe('s03');
    expect(result.code).toBe('checkpoint_failed');
  });

  it('without the URL check the same replay "succeeds" for the wrong member (and validation warns)', async () => {
    const cap = withAnyRowFallback(await recordLookup());
    const staticOnly: Capability = {
      ...cap,
      steps: cap.steps.map((s) => (s.id === 's03' ? { ...s, postcondition: { kind: 'text_visible', text: 'Savings Balance', frame: MAIN } } : s)),
      success: { ...cap.success, condition: { kind: 'text_visible', text: 'Savings Balance', frame: MAIN } },
    };
    const validated = validateCapability(staticOnly);
    expect(validated.ok && validated.warnings.map((w) => w.code)).toEqual(['unverified_input_binding']);
    const { result } = await replayFor(staticOnly, '67890');
    expect(result.kind).toBe('success');
  });

  it('binds the value regex-escaped and whole-token: only the exact member id matches', async () => {
    const view = (mainUrl: string): ConditionView => ({
      url: `${BASE}/workstation`,
      textDigest: '',
      frameText: () => '',
      frameUrl: (frame) => (JSON.stringify(frame) === JSON.stringify(MAIN) ? mainUrl : undefined),
      hasElement: () => false,
    });
    const holds = (memberId: string, mainUrl: string) =>
      evaluateCondition(bindCondition(MEMBER_URL_CHECK, { baseUrl: BASE, inputs: { memberId } }), view(mainUrl));
    expect(await holds('12345', `${BASE}/members/12345`)).toBe(true);
    expect(await holds('12345', `${BASE}/members/12345?tab=profile`)).toBe(true);
    expect(await holds('1234', `${BASE}/members/12345`)).toBe(false);
    expect(await holds('67890', `${BASE}/members/12345`)).toBe(false);
    expect(await holds('.*', `${BASE}/members/12345`)).toBe(false);
    expect(await holds('.*', `${BASE}/members/.*`)).toBe(true);
  });
});
