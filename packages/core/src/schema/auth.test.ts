/**
 * The `auth` block: `deriveAuth` (the one rule the recorder and the relogin operator share),
 * `resolveAuth` (explicit block first, tenant-applied steps), and `validateCapability`'s
 * `invalid_auth` checks. The shipped artifacts are the fixtures for the derived path: the recorded
 * one has no block and a sign-on click with no checkpoint; the example carries an explicit block.
 * The variants below are the flows a review found the first version of the rule got wrong.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Capability, Condition, Step, TargetDescriptor } from './index.js';
import { deriveAuth, formGoneCondition, resolveAuth, validateCapability } from './index.js';

const RECORDED = JSON.parse(fs.readFileSync('artifacts/lookup-member-savings-balance.json', 'utf8')) as Capability;
const EXAMPLE = JSON.parse(fs.readFileSync('artifacts/examples/lookup-member-savings-balance.example.json', 'utf8')) as Capability;

const field = (label: string, role = 'textbox'): TargetDescriptor => ({
  description: `${label} field`,
  frame: [],
  locators: [
    { strategy: { kind: 'label', label }, confidence: 0.8, source: 'recorded' },
    { strategy: { kind: 'bbox', x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, confidence: 0.1, source: 'inferred' },
  ],
  snapshot: { tag: 'input', role, name: label },
});
const button = (name: string): TargetDescriptor => ({
  description: `${name} button`,
  frame: [],
  locators: [{ strategy: { kind: 'role', role: 'button', name }, confidence: 0.9, source: 'recorded' }],
  snapshot: { tag: 'input', role: 'button', name },
});
const nav = (id: string, url = '{baseUrl}/login'): Step => ({ id, name: 'open', action: { type: 'navigate', url }, risk: 'read' });
const secret = (id: string, env: string, extra: { pressEnter?: boolean } = {}): Step => ({
  id,
  name: `type ${env}`,
  action: { type: 'type', target: field(env), value: { kind: 'secret', env }, ...extra },
  risk: 'reversible',
});
const click = (id: string, target: TargetDescriptor = button('Sign on'), extra: Partial<Step> = {}): Step => ({
  id,
  name: 'click',
  action: { type: 'click', target },
  risk: 'reversible',
  ...extra,
});
const typeInput = (id: string): Step => ({ id, name: 'type member id', action: { type: 'type', target: field('Member ID'), value: { kind: 'input', name: 'memberId' } }, risk: 'reversible' });

/** The form-gone condition for a field built by `field(label)` (bbox dropped). */
const gone = (label: string): Condition => ({
  kind: 'not',
  of: { kind: 'element_visible', target: { ...field(label), locators: [field(label).locators[0]!] } },
});

describe('deriveAuth', () => {
  it('the recorded artifact (no block, unchecked sign-on): entry through the sign-on click, proven by the password field being gone', () => {
    expect(RECORDED.auth).toBeUndefined();
    const auth = deriveAuth(RECORDED);
    expect(auth?.steps).toEqual(['s01', 's02', 's03', 's04', 's05']);
    expect(auth?.signedIn).toEqual(formGoneCondition(RECORDED.steps[3]!));
    // The bounding box is dropped: a coordinate always hits something on the next page.
    expect(JSON.stringify(auth?.signedIn)).not.toContain('"bbox"');
  });

  it("the example: the sign-on click's own checkpoint proves the sign-in, and matches its explicit block", () => {
    const { auth, ...withoutBlock } = EXAMPLE;
    expect(deriveAuth(withoutBlock)).toEqual({ steps: ['s01', 's02', 's03', 's04'], signedIn: { kind: 'url_matches', pattern: '/workstation$' } });
    expect(auth).toEqual(deriveAuth(withoutBlock));
  });

  it('(review a) a PIN typed later in the business flow never stretches the sign-in over the member search', () => {
    const steps = [nav('s01'), secret('s02', 'U'), secret('s03', 'P'), click('s04'), typeInput('s05'), click('s06', button('Search')), secret('s07', 'PIN'), click('s08', button('Go'))];
    expect(deriveAuth({ steps })).toEqual({ steps: ['s01', 's02', 's03', 's04'], signedIn: gone('P') });
  });

  it('(review b) a "remember me" checkbox between the password and Sign on is part of the sign-in, not its end', () => {
    const remember = click('s04', field('Remember me', 'checkbox'));
    const steps = [nav('s01'), secret('s02', 'U'), secret('s03', 'P'), remember, click('s05'), typeInput('s06')];
    expect(deriveAuth({ steps })?.steps).toEqual(['s01', 's02', 's03', 's04', 's05']);
  });

  it('(review c) entry on a home page, then a click through to /login: the condition is about the form, not the URL', () => {
    const steps = [nav('s01', '{baseUrl}/'), click('s02', button('Log in')), secret('s03', 'U'), secret('s04', 'P'), click('s05'), typeInput('s06')];
    const auth = deriveAuth({ steps });
    expect(auth?.steps).toEqual(['s01', 's02', 's03', 's04', 's05']);
    // On /login the password field IS visible, so this does not hold before (or after a refused) sign-in.
    expect(auth?.signedIn).toEqual(gone('P'));
  });

  it('a two-page login (user, Next, password, Sign on) ends at the last submit before the business flow', () => {
    const steps = [nav('s01'), secret('s02', 'U'), click('s03', button('Next')), secret('s04', 'P'), click('s05'), typeInput('s06')];
    expect(deriveAuth({ steps })?.steps).toEqual(['s01', 's02', 's03', 's04', 's05']);
  });

  it('ends at the secret step itself when it presses Enter', () => {
    const steps = [nav('s01'), secret('s02', 'U'), secret('s03', 'P', { pressEnter: true }), typeInput('s04')];
    expect(deriveAuth({ steps })?.steps).toEqual(['s01', 's02', 's03']);
  });

  it('a submit whose own checkpoint names an input depends on inputs, so it is not a sign-in step (nothing derived)', () => {
    const steps = [nav('s01'), secret('s02', 'P'), click('s03', button('Sign on'), { postcondition: { kind: 'text_visible', text: 'Hello {input.memberId}' } }), typeInput('s04')];
    expect(deriveAuth({ steps })).toBeUndefined();
  });

  it('derives nothing without a secret before the business flow, an entry navigate, a submit, or across an irreversible step', () => {
    expect(deriveAuth({ steps: [nav('s01'), click('s02')] })).toBeUndefined();
    expect(deriveAuth({ steps: [nav('s01'), typeInput('s02'), secret('s03', 'PIN'), click('s04')] })).toBeUndefined();
    expect(deriveAuth({ steps: [secret('s01', 'P'), click('s02')] })).toBeUndefined();
    expect(deriveAuth({ steps: [nav('s01'), secret('s02', 'P'), click('s03', field('Remember me', 'checkbox'))] })).toBeUndefined();
    expect(deriveAuth({ steps: [nav('s01'), secret('s02', 'P'), click('s03', button('Sign on'), { risk: 'irreversible' })] })).toBeUndefined();
  });
});

describe('resolveAuth', () => {
  it('prefers the explicit block', () => {
    const r = resolveAuth(EXAMPLE);
    expect(r?.source).toBe('explicit');
    expect(r?.steps.map((s) => s.id)).toEqual(['s01', 's02', 's03', 's04']);
  });

  it('derives when there is no block', () => {
    const r = resolveAuth(RECORDED);
    expect(r?.source).toBe('derived');
    expect(r?.steps.map((s) => s.id)).toEqual(['s01', 's02', 's03', 's04', 's05']);
  });

  it("takes an explicit block's steps from first to last id, so a tenant's extra step inside it is re-run too", () => {
    const steps = [nav('s01'), secret('s02', 'P'), click('s02b', field('Remember me', 'checkbox')), click('s03'), typeInput('s04')];
    const r = resolveAuth({ steps, auth: { steps: ['s01', 's02', 's03'], signedIn: { kind: 'text_visible', text: 'Hi' } } });
    expect(r?.steps.map((s) => s.id)).toEqual(['s01', 's02', 's02b', 's03']);
  });

  it('is undefined when an explicit block names a step the run does not have', () => {
    expect(resolveAuth({ steps: [nav('s01')], auth: { steps: ['s01', 's09'], signedIn: { kind: 'text_visible', text: 'Hi' } } })).toBeUndefined();
  });
});

describe('validateCapability: the auth block', () => {
  const S = EXAMPLE.auth!.signedIn;
  const withAuth = (auth: unknown): unknown => ({ ...structuredClone(EXAMPLE), auth });
  const codes = (r: ReturnType<typeof validateCapability>): string[] => (r.ok ? [] : r.issues.map((i) => `${i.code}@${i.path.join('.')}`));

  it('accepts the example artifact, the shipped artifact (no block), and the shipped artifact with its derived block', () => {
    expect(validateCapability(EXAMPLE).ok).toBe(true);
    expect(validateCapability(RECORDED).ok).toBe(true);
    const r = validateCapability({ ...structuredClone(RECORDED), auth: deriveAuth(RECORDED) });
    expect(codes(r)).toEqual([]);
  });

  it('rejects an id that is not a step', () => {
    expect(codes(validateCapability(withAuth({ steps: ['s01', 's99'], signedIn: S })))).toContain('invalid_auth@auth.steps.1');
  });

  it('rejects ids that are not the first steps in order', () => {
    expect(codes(validateCapability(withAuth({ steps: ['s02', 's03', 's04'], signedIn: S })))).toContain('invalid_auth@auth.steps.0');
    expect(codes(validateCapability(withAuth({ steps: ['s01', 's03', 's04'], signedIn: S })))).toContain('invalid_auth@auth.steps.1');
  });

  it('rejects a run with no secret-bound step', () => {
    expect(codes(validateCapability(withAuth({ steps: ['s01'], signedIn: S })))).toContain('invalid_auth@auth.steps');
  });

  it('rejects a run that does not end at the submit', () => {
    expect(codes(validateCapability(withAuth({ steps: ['s01', 's02', 's03'], signedIn: S })))).toContain('invalid_auth@auth.steps.2');
  });

  it('rejects a run stretched over the business flow: an input-bound step, or an extract', () => {
    const r = codes(validateCapability(withAuth({ steps: ['s01', 's02', 's03', 's04', 's05', 's06'], signedIn: S })));
    expect(r).toContain('invalid_auth@auth.steps.4'); // s05 types {input memberId}
  });

  it('rejects a run containing an irreversible step', () => {
    const cap = structuredClone(EXAMPLE) as Capability;
    cap.steps[3]!.risk = 'irreversible';
    cap.riskLevel = 'irreversible';
    expect(codes(validateCapability(cap))).toContain('invalid_auth@auth.steps.3');
  });

  it('rejects a trivially-true signed-in condition (only negations), but accepts "the secret field is gone"', () => {
    const steps = ['s01', 's02', 's03', 's04'];
    for (const trivial of [
      { kind: 'not', of: { kind: 'text_visible', text: 'zz-never-on-any-page' } },
      { kind: 'text_absent', text: 'zz-never-on-any-page' },
      { kind: 'all', of: [{ kind: 'text_absent', text: 'a' }, { kind: 'not', of: { kind: 'url_matches', pattern: 'x' } }] },
      { kind: 'not', of: { kind: 'element_visible', target: button('Unrelated') } },
    ]) {
      expect(codes(validateCapability(withAuth({ steps, signedIn: trivial }))), JSON.stringify(trivial)).toContain('invalid_auth@auth.signedIn');
    }
    const formGone = formGoneCondition(EXAMPLE.steps[2]!)!;
    expect(codes(validateCapability(withAuth({ steps, signedIn: formGone })))).toEqual([]);
  });

  it('rejects a signed-in condition that depends on inputs, and checks its regexes', () => {
    expect(codes(validateCapability(withAuth({ steps: ['s01', 's02', 's03', 's04'], signedIn: { kind: 'text_visible', text: 'Hi {input.memberId}' } })))).toContain(
      'invalid_auth@auth.signedIn',
    );
    expect(codes(validateCapability(withAuth({ steps: ['s01', 's02', 's03', 's04'], signedIn: { kind: 'url_matches', pattern: '(' } })))).toContain(
      'invalid_regex@auth.signedIn.pattern',
    );
  });

  it('never treats the step ids in the block as a leaked record-time value', () => {
    const r = validateCapability(EXAMPLE, { knownValues: ['s01', 's04'] });
    // (The example's prose mentions step ids elsewhere; only the block itself is under test.)
    expect((r.ok ? [] : r.issues).filter((i) => i.path[0] === 'auth')).toEqual([]);
  });
});
