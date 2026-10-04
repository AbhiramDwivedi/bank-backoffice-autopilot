import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Surface, SurfaceAction } from '../surface/types.js';
import { el, FakeSurface, scenario } from '../surface/index.js';
import { createPolicyGuard } from './guard.js';
import { parsePolicy } from './load.js';
import { withPolicy, type PolicyDecisionEvent, type PolicySurface } from './enforcing-surface.js';

const BASE = 'http://x.test';

function testPolicy() {
  return parsePolicy(`
name: enforcing-surface-test
allowedOrigins: ['${BASE}']
allowedPathPatterns: []
deniedPathPatterns: ['^/__faults']
allowedActions: [navigate, click, type, select, press, extract, wait, dismiss_dialog]
risk:
  irreversibleTextPatterns:
    - '^(confirm|submit)\\b'
  irreversibleUrlPatterns: []
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
    .screen('form', {
      url: `${BASE}/form`,
      title: 'Form',
      elements: [
        el({ id: 'field', role: 'textbox', name: 'Field', tag: 'input', bbox: { x: 0, y: 0, w: 100, h: 20 } }),
        el({ id: 'confirmBtn', role: 'button', name: 'Confirm', tag: 'button', bbox: { x: 0, y: 30, w: 80, h: 20 } }),
        el({ id: 'cancelBtn', role: 'button', name: 'Cancel', tag: 'button', bbox: { x: 90, y: 30, w: 80, h: 20 } }),
        el({ id: 'searchBtn', role: 'button', name: 'Search', tag: 'button', bbox: { x: 180, y: 30, w: 80, h: 20 } }),
        el({ id: 'externalLink', role: 'link', name: 'Go External', tag: 'a', bbox: { x: 0, y: 60, w: 100, h: 20 } }),
        el({ id: 'trapBtn', role: 'button', name: 'Continue', tag: 'button', bbox: { x: 0, y: 90, w: 80, h: 20 } }),
        el({ id: 'trapBtn2', role: 'button', name: 'Confirm Now', tag: 'button', bbox: { x: 90, y: 90, w: 80, h: 20 } }),
      ],
    })
    .on('click', { targetId: 'confirmBtn' })
    .goto('done')
    .on('click', { targetId: 'cancelBtn' })
    .goto('form')
    .on('click', { targetId: 'searchBtn' })
    .goto('form')
    .on('click', { targetId: 'externalLink' })
    .goto('external')
    .on('click', { targetId: 'trapBtn' })
    .goto('form')
    .on('click', { targetId: 'trapBtn2' })
    .goto('form')
    .screen('done', { url: `${BASE}/done`, title: 'Done', elements: [] })
    .screen('external', {
      url: 'http://evil.test/external',
      title: 'External',
      elements: [el({ id: 'somethingHere', role: 'button', name: 'Whatever', tag: 'button', bbox: { x: 0, y: 0, w: 50, h: 20 } })],
    })
    .onAny('navigate', { url: `${BASE}/form` })
    .goto('form')
    .build();
}

function makeSurface(): FakeSurface {
  return new FakeSurface(buildScenario());
}

/** Strips the optional `describeRef`/`frameUrls` Surface methods entirely (not just to
 * `undefined`), to test the "surface doesn't implement this at all" branches. */
function withoutOptionalMethods(inner: FakeSurface): Surface {
  return {
    observe: () => inner.observe(),
    resolve: (t, ms) => inner.resolve(t, ms),
    act: (a, ms, o) => inner.act(a, ms, o),
    readText: (t, ms) => inner.readText(t, ms),
    check: (c) => inner.check(c),
    waitFor: (c, ms) => inner.waitFor(c, ms),
    screenshot: () => inner.screenshot(),
    domSnapshot: () => inner.domSnapshot(),
    currentUrl: () => inner.currentUrl(),
    close: () => inner.close(),
    // describeRef and frameUrls intentionally omitted.
  };
}

let events: PolicyDecisionEvent[];
function onDecision(e: PolicyDecisionEvent): void {
  events.push(e);
}

beforeEach(() => {
  events = [];
});

describe('withPolicy: deny never reaches the underlying surface', () => {
  it('denies an action type not in allowedActions (switch_frame)', async () => {
    const inner = makeSurface();
    const actSpy = vi.spyOn(inner, 'act');
    const ps = withPolicy(inner, guard, { onDecision });
    const result = await ps.act({ type: 'switch_frame', frame: [] }, 1000);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('policy_violation');
    expect(actSpy).not.toHaveBeenCalled();
    expect(events.at(-1)?.decision).toBe('deny');
  });

  it('denies navigate to an off-policy origin', async () => {
    const inner = makeSurface();
    const actSpy = vi.spyOn(inner, 'act');
    const ps = withPolicy(inner, guard, { onDecision });
    const result = await ps.act({ type: 'navigate', url: 'http://evil.test/steal' }, 1000);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('policy_violation');
    expect(actSpy).not.toHaveBeenCalled();
    expect(events.at(-1)?.decision).toBe('deny');
  });

  it('denies navigate to /__faults', async () => {
    const inner = makeSurface();
    const actSpy = vi.spyOn(inner, 'act');
    const ps = withPolicy(inner, guard, { onDecision });
    const result = await ps.act({ type: 'navigate', url: `${BASE}/__faults` }, 1000);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('policy_violation');
    expect(actSpy).not.toHaveBeenCalled();
  });
});

describe('withPolicy: flag_irreversible refuses by default, proceeds with allowIrreversible', () => {
  it('refuses a "Confirm" click without allowIrreversible, and never reaches the inner surface', async () => {
    const inner = makeSurface();
    const actSpy = vi.spyOn(inner, 'act');
    const ps = withPolicy(inner, guard, { onDecision });
    const obs = await ps.observe();
    const confirmEl = obs.elements.find((e) => e.name === 'Confirm' && e.tag === 'button')!;
    const result = await ps.act({ type: 'click', target: confirmEl.descriptor }, 1000);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('policy_violation');
    expect(actSpy).not.toHaveBeenCalled();
    expect(inner.currentScreenId()).toBe('form');
    expect(events.some((e) => e.decision === 'refused_irreversible')).toBe(true);
  });

  it('proceeds when allowIrreversible is passed, and reports flag_irreversible', async () => {
    const inner = makeSurface();
    const actSpy = vi.spyOn(inner, 'act');
    const ps = withPolicy(inner, guard, { onDecision });
    const obs = await ps.observe();
    const confirmEl = obs.elements.find((e) => e.name === 'Confirm' && e.tag === 'button')!;
    const result = await ps.act({ type: 'click', target: confirmEl.descriptor }, 1000, { allowIrreversible: true });
    expect(result.ok).toBe(true);
    expect(actSpy).toHaveBeenCalledTimes(1);
    expect(inner.currentScreenId()).toBe('done');
    expect(events.some((e) => e.decision === 'flag_irreversible')).toBe(true);
  });
});

describe('withPolicy: no bypass via ref', () => {
  it('a {ref} target of a "Confirm" element is still flagged, not silently allowed', async () => {
    const inner = makeSurface();
    const actSpy = vi.spyOn(inner, 'act');
    const ps = withPolicy(inner, guard, { onDecision });
    const obs = await ps.observe();
    const confirmEl = obs.elements.find((e) => e.name === 'Confirm' && e.tag === 'button')!;
    const result = await ps.act({ type: 'click', target: { ref: confirmEl.ref } }, 1000);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('policy_violation');
    expect(actSpy).not.toHaveBeenCalled();
  });

  it('a descriptor with a misleading snapshot ("Continue") that resolves live to "Confirm" is flagged', async () => {
    const inner = makeSurface();
    const actSpy = vi.spyOn(inner, 'act');
    const ps = withPolicy(inner, guard, { onDecision });
    const obs = await ps.observe();
    const trapDescriptor = obs.elements.find((e) => e.name === 'Continue')!.descriptor;
    expect(trapDescriptor.snapshot?.name).toBe('Continue'); // sanity: snapshot is the stale name
    inner.inject({ kind: 'drift', elementId: 'trapBtn', patch: { name: 'Confirm', text: 'Confirm' } });
    const result = await ps.act({ type: 'click', target: trapDescriptor }, 1000);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('policy_violation');
    expect(actSpy).not.toHaveBeenCalled();
  });

  it('a descriptor whose static snapshot says "Confirm" but drifts live to "Continue" is still flagged (union of static + live text)', async () => {
    const inner = makeSurface();
    const actSpy = vi.spyOn(inner, 'act');
    const ps = withPolicy(inner, guard, { onDecision });
    const obs = await ps.observe();
    const trapDescriptor = obs.elements.find((e) => e.name === 'Confirm Now')!.descriptor;
    expect(trapDescriptor.snapshot?.name).toBe('Confirm Now');
    inner.inject({ kind: 'drift', elementId: 'trapBtn2', patch: { name: 'Continue', text: 'Continue' } });
    const result = await ps.act({ type: 'click', target: trapDescriptor }, 1000);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('policy_violation');
    expect(actSpy).not.toHaveBeenCalled();
  });

  it('a ref with unknown describeRef (stale ref) is flagged conservatively, not silently allowed', async () => {
    const inner = makeSurface();
    const actSpy = vi.spyOn(inner, 'act');
    const ps = withPolicy(inner, guard, { onDecision });
    const result = await ps.act({ type: 'click', target: { ref: 'e999' } }, 1000);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('policy_violation');
    expect(actSpy).not.toHaveBeenCalled();
    expect(events.some((e) => e.decision === 'refused_irreversible')).toBe(true);
  });

  it('a ref is flagged conservatively when the surface has no describeRef method at all', async () => {
    const inner = makeSurface();
    const bare = withoutOptionalMethods(inner);
    const actSpy = vi.spyOn(inner, 'act');
    const ps = withPolicy(bare, guard, { onDecision });
    const result = await ps.act({ type: 'click', target: { ref: 'e2' } }, 1000);
    expect(result.ok).toBe(false);
    expect(actSpy).not.toHaveBeenCalled();
    expect(events.some((e) => e.decision === 'refused_irreversible')).toBe(true);
  });
});

describe('withPolicy: descriptor description is a risk signal', () => {
  it('flags a bbox-only descriptor whose description names an irreversible action, on a surface without describeRef', async () => {
    const events: PolicyDecisionEvent[] = [];
    const inner = makeSurface();
    const bare = withoutOptionalMethods(inner);
    const actSpy = vi.spyOn(inner, 'act');
    const ps = withPolicy(bare, guard, { onDecision: (e) => events.push(e) });
    const target = {
      description: 'Confirm the wire transfer',
      frame: [],
      locators: [{ strategy: { kind: 'bbox' as const, x: 0, y: 30 / 800, w: 80 / 1280, h: 20 / 800 }, confidence: 0.1, source: 'recorded' as const }],
    };
    const result = await ps.act({ type: 'click', target }, 1000);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('policy_violation');
    expect(actSpy).not.toHaveBeenCalled();
    expect(events.some((e) => e.decision === 'refused_irreversible')).toBe(true);
  });
});

describe('withPolicy: quarantine', () => {
  it('quarantines after an off-policy navigation, refuses a subsequent click, and clears on navigating back', async () => {
    const inner = makeSurface();
    const actSpy = vi.spyOn(inner, 'act');
    const ps: PolicySurface = withPolicy(inner, guard, { onDecision });

    expect(ps.quarantined).toBe(false);

    const obs = await ps.observe();
    const externalLink = obs.elements.find((e) => e.name === 'Go External')!;
    const clickResult = await ps.act({ type: 'click', target: externalLink.descriptor }, 1000);
    expect(clickResult.ok).toBe(true); // the click itself was allowed (reversible) and executed
    expect(inner.currentScreenId()).toBe('external');
    expect(ps.quarantined).toBe(true);
    expect(events.some((e) => e.decision === 'quarantine')).toBe(true);
    expect(actSpy).toHaveBeenCalledTimes(1);

    // Any non-navigate/dismiss_dialog action is now refused without reaching the inner surface.
    const blocked = await ps.act({ type: 'click', target: { ref: 'e1' } }, 1000);
    expect(blocked.ok).toBe(false);
    expect(blocked.error?.code).toBe('policy_violation');
    expect(actSpy).toHaveBeenCalledTimes(1); // unchanged

    // navigate to an allowed URL clears quarantine.
    const navResult = await ps.act({ type: 'navigate', url: `${BASE}/form` }, 1000);
    expect(navResult.ok).toBe(true);
    expect(ps.quarantined).toBe(false);
    expect(events.some((e) => e.decision === 'quarantine_cleared')).toBe(true);
    expect(actSpy).toHaveBeenCalledTimes(2);
  });

  it('a navigate to a still-off-policy URL while quarantined is refused', async () => {
    const inner = makeSurface();
    const ps = withPolicy(inner, guard, { onDecision });
    await ps.act({ type: 'click', target: { ref: (await ps.observe()).elements.find((e) => e.name === 'Go External')!.ref } }, 1000);
    expect(ps.quarantined).toBe(true);
    const result = await ps.act({ type: 'navigate', url: 'http://also-evil.test/x' }, 1000);
    expect(result.ok).toBe(false);
    expect(ps.quarantined).toBe(true);
  });

  it('quarantine detection still works when the surface has no frameUrls method (falls back to currentUrl())', async () => {
    const inner = makeSurface();
    const bare = withoutOptionalMethods(inner);
    const ps = withPolicy(bare, guard, { onDecision });
    const obs = await ps.observe();
    const externalLink = obs.elements.find((e) => e.name === 'Go External')!;
    // No describeRef either, so the target is classified conservatively -- use allowIrreversible
    // to get past that and exercise the frameUrls-fallback quarantine path.
    await ps.act({ type: 'click', target: externalLink.descriptor }, 1000, { allowIrreversible: true });
    expect(ps.quarantined).toBe(true);
  });
});

describe('withPolicy: pre-act allowlist check', () => {
  it('a page moved off-policy without going through this surface (e.g. a human navigating away during a handoff) is caught before the next action reaches the inner surface', async () => {
    const inner = makeSurface();
    const ps = withPolicy(inner, guard, { onDecision });
    expect(ps.quarantined).toBe(false);

    // Simulate a human moving the live page off-policy during a handoff: acted on the *inner*
    // surface directly, never through `ps`, so the wrapper has had no `act()`/`observe()` call to
    // notice it via the existing post-act scan.
    const preObs = await inner.observe();
    const externalLink = preObs.elements.find((e) => e.name === 'Go External')!;
    await inner.act({ type: 'click', target: { ref: externalLink.ref } }, 1000);
    expect(inner.currentScreenId()).toBe('external');
    expect(ps.quarantined).toBe(false); // the wrapper doesn't know yet -- nothing has called it since

    // Only now spy: the click below must never reach the inner surface's act().
    const actSpy = vi.spyOn(inner, 'act');
    const result = await ps.act({ type: 'click', target: { ref: 'e1' } }, 1000);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('policy_violation');
    expect(actSpy).not.toHaveBeenCalled();
    expect(inner.currentScreenId()).toBe('external'); // unchanged: the click never ran
    expect(ps.quarantined).toBe(true);
    expect(events.some((e) => e.decision === 'quarantine')).toBe(true);
    expect(events.at(-1)?.decision).toBe('deny');
  });

  it('an off-policy sub-frame (top document still on-policy) also blocks the next action before it reaches the inner surface', async () => {
    const framed = scenario()
      .screen('form', {
        url: `${BASE}/form`,
        title: 'Form',
        elements: [el({ id: 'framesLink', role: 'link', name: 'Frames', tag: 'a', bbox: { x: 0, y: 0, w: 80, h: 20 } })],
      })
      .on('click', { targetId: 'framesLink' })
      .goto('framed')
      .screen('framed', {
        url: `${BASE}/shell`,
        title: 'Shell',
        frames: [{ path: [{ name: 'main' }], url: 'http://evil.test/inner' }],
        elements: [el({ id: 'ok', role: 'button', name: 'OK', tag: 'button', bbox: { x: 0, y: 0, w: 50, h: 20 } })],
      })
      .build();
    const inner = new FakeSurface(framed);
    const ps = withPolicy(inner, guard, { onDecision });
    // A human moves the page to a shell whose sub-frame is off-policy, bypassing the wrapper.
    const link = (await inner.observe()).elements.find((e) => e.name === 'Frames')!;
    await inner.act({ type: 'click', target: { ref: link.ref } }, 1000);
    expect(await inner.currentUrl()).toBe(`${BASE}/shell`);

    const actSpy = vi.spyOn(inner, 'act');
    const okRef = (await inner.observe()).elements.find((e) => e.name === 'OK')!.ref;
    const result = await ps.act({ type: 'click', target: { ref: okRef } }, 1000);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('policy_violation');
    expect(actSpy).not.toHaveBeenCalled();
    expect(ps.quarantined).toBe(true);
    expect(events.some((e) => e.decision === 'quarantine')).toBe(true);
  });

  it('the very first navigate off a fresh surface starting at about:blank is not refused by the pre-act check (about:blank is neutral, not off-policy)', async () => {
    const aboutBlankScenario = scenario()
      .screen('blank', { url: 'about:blank', title: '', elements: [] })
      .onAny('navigate', { url: `${BASE}/form` })
      .goto('form')
      .screen('form', { url: `${BASE}/form`, title: 'Form', elements: [] })
      .build();
    const inner = new FakeSurface(aboutBlankScenario);
    const actSpy = vi.spyOn(inner, 'act');
    const ps = withPolicy(inner, guard, { onDecision });

    const result = await ps.act({ type: 'navigate', url: `${BASE}/form` }, 1000);

    expect(result.ok).toBe(true);
    expect(actSpy).toHaveBeenCalledTimes(1);
    expect(ps.quarantined).toBe(false);
    expect(events.some((e) => e.decision === 'quarantine')).toBe(false);
  });
});

describe('withPolicy: events never carry typed values', () => {
  it('typing a secret value never appears anywhere in the emitted events', async () => {
    const inner = makeSurface();
    const ps = withPolicy(inner, guard, { onDecision });
    const obs = await ps.observe();
    const field = obs.elements.find((e) => e.name === 'Field')!;
    const action: SurfaceAction = { type: 'type', target: field.descriptor, value: 'SECRET-VALUE' };
    const result = await ps.act(action, 1000);
    expect(result.ok).toBe(true);
    const json = JSON.stringify(events);
    expect(json).not.toContain('SECRET-VALUE');
  });
});

describe('withPolicy: allow path actually runs, and reports allow', () => {
  it('a reversible click ("Search") is allowed and reaches the inner surface', async () => {
    const inner = makeSurface();
    const actSpy = vi.spyOn(inner, 'act');
    const ps = withPolicy(inner, guard, { onDecision });
    const obs = await ps.observe();
    const search = obs.elements.find((e) => e.name === 'Search')!;
    const result = await ps.act({ type: 'click', target: search.descriptor }, 1000);
    expect(result.ok).toBe(true);
    expect(actSpy).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ decision: 'allow', risk: 'reversible' });
  });
});

describe('withPolicy: passthrough delegation', () => {
  it('readText and check delegate to the underlying surface', async () => {
    const inner = makeSurface();
    const ps = withPolicy(inner, guard, { onDecision });
    const obs = await ps.observe();
    const confirmBtn = obs.elements.find((e) => e.name === 'Confirm' && e.tag === 'button')!;
    const viaPolicy = await ps.readText({ ref: confirmBtn.ref }, 1000);
    const viaInner = await inner.readText({ ref: confirmBtn.ref }, 1000);
    expect(viaPolicy).toEqual(viaInner);
    expect(viaPolicy).toEqual({ ok: true, text: 'Confirm' });
    expect(await ps.check({ kind: 'text_visible', text: 'Field' })).toBe(true);
    expect(await ps.check({ kind: 'text_visible', text: 'Nonexistent Text' })).toBe(false);
  });

  it('screenshot/domSnapshot/currentUrl/close delegate without alteration', async () => {
    const inner = makeSurface();
    const ps = withPolicy(inner, guard, { onDecision });
    expect(await ps.currentUrl()).toBe(`${BASE}/form`);
    expect((await ps.screenshot()).length).toBeGreaterThan(0);
    expect(await ps.domSnapshot()).toContain('form');
    await ps.close();
  });
});
