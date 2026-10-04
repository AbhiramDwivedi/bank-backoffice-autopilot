import { describe, expect, it } from 'vitest';
import type { TargetDescriptor } from '../../schema/index.js';
import { createCuCoreSurface } from './cu-core.js';

function roleTarget(role: string, name: string, description = `${role} "${name}"`): TargetDescriptor {
  return {
    description,
    frame: [],
    locators: [{ strategy: { kind: 'role', role, name }, confidence: 0.9, source: 'inferred' }],
  };
}

function mainRoleTarget(role: string, name: string): TargetDescriptor {
  return {
    description: `${role} "${name}" in main frame`,
    frame: [{ name: 'main' }],
    locators: [{ strategy: { kind: 'role', role, name }, confidence: 0.9, source: 'inferred' }],
  };
}

/** The search button and result rows are plain divs/trs with no ARIA role (see cu-core.ts's file
 * header), so they can only be found by visible text, not by role. */
function mainTextTarget(text: string, tag: string): TargetDescriptor {
  return {
    description: `text "${text}" (<${tag}>) in main frame`,
    frame: [{ name: 'main' }],
    locators: [{ strategy: { kind: 'text', text, tag }, confidence: 0.75, source: 'inferred' }],
  };
}

async function login(surface: ReturnType<typeof createCuCoreSurface>): Promise<void> {
  await surface.act({ type: 'type', target: roleTarget('textbox', 'User ID'), value: 'operator1' }, 1000);
  await surface.act({ type: 'type', target: roleTarget('textbox', 'Password'), value: 'demo-pass-123' }, 1000);
  // login.ejs's submit is an <input type="image" name="login"> with no alt text; its accessible
  // name falls back to the `name` attribute, "login" (see cu-core.ts's loginElements()).
  const r = await surface.act({ type: 'click', target: roleTarget('button', 'login') }, 1000);
  expect(r.ok).toBe(true);
}

describe('cu-core scenario: G1 happy path', () => {
  it('logs in, dismisses the interstitial, searches, opens the member, and reads the savings balance', async () => {
    const surface = createCuCoreSurface();
    expect(surface.currentScreenId()).toBe('login');

    await login(surface);
    expect(surface.currentScreenId()).toBe('workstation_notice');

    let obs = await surface.observe();
    expect(obs.textDigest).toContain('System Maintenance Notice');

    const okClick = await surface.act({ type: 'click', target: mainRoleTarget('clickable', 'OK') }, 1000);
    expect(okClick).toEqual({ ok: true, navigated: true });
    expect(surface.currentScreenId()).toBe('workstation');

    await surface.act({ type: 'type', target: mainRoleTarget('textbox', 'Member ID'), value: '12345' }, 1000);
    const searchClick = await surface.act({ type: 'click', target: mainTextTarget('Search', 'div') }, 1000);
    expect(searchClick.ok).toBe(true);
    expect(surface.currentScreenId()).toBe('search_results_12345');

    obs = await surface.observe();
    const row = obs.elements.find((e) => e.text?.startsWith('12345'));
    expect(row).toBeDefined();

    const rowClick = await surface.act({ type: 'click', target: { ref: row!.ref } }, 1000);
    expect(rowClick).toEqual({ ok: true, navigated: true });
    expect(surface.currentScreenId()).toBe('member_12345');

    obs = await surface.observe();
    const savings = obs.elements.find((e) => e.name === 'Savings Balance' ? false : e.text === '$1,234.56');
    expect(savings?.text).toBe('$1,234.56');
    const memberName = obs.elements.find((e) => e.text === 'Jane Q. Sample');
    expect(memberName).toBeDefined();

    await surface.close();
  });

  it('reaches the same screens via typed descriptors with fallback locators (label, then text)', async () => {
    const surface = createCuCoreSurface({ interstitial: false });
    const userIdTarget: TargetDescriptor = {
      description: 'User ID field',
      frame: [],
      locators: [
        { strategy: { kind: 'role', role: 'textbox', name: 'nonexistent-role-name' }, confidence: 0.9, source: 'inferred' },
        { strategy: { kind: 'label', label: 'User ID' }, confidence: 0.7, source: 'inferred' },
      ],
    };
    await surface.act({ type: 'type', target: userIdTarget, value: 'operator1' }, 1000);
    await surface.act({ type: 'type', target: roleTarget('textbox', 'Password'), value: 'demo-pass-123' }, 1000);
    const r = await surface.act({ type: 'click', target: roleTarget('button', 'login') }, 1000);
    expect(r.ok).toBe(true);
    // interstitial:false skips workstation_notice entirely.
    expect(surface.currentScreenId()).toBe('workstation');
  });
});

describe('cu-core scenario: business outcomes', () => {
  it('not-found search lands on search_empty with the red message', async () => {
    const surface = createCuCoreSurface({ interstitial: false });
    await login(surface);
    expect(surface.currentScreenId()).toBe('workstation');

    await surface.act({ type: 'type', target: mainRoleTarget('textbox', 'Member ID'), value: '99999' }, 1000);
    await surface.act({ type: 'click', target: mainTextTarget('Search', 'div') }, 1000);
    expect(surface.currentScreenId()).toBe('search_empty');

    const digest = (await surface.observe()).textDigest;
    expect(digest).toContain('No records found.');
  });

  it('access-denied for the restricted member (90001), reached via search then row click', async () => {
    const surface = createCuCoreSurface({ interstitial: false });
    await login(surface);

    await surface.act({ type: 'type', target: mainRoleTarget('textbox', 'Member ID'), value: '90001' }, 1000);
    await surface.act({ type: 'click', target: mainTextTarget('Search', 'div') }, 1000);
    expect(surface.currentScreenId()).toBe('search_results_90001');

    const obs = await surface.observe();
    const row = obs.elements.find((e) => e.text?.startsWith('90001'))!;
    const rowClick = await surface.act({ type: 'click', target: { ref: row.ref } }, 1000);
    expect(rowClick.ok).toBe(true);
    expect(surface.currentScreenId()).toBe('access_denied');

    const digest = (await surface.observe()).textDigest;
    expect(digest).toContain('Access Denied: your role does not permit viewing this member.');
  });

  it('wrong password re-shows login with the red error text and stays on login_error', async () => {
    const surface = createCuCoreSurface();
    await surface.act({ type: 'type', target: roleTarget('textbox', 'User ID'), value: 'operator1' }, 1000);
    await surface.act({ type: 'type', target: roleTarget('textbox', 'Password'), value: 'wrong-password' }, 1000);
    const r = await surface.act({ type: 'click', target: roleTarget('button', 'login') }, 1000);
    expect(r.ok).toBe(true);
    expect(surface.currentScreenId()).toBe('login_error');
    const digest = (await surface.observe()).textDigest;
    expect(digest).toContain('Invalid user ID or password.');
  });
});

describe('cu-core scenario: tenant b', () => {
  it('uses the "Member #" label instead of "Member ID"', async () => {
    const surface = createCuCoreSurface({ tenant: 'b', interstitial: false });
    await login(surface);
    const obs = await surface.observe();
    const label = obs.elements.find((e) => e.frame.some((h) => h.name === 'main') && e.role === 'cell' && e.text === 'Member #');
    expect(label).toBeDefined();
    expect(obs.elements.some((e) => e.text === 'Member ID')).toBe(false);
  });
});

describe('cu-core scenario: session expiry injection', () => {
  it('the next act() after expire_session redirects to session_expired', async () => {
    const surface = createCuCoreSurface({ interstitial: false });
    await login(surface);
    surface.inject({ kind: 'expire_session' });
    const r = await surface.act({ type: 'click', target: mainTextTarget('Search', 'div') }, 1000);
    expect(r).toEqual({ ok: true, navigated: true });
    expect(surface.currentScreenId()).toBe('session_expired');
    const digest = (await surface.observe()).textDigest;
    expect(digest).toContain('Your session has expired. Click here to log in.');
  });
});
