/**
 * The desktop surface honours the screen-masking contract of the `Surface` port
 * (docs/design/screen-masking.md), on the fake bridge (any OS):
 *  - `check`/`waitFor` with `{ view: 'masked' }` evaluate against the masked text view;
 *  - `readText` sets `masked` when the element is masked;
 *  - `describeRef` returns the masked view, the real strings only in `classifyName`/`classifyText`,
 *    so a policy decision event never quotes a masked value;
 *  - an observation that may not carry a screenshot carries none;
 *  - `desktopScreenMaskFromPolicy` maps the policy block (whole-label `maskLabels`, `maskInputs`,
 *    the patterns and the run's values).
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPolicyGuard, loadPolicy, withPolicy, type PolicyDecisionEvent } from '@cu/core/policy';
import { resolveScreenMask } from '@cu/core/schema';
import { screenMaskOptionsFromPolicy, type Observation, type ObservedElement } from '@cu/core/surface';
import { createFakeTeller } from './fake-bridge.js';
import { desktopScreenMaskFromPolicy, MASKED_TEXT, type DesktopScreenMask } from './mask.js';
import { createDesktopSurface, type DesktopSurface } from './surface.js';

let surface: DesktopSurface | undefined;
afterEach(async () => {
  await surface?.close();
  surface = undefined;
});

async function open(mask?: DesktopScreenMask): Promise<DesktopSurface> {
  const { app, bridge } = createFakeTeller();
  surface = await createDesktopSurface({ processName: 'TellerWorkstation', attachPid: app.pid, bridge: bridge.connection(), ...(mask ? { mask } : {}) });
  return surface;
}

function find(obs: Observation, role: string, name: string): ObservedElement {
  const el = obs.elements.find((e) => e.role === role && e.name === name);
  if (!el) throw new Error(`no ${role} "${name}" in ${obs.elements.map((e) => `${e.role}:${e.name}`).join(', ')}`);
  return el;
}

async function toDetail(s: DesktopSurface): Promise<Observation> {
  let obs = await s.observe();
  await s.act({ type: 'type', target: { ref: find(obs, 'textbox', 'User ID').ref }, value: 'operator1' }, 5000);
  await s.act({ type: 'type', target: { ref: find(obs, 'textbox', 'Password').ref }, value: 'demo-pass-123' }, 5000);
  await s.act({ type: 'click', target: { ref: find(obs, 'button', 'Sign On').ref } }, 5000);
  obs = await s.observe();
  await s.act({ type: 'type', target: { ref: find(obs, 'textbox', 'Member ID').ref }, value: '12345', pressEnter: true }, 5000);
  return s.observe();
}

const textVisible = (text: string) => ({ kind: 'text_visible' as const, text });

describe('desktop surface: the screen-masking contract', () => {
  it("check/waitFor with view 'masked' see the masked view; the real view still sees the value", async () => {
    const s = await open({ maskLabels: ['checking balance'] });
    await toDetail(s);
    expect(await s.check(textVisible('$310.00'))).toBe(true);
    expect(await s.check(textVisible('$310.00'), { view: 'masked' })).toBe(false);
    expect(await s.waitFor(textVisible('$310.00'), 300, { view: 'masked' })).toBe(false);
    // Unmasked text is visible in both.
    expect(await s.check(textVisible('MEMBER DETAIL'), { view: 'masked' })).toBe(true);
  });

  it('readText flags a masked element; an unmasked one is not flagged', async () => {
    const s = await open({ maskLabels: ['checking balance'] });
    const obs = await toDetail(s);
    const masked = obs.elements.find((e) => e.masked === true && e.role === 'text')!;
    expect(await s.readText({ ref: masked.ref }, 1000)).toEqual({ ok: true, text: '$310.00', masked: true });
    const header = obs.elements.find((e) => e.role === 'text' && e.name === 'MEMBER DETAIL')!;
    expect(await s.readText({ ref: header.ref }, 1000)).toEqual({ ok: true, text: 'MEMBER DETAIL' });
  });

  it('describeRef returns the masked view and the real strings only as classifyName/classifyText', async () => {
    const s = await open({ maskLabels: ['checking balance'] });
    const obs = await toDetail(s);
    const masked = obs.elements.find((e) => e.masked === true && e.role === 'text')!;
    const d = await s.describeRef(masked.ref);
    expect(d).toMatchObject({ name: MASKED_TEXT, classifyName: '$310.00' });
    expect(d?.name).toBe(masked.name);
    expect(JSON.stringify({ name: d?.name, text: d?.text, frameUrl: d?.frameUrl })).not.toContain('$310.00');
  });

  it("a policy decision event never quotes a masked control's real text (the reviewer's events.jsonl leak)", async () => {
    const s = await open({ maskTextPatterns: ['^open sub-account\\.\\.\\.$'] });
    const obs = await toDetail(s);
    const button = obs.elements.find((e) => e.role === 'button' && e.masked === true)!;
    expect(button.name).toBe(MASKED_TEXT);
    const events: PolicyDecisionEvent[] = [];
    const policy = loadPolicy(path.resolve('policies/desktop.yaml'));
    const guarded = withPolicy(s, createPolicyGuard(policy), { runKind: 'discovery', onDecision: (e) => events.push(e) });
    await guarded.observe();
    await guarded.act({ type: 'click', target: { ref: button.ref } }, 2000);
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain('Open Sub-Account...');
  });

  it('an observation that may not carry a screenshot carries none (not a blank PNG)', async () => {
    const s = await open({ omitScreenshotUrlPatterns: ['Sign%20On'] });
    expect((await s.observe()).screenshotPng).toBeUndefined();
  });

  it('desktopScreenMaskFromPolicy: whole-label maskLabels, maskInputs all (an empty field stays empty), patterns and run values', async () => {
    const base = loadPolicy(path.resolve('policies/desktop.yaml'));
    const mask = desktopScreenMaskFromPolicy(
      screenMaskOptionsFromPolicy({ ...base, redaction: { ...base.redaction, screen: { ...resolveScreenMask(undefined), maskLabels: ['address'] } } }, () => ['Jane Q. Sample']),
    );
    expect(mask.maskInputs).toBe('all');
    expect(mask.maskTextPatterns!.length).toBeGreaterThan(0);
    const s = await open(mask);
    const signOn = await s.observe();
    expect(find(signOn, 'textbox', 'User ID').value, 'an empty field under all').toBe('');
    const obs = await toDetail(s);
    const all = JSON.stringify(obs);
    // maskInputs all: every edit field's value; the run value wherever it shows (the header too).
    for (const value of ['$1,234.56', '900-25-2345', '282 Mill St', 'Jane Q. Sample']) expect(all, value).not.toContain(value);
    // Whole-label match: "Address" is a label, the label words themselves stay.
    expect(all).toContain('Address');
  });
});
