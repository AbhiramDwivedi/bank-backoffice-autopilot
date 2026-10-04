import { describe, expect, it } from 'vitest';
import { REDACTED_VALUE } from '../schema/index.js';
import type { ObservedElement } from '../surface/types.js';
import { buildTurnContent, formatElementLine, systemPrompt, type TurnState } from './prompt.js';

function makeElement(overrides: Partial<ObservedElement> = {}): ObservedElement {
  return {
    ref: 'e1',
    role: 'textbox',
    name: 'Search Value',
    tag: 'input',
    bbox: { x: 0, y: 0, w: 10, h: 10 },
    frame: [],
    enabled: true,
    descriptor: { description: 'x', frame: [], locators: [{ strategy: { kind: 'css', selector: '#x' }, confidence: 0.3, source: 'inferred' }] },
    ...overrides,
  };
}

function baseState(overrides: Partial<TurnState> = {}): TurnState {
  return {
    goal: 'Look something up.',
    inputs: {},
    secretEnvNames: ['MOCK_USER', 'MOCK_PASSWORD'],
    extractedOutputs: new Set(),
    stepsUsed: 0,
    maxSteps: 40,
    history: [],
    observation: { url: 'http://localhost:4173/x', title: 'X', frames: [], elements: [], textDigest: '' },
    ...overrides,
  };
}

describe('formatElementLine', () => {
  it('formats ref, role, name and frame', () => {
    const line = formatElementLine(makeElement({ frame: [{ name: 'main' }] }));
    expect(line).toBe('[e1] textbox "Search Value" (frame: main)');
  });

  it('uses "top" for the empty frame path', () => {
    const line = formatElementLine(makeElement({ frame: [] }));
    expect(line).toContain('(frame: top)');
  });

  it('joins multiple frame hops with ">"', () => {
    const line = formatElementLine(makeElement({ frame: [{ name: 'shell' }, { name: 'main' }] }));
    expect(line).toContain('(frame: shell>main)');
  });

  it('includes text when it differs from name', () => {
    const line = formatElementLine(makeElement({ name: 'Search', text: 'Search now' }));
    expect(line).toContain('text="Search now"');
  });

  it('omits text when it equals name', () => {
    const line = formatElementLine(makeElement({ name: 'Search', text: 'Search' }));
    expect(line).not.toContain('text=');
  });

  it('flags disabled elements', () => {
    const line = formatElementLine(makeElement({ enabled: false }));
    expect(line).toContain('disabled');
  });

  it('does not flag enabled elements', () => {
    const line = formatElementLine(makeElement({ enabled: true }));
    expect(line).not.toContain('disabled');
  });

  it('includes value when present and not redacted', () => {
    const line = formatElementLine(makeElement({ value: '12345' }));
    expect(line).toContain('value="12345"');
  });

  it('omits value entirely when it is REDACTED (password fields)', () => {
    const line = formatElementLine(makeElement({ role: 'textbox', name: 'Password', value: REDACTED_VALUE }));
    expect(line).not.toContain('value=');
    expect(line).not.toContain(REDACTED_VALUE);
  });

  it('omits value when undefined', () => {
    const line = formatElementLine(makeElement({ value: undefined }));
    expect(line).not.toContain('value=');
  });
});

describe('buildTurnContent', () => {
  it('puts an image block first when a screenshot is provided', () => {
    const blocks = buildTurnContent(baseState({ screenshotPng: Buffer.from([1, 2, 3]) }));
    expect(blocks[0]?.type).toBe('image');
    expect(blocks[1]?.type).toBe('text');
  });

  it('attaches evidencePath to the image block when given', () => {
    const blocks = buildTurnContent(baseState({ screenshotPng: Buffer.from([1, 2, 3]), evidencePath: 'shots/3.png' }));
    const img = blocks[0];
    expect(img?.type).toBe('image');
    if (img?.type === 'image') expect(img.evidencePath).toBe('shots/3.png');
  });

  it('omits the image and notes it when no screenshot is provided', () => {
    const blocks = buildTurnContent(baseState());
    expect(blocks[0]).toEqual({ type: 'text', text: 'screenshot omitted' });
  });

  it('omits the image and notes it when the screenshot exceeds the size cap', () => {
    const big = Buffer.alloc(4 * 1024 * 1024);
    const blocks = buildTurnContent(baseState({ screenshotPng: big }));
    expect(blocks[0]).toEqual({ type: 'text', text: 'screenshot omitted' });
  });

  it('shows a sensitive input as <sensitive>, never its value', () => {
    const blocks = buildTurnContent(
      baseState({
        inputs: { ssn: { value: '123-45-6789', sensitive: true, description: 'Member SSN', type: 'string' } },
      }),
    );
    const text = blocks.find((b) => b.type === 'text' && b.text.includes('INPUTS'));
    expect(text?.type).toBe('text');
    if (text?.type === 'text') {
      expect(text.text).toContain('ssn (string, sensitive): Member SSN = <sensitive>');
      expect(text.text).not.toContain('123-45-6789');
    }
  });

  it('shows a non-sensitive input value', () => {
    const blocks = buildTurnContent(
      baseState({
        inputs: { memberId: { value: '12345', sensitive: false, description: 'Account holder id', type: 'string' } },
      }),
    );
    const text = blocks.at(-1);
    if (text?.type === 'text') expect(text.text).toContain('memberId (string): Account holder id = 12345');
  });

  it('lists declared outputs and marks which are already extracted', () => {
    const blocks = buildTurnContent(
      baseState({
        outputs: { balance: { type: 'number', description: 'The balance' } },
        extractedOutputs: new Set(['balance']),
      }),
    );
    const text = blocks.at(-1);
    if (text?.type === 'text') expect(text.text).toContain('balance (number): The balance [already extracted]');
  });

  it('shows progress as steps used N/max', () => {
    const blocks = buildTurnContent(baseState({ stepsUsed: 3, maxSteps: 40 }));
    const text = blocks.at(-1);
    if (text?.type === 'text') expect(text.text).toContain('steps used 3/40');
  });

  it('formats history lines with expect status', () => {
    const blocks = buildTurnContent(
      baseState({
        history: [
          { stepId: 's01', tool: 'navigate', why: 'Open the entry page', expectMet: undefined },
          { stepId: 's02', tool: 'type', why: 'Enter the search value', expectMet: true },
          { stepId: 's03', tool: 'click', why: 'Submit the search', expectMet: false },
        ],
      }),
    );
    const text = blocks.at(-1);
    if (text?.type === 'text') {
      expect(text.text).toContain('s01 navigate "Open the entry page" (no expectation)');
      expect(text.text).toContain('s02 type "Enter the search value" (expect met)');
      expect(text.text).toContain('s03 click "Submit the search" (expectation not met)');
    }
  });

  it('shows the last result feedback, or a first-turn note', () => {
    const first = buildTurnContent(baseState());
    const firstText = first.at(-1);
    if (firstText?.type === 'text') expect(firstText.text).toContain('this is the first turn');

    const withFeedback = buildTurnContent(baseState({ lastResult: 'Refused by policy: irreversible action.' }));
    const feedbackText = withFeedback.at(-1);
    if (feedbackText?.type === 'text') expect(feedbackText.text).toContain('Refused by policy: irreversible action.');
  });

  it('truncates a long text digest at ~3000 chars', () => {
    const long = 'x'.repeat(5000);
    const blocks = buildTurnContent(baseState({ observation: { url: 'u', title: 't', frames: [], elements: [], textDigest: long } }));
    const text = blocks.at(-1);
    if (text?.type === 'text') {
      expect(text.text).toContain('…(truncated)');
      expect(text.text.length).toBeLessThan(long.length);
    }
  });

  it('does not truncate a short text digest', () => {
    const short = 'hello world';
    const blocks = buildTurnContent(baseState({ observation: { url: 'u', title: 't', frames: [], elements: [], textDigest: short } }));
    const text = blocks.at(-1);
    if (text?.type === 'text') {
      expect(text.text).toContain('hello world');
      expect(text.text).not.toContain('…(truncated)');
    }
  });

  it('says when the element list was capped, and how many elements it left out', () => {
    const capped = buildTurnContent(
      baseState({ observation: { url: 'u', title: 't', frames: [], elements: [makeElement()], elementsOmitted: 42, textDigest: '' } }),
    ).at(-1);
    if (capped?.type !== 'text') throw new Error('expected a text block');
    expect(capped.text).toContain('ELEMENTS (capped: 1 listed');
    expect(capped.text).toContain('42 more not listed');
    const full = buildTurnContent(baseState({ observation: { url: 'u', title: 't', frames: [], elements: [makeElement()], textDigest: '' } })).at(-1);
    if (full?.type !== 'text') throw new Error('expected a text block');
    expect(full.text).toContain('\nELEMENTS:\n');
    expect(full.text).not.toContain('capped');
  });

  it('renders the ELEMENTS list from the observation', () => {
    const blocks = buildTurnContent(baseState({ observation: { url: 'u', title: 't', frames: [], elements: [makeElement()], textDigest: '' } }));
    const text = blocks.at(-1);
    if (text?.type === 'text') expect(text.text).toContain('[e1] textbox "Search Value" (frame: top)');
  });
});

describe('systemPrompt', () => {
  it('lists the allowed secret env names', () => {
    const prompt = systemPrompt({ secretEnvNames: ['MOCK_USER', 'MOCK_PASSWORD'] });
    expect(prompt).toContain('MOCK_USER');
    expect(prompt).toContain('MOCK_PASSWORD');
  });

  it('never hardcodes mock-app-specific literals', () => {
    const prompt = systemPrompt({ secretEnvNames: ['MOCK_USER', 'MOCK_PASSWORD'] });
    for (const forbidden of ['Member ID', 'Maintenance', 'No records found', 'Sign On', 'operator1', 'demo-pass']) {
      expect(prompt).not.toContain(forbidden);
    }
  });

  it('adds the extend-mode addendum only when extend is true', () => {
    const normal = systemPrompt({ secretEnvNames: [] });
    const extend = systemPrompt({ secretEnvNames: [], extend: true });
    expect(normal).not.toContain('EXTEND MODE');
    expect(extend).toContain('EXTEND MODE');
    expect(extend).toContain('declare_outcome');
  });

  it('is a stable, reasonably-sized page of instructions', () => {
    const prompt = systemPrompt({ secretEnvNames: ['MOCK_USER'] });
    expect(prompt.length).toBeGreaterThan(500);
    expect(prompt.length).toBeLessThan(6000);
  });
});
