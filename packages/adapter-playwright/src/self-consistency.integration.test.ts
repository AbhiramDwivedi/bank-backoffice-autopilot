/**
 * Self-consistency: for each element observe() finds along the discovery flow, its own
 * synthesized `descriptor` should resolve back to itself via the descriptor's own *primary*
 * (index 0) locator. That is the guarantee replay depends on -- a recorded artifact's first
 * locator per step is the one enumerate.ts thought was best, so a fresh discovery run's own
 * descriptors should round-trip through resolve() at strategyIndex 0.
 *
 * This is not a replay of artifacts/lookup-member-savings-balance.json; it drives the same
 * tenant-A flow the artifact was recorded from (login -> maintenance notice -> member search ->
 * result row -> detail tabs -> savings balance) and, at each step, immediately resolves the
 * descriptor observe() just synthesized for that element, checking:
 *   1. resolve() finds it at all,
 *   2. the winning strategy is index 0 (no fallback),
 *   3. the resolved element is the same element the descriptor came from.
 *
 * Failures are collected (not asserted eagerly) so one run reports every element that fails any
 * of the three checks, not just the first.
 *
 * Identity check (3), explained: `Surface.resolve()` only returns a fresh ref and which strategy
 * won -- never a raw handle -- and `ObservedElement` never exposes one either, so there is no
 * public (Surface-interface) way to compare DOM node identity directly, and a description match
 * (tag/role/name/text/frameUrl via `describeRef`) is not strict enough: it cannot tell a wrapper
 * <div> apart from the one clickable child it wraps, since both can describe identically (same
 * tag, same inherited text, same frame) despite being different nodes -- exactly the maintenance
 * OK div / zero-padding wrapper pair this suite guards against. So this file uses
 * `PlaywrightSurface.isSameElement(refA, refB)` instead: a minimal, clearly test-only method
 * (see its doc comment in surface.ts) that evaluates real DOM node identity (`el === other`) via
 * the two refs' element handles, the same check resolve.ts's own `sameElement`/`dedupeByIdentity`
 * already rely on internally.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '@cu/mock-app/app';
import type { FramePath } from '@cu/core/schema';
import type { Observation, ObservedElement, Resolution } from '@cu/core/surface';
import { createPlaywrightSurface, type PlaywrightSurface } from './surface.js';

const TOP: FramePath = [];
const MAIN: FramePath = [{ name: 'main' }];
const inFrame = (e: ObservedElement, frame: FramePath): boolean => JSON.stringify(e.frame) === JSON.stringify(frame);

/** One element's self-consistency failure, with enough detail to diagnose without re-running. */
interface Failure {
  name: string;
  detail: string;
  descriptor: unknown;
  resolution: unknown;
}

function formatFailures(failures: Failure[]): string {
  return failures
    .map(
      (f, i) =>
        `${i + 1}. ${f.name}: ${f.detail}\n   descriptor: ${JSON.stringify(f.descriptor)}\n   resolve(): ${JSON.stringify(f.resolution)}`,
    )
    .join('\n\n');
}

/**
 * Finds `predicate` in `obs.elements`, resolves the element's own descriptor via `surface`, and
 * pushes a Failure (with the descriptor and the resolve() outcome) unless it resolves at
 * strategyIndex 0 to the same element. Always returns the observed element (when found) so the
 * caller can act on it and keep the flow moving even after a recorded failure.
 */
async function checkSelfConsistency(
  surface: PlaywrightSurface,
  failures: Failure[],
  name: string,
  obs: Observation,
  predicate: (e: ObservedElement) => boolean,
): Promise<ObservedElement> {
  const el = obs.elements.find(predicate);
  if (!el) {
    failures.push({ name, detail: 'element not present in observe() output at all', descriptor: undefined, resolution: undefined });
    throw new Error(`${name}: not found in observe() -- cannot continue the flow past this step`);
  }

  const resolution: Resolution = await surface.resolve(el.descriptor, 10_000);

  if (!resolution.found) {
    failures.push({
      name,
      detail: 'resolve() did not find the element via ANY locator in its own just-synthesized descriptor',
      descriptor: el.descriptor,
      resolution,
    });
    return el;
  }
  if (resolution.strategyIndex !== 0) {
    failures.push({
      name,
      detail: `resolved via fallback strategy index ${resolution.strategyIndex} (kind "${resolution.strategyKind}"), not the primary locator (index 0, kind "${el.descriptor.locators[0]!.strategy.kind}")`,
      descriptor: el.descriptor,
      resolution,
    });
    return el;
  }

  const same = await surface.isSameElement(el.ref, resolution.ref);
  if (!same) {
    const observedDesc = await surface.describeRef(el.ref);
    const resolvedDesc = await surface.describeRef(resolution.ref);
    failures.push({
      name,
      detail: `strategyIndex 0, but the resolved element is not (DOM-identity) the observed one: observed=${JSON.stringify(observedDesc)} resolved=${JSON.stringify(resolvedDesc)}`,
      descriptor: el.descriptor,
      resolution,
    });
  }
  return el;
}

describe('PlaywrightSurface self-consistency (tenant A discovery flow)', () => {
  let server: Server;
  let baseUrl: string;
  let surface: PlaywrightSurface;

  beforeAll(async () => {
    const app = createApp({ tenant: 'a', password: 'demo-pass-123' });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    surface = await createPlaywrightSurface({ headless: true, baseUrl });
  });

  afterAll(async () => {
    await surface?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it('every observed element resolves its own descriptor at strategyIndex 0, to itself', async () => {
    const failures: Failure[] = [];

    expect((await surface.act({ type: 'navigate', url: `${baseUrl}/login` }, 10_000)).ok).toBe(true);

    // --- 1998 login: User ID, Password, sign-on image button ---
    // `navigate` only waits for `domcontentloaded` (act.ts); under a loaded parallel test run
    // that can win the race against observe() finding the just-rendered form, so every observe()
    // that must find an element is preceded by an explicit wait for concrete rendered content,
    // not just relying on navigate/url timing.
    expect(await surface.waitFor({ kind: 'text_visible', text: 'User ID', frame: TOP }, 10_000)).toBe(true);
    const login = await surface.observe();
    const userIdEl = await checkSelfConsistency(surface, failures, 'User ID field', login, (e) => e.tag === 'input' && inFrame(e, TOP) && e.name === 'User ID');
    expect((await surface.act({ type: 'type', target: { ref: userIdEl.ref }, value: 'operator1' }, 10_000)).ok).toBe(true);

    const pwEl = await checkSelfConsistency(surface, failures, 'Password field', login, (e) => e.tag === 'input' && inFrame(e, TOP) && e.name === 'Password');
    expect((await surface.act({ type: 'type', target: { ref: pwEl.ref }, value: 'demo-pass-123' }, 10_000)).ok).toBe(true);

    // role should be 'button' (input[type=image] -> inferRole), but fall back to the control's
    // `name` attribute ("login", from login.ejs) too so a transient role-inference hiccup can't
    // sink the whole flow on an element every tenant's login page has identically.
    const signOnEl = await checkSelfConsistency(surface, failures, 'Sign-on image button', login, (e) => e.tag === 'input' && inFrame(e, TOP) && (e.role === 'button' || e.name === 'login'));
    expect((await surface.act({ type: 'click', target: { ref: signOnEl.ref } }, 10_000)).ok).toBe(true);

    // --- 2001 frameset, content in frame "main" ---
    expect(await surface.waitFor({ kind: 'url_matches', pattern: '/members/search', frame: MAIN }, 10_000)).toBe(true);

    // --- Maintenance interstitial (default ON): OK div-button inside frame main. Asserted (not
    // a conditional guard) -- the interstitial is on by default, so this step must always run;
    // a config change that silently turned it off would otherwise make this suite quietly stop
    // covering the OK button at all. This wait also doubles as the frame-main render-readiness
    // gate for the observe() just below. ---
    expect(await surface.waitFor({ kind: 'text_visible', text: 'System Maintenance Notice', frame: MAIN }, 3_000)).toBe(true);
    const shell = await surface.observe();
    const okEl = await checkSelfConsistency(surface, failures, 'Maintenance notice OK button', shell, (e) => inFrame(e, MAIN) && e.text === 'OK');
    expect((await surface.act({ type: 'click', target: { ref: okEl.ref } }, 10_000)).ok).toBe(true);
    expect(await surface.waitFor({ kind: 'text_absent', text: 'System Maintenance Notice' }, 5_000)).toBe(true);

    // --- 2005 search: Member ID field, Search div button ---
    expect(await surface.waitFor({ kind: 'text_visible', text: 'Member ID', frame: MAIN }, 10_000)).toBe(true);
    const search = await surface.observe();
    const memberIdEl = await checkSelfConsistency(surface, failures, 'Member ID field', search, (e) => e.tag === 'input' && inFrame(e, MAIN) && e.name === 'Member ID');
    expect((await surface.act({ type: 'type', target: { ref: memberIdEl.ref }, value: '12345' }, 10_000)).ok).toBe(true);

    const searchEl = await checkSelfConsistency(surface, failures, 'Search button', search, (e) => e.tag === 'div' && inFrame(e, MAIN) && e.text === 'Search');
    expect((await surface.act({ type: 'click', target: { ref: searchEl.ref } }, 10_000)).ok).toBe(true);
    expect(await surface.waitFor({ kind: 'url_matches', pattern: 'memberId=12345', frame: MAIN }, 10_000)).toBe(true);

    // --- Result row ---
    expect(await surface.waitFor({ kind: 'text_visible', text: '12345', frame: MAIN }, 10_000)).toBe(true);
    const results = await surface.observe();
    // ObservedElement.text is the row's OWN (full) text -- every cell concatenated, e.g.
    // "12345 Jane Q. Sample 08/15/2004 Active" -- not just the first cell, so match by prefix.
    const rowEl = await checkSelfConsistency(surface, failures, 'Result row 12345', results, (e) => e.tag === 'tr' && inFrame(e, MAIN) && (e.text ?? '').startsWith('12345'));
    expect((await surface.act({ type: 'click', target: { ref: rowEl.ref } }, 10_000)).ok).toBe(true);
    expect(await surface.waitFor({ kind: 'url_matches', pattern: '/members/12345', frame: MAIN }, 10_000)).toBe(true);

    // --- 2008 detail: Profile tab (checked while it's still the visible pane), Savings Balance
    // value cell (must be checked before switching away from Profile -- the Accounts pane hides
    // it via display:none, which fails isVisible()), then the Accounts tab. ---
    expect(await surface.waitFor({ kind: 'text_visible', text: 'Savings Balance', frame: MAIN }, 10_000)).toBe(true);
    const detail = await surface.observe();
    const profileTabEl = await checkSelfConsistency(surface, failures, 'Profile tab', detail, (e) => e.tag === 'span' && inFrame(e, MAIN) && e.text === 'Profile');
    expect((await surface.act({ type: 'click', target: { ref: profileTabEl.ref } }, 10_000)).ok).toBe(true);

    expect(await surface.waitFor({ kind: 'text_visible', text: '$1,234.56', frame: MAIN }, 10_000)).toBe(true);
    const detailAfterProfile = await surface.observe();
    const balanceEl = await checkSelfConsistency(surface, failures, 'Savings Balance value cell', detailAfterProfile, (e) => e.tag === 'td' && inFrame(e, MAIN) && e.text === '$1,234.56');
    const balanceRead = await surface.readText({ ref: balanceEl.ref }, 10_000);
    expect(balanceRead).toEqual({ ok: true, text: '$1,234.56' });

    const accountsTabEl = await checkSelfConsistency(surface, failures, 'Accounts tab', detailAfterProfile, (e) => e.tag === 'span' && inFrame(e, MAIN) && e.text === 'Accounts');
    expect((await surface.act({ type: 'click', target: { ref: accountsTabEl.ref } }, 10_000)).ok).toBe(true);

    expect(failures.length, `${failures.length} element(s) failed self-consistency:\n\n${formatFailures(failures)}`).toBe(0);
  });
});

describe('PlaywrightSurface self-consistency (tenant B "Member #" field)', () => {
  let server: Server;
  let baseUrl: string;
  let surface: PlaywrightSurface;

  beforeAll(async () => {
    const app = createApp({ tenant: 'b', password: 'demo-pass-123' });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    surface = await createPlaywrightSurface({ headless: true, baseUrl });
  });

  afterAll(async () => {
    await surface?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it('the "Member #" field (tenant B label) resolves its own descriptor at strategyIndex 0, to itself', async () => {
    const failures: Failure[] = [];

    expect((await surface.act({ type: 'navigate', url: `${baseUrl}/login` }, 10_000)).ok).toBe(true);
    // See the tenant-A test above: navigate only waits for domcontentloaded, so an explicit,
    // concrete-content wait guards every observe() that must find an element instead of relying
    // on navigate/url timing (this is what a flake under a fully-parallel `npm test` run was
    // traced to: observe() sometimes ran a beat before the login form had rendered).
    expect(await surface.waitFor({ kind: 'text_visible', text: 'User ID', frame: TOP }, 10_000)).toBe(true);
    const login = await surface.observe();
    const userIdEl = login.elements.find((e) => e.tag === 'input' && inFrame(e, TOP) && e.name === 'User ID');
    expect(userIdEl).toBeDefined();
    expect((await surface.act({ type: 'type', target: { ref: userIdEl!.ref }, value: 'operator1' }, 10_000)).ok).toBe(true);
    const pwEl = login.elements.find((e) => e.tag === 'input' && inFrame(e, TOP) && e.name === 'Password');
    expect(pwEl).toBeDefined();
    expect((await surface.act({ type: 'type', target: { ref: pwEl!.ref }, value: 'demo-pass-123' }, 10_000)).ok).toBe(true);
    // login.ejs is shared by every tenant (tenant.ts only varies banner/copy, never the form
    // markup), so tenant B's sign-on control is the same input[type=image] -> role 'button' as
    // tenant A's; fall back to the `name` attribute ("login") too, same as the tenant-A test,
    // so a transient role-inference hiccup can't sink the flow.
    const signOnEl = login.elements.find((e) => e.tag === 'input' && inFrame(e, TOP) && (e.role === 'button' || e.name === 'login'));
    expect(signOnEl).toBeDefined();
    expect((await surface.act({ type: 'click', target: { ref: signOnEl!.ref } }, 10_000)).ok).toBe(true);

    // Tenant B: /workstation uses <iframe name="main"> inside a table, not a <frameset>; frame
    // addressing by name is identical either way (frames.ts matches by Frame.name()).
    expect(await surface.waitFor({ kind: 'url_matches', pattern: '/members/search', frame: MAIN }, 10_000)).toBe(true);

    // Asserted (not a conditional guard) -- see the tenant-A test above for why. This wait also
    // doubles as the frame-main render-readiness gate for the observe() just below.
    expect(await surface.waitFor({ kind: 'text_visible', text: 'System Maintenance Notice', frame: MAIN }, 3_000)).toBe(true);
    const shell = await surface.observe();
    const okEl = shell.elements.find((e) => inFrame(e, MAIN) && e.text === 'OK');
    expect(okEl).toBeDefined();
    expect((await surface.act({ type: 'click', target: { ref: okEl!.ref } }, 10_000)).ok).toBe(true);
    expect(await surface.waitFor({ kind: 'text_absent', text: 'System Maintenance Notice' }, 5_000)).toBe(true);

    expect(await surface.waitFor({ kind: 'text_visible', text: 'Member #', frame: MAIN }, 10_000)).toBe(true);
    const search = await surface.observe();
    const memberHashEl = await checkSelfConsistency(surface, failures, 'Member # field (tenant B)', search, (e) => e.tag === 'input' && inFrame(e, MAIN) && e.name === 'Member #');
    expect((await surface.act({ type: 'type', target: { ref: memberHashEl.ref }, value: '12345' }, 10_000)).ok).toBe(true);

    expect(failures.length, `${failures.length} element(s) failed self-consistency:\n\n${formatFailures(failures)}`).toBe(0);
  });
});
