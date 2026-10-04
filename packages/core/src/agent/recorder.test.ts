import { describe, expect, it } from 'vitest';
import type { Condition, TargetDescriptor } from '../schema/index.js';
import { bindCondition, validateCapability } from '../schema/index.js';
import { createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';
import type { FakeSurface } from '../surface/index.js';
import { createRecorder, findLeaks, kebabFromGoal, shortStepName, toIdentifier, type BuildMeta } from './recorder.js';

// ---------------------------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------------------------

const BASE_URL = 'http://localhost:4173';

function baseMeta(overrides: Partial<BuildMeta> = {}): BuildMeta {
  return {
    id: 'discovered-capability',
    goal: 'Do the thing.',
    app: { vendor: 'Acme Core Systems', product: 'CU Core Workstation', surface: 'web' },
    entryUrl: `${BASE_URL}/login`,
    runId: 'run_test_1',
    model: 'test-model',
    discoveredAt: '2026-09-25T00:00:00Z',
    ...overrides,
  };
}

const DUMMY_TARGET: TargetDescriptor = {
  description: 'A generic button',
  frame: [],
  locators: [{ strategy: { kind: 'role', role: 'button', name: 'Go' }, confidence: 0.9, source: 'recorded' }],
};

// Several CU Core elements share a `name` (e.g. a legacy label <td> and its adjacent <input> both
// get the label text as their accessible name), so lookups are qualified by role.

async function findByName(surface: FakeSurface, name: string) {
  const obs = await surface.observe();
  const el = obs.elements.find((e) => e.name === name);
  if (!el) throw new Error(`test setup: element not found: ${name} (have: ${obs.elements.map((e) => e.name).join(', ')})`);
  return el;
}

async function findByRoleName(surface: FakeSurface, role: string, name: string) {
  const obs = await surface.observe();
  const el = obs.elements.find((e) => e.role === role && e.name === name);
  if (!el) {
    throw new Error(
      `test setup: element not found: role=${role} name=${name} (have: ${obs.elements.map((e) => `${e.role}:${e.name}`).join(', ')})`,
    );
  }
  return el;
}

async function typeInto(surface: FakeSurface, role: string, name: string, value: string): Promise<Awaited<ReturnType<typeof findByRoleName>>> {
  const el = await findByRoleName(surface, role, name);
  const res = await surface.act({ type: 'type', target: { ref: el.ref }, value, clear: true }, 5000);
  if (!res.ok) throw new Error(`test setup: type into ${role}:${name} failed: ${JSON.stringify(res.error)}`);
  return el;
}

async function clickOn(surface: FakeSurface, role: string, name: string): Promise<Awaited<ReturnType<typeof findByRoleName>>> {
  const el = await findByRoleName(surface, role, name);
  const res = await surface.act({ type: 'click', target: { ref: el.ref } }, 5000);
  if (!res.ok) throw new Error(`test setup: click ${role}:${name} failed: ${JSON.stringify(res.error)}`);
  return el;
}

// ---------------------------------------------------------------------------------------------
// Canonicalization: whole-token matching, min length, longest-first, placeholders
// ---------------------------------------------------------------------------------------------

describe('canonicalizeString: whole-token matching', () => {
  it('replaces a standalone value but not when it is part of a longer token', () => {
    const recorder = createRecorder({
      baseUrl: BASE_URL,
      inputs: { code: { value: '123', sensitive: false, description: 'd', type: 'string' } },
    });
    const out = recorder.canonicalizeString('codes: 1234, a123, 123, 123x, x123');
    expect(out).toBe('codes: 1234, a123, {input.code}, 123x, x123');
  });

  it('skips values shorter than 3 characters and logs once', () => {
    const logs: { message: string; data?: Record<string, unknown> }[] = [];
    const recorder = createRecorder({
      baseUrl: BASE_URL,
      inputs: { tiny: { value: 'ab', sensitive: false, description: 'd', type: 'string' } },
      onLog: (message, data) => logs.push({ message, data }),
    });
    const out = recorder.canonicalizeString('ab is too short to canonicalize, ab again');
    expect(out).toBe('ab is too short to canonicalize, ab again');
    expect(logs.filter((l) => l.message.includes('too short'))).toHaveLength(1);
  });

  it('replaces the longest value first and does not re-match a shorter value inside the placeholder or other tokens', () => {
    const recorder = createRecorder({
      baseUrl: BASE_URL,
      inputs: {
        memberId: { value: '12345', sensitive: false, description: 'd', type: 'string' },
        other: { value: '234', sensitive: false, description: 'd', type: 'string' },
      },
    });
    const out = recorder.canonicalizeString('/members/12345?tab=profile 234 standalone, and 12345 Sample, Jane Q. Active');
    expect(out).toBe('/members/{input.memberId}?tab=profile {input.other} standalone, and {input.memberId} Sample, Jane Q. Active');
  });

  it('never touches text already inside a {...} placeholder', () => {
    const recorder = createRecorder({
      baseUrl: BASE_URL,
      inputs: { memberId: { value: 'baseUrl', sensitive: false, description: 'd', type: 'string' } },
    });
    // 'baseUrl' the input value happens to collide with the literal placeholder name; it must
    // not be substituted inside {baseUrl} itself.
    const out = recorder.canonicalizeString('go to {baseUrl}/x then baseUrl again');
    expect(out).toBe('go to {baseUrl}/x then {input.memberId} again');
  });
});

describe('canonicalizeUrl', () => {
  it('replaces the baseUrl prefix and then input values', () => {
    const recorder = createRecorder({
      baseUrl: BASE_URL,
      inputs: { memberId: { value: '12345', sensitive: false, description: 'd', type: 'string' } },
    });
    expect(recorder.canonicalizeUrl(`${BASE_URL}/members/12345?tab=profile`)).toBe('{baseUrl}/members/{input.memberId}?tab=profile');
    expect(recorder.canonicalizeUrl(BASE_URL)).toBe('{baseUrl}');
  });

  it('normalizes a trailing slash on baseUrl before comparing', () => {
    const recorder = createRecorder({ baseUrl: `${BASE_URL}/`, inputs: {} });
    expect(recorder.canonicalizeUrl(`${BASE_URL}/login`)).toBe('{baseUrl}/login');
  });

  it('leaves URLs that do not start with baseUrl unchanged (besides input substitution)', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    expect(recorder.canonicalizeUrl('https://other-host.example/x')).toBe('https://other-host.example/x');
  });
});

// ---------------------------------------------------------------------------------------------
// Descriptor canonicalization + narrowing, driven off real FakeSurface observations
// ---------------------------------------------------------------------------------------------

describe('canonicalizeDescriptor: narrowing against real observed descriptors', () => {
  it('narrows the result-row text locator to the placeholder alone, keeps tag, lowers confidence, and does not touch label locators', async () => {
    const surface = createCuCoreSurface({ interstitial: false });
    await typeInto(surface, 'textbox', 'User ID', 'operator1');
    await typeInto(surface, 'textbox', 'Password', 'demo-pass-123');
    await clickOn(surface, 'button', 'login');
    await typeInto(surface, 'textbox', 'Member ID', '12345');
    await clickOn(surface, 'clickable', 'Search');

    const obs = await surface.observe();
    const memberIdEl = await findByRoleName(surface, 'textbox', 'Member ID');
    const resultRowEl = obs.elements.find((e) => e.role === 'clickable' && e.name.startsWith('12345'));
    if (!resultRowEl) throw new Error('test setup: result row not found');

    const recorder = createRecorder({
      baseUrl: BASE_URL,
      inputs: { memberId: { value: '12345', sensitive: false, description: 'd', type: 'string' } },
    });

    const canonicalRow = recorder.canonicalizeDescriptor(resultRowEl.descriptor);
    const textLocator = canonicalRow.locators.find((l) => l.strategy.kind === 'text');
    if (!textLocator || textLocator.strategy.kind !== 'text') throw new Error('expected a text locator');
    expect(textLocator.strategy.text).toBe('{input.memberId}');
    expect(textLocator.strategy.exact).toBe(false);
    expect(textLocator.strategy.tag).toBe('tr');
    const originalTextLocator = resultRowEl.descriptor.locators.find((l) => l.strategy.kind === 'text')!;
    expect(textLocator.confidence).toBeCloseTo(originalTextLocator.confidence - 0.1, 5);
    // Snapshot and description are narrowed too: the rest of the row text is the recorded
    // member's PII (name, date) and must not persist in a reusable artifact.
    expect(canonicalRow.snapshot?.text).toBe('{input.memberId}');
    expect(canonicalRow.description).not.toContain('Jane');
    expect(canonicalRow.description).toContain('{input.memberId}');

    // Label locators are NOT narrowed even though they carry the same input value.
    const canonicalMemberIdField = recorder.canonicalizeDescriptor(memberIdEl.descriptor);
    const labelLocator = canonicalMemberIdField.locators.find((l) => l.strategy.kind === 'label');
    if (!labelLocator || labelLocator.strategy.kind !== 'label') throw new Error('expected a label locator');
    expect(labelLocator.strategy.label).toBe('Member ID');

    await surface.close();
  });

  it('does not narrow a synthetic label locator even when it contains a placeholder plus extra text', () => {
    const recorder = createRecorder({
      baseUrl: BASE_URL,
      inputs: { memberId: { value: '12345', sensitive: false, description: 'd', type: 'string' } },
    });
    const target: TargetDescriptor = {
      description: 'Member 12345 record',
      frame: [],
      locators: [{ strategy: { kind: 'label', label: 'Member 12345 record label' }, confidence: 0.8, source: 'inferred' }],
    };
    const canonical = recorder.canonicalizeDescriptor(target);
    const loc = canonical.locators[0]!;
    expect(loc.strategy).toEqual({ kind: 'label', label: 'Member {input.memberId} record label' });
    expect(loc.confidence).toBe(0.8); // unchanged: labels are excluded from narrowing
  });

  it('canonicalizes a sensitive input value out of a descriptor and never logs the raw value', () => {
    const logs: { message: string; data?: Record<string, unknown> }[] = [];
    const recorder = createRecorder({
      baseUrl: BASE_URL,
      inputs: { accountNumber: { value: 'ACC-998877', sensitive: true, description: 'Account number', type: 'string' } },
      onLog: (message, data) => logs.push({ message, data }),
    });
    const target: TargetDescriptor = {
      description: 'Row for account ACC-998877',
      frame: [],
      locators: [{ strategy: { kind: 'text', text: 'ACC-998877 Checking Active', exact: false, tag: 'tr' }, confidence: 0.6, source: 'inferred' }],
    };
    const canonical = recorder.canonicalizeDescriptor(target);
    expect(canonical.description).toBe('Row for account {input.accountNumber}');
    const textLoc = canonical.locators[0]!;
    expect(textLoc.strategy).toEqual({ kind: 'text', text: '{input.accountNumber}', exact: false, tag: 'tr', wholeWord: true });
    expect(textLoc.confidence).toBeCloseTo(0.5, 5);
    for (const entry of logs) {
      expect(entry.message).not.toContain('ACC-998877');
      expect(JSON.stringify(entry.data ?? {})).not.toContain('ACC-998877');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// recordStep: value bindings
// ---------------------------------------------------------------------------------------------

describe('recordStep: value bindings', () => {
  it('preserves a secret binding untouched', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    const step = recorder.recordStep({
      action: { type: 'type', target: DUMMY_TARGET, value: { kind: 'secret', env: 'MOCK_PASSWORD' }, clear: true },
      why: 'Enter the password.',
      risk: 'read',
    });
    expect(step.action.type).toBe('type');
    if (step.action.type !== 'type') throw new Error('expected type action');
    expect(step.action.value).toEqual({ kind: 'secret', env: 'MOCK_PASSWORD' });
  });

  it('keeps an input binding unchanged', () => {
    const recorder = createRecorder({
      baseUrl: BASE_URL,
      inputs: { memberId: { value: '12345', sensitive: false, description: 'd', type: 'string' } },
    });
    const step = recorder.recordStep({
      action: { type: 'type', target: DUMMY_TARGET, value: { kind: 'input', name: 'memberId' } },
      why: 'Enter the member ID.',
      risk: 'read',
    });
    if (step.action.type !== 'type') throw new Error('expected type action');
    expect(step.action.value).toEqual({ kind: 'input', name: 'memberId' });
  });

  it('templates an input value found inside a literal binding', () => {
    const recorder = createRecorder({
      baseUrl: BASE_URL,
      inputs: { memberId: { value: '12345', sensitive: false, description: 'd', type: 'string' } },
    });
    const step = recorder.recordStep({
      action: { type: 'type', target: DUMMY_TARGET, value: { kind: 'literal', value: 'search 12345 now' } },
      why: 'Type a literal search string.',
      risk: 'read',
    });
    if (step.action.type !== 'type') throw new Error('expected type action');
    expect(step.action.value).toEqual({ kind: 'literal', value: 'search {input.memberId} now' });
  });

  it('assigns sequential step ids and a name derived from why', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    const s1 = recorder.recordStep({ action: { type: 'navigate', url: `${BASE_URL}/login` }, why: 'Open the login page.', risk: 'read' });
    const s2 = recorder.recordStep({ action: { type: 'click', target: DUMMY_TARGET }, why: 'click it', risk: 'read' });
    expect(s1.id).toBe('s01');
    expect(s2.id).toBe('s02');
    expect(s1.name).toBe('Open the login page');
    expect(s2.name).toBe('Click it');
  });
});

// ---------------------------------------------------------------------------------------------
// sanitizeExtractedTarget (Defect 1)
// ---------------------------------------------------------------------------------------------

const VALUE_BEARING_TARGET: TargetDescriptor = {
  description: 'cell "$1,234.56" (<td>)',
  frame: [{ name: 'main' }],
  locators: [
    { strategy: { kind: 'text', text: '$1,234.56', exact: true, tag: 'td' }, confidence: 0.7, source: 'inferred' },
    { strategy: { kind: 'relative', anchor: { text: 'Savings Balance' }, relation: 'right-of', tag: 'td' }, confidence: 0.5, source: 'inferred' },
    { strategy: { kind: 'css', selector: 'tr:nth-of-type(6) > td:nth-of-type(2)' }, confidence: 0.3, source: 'inferred' },
    { strategy: { kind: 'bbox', x: 0.15, y: 0.24, w: 0.17, h: 0.03 }, confidence: 0.1, source: 'inferred' },
  ],
  snapshot: { tag: 'td', role: 'cell', name: '$1,234.56', text: '$1,234.56' },
};

describe('sanitizeExtractedTarget', () => {
  it('drops the value-bearing locator, rewrites description from the best survivor, strips matching snapshot fields', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    const result = recorder.sanitizeExtractedTarget(VALUE_BEARING_TARGET, 'savingsBalance', '$1,234.56');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.target.locators.map((l) => l.strategy.kind)).toEqual(['relative', 'css', 'bbox']);
    expect(result.target.description).toBe('cell right of "Savings Balance" (<td>)');
    expect(result.target.snapshot?.text).toBeUndefined();
    expect(result.target.snapshot?.name).toBeUndefined();
    expect(result.target.snapshot?.tag).toBe('td');
    expect(result.target.snapshot?.role).toBe('cell');
    expect(JSON.stringify(result.target)).not.toContain('1,234.56');
  });

  it('matches the raw value case-insensitively and whitespace-tolerantly', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    const result = recorder.sanitizeExtractedTarget(VALUE_BEARING_TARGET, 'savingsBalance', '  $1,234.56  ');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.target.locators.some((l) => l.strategy.kind === 'text')).toBe(false);
  });

  it('leaves the target unchanged when no locator names the extracted value', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    const labelTarget: TargetDescriptor = {
      description: 'cell labeled "Savings Balance" (<td>)',
      frame: [],
      locators: [{ strategy: { kind: 'label', label: 'Savings Balance' }, confidence: 0.8, source: 'inferred' }],
    };
    const result = recorder.sanitizeExtractedTarget(labelTarget, 'savingsBalance', '$1,234.56');
    expect(result).toEqual({ ok: true, target: labelTarget });
  });

  it('review fix: fails without registering the value when every locator would be dropped', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    const onlyValueTarget: TargetDescriptor = {
      description: 'cell "UNIQUEVALUE123" (<td>)',
      frame: [],
      locators: [{ strategy: { kind: 'text', text: 'UNIQUEVALUE123', exact: true }, confidence: 0.7, source: 'inferred' }],
    };
    const result = recorder.sanitizeExtractedTarget(onlyValueTarget, 'weirdField', 'UNIQUEVALUE123');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('weirdField');

    // The failed call must leave the recorder as if it never happened. Prove it observably (no
    // access to private state needed): record a step and a success description that repeats the
    // SAME value as ordinary prose, then build(). If the failed call above had registered the
    // value (the bug), build()'s free-text scrub would replace it with `{output.weirdField}`.
    recorder.recordStep({ action: { type: 'navigate', url: `${BASE_URL}/login` }, why: 'Open the login page.', risk: 'read' });
    recorder.setSuccess({ kind: 'text_visible', text: 'ok' }, 'The screen still shows UNIQUEVALUE123 in its own right.');
    const built = recorder.build(baseMeta());
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(`expected ok build, got: ${JSON.stringify(built.issues)}`);
    expect(built.capability.success.description).toBe('The screen still shows UNIQUEVALUE123 in its own right.');
  });

  it('registers the value on a successful call so build() scrubs it elsewhere, and enforces the leak check at emission', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    const sanitized = recorder.sanitizeExtractedTarget(VALUE_BEARING_TARGET, 'savingsBalance', '$1,234.56');
    if (!sanitized.ok) throw new Error('expected ok');
    recorder.recordStep({
      action: { type: 'extract', target: sanitized.target, output: 'savingsBalance', parse: 'currency' },
      why: 'Read the balance.',
      risk: 'read',
    });
    recorder.recordOutput('savingsBalance', 'currency', 'Read the balance.');
    recorder.setSuccess({ kind: 'text_visible', text: 'Savings Balance' }, "Read the member's savings balance of $1,234.56.");

    const result = recorder.build(baseMeta());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok build, got: ${JSON.stringify(result.issues)}`);
    expect(result.capability.success.description).toBe("Read the member's savings balance of {output.savingsBalance}.");
    expect(JSON.stringify(result.capability)).not.toContain('1,234.56');
  });
});

// ---------------------------------------------------------------------------------------------
// recordRecovery / recordOutcome
// ---------------------------------------------------------------------------------------------

describe('recordRecovery', () => {
  it('builds a dismiss rule from real observations (title separate from the body trigger text) and dedupes by name', async () => {
    const surface = createCuCoreSurface({ interstitial: true });
    await typeInto(surface, 'textbox', 'User ID', 'operator1');
    await typeInto(surface, 'textbox', 'Password', 'demo-pass-123');
    await clickOn(surface, 'button', 'login');

    // Real shape: the modal's own heading ("System Maintenance Notice") is a SEPARATE element
    // from its longer body copy -- see apps/mock-app/views/partials/interstitial.ejs.
    const titleEl = await findByName(surface, 'System Maintenance Notice');
    const bodyEl = await findByName(surface, 'Scheduled maintenance Sunday 02:00–04:00 ET. Some functions may be unavailable.');
    const okEl = await findByName(surface, 'OK');

    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    const rule1 = recorder.recordRecovery({
      triggerText: bodyEl.text ?? bodyEl.name,
      title: titleEl.text ?? titleEl.name,
      frame: [{ name: 'main' }],
      dismissTarget: okEl.descriptor,
      description: 'Dismiss the one-time maintenance notice.',
    });
    const rule2 = recorder.recordRecovery({
      triggerText: bodyEl.text ?? bodyEl.name,
      title: titleEl.text ?? titleEl.name,
      frame: [{ name: 'main' }],
      dismissTarget: okEl.descriptor,
      description: 'Dismiss again (should dedupe).',
    });

    expect(rule2).toBe(rule1);
    expect(recorder.recoveryRules).toHaveLength(1);
    expect(rule1.name).toMatch(/^dismiss_/);
    // Defect 3: named from the first 4 words of the TITLE, never the trigger/body text. The old
    // (still-buggy) behaviour named it off the trigger text, which for this exact notice is the
    // BODY -- producing "dismiss_scheduled_maintenance_sunday_02_00_04_00_et" in the real,
    // buggy artifact. The trigger condition itself still uses the body text (it's what's
    // actually distinctive/matchable on screen); only the NAME comes from the title.
    expect(rule1.name).toBe('dismiss_system_maintenance_notice');
    expect(rule1.trigger).toEqual({
      kind: 'text_visible',
      text: 'Scheduled maintenance Sunday 02:00–04:00 ET. Some functions may be unavailable.',
      frame: [{ name: 'main' }],
    });
    expect(rule1.actions).toHaveLength(2);
    expect(rule1.actions[0]!.type).toBe('click');
    expect(rule1.actions[1]).toMatchObject({
      type: 'wait',
      timeoutMs: 5000,
      condition: {
        kind: 'text_absent',
        text: 'Scheduled maintenance Sunday 02:00–04:00 ET. Some functions may be unavailable.',
        frame: [{ name: 'main' }],
      },
    });
    expect(rule1.maxAttempts).toBe(2);

    await surface.close();
  });
});

describe('recordRecovery: rule naming (Defect 3)', () => {
  it('names the rule from the first 4 words of the TITLE, snake_cased, dropping the 5th+ word -- NEVER from trigger_text', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    const rule = recorder.recordRecovery({
      // The trigger text is a long, unrelated body -- if naming ever fell back to deriving from
      // it (the old, still-buggy behaviour), the assertion below would fail.
      triggerText: 'Scheduled maintenance Sunday 02:00-04:00 ET. Some functions may be unavailable.',
      // 6 words; only the first 4 should survive into the name -- "and beyond" dropped.
      title: 'System notice today now and beyond',
      dismissTarget: DUMMY_TARGET,
      description: 'Dismiss the notice.',
    });
    expect(rule.name).toBe('dismiss_system_notice_today_now');
    expect(rule.name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/); // schema's Identifier: snake_case, not kebab-case
  });

  it('caps the name at 40 characters without truncating mid schema-invalid', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    const rule = recorder.recordRecovery({
      triggerText: 'Some unrelated body copy.',
      title: 'Extraordinarily lengthy notification headline wording',
      dismissTarget: DUMMY_TARGET,
      description: 'Dismiss the notice.',
    });
    expect(rule.name.length).toBeLessThanOrEqual(40);
    expect(rule.name).toMatch(/^dismiss_/);
    expect(rule.name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
  });

  it('falls back to dismiss_interstitial_<n> when there is no title at all (not derived from trigger_text)', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    // No `title` field at all -- the model reported the notice has no heading.
    const rule1 = recorder.recordRecovery({
      triggerText: 'Scheduled maintenance Sunday 02:00-04:00 ET. Some functions may be unavailable.',
      dismissTarget: DUMMY_TARGET,
      description: 'd1',
    });
    expect(rule1.name).toBe('dismiss_interstitial_1');

    // A second notice, ALSO with no usable title (here: title present but no word characters),
    // gets a distinct fallback name rather than colliding on "dismiss_interstitial_1" again.
    const rule2 = recorder.recordRecovery({
      triggerText: 'Some other notice body.',
      title: '\u{1F389}\u{1F389}\u{1F389}',
      dismissTarget: DUMMY_TARGET,
      description: 'd2',
    });
    expect(rule2.name).toBe('dismiss_interstitial_2');
    expect(recorder.recoveryRules).toHaveLength(2);
  });

  it('review fix: dedupes the SAME untitled notice by its trigger condition, not by the (call-unique) fallback name', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    // The fallback name increments every CALL, so if dedupe only checked names, recording the
    // same untitled notice twice would previously produce "dismiss_interstitial_1" then
    // "dismiss_interstitial_2" -- two rules for one notice.
    const rule1 = recorder.recordRecovery({
      triggerText: 'Scheduled maintenance Sunday 02:00-04:00 ET. Some functions may be unavailable.',
      frame: [{ name: 'main' }],
      dismissTarget: DUMMY_TARGET,
      description: 'First sighting.',
    });
    const rule2 = recorder.recordRecovery({
      triggerText: 'Scheduled maintenance Sunday 02:00-04:00 ET. Some functions may be unavailable.',
      frame: [{ name: 'main' }],
      dismissTarget: DUMMY_TARGET,
      description: 'Second sighting (should dedupe).',
    });
    expect(rule2).toBe(rule1);
    expect(recorder.recoveryRules).toHaveLength(1);
    expect(rule1.name).toBe('dismiss_interstitial_1');

    // A genuinely DIFFERENT untitled notice still gets its own rule, numbered next.
    const rule3 = recorder.recordRecovery({
      triggerText: 'A completely different notice.',
      frame: [{ name: 'main' }],
      dismissTarget: DUMMY_TARGET,
      description: 'Third, different notice.',
    });
    expect(rule3.name).toBe('dismiss_interstitial_2');
    expect(recorder.recoveryRules).toHaveLength(2);
  });
});

describe('recordOutcome', () => {
  it('sets afterSteps to the last recorded step id and replaces a same-name outcome', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    recorder.recordStep({ action: { type: 'click', target: DUMMY_TARGET }, why: 'Search for the member.', risk: 'read' });

    const outcome1 = recorder.recordOutcome({
      name: 'member_not_found',
      description: 'No member matches the searched memberId.',
      detectorText: 'No records found.',
      frame: [{ name: 'main' }],
      returns: [],
    });
    expect(outcome1.name).toBe('member_not_found');
    expect(outcome1.afterSteps).toEqual(['s01']);
    expect(outcome1.detector).toEqual({ kind: 'text_visible', text: 'No records found.', frame: [{ name: 'main' }] });

    const outcome2 = recorder.recordOutcome({
      name: 'member_not_found',
      description: 'Updated description.',
      detectorText: 'No records found.',
      returns: [],
    });
    expect(recorder.outcomes).toHaveLength(1);
    expect(recorder.outcomes[0]).toBe(outcome2);
    expect(recorder.outcomes[0]!.description).toBe('Updated description.');
  });

  it('sanitizes the outcome name to a valid identifier and types returns/extract from parse', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    const outcome = recorder.recordOutcome({
      name: 'Access Denied!',
      description: 'The role does not permit viewing this member.',
      detectorText: 'Access Denied',
      returns: [{ output: 'message', target: DUMMY_TARGET, parse: 'text', description: 'The denial message.' }],
    });
    expect(outcome.name).toBe('access_denied');
    expect(outcome.returns.message).toEqual({ type: 'string', description: 'The denial message.' });
    expect(outcome.extract).toHaveLength(1);
    expect(outcome.extract![0]!.output).toBe('message');
  });
});

// ---------------------------------------------------------------------------------------------
// build()
// ---------------------------------------------------------------------------------------------

describe('build()', () => {
  it('produces a capability that passes validateCapability, using real observed descriptors end to end', async () => {
    const surface = createCuCoreSurface({ interstitial: false });
    const recorder = createRecorder({
      baseUrl: BASE_URL,
      inputs: {
        memberId: { value: '12345', sensitive: false, description: 'The member id.', type: 'string' },
        unused: { value: 'zzz-never-used', sensitive: false, description: 'Never referenced.', type: 'string' },
      },
      outputsHint: { memberName: { type: 'string', description: 'The member display name.' } },
    });

    recorder.recordStep({ action: { type: 'navigate', url: `${BASE_URL}/login` }, why: 'Open the login page.', risk: 'read' });

    const userIdEl = await typeInto(surface, 'textbox', 'User ID', 'operator1');
    recorder.recordStep({
      action: { type: 'type', target: userIdEl.descriptor, value: { kind: 'secret', env: 'MOCK_USER' }, clear: true },
      why: 'Enter the user ID.',
      risk: 'read',
    });

    const passwordEl = await typeInto(surface, 'textbox', 'Password', 'demo-pass-123');
    recorder.recordStep({
      action: { type: 'type', target: passwordEl.descriptor, value: { kind: 'secret', env: 'MOCK_PASSWORD' }, clear: true },
      why: 'Enter the password.',
      risk: 'read',
    });

    const signOnEl = await clickOn(surface, 'button', 'login');
    recorder.recordStep({
      action: { type: 'click', target: signOnEl.descriptor },
      why: 'Sign on.',
      risk: 'read',
      postcondition: { kind: 'text_visible', text: 'Member ID', frame: [{ name: 'main' }] },
    });

    const memberIdEl = await typeInto(surface, 'textbox', 'Member ID', '12345');
    recorder.recordStep({
      action: { type: 'type', target: memberIdEl.descriptor, value: { kind: 'input', name: 'memberId' }, clear: true },
      why: 'Enter the member ID.',
      risk: 'read',
    });

    const searchEl = await clickOn(surface, 'clickable', 'Search');
    recorder.recordStep({
      action: { type: 'click', target: searchEl.descriptor },
      why: 'Search for the member.',
      risk: 'read',
      postcondition: { kind: 'text_visible', text: 'record(s) found', frame: [{ name: 'main' }] },
    });

    let obs = await surface.observe();
    const resultRowEl = obs.elements.find((e) => e.role === 'clickable' && e.name.startsWith('12345'));
    if (!resultRowEl) throw new Error('test setup: result row not found');
    await surface.act({ type: 'click', target: { ref: resultRowEl.ref } }, 5000);
    recorder.recordStep({
      action: { type: 'click', target: resultRowEl.descriptor },
      why: 'Open the matching result.',
      risk: 'read',
      postcondition: { kind: 'text_visible', text: 'Savings Balance', frame: [{ name: 'main' }] },
    });

    obs = await surface.observe();
    const memberNameEl = obs.elements.find((e) => e.name === 'Jane Q. Sample');
    const savingsEl = obs.elements.find((e) => e.name === '$1,234.56');
    if (!memberNameEl || !savingsEl) throw new Error('test setup: profile fields not found');

    recorder.recordStep({
      action: { type: 'extract', target: memberNameEl.descriptor, output: 'memberName', parse: 'text' },
      why: 'Read the member name.',
      risk: 'read',
    });
    recorder.recordOutput('memberName', 'text', 'Read the member name.');

    recorder.recordStep({
      action: { type: 'extract', target: savingsEl.descriptor, output: 'savingsBalance', parse: 'currency' },
      why: 'Read the savings balance.',
      risk: 'read',
    });
    recorder.recordOutput('savingsBalance', 'currency', 'Read the savings balance.');

    recorder.setSuccess(
      {
        kind: 'all',
        of: [
          { kind: 'text_visible', text: 'Savings Balance', frame: [{ name: 'main' }] },
          { kind: 'text_visible', text: 'Member Name', frame: [{ name: 'main' }] },
        ],
      },
      'The member profile is showing with the savings balance visible.',
    );

    const result = recorder.build(
      baseMeta({
        id: 'lookup-member-savings-balance',
        goal: 'Log in, look up member 12345 and read their current savings balance.',
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok build, got issues: ${JSON.stringify(result.issues)}`);

    const revalidated = validateCapability(result.capability);
    expect(revalidated.ok).toBe(true);

    // Unreferenced input dropped, with a warning.
    expect(result.capability.inputs.unused).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('unused'))).toBe(true);

    // All-digit value gets the digit pattern.
    expect(result.capability.inputs.memberId?.pattern).toBe('^\\d+$');
    // `example` is never filled from the run's own value: that value is real record data.
    expect(result.capability.inputs.memberId?.example).toBeUndefined();

    // riskLevel is the max over steps (all read here).
    expect(result.capability.riskLevel).toBe('read');

    // Outputs typed by parse.
    expect(result.capability.outputs.memberName).toEqual({ type: 'string', description: 'The member display name.' });
    expect(result.capability.outputs.savingsBalance?.type).toBe('number');

    // Business goal text canonicalized (memberId value replaced).
    expect(result.capability.description).toContain('{input.memberId}');
    expect(result.capability.description).not.toContain('12345');

    // app.entryUrl canonicalized.
    expect(result.capability.app.entryUrl).toBe('{baseUrl}/login');

    // The auth block: entry navigation through the sign-on click (the submit after the last
    // secret-bound step), proven by that click's own checkpoint. Not the member search.
    expect(result.capability.auth).toEqual({
      steps: ['s01', 's02', 's03', 's04'],
      signedIn: { kind: 'text_visible', text: 'Member ID', frame: [{ name: 'main' }] },
    });

    await surface.close();
  });

  it('records no auth block for a capability that binds no secret', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    recorder.recordStep({ action: { type: 'navigate', url: `${BASE_URL}/status` }, why: 'Open the status page.', risk: 'read' });
    recorder.recordStep({ action: { type: 'extract', target: DUMMY_TARGET, output: 'status', parse: 'text' }, why: 'Read the status.', risk: 'read' });
    recorder.recordOutput('status', 'text', 'Read the status.');
    recorder.setSuccess({ kind: 'text_visible', text: 'Status' }, 'Status shown.');
    const result = recorder.build(baseMeta({ entryUrl: `${BASE_URL}/status` }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.capability.auth).toBeUndefined();
  });

  it('returns ok:false with a schema issue when success was never set', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    recorder.recordStep({ action: { type: 'navigate', url: `${BASE_URL}/login` }, why: 'Open the login page.', risk: 'read' });
    const result = recorder.build(baseMeta());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.issues.some((i) => i.path.join('.') === 'success')).toBe(true);
  });

  it('repair pass: removes an output that is never produced by any step extract', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    recorder.recordStep({ action: { type: 'navigate', url: `${BASE_URL}/login` }, why: 'Open the login page.', risk: 'read' });
    recorder.recordOutput('ghost', 'text', 'never actually extracted by any step');
    recorder.setSuccess({ kind: 'text_visible', text: 'ok' }, 'done');

    const result = recorder.build(baseMeta());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok build, got: ${JSON.stringify(result.issues)}`);
    expect(result.capability.outputs.ghost).toBeUndefined();
    expect(result.repairs.some((r) => r.includes('ghost'))).toBe(true);
  });

  it('repair pass: declares an output produced by an extract step but never recordOutput-ed', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    recorder.recordStep({ action: { type: 'extract', target: DUMMY_TARGET, output: 'bonus', parse: 'number' }, why: 'Extract a bonus field.', risk: 'read' });
    recorder.setSuccess({ kind: 'text_visible', text: 'ok' }, 'done');

    const result = recorder.build(baseMeta());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok build, got: ${JSON.stringify(result.issues)}`);
    expect(result.capability.outputs.bonus).toEqual({ type: 'string', description: 'Extracted value bonus' });
    expect(result.repairs.some((r) => r.includes('bonus'))).toBe(true);
  });

  it('an output declared only via outputsHint but never recorded is not added', () => {
    const recorder = createRecorder({
      baseUrl: BASE_URL,
      inputs: {},
      outputsHint: { extra: { type: 'string', description: 'hint only, never produced' } },
    });
    recorder.recordStep({ action: { type: 'navigate', url: `${BASE_URL}/login` }, why: 'Open the login page.', risk: 'read' });
    recorder.setSuccess({ kind: 'text_visible', text: 'ok' }, 'done');

    const result = recorder.build(baseMeta());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok build, got: ${JSON.stringify(result.issues)}`);
    expect(result.capability.outputs.extra).toBeUndefined();
    expect(result.repairs).toHaveLength(0);
  });

  it('riskLevel reflects the max risk over steps', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    recorder.recordStep({ action: { type: 'navigate', url: `${BASE_URL}/login` }, why: 'Open the login page.', risk: 'read' });
    recorder.recordStep({ action: { type: 'click', target: DUMMY_TARGET }, why: 'Submit the transfer.', risk: 'irreversible', onFailure: 'escalate' });
    recorder.setSuccess({ kind: 'text_visible', text: 'ok' }, 'done');
    const result = recorder.build(baseMeta());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok build');
    expect(result.capability.riskLevel).toBe('irreversible');
    expect(result.capability.steps[1]!.onFailure).toBe('escalate');
  });

  it('fails closed when a forbidden secret value would be persisted in a literal', () => {
    const recorder = createRecorder({
      baseUrl: BASE_URL,
      inputs: {},
      forbiddenValues: ['demo-pass-123'],
    });
    recorder.recordStep({ action: { type: 'navigate', url: `${BASE_URL}/login` }, why: 'Open the login page.', risk: 'read' });
    recorder.recordStep({
      action: { type: 'type', target: DUMMY_TARGET, value: { kind: 'literal', value: 'demo-pass-123' } },
      why: 'Enter the password (recorded incorrectly as a literal).',
      risk: 'read',
    });
    recorder.setSuccess({ kind: 'text_visible', text: 'ok' }, 'done');

    const result = recorder.build(baseMeta());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.issues.some((i) => i.message.includes('secret or sensitive'))).toBe(true);
    expect(JSON.stringify(result.draft)).not.toContain('demo-pass-123');
  });

  it('fails closed when a sensitive input value would survive canonicalization somehow', () => {
    // A pathological case where the value is embedded via a condition that canonicalization
    // does not reach (a css selector is canonicalized, but this checks the fail-closed backstop
    // regardless of *why* a value might have survived).
    const recorder = createRecorder({
      baseUrl: BASE_URL,
      inputs: { pin: { value: '4471', sensitive: true, description: 'PIN', type: 'string' } },
    });
    recorder.recordStep({ action: { type: 'navigate', url: `${BASE_URL}/login` }, why: 'Open the login page.', risk: 'read' });
    recorder.addNote('Operator confirmed PIN 4471 out of band.'); // canonicalized note; should not leak
    recorder.setSuccess({ kind: 'text_visible', text: 'ok' }, 'done');
    const result = recorder.build(baseMeta());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok build');
    expect(JSON.stringify(result.capability)).not.toContain('4471');
  });
});

// ---------------------------------------------------------------------------------------------
// kebabFromGoal / shortStepName / toIdentifier / findLeaks
// ---------------------------------------------------------------------------------------------

describe('kebabFromGoal', () => {
  it('drops input values, lowercases, kebab-cases, and caps at 6 words', () => {
    expect(kebabFromGoal('Look up member 12345 and read their current savings balance please', ['12345'])).toBe(
      'look-up-member-read-savings-balance',
    );
  });

  it('drops existing placeholders', () => {
    expect(kebabFromGoal('Look up member {input.memberId} savings balance')).toBe('look-up-member-savings-balance');
  });

  it('falls back to discovered-capability when nothing usable remains', () => {
    expect(kebabFromGoal('12345', ['12345'])).toBe('discovered-capability');
    expect(kebabFromGoal('')).toBe('discovered-capability');
  });
});

describe('shortStepName', () => {
  it('takes the first clause, capitalizes it, and caps at 60 chars', () => {
    expect(shortStepName('enter the member ID. then click search.')).toBe('Enter the member ID');
    expect(shortStepName('   ')).toBe('Step');
    expect(shortStepName('x'.repeat(100))).toHaveLength(60);
  });
});

describe('toIdentifier', () => {
  it('produces a valid snake_case identifier', () => {
    expect(toIdentifier('member_not_found')).toBe('member_not_found');
    expect(toIdentifier('Access Denied!')).toBe('access_denied');
    expect(toIdentifier('memberNotFound')).toBe('member_not_found');
    expect(toIdentifier('123abc')).toBe('_123abc');
    expect(toIdentifier('')).toBe('x');
  });
});

describe('findLeaks', () => {
  it('finds string leaves containing a forbidden value and skips empty forbidden entries', () => {
    const value = { a: 'contains SECRET here', b: { c: ['no match', 'also SECRET'] }, d: 42 };
    const hits = findLeaks(value, ['SECRET', '']);
    expect(hits.sort()).toEqual(['/a', '/b/c/1'].sort());
  });

  it('returns no hits when forbidden is empty or nothing matches', () => {
    expect(findLeaks({ a: 'clean' }, [])).toEqual([]);
    expect(findLeaks({ a: 'clean' }, ['nope'])).toEqual([]);
  });
});

it('condition canonicalization does not touch a url_matches regex pattern', () => {
  const recorder = createRecorder({
    baseUrl: BASE_URL,
    inputs: { memberId: { value: '12345', sensitive: false, description: 'd', type: 'string' } },
  });
  const cond: Condition = { kind: 'url_matches', pattern: '/members/12345$' };
  expect(recorder.canonicalizeCondition(cond)).toEqual({ kind: 'url_matches', pattern: '/members/12345$' });
});

it('condition canonicalization recurses through all/any/not and canonicalizes text', () => {
  const recorder = createRecorder({
    baseUrl: BASE_URL,
    inputs: { memberId: { value: '12345', sensitive: false, description: 'd', type: 'string' } },
  });
  const cond: Condition = {
    kind: 'all',
    of: [
      { kind: 'text_visible', text: 'member 12345 found' },
      { kind: 'not', of: { kind: 'text_absent', text: 'still 12345' } },
    ],
  };
  const out = recorder.canonicalizeCondition(cond);
  expect(out).toEqual({
    kind: 'all',
    of: [
      { kind: 'text_visible', text: 'member {input.memberId} found' },
      { kind: 'not', of: { kind: 'text_absent', text: 'still {input.memberId}' } },
    ],
  });
});

describe('recordRecovery: same notice, different dismiss control', () => {
  const OTHER_TARGET: TargetDescriptor = {
    description: 'The Close button',
    frame: [],
    locators: [{ strategy: { kind: 'role', role: 'button', name: 'Close' }, confidence: 0.9, source: 'recorded' }],
  };

  it('replaces a titled rule, keeping its name and position, when the dismiss target differs', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    const first = recorder.recordRecovery({ triggerText: 'Body', title: 'System Notice', dismissTarget: DUMMY_TARGET, description: 'first' });
    recorder.recordRecovery({ triggerText: 'Other body', title: 'Other Notice', dismissTarget: DUMMY_TARGET, description: 'other' });
    const second = recorder.recordRecovery({ triggerText: 'Body', title: 'System Notice', dismissTarget: OTHER_TARGET, description: 'second' });

    expect(second).not.toBe(first);
    expect(second.name).toBe(first.name);
    expect(recorder.recoveryRules).toHaveLength(2);
    expect(recorder.recoveryRules[0]).toBe(second);
    expect(second.actions[0]).toMatchObject({ type: 'click', target: { description: 'The Close button' } });
  });

  it('replaces an untitled rule matched by its trigger when the dismiss target differs', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    const first = recorder.recordRecovery({ triggerText: 'Body', dismissTarget: DUMMY_TARGET, description: 'first' });
    const second = recorder.recordRecovery({ triggerText: 'Body', dismissTarget: OTHER_TARGET, description: 'second' });
    expect(second.name).toBe(first.name);
    expect(recorder.recoveryRules).toEqual([second]);
  });

  it('keeps the existing rule when the dismiss target is the same', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    const first = recorder.recordRecovery({ triggerText: 'Body', title: 'System Notice', dismissTarget: DUMMY_TARGET, description: 'first' });
    const again = recorder.recordRecovery({ triggerText: 'Body', title: 'System Notice', dismissTarget: structuredClone(DUMMY_TARGET), description: 'again' });
    expect(again).toBe(first);
    expect(again.description).toBe('first');
  });
});

describe('extracted-value registry', () => {
  function balanceTarget(): TargetDescriptor {
    return {
      description: 'cell right of "Status"',
      frame: [],
      locators: [{ strategy: { kind: 'relative', relation: 'right-of', anchor: { text: 'Status' } }, confidence: 0.8, source: 'inferred' }],
    };
  }

  it('keeps one value per output name: a re-extract replaces the earlier value', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    expect(recorder.sanitizeExtractedTarget(balanceTarget(), 'memberStatus', 'Pending').ok).toBe(true);
    expect(recorder.sanitizeExtractedTarget(balanceTarget(), 'memberStatus', 'Active').ok).toBe(true);
    expect(recorder.sanitizeExtractedTarget(balanceTarget(), 'memberName', 'Jane Q. Sample').ok).toBe(true);
    expect(recorder.extractedValues).toEqual([
      { name: 'memberStatus', value: 'Active' },
      { name: 'memberName', value: 'Jane Q. Sample' },
    ]);
  });

  it('does not register a value equal to or contained in the outcome detector text, and keeps its target as is', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    const message = 'Access Denied: your role does not permit viewing this member.';
    const msgTarget: TargetDescriptor = {
      description: 'text "Access Denied"',
      frame: [],
      locators: [{ strategy: { kind: 'text', text: message }, confidence: 0.7, source: 'inferred' }],
    };
    expect(recorder.sanitizeExtractedTarget(msgTarget, 'denial', `  ${message} `, message)).toEqual({ ok: true, target: msgTarget });
    expect(recorder.sanitizeExtractedTarget(balanceTarget(), 'denialTitle', 'access denied', message).ok).toBe(true);
    expect(recorder.sanitizeExtractedTarget(balanceTarget(), 'memberName', 'Jane Q. Sample', message).ok).toBe(true);
    expect(recorder.extractedValues).toEqual([{ name: 'memberName', value: 'Jane Q. Sample' }]);

    recorder.recordOutcome({ name: 'access_denied', description: 'Denied.', detectorText: message, returns: [{ output: 'denial', target: msgTarget, parse: 'text', description: 'The message.' }] });
    recorder.recordStep({ action: { type: 'navigate', url: `${BASE_URL}/members` }, why: 'Open members.', risk: 'read' });
    recorder.setSuccess({ kind: 'text_visible', text: 'Members' }, 'Done.');
    const built = recorder.build(baseMeta());
    if (!built.ok) throw new Error(`expected ok build, got: ${JSON.stringify(built.issues)}`);
    expect(built.capability.businessOutcomes[0]!.detector).toEqual({ kind: 'text_visible', text: message });
  });

  it('scrubs extracted values out of outcome and recovery-rule names and notes, so the build passes the leak check', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    recorder.recordRecovery({
      triggerText: 'Please read this alert',
      title: 'Alert Sample',
      dismissTarget: DUMMY_TARGET,
      description: 'Dismiss the alert.',
    });
    const sanitizedName = recorder.sanitizeExtractedTarget(balanceTarget(), 'memberName', 'Sample');
    const sanitizedAcct = recorder.sanitizeExtractedTarget(balanceTarget(), 'accountNumber', '98765');
    if (!sanitizedName.ok || !sanitizedAcct.ok) throw new Error('expected ok');
    recorder.recordStep({ action: { type: 'extract', target: sanitizedAcct.target, output: 'accountNumber', parse: 'text' }, why: 'Read the account.', risk: 'read' });
    recorder.recordOutput('accountNumber', 'text', 'Read the account.');
    recorder.recordOutcome({ name: 'overdrawn_98765', description: 'Overdrawn.', detectorText: 'Overdrawn', returns: [] });
    recorder.recordOutcome({ name: 'overdrawn_account_number', description: 'Overdrawn again.', detectorText: 'Overdrawn!', returns: [] });
    recorder.addNote('Balance for 98765 looked odd.');
    recorder.setSuccess({ kind: 'text_visible', text: 'Account' }, 'Done.');

    const built = recorder.build(baseMeta());
    if (!built.ok) throw new Error(`expected ok build, got: ${JSON.stringify(built.issues)}`);
    expect(built.capability.recoveryRules.map((r) => r.name)).toEqual(['dismiss_alert_member_name']);
    expect(built.capability.businessOutcomes.map((o) => o.name)).toEqual(['overdrawn_account_number_2', 'overdrawn_account_number']);
    expect(built.capability.provenance.notes).toBe('Balance for {output.accountNumber} looked odd.');
  });

  it('a corrected re-extract no longer fails the build over the earlier, wrong value', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    recorder.sanitizeExtractedTarget(balanceTarget(), 'memberStatus', 'Savings');
    const sanitized = recorder.sanitizeExtractedTarget(balanceTarget(), 'memberStatus', 'Active');
    if (!sanitized.ok) throw new Error('expected ok');
    recorder.recordStep({ action: { type: 'extract', target: sanitized.target, output: 'memberStatus', parse: 'text' }, why: 'Read the status.', risk: 'read' });
    recorder.recordOutput('memberStatus', 'text', 'Read the status.');
    // Functional match text naming "Savings" (the earlier, wrong extract) and "Inactive" (which
    // contains the corrected value only inside a longer word).
    recorder.setSuccess({ kind: 'text_visible', text: 'Savings Balance' }, 'The status is shown, never Inactive.');

    const built = recorder.build(baseMeta({ id: 'lookup-member-savings-status' }));
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(`expected ok build, got: ${JSON.stringify(built.issues)}`);
    expect(built.capability.success.condition).toEqual({ kind: 'text_visible', text: 'Savings Balance' });
  });
});

// ---------------------------------------------------------------------------------------------
// noteLocation: input-bound URL checkpoints
// ---------------------------------------------------------------------------------------------

describe('noteLocation: input-bound URL checkpoints', () => {
  const MAIN = [{ name: 'main' }];
  const MEMBER_INPUTS = { memberId: { value: '12345', sensitive: false, description: 'Member ID', type: 'string' as const } };
  const ROW_TARGET: TargetDescriptor = {
    description: 'clickable "12345 Jane Q. Sample" (<tr>)',
    frame: MAIN,
    locators: [
      { strategy: { kind: 'text', text: '12345 Jane Q. Sample', tag: 'tr' }, confidence: 0.7, source: 'inferred' },
      { strategy: { kind: 'css', selector: 'td > table > tbody > tr:nth-of-type(2)' }, confidence: 0.3, source: 'inferred' },
    ],
  };
  const MEMBER_URL_CHECK: Condition = { kind: 'url_matches', pattern: '/members/{input.memberId}(?![A-Za-z0-9])', frame: MAIN };

  function at(mainUrl: string, topUrl = `${BASE_URL}/workstation`) {
    return { url: topUrl, frames: [{ path: MAIN, url: mainUrl }] };
  }

  it('binds the row click that lands on /members/12345 to {input.memberId}, in its frame, and adds it to success', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: MEMBER_INPUTS });
    recorder.noteLocation(at(`${BASE_URL}/members/search`));
    recorder.recordStep({
      action: { type: 'click', target: ROW_TARGET },
      why: 'Open the member record',
      risk: 'read',
      postcondition: { kind: 'text_visible', text: 'Savings', frame: MAIN },
    });
    recorder.noteLocation(at(`${BASE_URL}/members/12345`));
    recorder.setSuccess({ kind: 'text_visible', text: 'Savings Balance', frame: MAIN }, 'Opened member 12345.');

    const built = recorder.build(baseMeta({ id: 'lookup-member' }));
    if (!built.ok) throw new Error(`expected ok build, got: ${JSON.stringify(built.issues)}`);
    const cap = built.capability;
    expect(cap.steps[0]!.postcondition).toEqual({ kind: 'all', of: [{ kind: 'text_visible', text: 'Savings', frame: MAIN }, MEMBER_URL_CHECK] });
    expect(cap.success.condition).toEqual({ kind: 'all', of: [{ kind: 'text_visible', text: 'Savings Balance', frame: MAIN }, MEMBER_URL_CHECK] });
    expect(JSON.stringify(cap)).not.toContain('12345');
    expect(built.warnings).toEqual([]);
    const validated = validateCapability(cap);
    expect(validated.ok && validated.warnings).toEqual([]);
  });

  it('a step with no postcondition of its own gets the bare URL check; a step that leaves the URL unchanged gets none', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: MEMBER_INPUTS });
    recorder.noteLocation(at(`${BASE_URL}/members/search`));
    recorder.recordStep({ action: { type: 'click', target: ROW_TARGET }, why: 'Open the member record', risk: 'read' });
    recorder.noteLocation(at(`${BASE_URL}/members/12345?tab=profile`));
    recorder.recordStep({ action: { type: 'extract', target: { ...DUMMY_TARGET, frame: MAIN }, output: 'savingsBalance', parse: 'currency' }, why: 'Read it', risk: 'read' });
    recorder.noteLocation(at(`${BASE_URL}/members/12345?tab=profile`));
    expect(recorder.steps[0]!.postcondition).toEqual(MEMBER_URL_CHECK);
    expect(recorder.steps[1]!.postcondition).toBeUndefined();
  });

  it('pins a query parameter carrying the value, independent of parameter order', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: MEMBER_INPUTS });
    recorder.noteLocation(at(`${BASE_URL}/members/search`));
    recorder.recordStep({ action: { type: 'click', target: { ...DUMMY_TARGET, frame: MAIN } }, why: 'Search', risk: 'read' });
    recorder.noteLocation(at(`${BASE_URL}/members/search?memberId=12345&lastName=`));
    expect(recorder.steps[0]!.postcondition).toEqual({ kind: 'url_matches', pattern: '[?&]memberId={input.memberId}(?![A-Za-z0-9])', frame: MAIN });
  });

  it('checks the top document for a navigate step and canonicalizes its url', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: MEMBER_INPUTS });
    recorder.recordStep({ action: { type: 'navigate', url: `${BASE_URL}/members/12345` }, why: 'Open the member page', risk: 'read' });
    recorder.noteLocation({ url: `${BASE_URL}/members/12345`, frames: [] });
    expect(recorder.steps[0]!.action).toEqual({ type: 'navigate', url: '{baseUrl}/members/{input.memberId}' });
    expect(recorder.steps[0]!.postcondition).toEqual({ kind: 'url_matches', pattern: '/members/{input.memberId}(?![A-Za-z0-9])' });
  });

  function landingCheck(url: string, inputs: Parameters<typeof createRecorder>[0]['inputs'] = MEMBER_INPUTS): Condition | undefined {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs });
    recorder.noteLocation({ url: `${BASE_URL}/start`, frames: [] });
    recorder.recordStep({ action: { type: 'click', target: DUMMY_TARGET }, why: 'Open', risk: 'read' });
    recorder.noteLocation({ url, frames: [] });
    return recorder.steps[0]!.postcondition;
  }

  it('pins only the placeholder segment and the literal segment before it, not a record-specific prefix', () => {
    const check = landingCheck(`${BASE_URL}/branch/004/members/12345`);
    expect(check).toEqual({ kind: 'url_matches', pattern: '/members/{input.memberId}(?![A-Za-z0-9])' });
    const bound = bindCondition(check!, { baseUrl: BASE_URL, inputs: { memberId: '67890' } }) as Extract<Condition, { kind: 'url_matches' }>;
    expect(new RegExp(bound.pattern).test(`${BASE_URL}/branch/017/members/67890`)).toBe(true);
    expect(new RegExp(bound.pattern).test(`${BASE_URL}/branch/017/members/678901`)).toBe(false);
  });

  it('does not pin an ASP.NET cookieless session segment', () => {
    expect(landingCheck(`${BASE_URL}/(S(abc123xyz))/members/12345`)).toEqual({ kind: 'url_matches', pattern: '/members/{input.memberId}(?![A-Za-z0-9])' });
    expect(landingCheck(`${BASE_URL}/(S(abc123xyz))/12345/profile`)).toEqual({ kind: 'url_matches', pattern: '/{input.memberId}(?![A-Za-z0-9])' });
  });

  it('pins a first-segment placeholder on its own, and each placeholder segment separately', () => {
    expect(landingCheck(`${BASE_URL}/12345/profile`)).toEqual({ kind: 'url_matches', pattern: '/{input.memberId}(?![A-Za-z0-9])' });
    const two = landingCheck(`${BASE_URL}/org/7/members/12345/accounts/99887?view=full`, {
      ...MEMBER_INPUTS,
      accountId: { value: '99887', sensitive: false, description: 'Account', type: 'string' },
    });
    expect(two).toEqual({
      kind: 'all',
      of: [
        { kind: 'url_matches', pattern: '/members/{input.memberId}(?![A-Za-z0-9])' },
        { kind: 'url_matches', pattern: '/accounts/{input.accountId}(?![A-Za-z0-9])' },
      ],
    });
  });

  it('keeps the query-parameter and fragment checks alongside a path check', () => {
    expect(landingCheck(`${BASE_URL}/x/members/12345?ref=12345#m-12345`)).toEqual({
      kind: 'all',
      of: [
        { kind: 'url_matches', pattern: '/members/{input.memberId}(?![A-Za-z0-9])' },
        { kind: 'url_matches', pattern: '[?&]ref={input.memberId}(?![A-Za-z0-9])' },
        { kind: 'url_matches', pattern: '#m-{input.memberId}(?![A-Za-z0-9])' },
      ],
    });
  });

  it('only binds a whole-token match: 1234 is not found inside /members/12345', () => {
    const recorder = createRecorder({
      baseUrl: BASE_URL,
      inputs: { memberId: { value: '1234', sensitive: false, description: 'Member ID', type: 'string' } },
    });
    recorder.noteLocation(at(`${BASE_URL}/members/search`));
    recorder.recordStep({ action: { type: 'click', target: { ...DUMMY_TARGET, frame: MAIN } }, why: 'Open', risk: 'read' });
    recorder.noteLocation(at(`${BASE_URL}/members/12345`));
    recorder.setSuccess({ kind: 'text_visible', text: 'Savings Balance', frame: MAIN }, 'Done.');
    expect(recorder.steps[0]!.postcondition).toBeUndefined();
    const built = recorder.build(baseMeta());
    if (!built.ok) throw new Error(`expected ok build, got: ${JSON.stringify(built.issues)}`);
    expect(built.capability.success.condition).toEqual({ kind: 'text_visible', text: 'Savings Balance', frame: MAIN });
  });
});
