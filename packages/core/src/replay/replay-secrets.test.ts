/** No bound secret or sensitive value ever reaches evidence. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCuCoreSurface } from '../surface/fake-scenarios/cu-core.js';
import { validateCapability, type TargetDescriptor } from '../schema/index.js';
import { MOCK_PASSWORD, MOCK_USER, loadExample, makeFakeClock, runReplay } from './test-helpers.js';

function assertNowhere(needle: string, ...haystacks: string[]): void {
  for (const h of haystacks) expect(h).not.toContain(needle);
}

describe('replay: secrets never reach evidence', () => {
  it('a successful run never writes the bound secret or username, and marks the login steps valueRedacted', async () => {
    const { events, runDir } = await runReplay();

    const rawEvents = readFileSync(path.join(runDir, 'events.jsonl'), 'utf8');
    const rawResult = readFileSync(path.join(runDir, 'result.json'), 'utf8');
    assertNowhere(MOCK_PASSWORD, rawEvents, rawResult);
    assertNowhere(MOCK_USER, rawEvents, rawResult);

    const s02 = events.find((e) => e.kind === 'action' && e.stepId === 's02');
    const s03 = events.find((e) => e.kind === 'action' && e.stepId === 's03');
    expect(s02?.data.valueRedacted).toBe(true);
    expect(s03?.data.valueRedacted).toBe(true);
  });

  it('a failure that captures a DOM snapshot of the still-filled-in login form never writes the secret or username', async () => {
    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    // Hides the sign-on button so element_not_found fires at s04, WHILE STILL ON THE LOGIN
    // SCREEN -- the DOM snapshot captured for evidence reflects that screen's elements, including
    // the (non-password) userId field's typed value, exactly the leak the scrubber must catch.
    surface.inject({ kind: 'hide_element', elementId: 'signOn' });

    const { result, runDir } = await runReplay({ surface, clock });

    expect(result.kind).toBe('hard_failure');
    if (result.kind === 'hard_failure') {
      expect(result.code).toBe('element_not_found');
      expect(result.evidence.dom).toBeDefined();
    }

    const domDir = path.join(runDir, 'dom');
    expect(existsSync(domDir)).toBe(true);
    const domFiles = readdirSync(domDir);
    expect(domFiles.length).toBeGreaterThan(0);
    for (const f of domFiles) {
      const html = readFileSync(path.join(domDir, f), 'utf8');
      assertNowhere(MOCK_PASSWORD, html);
      assertNowhere(MOCK_USER, html);
    }

    const rawEvents = readFileSync(path.join(runDir, 'events.jsonl'), 'utf8');
    const rawResult = readFileSync(path.join(runDir, 'result.json'), 'utf8');
    assertNowhere(MOCK_PASSWORD, rawEvents, rawResult);
    assertNowhere(MOCK_USER, rawEvents, rawResult);
  });

  it('a sensitive input value never reaches events, result.json or any DOM snapshot', async () => {
    // Clone the example and add a sensitive 'pin' input, bound into a step that types it into the
    // (unused-by-the-happy-path) Last Name field -- so it lands in the surface's raw values store
    // and, without the scrubber, would show up verbatim in a DOM snapshot.
    const cap = structuredClone(loadExample());
    cap.inputs.pin = { type: 'string', description: 'A PIN, sensitive test input.', required: true, sensitive: true, pattern: '^[0-9]{4,6}$' };
    const lastNameTarget: TargetDescriptor = {
      description: 'Last Name field on the member search form (test-only use).',
      frame: [{ name: 'main' }],
      locators: [{ strategy: { kind: 'label', label: 'Last Name' }, confidence: 0.8, source: 'recorded' }],
    };
    const s05Index = cap.steps.findIndex((s) => s.id === 's05');
    cap.steps.splice(s05Index + 1, 0, {
      id: 'sPin',
      name: 'Enter pin (test only, proves sensitive-input redaction)',
      risk: 'read',
      action: { type: 'type', target: lastNameTarget, value: { kind: 'input', name: 'pin' }, clear: true },
    });
    const validated = validateCapability(cap);
    if (!validated.ok) throw new Error(JSON.stringify(validated.issues));

    const clock = makeFakeClock();
    const surface = createCuCoreSurface({ clock });
    // Force a failure (with a DOM snapshot) after the pin has been typed, while it is still on
    // screen (the search step's target is hidden).
    surface.inject({ kind: 'hide_element', elementId: 'search' });

    const PIN = '773311';
    const { result, events, resultJson, runDir } = await runReplay({
      capability: validated.capability,
      inputs: { memberId: '12345', pin: PIN },
      surface,
      clock,
    });

    expect(result.kind).toBe('hard_failure');

    assertNowhere(PIN, JSON.stringify(events), JSON.stringify(resultJson));
    const domDir = path.join(runDir, 'dom');
    if (existsSync(domDir)) {
      for (const f of readdirSync(domDir)) {
        assertNowhere(PIN, readFileSync(path.join(domDir, f), 'utf8'));
      }
    }
  });
});
