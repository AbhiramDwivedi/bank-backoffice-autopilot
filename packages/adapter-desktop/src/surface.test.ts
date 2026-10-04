/**
 * The desktop surface end to end against the fake bridge and the fake Teller Workstation: runs on
 * every OS. The same flows against the real bridge and the real app are in
 * mock-desktop.integration.test.ts (Windows only).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { REDACTED_VALUE, type TargetDescriptor } from '@cu/core/schema';
import { isOmittedScreenshot, type Observation, type ObservedElement } from '@cu/core/surface';
import { createFakeTeller, FakeTellerApp, type FakeBridge } from './fake-bridge.js';
import { createDesktopSurface, type DesktopSurface } from './surface.js';
import { MASKED_TEXT, type DesktopScreenMask } from './mask.js';

let surface: DesktopSurface | undefined;
afterEach(async () => {
  await surface?.close();
  surface = undefined;
});

async function open(opts: { mask?: DesktopScreenMask; launcherWindow?: boolean } = {}): Promise<{ s: DesktopSurface; app: FakeTellerApp; bridge: FakeBridge }> {
  const { app, bridge } = createFakeTeller(opts.launcherWindow ? { launcherWindow: true } : {});
  const s = await createDesktopSurface({ processName: 'TellerWorkstation', attachPid: app.pid, bridge: bridge.connection(), ...(opts.mask ? { mask: opts.mask } : {}) });
  surface = s;
  return { s, app, bridge };
}

function find(obs: Observation, role: string, name: string): ObservedElement {
  const el = obs.elements.find((e) => e.role === role && e.name === name);
  if (!el) throw new Error(`no ${role} "${name}" in ${obs.elements.map((e) => `${e.role}:${e.name}`).join(', ')}`);
  return el;
}

async function signOn(s: DesktopSurface): Promise<void> {
  const obs = await s.observe();
  expect((await s.act({ type: 'type', target: { ref: find(obs, 'textbox', 'User ID').ref }, value: 'operator1' }, 5000)).ok).toBe(true);
  expect((await s.act({ type: 'type', target: { ref: find(obs, 'textbox', 'Password').ref }, value: 'demo-pass-123' }, 5000)).ok).toBe(true);
  const r = await s.act({ type: 'click', target: { ref: find(obs, 'button', 'Sign On').ref } }, 5000);
  expect(r).toMatchObject({ ok: true, navigated: true });
}

async function lookUp(s: DesktopSurface, id: string): Promise<Observation> {
  const obs = await s.observe();
  expect((await s.act({ type: 'type', target: { ref: find(obs, 'textbox', 'Member ID').ref }, value: id, pressEnter: true }, 5000)).ok).toBe(true);
  return s.observe();
}

describe('observe', () => {
  it('reports the app as desktop://<process>/<title>, its controls with roles, names and descriptors, and a digest', async () => {
    const { s } = await open();
    const obs = await s.observe();
    expect(obs.url).toBe('desktop://tellerworkstation/Teller%20Workstation%20-%20Sign%20On');
    expect(obs.title).toBe('Teller Workstation - Sign On');
    expect(obs.elements.map((e) => `${e.role}:${e.name}`)).toEqual(
      expect.arrayContaining(['textbox:User ID', 'textbox:Password', 'button:Sign On', 'text:User ID:', 'text:Password:']),
    );
    // Interactive controls first, informative after.
    const firstText = obs.elements.findIndex((e) => e.role === 'text');
    expect(obs.elements.slice(firstText).every((e) => e.role === 'text')).toBe(true);
    expect(obs.textDigest).toContain('TELLER WORKSTATION');
    expect(obs.screenshotPng?.length).toBeGreaterThan(0);
    expect(obs.dialog).toBeUndefined();
  });

  it('never carries a password value, and maps geometry to screenshot pixels on a 200% display', async () => {
    const { s } = await open();
    let obs = await s.observe();
    await s.act({ type: 'type', target: { ref: find(obs, 'textbox', 'Password').ref }, value: 'hunter2-secret' }, 5000);
    obs = await s.observe();
    const pw = find(obs, 'textbox', 'Password');
    expect(pw.value).toBe(REDACTED_VALUE);
    expect(JSON.stringify(obs)).not.toContain('hunter2-secret');
    // The fake reports physical rectangles at 2x; the observation is in the app's own pixels.
    expect(pw.bbox).toEqual({ x: 110, y: 97, w: 160, h: 20 });
  });

  it('shows the geometric label, not the borrowed Win32 caption, for an edit whose UIA name is some other control', async () => {
    const { s } = await open();
    await signOn(s);
    const obs = await s.observe();
    const box = obs.elements.find((e) => e.role === 'textbox')!;
    expect(box.name).toBe('Member ID');
    expect(box.descriptor.locators.map((l) => l.strategy.kind)).not.toContain('role');
    expect(box.descriptor.locators[0]!.strategy).toEqual({ kind: 'label', label: 'Member ID', exact: true });
  });

  it('puts group contents in a frame named by the group caption', async () => {
    const { s } = await open();
    await signOn(s);
    const obs = await lookUp(s, '12345');
    const savings = find(obs, 'textbox', 'Savings Balance');
    expect(savings.frame).toEqual([{ name: 'Balances' }]);
    expect(savings.value).toBe('$1,234.56');
    expect(obs.frames).toEqual(expect.arrayContaining([{ path: [{ name: 'Balances' }], url: obs.url }]));
  });

  it('never picks another process of the tree (a launcher console) as the main window', async () => {
    const { s } = await open({ launcherWindow: true });
    const obs = await s.observe();
    expect(obs.url).toContain('desktop://tellerworkstation/');
    expect(obs.frames.map((f) => f.url)).toContain('desktop://powershell/Launcher');
  });
});

describe('descriptors replay at depth 0 on the screen they were recorded on', () => {
  it('every element of every screen resolves through its own descriptor to itself, first locator', async () => {
    const { s, app } = await open();
    let checked = 0;
    const checkScreen = async (): Promise<void> => {
      const obs = await s.observe();
      for (const el of obs.elements) {
        // resolve() binds an r-ref; describeRef tells which element it is.
        const r = await s.resolve(el.descriptor, 0);
        expect(r, `${el.role} "${el.name}" on ${obs.title}`).toMatchObject({ found: true, strategyIndex: 0 });
        if (!r.found) continue;
        expect(await s.describeRef(r.ref)).toMatchObject({ role: el.role, name: el.name });
        checked++;
      }
    };
    await checkScreen();
    await signOn(s);
    await checkScreen();
    await lookUp(s, '12345');
    await checkScreen();
    app.dialogOpen = true;
    await checkScreen();
    expect(checked).toBeGreaterThan(30);
  });

  it('prefers a developer-assigned AutomationId, and never records a window-handle id', async () => {
    const { s } = await open();
    const obs = await s.observe();
    expect(find(obs, 'textbox', 'User ID').descriptor.locators[0]!.strategy).toEqual({ kind: 'automation_id', id: 'txtUserId' });
    const pw = find(obs, 'textbox', 'Password');
    expect(pw.descriptor.locators.some((l) => l.strategy.kind === 'automation_id')).toBe(false);
    expect(pw.descriptor.locators.some((l) => l.strategy.kind === 'role')).toBe(false); // never a role locator on a password field
  });
});

describe('resolve: each strategy, falling through the chain', () => {
  const base = { description: 'target', frame: [] as TargetDescriptor['frame'] };
  const loc = (strategy: TargetDescriptor['locators'][number]['strategy']) => ({ strategy, confidence: 0.5, source: 'recorded' as const });

  it.each([
    ['automation_id', { kind: 'automation_id', id: 'btnSignOn' }],
    ['role', { kind: 'role', role: 'button', name: 'Sign On', exact: true }],
    ['label', { kind: 'label', label: 'User ID:' }],
    ['text', { kind: 'text', text: 'Sign On', tag: 'button' }],
    ['relative', { kind: 'relative', anchor: { text: 'Password:' }, relation: 'right-of', role: 'textbox' }],
    ['bbox', { kind: 'bbox', x: 0.25, y: 0.433, w: 0.2, h: 0.08 }],
  ] as const)('%s resolves on its own', async (kind, strategy) => {
    const { s } = await open();
    const r = await s.resolve({ ...base, locators: [loc(strategy as never)] }, 0);
    expect(r).toMatchObject({ found: true, strategyKind: kind, strategyIndex: 0 });
  });

  it('a css locator (recorded on the web) is a miss and the chain falls through to the next locator', async () => {
    const { s } = await open();
    const r = await s.resolve({ ...base, locators: [loc({ kind: 'css', selector: '#btnSignOn' }), loc({ kind: 'role', role: 'button', name: 'Sign On' })] }, 0);
    expect(r).toMatchObject({ found: true, strategyIndex: 1, strategyKind: 'role' });
  });

  it('a relative locator carrying a CSS selector (recorded on the web) is a miss, not a looser match', async () => {
    const { s } = await open();
    const withSelector = loc({ kind: 'relative', anchor: { text: 'Password:' }, relation: 'right-of', role: 'textbox', selector: 'input.pw' });
    const r = await s.resolve({ ...base, locators: [withSelector, loc({ kind: 'role', role: 'button', name: 'Sign On' })] }, 0);
    expect(r).toMatchObject({ found: true, strategyIndex: 1, strategyKind: 'role' });
  });

  it('isSameElement compares runtime ids: an observed ref and its resolved ref match, two different controls do not', async () => {
    const { s } = await open();
    const obs = await s.observe();
    const [a, b] = obs.elements;
    const r = await s.resolve(a!.descriptor, 0);
    expect(r.found).toBe(true);
    if (r.found) expect(await s.isSameElement(a!.ref, r.ref)).toBe(true);
    expect(await s.isSameElement(a!.ref, b!.ref)).toBe(false);
    expect(await s.isSameElement(a!.ref, 'e999')).toBe(false);
  });

  it('a relative locator with a container bound is a miss; an exact anchor matches only whole text', async () => {
    const { s } = await open();
    const fallback = loc({ kind: 'role', role: 'button', name: 'Sign On' });
    const within = loc({ kind: 'relative', anchor: { text: 'Password:' }, relation: 'right-of', role: 'textbox', within: 'div.form' });
    expect(await s.resolve({ ...base, locators: [within, fallback] }, 0)).toMatchObject({ found: true, strategyIndex: 1 });
    const partial = loc({ kind: 'relative', anchor: { text: 'Password', exact: true }, relation: 'right-of', role: 'textbox' });
    expect(await s.resolve({ ...base, locators: [partial, fallback] }, 0)).toMatchObject({ found: true, strategyIndex: 1 });
    const whole = loc({ kind: 'relative', anchor: { text: 'Password:', exact: true }, relation: 'right-of', role: 'textbox' });
    expect(await s.resolve({ ...base, locators: [whole, fallback] }, 0)).toMatchObject({ found: true, strategyIndex: 0 });
  });

  it('an ambiguous match is a miss, marked with its match count', async () => {
    const { s } = await open();
    const r = await s.resolve({ ...base, locators: [loc({ kind: 'role', role: 'textbox', name: '' })] }, 0);
    expect(r.found).toBe(false);
    if (!r.found) {
      expect(r.tried[0]!.error).toMatch(/ambiguous/);
      expect(r.tried[0]).toMatchObject({ strategyKind: 'role', ambiguous: true });
      expect(r.tried[0]!.matches).toBeGreaterThan(1);
    }
  });

  it('a relative anchor that two statics show is ambiguous, not "the first in the tree"; the found resolution reports it', async () => {
    const { s } = await open();
    // ":" is in "User ID:" and in "Password:", and equals neither.
    const colon = loc({ kind: 'relative', anchor: { text: ':' }, relation: 'right-of', role: 'textbox' });
    const alone = await s.resolve({ ...base, locators: [colon] }, 0);
    expect(alone).toEqual({ found: false, tried: [{ strategyKind: 'relative', error: 'ambiguous anchor: 2 matches', ambiguous: true, matches: 2 }] });

    // With a bbox behind it the surface still finds an element; it reports what missed before the
    // winner, and replay decides (it refuses a positional winner after an ambiguity).
    const r = await s.resolve({ ...base, locators: [colon, loc({ kind: 'bbox', x: 0.25, y: 0.433, w: 0.2, h: 0.08 })] }, 0);
    expect(r).toMatchObject({
      found: true,
      strategyIndex: 1,
      strategyKind: 'bbox',
      tried: [{ strategyKind: 'relative', error: 'ambiguous anchor: 2 matches', ambiguous: true, matches: 2 }],
    });
  });

  it('a relative anchor equal to one static wins over statics that only contain it', async () => {
    const { s } = await open();
    const obs = await s.observe();
    const password = find(obs, 'textbox', 'Password');
    const r = await s.resolve({ ...base, locators: [loc({ kind: 'relative', anchor: { text: 'password:' }, relation: 'right-of', role: 'textbox' })] }, 0);
    expect(r).toMatchObject({ found: true, strategyIndex: 0, tried: [] });
    if (r.found) expect(await s.isSameElement(password.ref, r.ref)).toBe(true);
  });

  it('a target in a frame (group) is not found outside it, and is found inside it', async () => {
    const { s } = await open();
    await signOn(s);
    await lookUp(s, '12345');
    const savings = { kind: 'automation_id', id: 'txtSavings' } as const;
    expect((await s.resolve({ ...base, locators: [loc(savings)] }, 0)).found).toBe(false);
    expect((await s.resolve({ ...base, frame: [{ name: 'Balances' }], locators: [loc(savings)] }, 0)).found).toBe(true);
  });

  it('waits up to the timeout for an element to appear', async () => {
    const { s, app } = await open();
    setTimeout(() => {
      app.screen = 'lookup';
    }, 300);
    const r = await s.resolve({ ...base, locators: [loc({ kind: 'role', role: 'button', name: 'Find' })] }, 3000);
    expect(r.found).toBe(true);
  });
});

describe('act and readText', () => {
  it('signs on, looks up a member and reads the balance', async () => {
    const { s } = await open();
    await signOn(s);
    const obs = await lookUp(s, '12345');
    expect(obs.title).toBe('Teller Workstation - Member 12345');
    const read = await s.readText(find(obs, 'textbox', 'Savings Balance').descriptor, 2000);
    expect(read).toEqual({ ok: true, text: '$1,234.56' });
  });

  it('refuses to read a password field', async () => {
    const { s } = await open();
    const obs = await s.observe();
    expect(await s.readText({ ref: find(obs, 'textbox', 'Password').ref }, 1000)).toMatchObject({ ok: false, error: { code: 'input_validation' } });
  });

  it('types by the Value pattern (replace by default, append with clear: false) and presses Enter by posting a key', async () => {
    const { s, app } = await open();
    const obs = await s.observe();
    const user = find(obs, 'textbox', 'User ID');
    await s.act({ type: 'type', target: { ref: user.ref }, value: 'oper' }, 2000);
    await s.act({ type: 'type', target: { ref: user.ref }, value: 'ator1', clear: false }, 2000);
    expect(app.values.get('42.3')).toBe('operator1');
    await s.act({ type: 'press', key: 'Enter' }, 2000);
    expect(app.keys.at(-1)).toMatchObject({ key: 'Enter' });
  });

  it('typing into a read-only field fails with a typed error instead of falling back to keystrokes', async () => {
    const { s } = await open();
    await signOn(s);
    const obs = await lookUp(s, '12345');
    const r = await s.act({ type: 'type', target: { ref: find(obs, 'textbox', 'Savings Balance').ref }, value: '1' }, 2000);
    expect(r).toMatchObject({ ok: false, error: { code: 'app_error' } });
    expect(r.error!.message).toMatch(/read-only/);
  });

  it('clicking a control no UIA pattern can activate fails with app_error naming why (no synthesized mouse input)', async () => {
    const { s } = await open();
    const obs = await s.observe();
    const r = await s.act({ type: 'click', target: { ref: find(obs, 'text', 'User ID:').ref } }, 2000);
    expect(r).toMatchObject({ ok: false, error: { code: 'app_error' } });
    expect(r.error!.message).toMatch(/synthesized mouse input/);
  });

  it('a ref whose element has left the screen is element_not_found; an unknown ref too', async () => {
    const { s } = await open();
    const obs = await s.observe();
    const r = await s.resolve(find(obs, 'button', 'Sign On').descriptor, 0);
    if (!r.found) throw new Error('Sign On not resolved');
    await signOn(s);
    expect(await s.act({ type: 'click', target: { ref: r.ref } }, 1000)).toMatchObject({ ok: false, error: { code: 'element_not_found' } });
    expect(await s.act({ type: 'click', target: { ref: 'e999' } }, 1000)).toMatchObject({ ok: false, error: { code: 'element_not_found' } });
  });

  it('reports the not-found business outcome as on-screen text', async () => {
    const { s } = await open();
    await signOn(s);
    await lookUp(s, '99999');
    expect(await s.check({ kind: 'text_visible', text: 'No member found with ID 99999' })).toBe(true);
  });
});

describe('navigate: waits for a window of this app, never starts a program', () => {
  it('the bare app location and the current window succeed', async () => {
    const { s } = await open();
    expect(await s.act({ type: 'navigate', url: 'desktop://tellerworkstation' }, 1000)).toMatchObject({ ok: true });
    expect(await s.act({ type: 'navigate', url: 'desktop://TellerWorkstation/Teller%20Workstation%20-%20Sign%20On' }, 1000)).toMatchObject({ ok: true });
  });

  it('a relative "/.." is the window titled "..", as the guard resolves it, not the bare app', async () => {
    const { s } = await open();
    const r = await s.act({ type: 'navigate', url: '/..' }, 300);
    expect(r).toMatchObject({ ok: false, error: { code: 'navigation_failed' } });
    expect(r.error!.message).toContain('".."');
  });

  it.each([
    ['another process', 'desktop://calc/'],
    ['a web URL', 'http://localhost:4173/login'],
    ['a window that never opens', 'desktop://tellerworkstation/Admin'],
    ['a UNC path', '\\\\host\\share\\x'],
    ['a protocol-relative URL', '//host/x'],
    ['an image name with .exe', 'desktop://tellerworkstation.exe/'],
  ])('%s fails with navigation_failed', async (_label, url) => {
    const { s } = await open();
    expect(await s.act({ type: 'navigate', url }, 300)).toMatchObject({ ok: false, error: { code: 'navigation_failed' } });
  });
});

describe('modal dialogs', () => {
  async function openDialog(): Promise<{ s: DesktopSurface; app: FakeTellerApp; obs: Observation }> {
    const ctx = await open();
    await signOn(ctx.s);
    let obs = await lookUp(ctx.s, '12345');
    await ctx.s.act({ type: 'click', target: { ref: find(obs, 'button', 'Open Sub-Account...').ref } }, 2000);
    obs = await ctx.s.observe();
    return { ...ctx, obs };
  }

  it('reports dialog_open with the message, lists the dialog controls in a frame named by its title', async () => {
    const { s, obs } = await openDialog();
    expect(obs.dialog).toEqual({ type: 'confirm', message: 'Open a new Share Savings sub-account for member 12345? This cannot be undone.' });
    expect(await s.check({ kind: 'dialog_open', messagePattern: 'sub-account' })).toBe(true);
    expect(find(obs, 'button', 'Cancel').frame).toEqual([{ name: 'Confirm Open Sub-Account' }]);
    expect(obs.elements[0]!.frame).toEqual([{ name: 'Confirm Open Sub-Account' }]); // the dialog is listed first
  });

  it('refuses actions outside the dialog with unexpected_dialog', async () => {
    const { s, obs } = await openDialog();
    expect(await s.act({ type: 'click', target: { ref: find(obs, 'button', 'New Lookup').ref } }, 1000)).toMatchObject({ ok: false, error: { code: 'unexpected_dialog' } });
  });

  it('dismiss_dialog(accept: false) presses Cancel; accept presses the default button', async () => {
    const first = await openDialog();
    expect(await first.s.act({ type: 'dismiss_dialog', accept: false }, 2000)).toMatchObject({ ok: true });
    expect(first.app.dialogOpen).toBe(false);
    expect(await first.s.check({ kind: 'text_visible', text: 'opened for member' })).toBe(false);
    let obs = await first.s.observe();
    await first.s.act({ type: 'click', target: { ref: find(obs, 'button', 'Open Sub-Account...').ref } }, 2000);
    expect(await first.s.act({ type: 'dismiss_dialog', accept: true }, 2000)).toMatchObject({ ok: true });
    obs = await first.s.observe();
    expect(obs.dialog).toBeUndefined();
    expect(obs.textDigest).toContain('Sub-account SA-1000001 opened for member 12345.');
  });

  it('dismiss_dialog with no dialog open is a no-op', async () => {
    const { s } = await open();
    expect(await s.act({ type: 'dismiss_dialog', accept: true }, 1000)).toEqual({ ok: true, navigated: false });
  });
});

describe('conditions over the accessibility view', () => {
  it('url_matches tests the desktop location, text conditions the digest, element conditions the locators', async () => {
    const { s } = await open();
    expect(await s.check({ kind: 'url_matches', pattern: '^desktop://tellerworkstation/Teller%20Workstation%20-%20Sign' })).toBe(true);
    expect(await s.check({ kind: 'text_visible', text: 'authorized use only' })).toBe(true);
    expect(await s.check({ kind: 'text_absent', text: 'MEMBER LOOKUP' })).toBe(true);
    const signOnButton: TargetDescriptor = { description: 'Sign On', frame: [], locators: [{ strategy: { kind: 'automation_id', id: 'btnSignOn' }, confidence: 1, source: 'recorded' }] };
    expect(await s.check({ kind: 'element_visible', target: signOnButton })).toBe(true);
    await signOn(s);
    expect(await s.waitFor({ kind: 'element_absent', target: signOnButton }, 1000)).toBe(true);
    expect(await s.check({ kind: 'text_visible', text: 'Member ID:', frame: [] })).toBe(true);
    expect(await s.check({ kind: 'text_visible', text: 'x', frame: [{ name: 'No Such Group' }] })).toBe(false);
  });
});

describe('masking', () => {
  it('paints passwords, typed fields and fields holding a typed value; hides labeled values as [MASKED]', async () => {
    const { s, app } = await open({ mask: { maskLabels: ['^tax id$'] } });
    let obs = await s.observe();
    await s.act({ type: 'type', target: { ref: find(obs, 'textbox', 'User ID').ref }, value: 'operator1' }, 2000);
    await s.screenshot();
    expect(app.lastScreenshot!.maskRids).toEqual(expect.arrayContaining(['42.3', '42.5']));
    // Typed values never travel to the bridge: fields are named by rid.
    expect(JSON.stringify(app.lastScreenshot)).not.toContain('operator1');
    await s.act({ type: 'type', target: { ref: find(obs, 'textbox', 'Password').ref }, value: 'demo-pass-123' }, 2000);
    await s.act({ type: 'click', target: { ref: find(obs, 'button', 'Sign On').ref } }, 2000);
    // A field that comes to hold a typed value (the app echoing it) is painted too, decided here.
    app.values.set('42.10', 'operator1');
    await s.screenshot();
    expect(app.lastScreenshot!.maskRids).toContain('42.10');
    expect(JSON.stringify(app.lastScreenshot)).not.toContain('operator1');
    obs = await lookUp(s, '12345');
    const tax = find(obs, 'textbox', 'Tax ID');
    expect(tax.value).toBe(MASKED_TEXT);
    expect(obs.textDigest).not.toContain('900-25-2345');
    expect(obs.textDigest).toContain(MASKED_TEXT);
    expect(app.lastScreenshot!.maskRids).toContain('42.30');
    // Runtime reads still see the real value (extract steps exist to read values), flagged masked so
    // the caller withholds it from the model and records it sensitive.
    expect(await s.readText({ ref: tax.ref }, 1000)).toEqual({ ok: true, text: '900-25-2345', masked: true });
  });

  it('a masked static shows its value nowhere: name, text, locators, snapshot, digest, domSnapshot', async () => {
    const { s } = await open({ mask: { maskLabels: ['^checking balance$'] } });
    await signOn(s);
    const obs = await lookUp(s, '12345');
    const strings: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === 'object' && !Buffer.isBuffer(v)) Object.values(v).forEach(walk);
    };
    walk(obs);
    expect(strings.filter((x) => x.includes('$310.00'))).toEqual([]);
    const masked = obs.elements.filter((e) => e.masked);
    expect(masked).toHaveLength(1);
    expect(masked[0]).toMatchObject({ role: 'text', name: MASKED_TEXT });
    expect(masked[0]!.descriptor.locators.map((l) => l.strategy.kind)).not.toContain('text');
    expect(await s.domSnapshot()).not.toContain('$310.00');
    // Unmasked fields are untouched, and the runtime still reads the real value.
    expect(find(obs, 'textbox', 'Savings Balance').value).toBe('$1,234.56');
    expect(await s.readText({ ref: masked[0]!.ref }, 1000)).toEqual({ ok: true, text: '$310.00', masked: true });
    // The descriptor still finds it, by what remains (relative to its label, or position).
    expect(await s.resolve(masked[0]!.descriptor, 0)).toMatchObject({ found: true });
  });

  it('a masked string in a window title is in no frame path, frame URL or location; targets under it still resolve', async () => {
    const { s, app } = await open({ mask: { maskTextPatterns: ['^open sub-account$'] } });
    await signOn(s);
    await lookUp(s, '12345');
    app.dialogOpen = true;
    const obs = await s.observe();
    const strings: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === 'object' && !Buffer.isBuffer(v)) Object.values(v).forEach(walk);
    };
    walk(obs);
    expect(strings.filter((x) => /open sub-account(?!\.\.\.)|Open%20Sub-Account/i.test(x) && !x.includes('Open Sub-Account...'))).toEqual([]);
    expect(await s.domSnapshot()).not.toMatch(/Confirm Open Sub-Account|Confirm%20Open%20Sub-Account/);
    // The dialog's hop carries no name; its controls are found by what is left.
    const cancel = find(obs, 'button', 'Cancel');
    expect(cancel.frame).toEqual([{ index: 0 }]);
    expect(await s.resolve(cancel.descriptor, 0)).toMatchObject({ found: true, strategyIndex: 0 });
    for (const el of obs.elements) expect((await s.resolve(el.descriptor, 0)).found, `${el.role} ${el.name}`).toBe(true);
    expect(obs.frames.every((f) => f.path.every((hop) => hop.name === undefined || !/Sub-Account/.test(hop.name)))).toBe(true);
    // The policy still sees the real location.
    expect(await s.frameUrls()).toContain('desktop://tellerworkstation/Confirm%20Open%20Sub-Account');
  });

  it('a window title that itself matches a text pattern is masked whole: not in the observation, the tree, or any hop', async () => {
    const { s, app } = await open({ mask: { maskTextPatterns: ['^confirm open'] } });
    await signOn(s);
    await lookUp(s, '12345');
    app.dialogOpen = true;
    const obs = await s.observe();
    expect(JSON.stringify(obs)).not.toMatch(/Confirm Open|Confirm%20Open/);
    expect(await s.domSnapshot()).not.toMatch(/Confirm Open|Confirm%20Open/);
    const cancel = find(obs, 'button', 'Cancel');
    expect(cancel.frame).toEqual([{ index: 0 }]);
    expect(await s.resolve(cancel.descriptor, 0)).toMatchObject({ found: true });
  });

  it('maskInputs: all paints every editable field; omitScreenshotUrlPatterns blanks screenshots at matching locations', async () => {
    const { s, app } = await open({ mask: { maskInputs: 'all', omitScreenshotUrlPatterns: ['Member%20\\d+'] } });
    await s.screenshot();
    expect(app.lastScreenshot!.maskRids).toEqual(expect.arrayContaining(['42.3', '42.5']));
    await signOn(s);
    await lookUp(s, '12345');
    app.lastScreenshot = undefined;
    const png = await s.screenshot();
    expect(app.lastScreenshot).toBeUndefined();
    // The omitted-screenshot placeholder, as on the web surface; an observation carries none.
    expect(isOmittedScreenshot(png)).toBe(true);
    expect((await s.observe()).screenshotPng).toBeUndefined();
  });
});

describe('evidence', () => {
  it('domSnapshot serializes the tree with names and never a value', async () => {
    const { s } = await open();
    await signOn(s);
    await lookUp(s, '12345');
    const dom = await s.domSnapshot();
    expect(dom).toContain('<window title="Teller Workstation - Member 12345"');
    expect(dom).toContain('automationId="txtSavings"');
    for (const value of ['$1,234.56', '900-25-2345', '282 Mill St', 'operator1']) expect(dom).not.toContain(value);
  });

  it('frameUrls and describeRef describe locations and targets for the policy wrapper', async () => {
    const { s, app } = await open();
    await signOn(s);
    await lookUp(s, '12345');
    app.dialogOpen = true;
    const obs = await s.observe();
    expect(await s.frameUrls()).toEqual([obs.url, 'desktop://tellerworkstation/Confirm%20Open%20Sub-Account']);
    expect(await s.describeRef(find(obs, 'button', 'Open Sub-Account').ref)).toEqual({
      tag: 'button',
      role: 'button',
      name: 'Open Sub-Account',
      text: 'Open Sub-Account',
      classifyName: 'Open Sub-Account',
      classifyText: 'Open Sub-Account',
      frameUrl: 'desktop://tellerworkstation/Confirm%20Open%20Sub-Account',
    });
    expect(await s.describeRef('e999')).toBeUndefined();
  });
});

describe('readRecordText', () => {
  it("reads the group that holds the value as its container, and the whole window for 'page'", async () => {
    const { s } = await open();
    await signOn(s);
    const obs = await lookUp(s, '12345');
    const savings = find(obs, 'textbox', 'Savings Balance');

    const box = await s.readRecordText({ ref: savings.ref }, 'container', 1000);
    if (!box.ok) throw new Error(box.error.message);
    expect(box.scope).toBe('container');
    expect(box.text).toContain('Checking Balance:');
    expect(box.text).toContain('$1,234.56'); // a read-only field's value is text a person reads
    expect(box.text).not.toContain('Tax ID'); // the contact group is another container

    const page = await s.readRecordText({ ref: savings.ref }, 'page', 1000);
    if (!page.ok) throw new Error(page.error.message);
    expect(page.scope).toBe('page');
    expect(page.text).toContain('Tax ID:');
    expect(page.text).toContain('Checking Balance:');
  });

  it('never counts an editable field or a password as text, and reports an unknown ref as element_not_found', async () => {
    const { s } = await open();
    const obs = await s.observe();
    await s.act({ type: 'type', target: { ref: find(obs, 'textbox', 'User ID').ref }, value: 'operator1' }, 5000);
    const page = await s.readRecordText({ ref: find(obs, 'button', 'Sign On').ref }, 'page', 1000);
    if (!page.ok) throw new Error(page.error.message);
    expect(page.text).toContain('User ID:');
    expect(page.text).not.toContain('operator1');
    const pw = await s.readRecordText({ ref: find(obs, 'textbox', 'Password').ref }, 'container', 1000);
    expect(pw).toMatchObject({ ok: false, error: { code: 'input_validation' } });
    expect(await s.readRecordText({ ref: 'e999' }, 'container', 100)).toMatchObject({ ok: false, error: { code: 'element_not_found' } });
  });
});

describe('lifecycle', () => {
  it('fails with a clear message when no window of the named process appears', async () => {
    const { app, bridge } = createFakeTeller();
    await expect(createDesktopSurface({ processName: 'notepad', attachPid: app.pid, bridge: bridge.connection(), startTimeoutMs: 300 })).rejects.toThrow(
      /no window of process "notepad".*tellerworkstation/is,
    );
    expect(bridge.closed).toBe(true);
  });

  it('close() closes the bridge and is idempotent; a closed surface refuses to act', async () => {
    const { s, bridge } = await open();
    await s.close();
    await s.close();
    expect(bridge.closed).toBe(true);
    await expect(s.observe()).rejects.toThrow(/closed/);
    surface = undefined;
  });
});
