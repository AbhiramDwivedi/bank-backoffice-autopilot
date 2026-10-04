/**
 * Exercises the allowlist/policy guarantees against `createPolicyGuard` directly and against
 * `withPolicy()` over `FakeSurface`. Each `it` documents one scenario and the guarantee it
 * checks. Real-browser redirect/link-click quarantine checks live in
 * `packages/adapter-playwright/src/allowlist.redteam.test.ts`; whether the mock app's server actually
 * routes a mangled path to `/__faults` is checked separately in `apps/mock-app/faults.redteam.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { el, FakeSurface, scenario } from '../surface/index.js';
import { createPolicyGuard, resolveRelativeUrl } from './guard.js';
import { DEFAULT_POLICY_PATH, loadPolicy, parsePolicy } from './load.js';
import { withPolicy } from './enforcing-surface.js';

const BASE = 'http://localhost:4173';
const defaultPolicy = loadPolicy(DEFAULT_POLICY_PATH);
const defaultGuard = createPolicyGuard(defaultPolicy);

// -------------------------------------------------------------------------------------------
// Scheme / origin allowlist attacks (guard.checkUrl)
// -------------------------------------------------------------------------------------------

describe('scheme/origin allowlist attacks -- all denied', () => {
  it.each([
    ['javascript: scheme', 'javascript:alert(1)'],
    ['data: URL', 'data:text/html,<script>alert(1)</script>'],
    ['file: URL', 'file:///C:/Windows/win.ini'],
    ['file: URL (unix-style)', 'file:///etc/passwd'],
  ])('%s is denied (non-http(s) scheme, never an allowed origin)', (_label, url) => {
    expect(defaultGuard.checkUrl(url).allowed).toBe(false);
  });

  it('protocol-relative "//evil.example/" resolves (against an allowed current URL) to the evil origin and is denied', () => {
    // A protocol-relative URL has no scheme of its own; classifyRisk/checkAction resolve it
    // against ctx.currentUrl first (resolveRelativeUrl), which is exactly what a real browser
    // does too -- so the guard checks the URL it will actually navigate to, not the literal
    // partial string.
    const resolved = new URL('//evil.example/', `${BASE}/form`).toString();
    expect(resolved).toBe('http://evil.example/');
    expect(defaultGuard.checkUrl(resolved).allowed).toBe(false);
  });

  it('userinfo trick "http://allowed-origin@evil.example/" -- origin is host-based, not userinfo-based, so it is still evil.example and denied', () => {
    const url = 'http://allowed-origin@evil.example/';
    expect(new URL(url).origin).toBe('http://evil.example');
    expect(defaultGuard.checkUrl(url).allowed).toBe(false);
  });

  it('uppercase scheme/host normalizes to the same lowercase origin, so it is still ALLOWED (this is not a bypass -- it is the same origin, just spelled differently)', () => {
    expect(defaultGuard.checkUrl('HTTP://LOCALHOST:4173/members/search').allowed).toBe(true);
  });

  it('trailing-dot host ("localhost.") is a byte-for-byte different origin string and is denied (not a bypass into the allowed origin, just a different, unlisted one)', () => {
    const url = 'http://localhost.:4173/members/search';
    expect(new URL(url).origin).toBe('http://localhost.:4173');
    expect(defaultGuard.checkUrl(url).allowed).toBe(false);
  });

  it('allowed host with a different port is denied (origin includes the port)', () => {
    expect(defaultGuard.checkUrl('http://localhost:9999/members/search').allowed).toBe(false);
  });

  it('about:blank / about:srcdoc are not allowed origins either (only NEUTRAL_FRAME_URLS treats them specially, for quarantine bookkeeping, never for checkUrl)', () => {
    expect(defaultGuard.checkUrl('about:blank').allowed).toBe(false);
    expect(defaultGuard.checkUrl('about:srcdoc').allowed).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
// Denied-path edge cases (guard.checkUrl), cross-checked against real Express routing
// -------------------------------------------------------------------------------------------

/**
 * `checkUrl` normalizes a pathname before matching it against deny/allow patterns:
 * percent-decodes it once, collapses repeated `/`, and resolves `.`/`..` segments -- the same
 * normalization a browser applies before issuing the request, so the guard evaluates the path
 * that would actually go out on the wire. This closes off percent-encoding, doubled-slash, and
 * dot-segment forms that would otherwise reach `/__faults`/`/__reset` without matching the deny
 * pattern's raw string. Server-side behavior (Express 5.2.1; see apps/mock-app/faults.redteam.test.ts)
 * is a separate, independently-enforced layer and is not what this suite checks.
 */
describe('UNC paths, backslashes and protocol-relative URLs are refused before any resolution', () => {
  // Resolved against an allowed http(s) page these become http URLs on some host and could pass the
  // origin check; a browser handed the raw string loads `\\host\share\x` as a file: page.
  const portless = createPolicyGuard({ ...loadPolicy(DEFAULT_POLICY_PATH), allowedOrigins: ['http://localhost'] });
  const cases = [
    ['a UNC path to the allowed host', '\\\\localhost\\c$\\Windows\\win.ini'],
    ['a UNC path to another host', '\\\\fileserver\\share\\x'],
    ['a mixed slash UNC path', '\\/localhost/c$/x'],
    ['a protocol-relative URL to the allowed host', '//localhost/x'],
    ['a protocol-relative URL hidden by a tab', '/\t/localhost/x'],
    ['a backslash scheme separator', 'http:\\\\localhost\\x'],
    ['a backslash in a path', '/members\\..\\__faults'],
    ['leading control characters before a UNC path', '\u0001 \\\\localhost\\c$\\x'],
  ] as const;

  it.each(cases)('%s: navigate is denied, from an http page', (_label, url) => {
    expect(portless.checkAction({ type: 'navigate', url }, { currentUrl: 'http://localhost/members' }).decision).toBe('deny');
  });

  it.each(cases)('%s: checkUrl denies it and resolveRelativeUrl never turns it into an http URL', (_label, url) => {
    expect(portless.checkUrl(url).allowed).toBe(false);
    expect(resolveRelativeUrl(url, 'http://localhost/members')).toBe(url);
  });

  it('through withPolicy over a FakeSurface, the navigate never reaches the surface, even quarantined', async () => {
    const inner = new FakeSurface(
      scenario()
        .screen('home', { url: 'http://localhost/members', title: 'Home', elements: [] })
        .onAny('navigate', {})
        .goto('home')
        .build(),
    );
    const actSpy = vi.spyOn(inner, 'act');
    const ps = withPolicy(inner, portless);
    for (const [, url] of cases) {
      expect(await ps.act({ type: 'navigate', url }, 1000)).toMatchObject({ ok: false, error: { code: 'policy_violation' } });
    }
    expect(actSpy).not.toHaveBeenCalled();
  });
});

describe('denied-path (/__faults, /__reset) edge cases, including encoded/normalized forms', () => {
  const denied = (path: string): boolean => !defaultGuard.checkUrl(`${BASE}${path}`).allowed;

  it('exact match', () => {
    expect(denied('/__faults')).toBe(true);
    expect(denied('/__reset')).toBe(true);
  });

  it('uppercase path is still denied (normalization lower-cases the path for the deny check)', () => {
    expect(denied('/__FAULTS')).toBe(true);
    expect(denied('/__ReSeT')).toBe(true);
  });

  it('query string / fragment do not change the pathname the deny pattern sees', () => {
    expect(denied('/__faults?x=1')).toBe(true);
    expect(denied('/__faults#frag')).toBe(true);
  });

  it('a trailing ".." cancels the segment before it, landing on "/" rather than the fault route (not a bypass: nothing at /__faults was actually reached)', () => {
    expect(denied('/__faults/..')).toBe(false);
  });

  it('a ".." in the middle of the path resolves onto the fault route and is denied', () => {
    expect(denied('/x/../__faults')).toBe(true);
    expect(denied('/./__faults')).toBe(true);
  });

  it('a percent-encoded underscore ("/%5f%5ffaults") decodes onto the fault route and is denied', () => {
    expect(denied('/%5f%5ffaults')).toBe(true);
    expect(denied('/%5F%5Ffaults')).toBe(true);
  });

  it('a doubled leading slash ("//__faults") collapses onto the fault route and is denied', () => {
    expect(denied('//__faults')).toBe(true);
  });

  it('a malformed percent-escape cannot be decoded and is denied rather than passed through', () => {
    expect(denied('/%zz')).toBe(true);
  });

  it('the mock app chaos report (/__faults/chaos, under the denied /__faults prefix) is denied in every form', () => {
    for (const path of [
      '/__faults/chaos',
      '/__FAULTS/CHAOS',
      '/__faults/chaos?x=1',
      '/__faults/chaos/',
      '/x/../__faults/chaos',
      '/%5f%5ffaults/chaos',
      '/__faults/%63haos',
      '//__faults/chaos',
      '/./__faults/./chaos',
    ]) {
      expect(denied(path), path).toBe(true);
    }
  });

  it('normal application paths are unaffected by the normalization', () => {
    expect(defaultGuard.checkUrl(`${BASE}/members/search`).allowed).toBe(true);
    expect(defaultGuard.checkUrl(`${BASE}/members/12345`).allowed).toBe(true);
    expect(defaultGuard.checkUrl(`${BASE}/workstation`).allowed).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------
// Allowlist enforcement never reaches the inner surface (withPolicy over FakeSurface)
// -------------------------------------------------------------------------------------------

function testPolicy() {
  return parsePolicy(`
name: allowlist-redteam
allowedOrigins: ['${BASE}']
allowedPathPatterns: []
deniedPathPatterns: ['^/__faults', '^/__reset']
allowedActions: [navigate, click, type, select, press, extract, wait, dismiss_dialog, switch_frame]
risk:
  irreversibleTextPatterns:
    - '^(submit|confirm|create|open account|transfer|delete|approve|post)\\b'
  irreversibleUrlPatterns:
    - '/subaccounts$'
  discoveryMode: escalate
  replayRequiresApproved: true
redaction:
  patterns: []
limits: { maxSteps: 40, maxDurationMs: 600000, maxLlmCalls: 60 }
`);
}
const guard = createPolicyGuard(testPolicy());

function buildScenario() {
  return scenario()
    .screen('wire', {
      url: `${BASE}/members/12345/subaccounts/new`,
      title: 'Open sub-account',
      elements: [
        el({ id: 'amount', role: 'textbox', name: 'Amount', tag: 'input', bbox: { x: 0, y: 0, w: 100, h: 20 } }),
        el({ id: 'nickname', role: 'textbox', name: 'Nickname', tag: 'input', bbox: { x: 0, y: 30, w: 100, h: 20 } }),
        el({ id: 'confirmBtn', role: 'button', name: 'Confirm Transfer', tag: 'button', bbox: { x: 0, y: 60, w: 100, h: 20 } }),
      ],
    })
    .on('press', { key: 'Enter' })
    .goto('done')
    .on('click', { targetId: 'confirmBtn' })
    .goto('done')
    .screen('wireDisabledConfirm', {
      url: `${BASE}/members/12345/subaccounts/new?variant=disabled`,
      title: 'Open sub-account (disabled confirm)',
      elements: [
        el({ id: 'amount', role: 'textbox', name: 'Amount', tag: 'input', bbox: { x: 0, y: 0, w: 100, h: 20 } }),
        el({ id: 'confirmBtnDisabled', role: 'button', name: 'Confirm Transfer', tag: 'button', enabled: false, bbox: { x: 0, y: 60, w: 100, h: 20 } }),
      ],
    })
    .on('press', { key: 'Enter' })
    .goto('doneDisabled')
    .screen('search', {
      url: `${BASE}/members/search`,
      title: 'Member search',
      elements: [
        el({ id: 'memberId', role: 'textbox', name: 'Member ID', tag: 'input', bbox: { x: 0, y: 0, w: 100, h: 20 } }),
        el({ id: 'searchBtn', role: 'button', name: 'Search', tag: 'button', bbox: { x: 0, y: 30, w: 100, h: 20 } }),
      ],
    })
    .on('press', { key: 'Enter' })
    .goto('searched')
    .screen('done', { url: `${BASE}/members/12345/subaccounts/SA-0000001/confirmation`, title: 'Confirmed', elements: [] })
    .screen('doneDisabled', { url: `${BASE}/members/12345/subaccounts/SA-0000002/confirmation`, title: 'Confirmed (should not happen)', elements: [] })
    .screen('searched', { url: `${BASE}/members/search?ok=1`, title: 'Searched', elements: [] })
    .build();
}

describe('press-Enter / type+pressEnter irreversible-submit bypass', () => {
  it('typing into an unrelated field ("Amount") and pressing Enter must not silently submit an irreversible form just because the *field itself* is not named "Confirm"', async () => {
    const inner = new FakeSurface(buildScenario());
    const actSpy = vi.spyOn(inner, 'act');
    const ps = withPolicy(inner, guard, { onDecision: () => {} });
    const obs = await ps.observe();
    const amount = obs.elements.find((e) => e.name === 'Amount')!;

    const result = await ps.act({ type: 'type', target: amount.descriptor, value: '5000000', pressEnter: true }, 1000);

    // classifyRisk('type', pressEnter) only looks at the typed-into field's own name ("Amount"),
    // never at the page's actual submit control, so without this check the action would return
    // ok:true and silently execute the same irreversible transition as clicking "Confirm Transfer".
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('policy_violation');
    expect(inner.currentScreenId()).toBe('wire'); // never actually submitted
    expect(actSpy).not.toHaveBeenCalled();
  });

  it('a bare press(Enter) with no target at all, while an enabled irreversible-looking control is on the page, is also refused', async () => {
    const inner = new FakeSurface(buildScenario());
    const actSpy = vi.spyOn(inner, 'act');
    const ps = withPolicy(inner, guard, { onDecision: () => {} });
    await ps.observe();

    const result = await ps.act({ type: 'press', key: 'Enter' }, 1000);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('policy_violation');
    expect(inner.currentScreenId()).toBe('wire');
    expect(actSpy).not.toHaveBeenCalled();
  });

  it.each(['\r', '\n', '\r\n', 'Return', 'RETURN'])('press(%j) is Enter (a surface presses it as Enter) and is refused the same way', async (key) => {
    const inner = new FakeSurface(buildScenario());
    const actSpy = vi.spyOn(inner, 'act');
    const ps = withPolicy(inner, guard, { onDecision: () => {} });
    await ps.observe();
    expect(await ps.act({ type: 'press', key }, 1000)).toMatchObject({ ok: false, error: { code: 'policy_violation' } });
    expect(actSpy).not.toHaveBeenCalled();
    expect(guard.classifyRisk({ type: 'press', key }, { targetName: 'Confirm Transfer', currentUrl: `${BASE}/x` })).toBe('irreversible');
  });

  it.each(['NumpadEnter', 'Space', ' ', 'Spacebar', 'enter', 'SPACE'])(
    'a bare press(%j) activates the focused control just like Enter, and is refused the same way',
    async (key) => {
      const inner = new FakeSurface(buildScenario());
      const actSpy = vi.spyOn(inner, 'act');
      const ps = withPolicy(inner, guard, { onDecision: () => {} });
      await ps.observe();
      const result = await ps.act({ type: 'press', key }, 1000);
      expect(result).toMatchObject({ ok: false, error: { code: 'policy_violation' } });
      expect(actSpy).not.toHaveBeenCalled();
    },
  );

  it.each(['NumpadEnter', 'Space', ' ', 'Spacebar'])('classifyRisk treats press(%j) on an irreversible target as irreversible, not read', (key) => {
    expect(guard.classifyRisk({ type: 'press', key }, { targetName: 'Confirm Transfer', currentUrl: `${BASE}/x` })).toBe('irreversible');
    expect(guard.classifyRisk({ type: 'press', key }, { targetName: 'Search', currentUrl: `${BASE}/x` })).toBe('reversible');
  });

  it('a non-committing key (Tab, Escape, a letter) stays read', () => {
    for (const key of ['Tab', 'Escape', 'a', 'ArrowDown']) expect(guard.classifyRisk({ type: 'press', key }, { targetName: 'Confirm Transfer', currentUrl: `${BASE}/x` })).toBe('read');
  });

  it('allowIrreversible still lets a deliberately-approved Enter-submit proceed (the fix flags, it does not permanently block)', async () => {
    const inner = new FakeSurface(buildScenario());
    const ps = withPolicy(inner, guard, { onDecision: () => {} });
    const obs = await ps.observe();
    const amount = obs.elements.find((e) => e.name === 'Amount')!;

    const result = await ps.act({ type: 'type', target: amount.descriptor, value: '5000000', pressEnter: true }, 1000, { allowIrreversible: true });
    expect(result.ok).toBe(true);
    expect(inner.currentScreenId()).toBe('done');
  });

  it('pressing Enter on an ordinary search form (no irreversible-looking control anywhere on the page) is not flagged -- this does not over-block ordinary Enter-to-search', async () => {
    const searchOnlyScenario = scenario()
      .screen('search', {
        url: `${BASE}/members/search`,
        title: 'Member search',
        elements: [
          el({ id: 'memberId', role: 'textbox', name: 'Member ID', tag: 'input', bbox: { x: 0, y: 0, w: 100, h: 20 } }),
          el({ id: 'searchBtn', role: 'button', name: 'Search', tag: 'button', bbox: { x: 0, y: 30, w: 100, h: 20 } }),
        ],
      })
      .on('press', { key: 'Enter' })
      .goto('searched')
      .screen('searched', { url: `${BASE}/members/search?ok=1`, title: 'Searched', elements: [] })
      .build();
    const inner = new FakeSurface(searchOnlyScenario);
    const ps = withPolicy(inner, guard, { onDecision: () => {} });
    const obs = await ps.observe();
    const memberId = obs.elements.find((e) => e.name === 'Member ID')!;

    const result = await ps.act({ type: 'type', target: memberId.descriptor, value: '12345', pressEnter: true }, 1000);
    expect(result.ok).toBe(true);
    expect(inner.currentScreenId()).toBe('searched');
  });

  it('a disabled irreversible-looking button elsewhere on the page does not block an unrelated Enter (no false positive from disabled controls)', async () => {
    const disabledScenario = scenario()
      .screen('wireDisabledConfirm', {
        url: `${BASE}/members/12345/subaccounts/new`,
        title: 'Open sub-account (disabled confirm)',
        elements: [
          el({ id: 'amount', role: 'textbox', name: 'Amount', tag: 'input', bbox: { x: 0, y: 0, w: 100, h: 20 } }),
          el({ id: 'confirmBtnDisabled', role: 'button', name: 'Confirm Transfer', tag: 'button', enabled: false, bbox: { x: 0, y: 60, w: 100, h: 20 } }),
        ],
      })
      .on('press', { key: 'Enter' })
      .goto('doneDisabled')
      .screen('doneDisabled', { url: `${BASE}/members/12345/subaccounts/SA-0000002/confirmation`, title: 'Confirmed (should not happen)', elements: [] })
      .build();
    const inner = new FakeSurface(disabledScenario);
    const ps = withPolicy(inner, guard, { onDecision: () => {} });
    const obs = await ps.observe();
    const amount = obs.elements.find((e) => e.name === 'Amount')!;
    const confirmBtn = obs.elements.find((e) => e.name === 'Confirm Transfer')!;
    expect(confirmBtn.enabled).toBe(false);

    const result = await ps.act({ type: 'type', target: amount.descriptor, value: '5000000', pressEnter: true }, 1000);
    expect(result.ok).toBe(true);
    expect(inner.currentScreenId()).toBe('doneDisabled');
  });
});

// -------------------------------------------------------------------------------------------
// select() on a control literally named "Confirm"
// -------------------------------------------------------------------------------------------

describe('select on an irreversible-named control', () => {
  it('select() targeting a dropdown/control whose own accessible name matches an irreversible pattern is flagged, end to end through withPolicy (not just at the pure-guard level)', async () => {
    const s = scenario()
      .screen('form', {
        url: `${BASE}/members/12345/subaccounts/new`,
        title: 'Open sub-account',
        elements: [el({ id: 'confirmSelect', role: 'combobox', name: 'Confirm Account Type', tag: 'select', bbox: { x: 0, y: 0, w: 100, h: 20 } })],
      })
      .on('select', { targetId: 'confirmSelect' })
      .goto('done')
      .screen('done', { url: `${BASE}/members/12345/subaccounts/SA-1/confirmation`, title: 'Done', elements: [] })
      .build();
    const inner = new FakeSurface(s);
    const actSpy = vi.spyOn(inner, 'act');
    const ps = withPolicy(inner, guard, { onDecision: () => {} });
    const obs = await ps.observe();
    const target = obs.elements.find((e) => e.name === 'Confirm Account Type')!;

    const result = await ps.act({ type: 'select', target: target.descriptor, value: 'Savings' }, 1000);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('policy_violation');
    expect(actSpy).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------------------------
// riskOverride can only raise risk, never lower it (guard-level contract, re-verified here
// against the specific attack: a capability/caller claims 'read' on a live "Confirm" button)
// -------------------------------------------------------------------------------------------

describe('riskOverride cannot be used to downgrade a live irreversible control', () => {
  it('riskOverride: "read" on a live "Confirm"/"Submit transfer" target is ignored; the action is still flag_irreversible', () => {
    const action = {
      type: 'click' as const,
      target: { description: 'x', frame: [], locators: [{ strategy: { kind: 'text' as const, text: 'x' }, confidence: 1, source: 'recorded' as const }] },
    };
    const result = defaultGuard.checkAction(action, { targetName: 'Submit Transfer', currentUrl: `${BASE}/workstation`, riskOverride: 'read' });
    expect(result.decision).toBe('flag_irreversible');
    expect(result.risk).toBe('irreversible');
  });
});

// -------------------------------------------------------------------------------------------
// {ref} bypass -- re-verified against the wrapper (no bypass via a bare ref)
// -------------------------------------------------------------------------------------------

describe('{ref} target cannot bypass risk classification', () => {
  it('a {ref} pointing at a live "Confirm" element is flagged, not silently allowed (also covered in enforcing-surface.test.ts; re-asserted here as an explicit attack)', async () => {
    const s = scenario()
      .screen('form', {
        url: `${BASE}/members/12345/subaccounts/new`,
        title: 'Open sub-account',
        elements: [el({ id: 'confirm', role: 'button', name: 'Confirm', tag: 'button', bbox: { x: 0, y: 0, w: 80, h: 20 } })],
      })
      .on('click', { targetId: 'confirm' })
      .goto('done')
      .screen('done', { url: `${BASE}/members/12345/subaccounts/SA-1/confirmation`, title: 'Done', elements: [] })
      .build();
    const inner = new FakeSurface(s);
    const actSpy = vi.spyOn(inner, 'act');
    const ps = withPolicy(inner, guard, { onDecision: () => {} });
    const obs = await ps.observe();
    const confirmEl = obs.elements.find((e) => e.name === 'Confirm')!;

    const result = await ps.act({ type: 'click', target: { ref: confirmEl.ref } }, 1000);
    expect(result.ok).toBe(false);
    expect(actSpy).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------------------------
// waitFor()/check()/observe() during an off-policy quarantine and in general never mutate
// -------------------------------------------------------------------------------------------

describe('read-only Surface methods never provide a mutation channel around policy', () => {
  it('waitFor() delegates straight through (by design, reads are always allowed) but can never itself invoke a mutating act() on the inner surface', async () => {
    const inner = makeReadonlyProbeSurface();
    const actSpy = vi.spyOn(inner, 'act');
    const ps = withPolicy(inner, guard, { onDecision: () => {} });

    const met = await ps.waitFor({ kind: 'text_visible', text: 'Field' }, 100);
    expect(met).toBe(true);
    expect(actSpy).not.toHaveBeenCalled();
  });
});

function makeReadonlyProbeSurface(): FakeSurface {
  return new FakeSurface(
    scenario()
      .screen('form', {
        url: `${BASE}/form`,
        title: 'Form',
        text: ['Field label text here'],
        elements: [],
      })
      .build(),
  );
}
