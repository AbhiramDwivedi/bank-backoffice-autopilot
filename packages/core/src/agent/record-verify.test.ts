/**
 * Record-time verification (tool-handlers.ts `prepareTarget`): a target that belongs to a record
 * named by a run input keeps no positional locator, and its input-bound chain, bound with this
 * run's inputs, must find the element acted on before anything is recorded.
 *  - An own-input chain narrowed to the bare placeholder that is ambiguous on the page ("12345"
 *    inside "123456") is recorded in its specific form instead (whole own text, exact).
 *  - When even that does not verify, an action keeps only its input-bound locators with
 *    `onFailure: escalate` (replay asks a human instead of guessing a position) and a provenance
 *    note -- never the positional chain. A surface that cannot compare element identity cannot
 *    verify, and counts as not verified.
 *  - A record-scoped action with nothing but positional locators is refused; an extract that does
 *    not verify is refused.
 *  - Every locator is tested alone, with no waiting: one that misses, is ambiguous or finds another
 *    element is not recorded, so the first recorded locator is one that found the element. That
 *    holds for every target; one that belongs to no record is never refused, and keeps its chain
 *    whole when no locator can be checked.
 * Driven through `discover()` on a FakeSurface with a scripted model.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discover } from './discover.js';
import { createScriptedLlm, requestText, type ScriptedTurn } from './scripted-llm.js';
import type { DiscoverOptions, PolicyGuardLike } from './types.js';
import { el, FakeSurface, scenario, type FakeElementSpec, type Observation, type Surface } from '../surface/index.js';
import { createRunLogger, newRunId } from '../evidence/index.js';
import { DEFAULT_POLICY_PATH, loadPolicy } from '../policy/index.js';
import { bindDescriptor, type Step, type TargetDescriptor } from '../schema/index.js';
import { findRef } from './test-helpers.js';

const BASE_URL = 'http://localhost:4173';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function allowGuard(): PolicyGuardLike {
  return { checkAction: () => ({ decision: 'allow', reason: 'ok', risk: 'read' }), checkUrl: () => ({ allowed: true, reason: 'ok' }) };
}

const row = (id: string, text: string, y: number): FakeElementSpec =>
  el({ id, role: 'clickable', name: text, text, tag: 'tr', css: [`tr.result:nth-of-type(${y / 30})`], bbox: { x: 10, y, w: 400, h: 20 } });

function surfaceWith(url: string, elements: FakeElementSpec[]): FakeSurface {
  const built = scenario()
    .screen('page', { url, title: 'Page', elements: [el({ id: 'heading', role: 'heading', name: 'Search results', text: 'Search results', tag: 'h2', bbox: { x: 10, y: 0, w: 300, h: 20 } }), ...elements] })
    .on('navigate', { url })
    .goto('page')
    .initial('page')
    .build();
  return new FakeSurface(built);
}

/** The price's descriptor as a web surface would give it: a container-bounded anchor on the
 *  member id. FakeSurface has no DOM, so it can never resolve `within` -- the verification miss. */
function withContainerAnchor(inner: Surface): Surface {
  const observe = async (): Promise<Observation> => {
    const obs = await inner.observe();
    return {
      ...obs,
      elements: obs.elements.map((e) =>
        e.name === '$29.99'
          ? {
              ...e,
              descriptor: {
                ...e.descriptor,
                locators: [
                  { strategy: { kind: 'relative', anchor: { text: '12345' }, relation: 'below', tag: 'div', within: 'div.card' }, confidence: 0.55, source: 'inferred' },
                  ...e.descriptor.locators,
                ],
              },
            }
          : e,
      ),
    };
  };
  return new Proxy(inner, { get: (t, p, r) => (p === 'observe' ? observe : (Reflect.get(t, p, r) as unknown)) });
}

/** The same surface, unable to compare element identity (as a surface without the method is). */
function withoutIdentity(inner: Surface): Surface {
  return new Proxy(inner, { get: (t, p, r) => (p === 'isSameElement' ? undefined : (Reflect.get(t, p, r) as unknown)) });
}

const MEMBER_INPUTS: DiscoverOptions['inputs'] = { memberId: { value: '12345', sensitive: false, description: 'member id', type: 'string' } };

function options(script: ScriptedTurn[], surface: Surface, entryUrl: string, outputs?: DiscoverOptions['outputs'], inputs: DiscoverOptions['inputs'] = MEMBER_INPUTS): DiscoverOptions {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'record-verify-'));
  dirs.push(dir);
  return {
    goal: 'Open member 12345.',
    target: { baseUrl: BASE_URL, entryUrl },
    app: { vendor: 'Acme Core Systems', product: 'CU Core Workstation', surface: 'web' },
    inputs,
    ...(outputs !== undefined ? { outputs } : {}),
    surface,
    policy: loadPolicy(DEFAULT_POLICY_PATH),
    guard: allowGuard(),
    logger: createRunLogger({ runId: newRunId(), runKind: 'discovery', rootDir: dir }),
    llm: createScriptedLlm(script),
    secretEnvNames: [],
    secrets: () => undefined,
    expectTimeoutMs: 150,
  };
}

const clickJane: ScriptedTurn = (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: 'Jane' }), why: 'Open the member', expect: '' } });
const done: ScriptedTurn = { tool: 'done', input: { success_text: 'Search results', summary: 'Opened.' } };

function onlyClick(steps: readonly Step[]): Step {
  const s = steps.find((x) => x.action.type === 'click');
  if (!s || s.action.type !== 'click') throw new Error('expected a click step');
  return s;
}

describe('record-time verification of record-scoped targets', () => {
  it('records a narrowed row click as a whole-word match: "12345" is not found inside "123456"', async () => {
    const surface = surfaceWith(`${BASE_URL}/results`, [row('r1', '12345 Jane Q. Sample', 30), row('r2', '123456 John Doe', 60)]);
    const result = await discover(options([clickJane, done], surface, `${BASE_URL}/results`));
    expect(result.status, JSON.stringify(result)).toBe('success');
    const step = onlyClick(result.capability!.steps);
    if (step.action.type !== 'click') throw new Error('expected a click');
    expect(step.action.target.locators.map((l) => l.strategy)).toEqual([{ kind: 'text', text: '{input.memberId}', exact: false, tag: 'tr', wholeWord: true }]);
    expect(step.onFailure).toBeUndefined();
  });

  it('records an ambiguous narrowed row click in its specific, exact form -- no positional fallback', async () => {
    const surface = surfaceWith(`${BASE_URL}/results`, [row('r1', '12345 Jane Q. Sample', 30), row('r2', '12345 John Doe', 60)]);
    const result = await discover(options([clickJane, done], surface, `${BASE_URL}/results`));
    expect(result.status, JSON.stringify(result)).toBe('success');
    const step = onlyClick(result.capability!.steps);
    if (step.action.type !== 'click') throw new Error('expected a click');
    expect(step.action.target.locators.map((l) => l.strategy)).toEqual([{ kind: 'text', text: '{input.memberId} Jane Q. Sample', exact: true, tag: 'tr' }]);
    expect(step.onFailure).toBeUndefined();
  });

  it('when even the specific form does not verify, keeps only input-bound locators and escalates on a miss', async () => {
    const twins = surfaceWith(`${BASE_URL}/results`, [row('r1', '12345 Jane Q. Sample', 30), row('r2', '12345 Jane Q. Sample', 60)]);
    const result = await discover(options([clickJane, done], twins, `${BASE_URL}/results`));
    expect(result.status, JSON.stringify(result)).toBe('success');
    const step = onlyClick(result.capability!.steps);
    if (step.action.type !== 'click') throw new Error('expected a click');
    const kinds = step.action.target.locators.map((l) => l.strategy.kind);
    expect(kinds).not.toContain('css');
    expect(kinds).not.toContain('bbox');
    expect(JSON.stringify(step.action.target.locators)).toContain('{input.memberId}');
    expect(step.onFailure).toBe('escalate');
    expect(result.capability!.provenance.notes).toMatch(/did not find the acted element/);
  });

  it('treats a surface that cannot compare element identity as unverified', async () => {
    const surface = withoutIdentity(surfaceWith(`${BASE_URL}/results`, [row('r1', '12345 Jane Q. Sample', 30)]));
    const result = await discover(options([clickJane, done], surface, `${BASE_URL}/results`));
    const step = onlyClick(result.capability!.steps);
    expect(step.onFailure).toBe('escalate');
  });

  it('refuses an action on a list page for the input whose only locators are positional', async () => {
    let second = '';
    const surface = surfaceWith(`${BASE_URL}/members/search?memberId=12345`, [
      el({ id: 'icon', role: 'clickable', name: '', tag: 'div', css: ['div:nth-of-type(4) > div'], bbox: { x: 500, y: 10, w: 16, h: 16 } }),
    ]);
    const script: ScriptedTurn[] = [
      (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role: 'clickable' }), why: 'Open the menu', expect: '' } }),
      (req) => {
        second = requestText(req);
        return { tool: 'stuck', input: { reason: 'refused' } };
      },
    ];
    const result = await discover(options(script, surface, `${BASE_URL}/members/search?memberId=12345`));
    expect(second).toContain('nothing identifies it except its position');
    expect(result.stepsRecorded).toBe(1); // the entry navigation only: no click was recorded
  });

  it("still dismisses an interstitial on the member's own page and records it as a recovery rule", async () => {
    const built = scenario()
      .screen('notice', {
        url: `${BASE_URL}/members/12345`,
        title: 'Member',
        text: ['Scheduled maintenance tonight'],
        elements: [
          el({ id: 'title', role: 'heading', name: 'System Notice', text: 'System Notice', tag: 'h2', bbox: { x: 10, y: 0, w: 200, h: 20 } }),
          el({ id: 'ok', role: 'clickable', name: 'OK', text: 'OK', tag: 'div', css: ['div.notice > div.ok'], bbox: { x: 10, y: 40, w: 40, h: 20 } }),
        ],
      })
      .on('navigate', { url: `${BASE_URL}/members/12345` })
      .goto('notice')
      .on('click', { targetId: 'ok' })
      .goto('member')
      .screen('member', {
        url: `${BASE_URL}/members/12345`,
        title: 'Member',
        elements: [el({ id: 'label', role: 'cell', name: 'Savings Balance', text: 'Savings Balance', tag: 'td', bbox: { x: 10, y: 10, w: 100, h: 20 } })],
      })
      .initial('notice')
      .build();
    const script: ScriptedTurn[] = [
      (req) => ({
        tool: 'dismiss_interstitial',
        input: { ref: findRef(requestText(req), { role: 'clickable', nameIncludes: 'OK' }), trigger_text: 'Scheduled maintenance tonight', title: 'System Notice', why: 'Dismiss the notice' },
      }),
      { tool: 'done', input: { success_text: 'Savings Balance', summary: 'Dismissed.' } },
    ];
    const result = await discover(options(script, new FakeSurface(built), `${BASE_URL}/members/12345`));
    expect(result.status, JSON.stringify(result)).toBe('success');
    expect(result.capability!.recoveryRules).toHaveLength(1);
    const click = result.capability!.recoveryRules[0]!.actions.find((a) => a.type === 'click');
    if (click?.type !== 'click') throw new Error('expected a click');
    expect(click.target.locators[0]!.strategy).toMatchObject({ kind: 'text', text: 'OK' });
  });

  it('refuses to record an extract whose record-scoped chain does not find the element read', async () => {
    let second = '';
    const surface = withContainerAnchor(
      surfaceWith(`${BASE_URL}/results`, [el({ id: 'price', role: 'generic', name: '$29.99', text: '$29.99', tag: 'div', bbox: { x: 10, y: 100, w: 60, h: 20 } })]),
    );
    const script: ScriptedTurn[] = [
      (req) => ({ tool: 'extract', input: { ref: findRef(requestText(req), { role: 'generic', nameIncludes: '$29.99' }), output: 'price', parse: 'currency', why: 'Read the price' } }),
      (req) => {
        second = requestText(req);
        return { tool: 'stuck', input: { reason: 'no reusable locator' } };
      },
    ];
    const result = await discover(options(script, surface, `${BASE_URL}/results`, { price: { type: 'number', description: 'price' } }));
    expect(second).toContain('Could not record a reusable locator for "price"');
    expect(result.status).not.toBe('success');
    expect(result.outputs?.price).toBeUndefined();
  });
});

describe('record-time pruning: a recorded locator found the element on its own', () => {
  const NAME = 'Canvas Backpack';
  const PRODUCT_INPUTS: DiscoverOptions['inputs'] = { productName: { value: NAME, sensitive: false, description: 'product name', type: 'string' } };
  const URL = `${BASE_URL}/products`;
  // A card as shops build it: a title link and an image link, both named after the product.
  const titleLink = el({ id: 'title', role: 'link', name: NAME, text: NAME, tag: 'a', css: ['a.title-link:nth-of-type(1)'], bbox: { x: 120, y: 30, w: 200, h: 20 } });
  const imageLink = el({ id: 'image', role: 'link', name: NAME, tag: 'a', css: ['a.image-link:nth-of-type(1)'], bbox: { x: 10, y: 30, w: 96, h: 96 } });
  const clickFirst =
    (role: string, name: string): ScriptedTurn =>
    (req) => ({ tool: 'click', input: { ref: findRef(requestText(req), { role, nameIncludes: name }), why: 'Open it', expect: '' } });

  /** Every `resolve()` discovery makes on the surface: how many locators it carried, and its timeout. */
  function spyOnResolve(inner: Surface): { surface: Surface; calls: { locators: number; timeoutMs: number }[] } {
    const calls: { locators: number; timeoutMs: number }[] = [];
    const resolve = (target: TargetDescriptor, timeoutMs: number): ReturnType<Surface['resolve']> => {
      calls.push({ locators: target.locators.length, timeoutMs });
      return inner.resolve(target, timeoutMs);
    };
    return { surface: new Proxy(inner, { get: (t, p, r) => (p === 'resolve' ? resolve : (Reflect.get(t, p, r) as unknown)) }), calls };
  }

  it('drops the role locator two links share, so the chain starts with the locator that finds the link', async () => {
    const fake = surfaceWith(URL, [titleLink, imageLink]);
    const { surface, calls } = spyOnResolve(fake);
    const result = await discover(options([clickFirst('link', NAME), done], surface, URL, undefined, PRODUCT_INPUTS));
    expect(result.status, JSON.stringify(result)).toBe('success');
    const step = onlyClick(result.capability!.steps);
    if (step.action.type !== 'click') throw new Error('expected a click');
    // The role locator (name "{input.productName}") matches both links and is gone.
    expect(step.action.target.locators.map((l) => l.strategy)).toEqual([{ kind: 'text', text: '{input.productName}', exact: false, tag: 'a' }]);
    expect(step.onFailure).toBeUndefined();
    // Replay's view: bound with the input, the recorded chain resolves at depth zero.
    const resolution = await fake.resolve(bindDescriptor(step.action.target, { baseUrl: BASE_URL, inputs: { productName: NAME } }), 0);
    expect(resolution).toMatchObject({ found: true, strategyIndex: 0 });
    // Cost: one lookup per kept locator, none of them waiting.
    expect(calls).toEqual([
      { locators: 1, timeoutMs: 0 },
      { locators: 1, timeoutMs: 0 },
    ]);
  });

  it('drops a locator that finds another element, and records the ones that find this one', async () => {
    // The surface offers a label locator on the product name that is really the quantity field's.
    const quantity = el({ id: 'qty', role: 'textbox', name: 'Quantity', label: NAME, tag: 'input', bbox: { x: 400, y: 30, w: 60, h: 20 } });
    const inner = surfaceWith(URL, [titleLink, quantity]);
    const observe = async (): Promise<Observation> => {
      const obs = await inner.observe();
      return {
        ...obs,
        elements: obs.elements.map((e) =>
          e.role === 'link'
            ? { ...e, descriptor: { ...e.descriptor, locators: [{ strategy: { kind: 'label', label: NAME, exact: true }, confidence: 0.8, source: 'inferred' }, ...e.descriptor.locators] } }
            : e,
        ),
      };
    };
    const surface = new Proxy(inner, { get: (t, p, r) => (p === 'observe' ? observe : (Reflect.get(t, p, r) as unknown)) });
    const result = await discover(options([clickFirst('link', NAME), done], surface, URL, undefined, PRODUCT_INPUTS));
    expect(result.status, JSON.stringify(result)).toBe('success');
    const step = onlyClick(result.capability!.steps);
    if (step.action.type !== 'click') throw new Error('expected a click');
    expect(step.action.target.locators.map((l) => l.strategy.kind)).toEqual(['role', 'text']);
    expect(step.onFailure).toBeUndefined();
  });

  describe('a target that belongs to no record', () => {
    // Two "Search" buttons, one in the header and one in the form: neither role nor text tells them apart.
    const search = (id: string, y: number): FakeElementSpec =>
      el({ id, role: 'button', name: 'Search', text: 'Search', tag: 'button', css: [`form#${id} > button.go`], bbox: { x: 10, y, w: 80, h: 20 } });
    const twoSearches = (): FakeSurface => surfaceWith(URL, [search('header-search', 30), search('member-search', 60)]);

    it('drops the locators that are ambiguous on the page and keeps the ones that find the control', async () => {
      const result = await discover(options([clickFirst('button', 'Search'), done], twoSearches(), URL));
      expect(result.status, JSON.stringify(result)).toBe('success');
      const step = onlyClick(result.capability!.steps);
      if (step.action.type !== 'click') throw new Error('expected a click');
      expect(step.action.target.locators.map((l) => l.strategy.kind)).toEqual(['css', 'bbox']);
      expect(step.action.target.locators[0]!.strategy).toMatchObject({ selector: 'form#header-search > button.go' });
      expect(step.onFailure).toBeUndefined();
    });

    it('keeps the chain whole on a surface that cannot compare elements: nothing was learned', async () => {
      const result = await discover(options([clickFirst('button', 'Search'), done], withoutIdentity(twoSearches()), URL));
      expect(result.status, JSON.stringify(result)).toBe('success');
      const step = onlyClick(result.capability!.steps);
      if (step.action.type !== 'click') throw new Error('expected a click');
      expect(step.action.target.locators.map((l) => l.strategy.kind)).toEqual(['role', 'text', 'css', 'bbox']);
    });
  });
});
