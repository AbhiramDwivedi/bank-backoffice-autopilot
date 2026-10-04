/**
 * Target identity scopes (recorder.ts `scopeTarget`): which locators a recorded target keeps.
 * Each case is a shape that went wrong: a value found through a neighbour of the recorded record,
 * a positional fallback finding the recorded row for another input, or a statically named control
 * stripped of its own locators because something near it mentioned the input.
 */
import { describe, expect, it } from 'vitest';
import { validateCapability, type Locator, type TargetDescriptor } from '../schema/index.js';
import { createRecorder, isPositional } from './recorder.js';

const BASE_URL = 'http://localhost:4173';
type Strat = Locator['strategy'];
const loc = (strategy: Strat): Locator => ({ strategy, confidence: 0.5, source: 'inferred' });
const target = (description: string, ...strategies: Strat[]): TargetDescriptor => ({ description, frame: [], locators: strategies.map(loc) });

/** A product card's price as the surface synthesizes it: its own text, two container-anchored
 *  relatives (the card's name, its summary), a structural css path and a bbox. */
const CARD_PRICE: TargetDescriptor = {
  ...target(
    'generic "$29.99" (<div>)',
    { kind: 'text', text: '$29.99', exact: true, tag: 'div' },
    { kind: 'relative', anchor: { text: 'Canvas Backpack' }, relation: 'below', tag: 'div', selector: 'div.price', within: 'div.card' },
    { kind: 'relative', anchor: { text: 'Water-resistant canvas pack.' }, relation: 'below', tag: 'div', selector: 'div.price', within: 'div.card' },
    { kind: 'css', selector: 'div:nth-of-type(3) > div > div:nth-of-type(2) > div' },
    { kind: 'bbox', x: 0.1, y: 0.2, w: 0.05, h: 0.03 },
  ),
  snapshot: { tag: 'div', role: 'generic', name: '$29.99', text: '$29.99' },
};

const PRICE_ANCHOR: Strat = {
  kind: 'relative',
  anchor: { text: '{input.productName}', exact: true },
  relation: 'below',
  tag: 'div',
  selector: 'div.price',
  within: 'div.card',
};

const PRODUCT_INPUT = { productName: { value: 'Canvas Backpack', sensitive: false, description: 'Product name', type: 'string' as const } };
const MEMBER_INPUT = { memberId: { value: '12345', sensitive: false, description: 'Member ID', type: 'string' as const } };

describe('scopeTarget: a recorded target keeps the locators its identity justifies', () => {
  it('anchor-input: a value with no identity of its own keeps only its exact, container-bounded anchor on the input', () => {
    const logs: string[] = [];
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: PRODUCT_INPUT, onLog: (m) => logs.push(m) });
    const sanitized = recorder.sanitizeExtractedTarget(CARD_PRICE, 'price', '$29.99');
    if (!sanitized.ok) throw new Error(sanitized.error);
    expect(recorder.scopeTarget(sanitized.target).scope).toBe('anchor-input');
    const step = recorder.recordStep({ action: { type: 'extract', target: sanitized.target, output: 'price', parse: 'currency' }, why: 'Read the price', risk: 'read' });
    if (step.action.type !== 'extract') throw new Error('expected an extract');
    expect(step.action.target.locators.map((l) => l.strategy)).toEqual([PRICE_ANCHOR]);
    expect(JSON.stringify(step.action.target)).not.toContain('29.99');
    expect(logs.some((m) => m.includes('anchor-input target keeps 1 of'))).toBe(true);
  });

  it('own-input: a result row whose own text is the input keeps its input-bound own locators, never a positional fallback', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: MEMBER_INPUT });
    const row = target(
      'clickable "12345 Jane Q. Sample" (<tr>)',
      { kind: 'text', text: '12345 Jane Q. Sample', tag: 'tr' },
      { kind: 'relative', anchor: { text: 'Search results' }, relation: 'below', tag: 'tr' },
      { kind: 'css', selector: 'table > tr:nth-of-type(2)' },
      { kind: 'bbox', x: 0.1, y: 0.3, w: 0.5, h: 0.03 },
    );
    const scoped = recorder.scopeTarget(row);
    expect(scoped.scope).toBe('own-input');
    expect(scoped.target.locators.map((l) => l.strategy)).toEqual([{ kind: 'text', text: '{input.memberId}', exact: false, tag: 'tr', wholeWord: true }]);
  });

  it('static: a tab that names itself keeps its own chain and drops the relative anchored on the input-bearing heading', () => {
    // The mock app's member page: "Accounts" under "Member: Jane Q. Sample (#12345)".
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: MEMBER_INPUT });
    const tab = target(
      'clickable "Accounts" (<span>)',
      { kind: 'text', text: 'Accounts', exact: true, tag: 'span' },
      { kind: 'relative', anchor: { text: 'Member: Jane Q. Sample (#12345)' }, relation: 'below', tag: 'span' },
      { kind: 'css', selector: 'span.tab:nth-of-type(2)' },
      { kind: 'bbox', x: 0.2, y: 0.1, w: 0.05, h: 0.02 },
    );
    const scoped = recorder.scopeTarget(tab);
    expect(scoped.scope).toBe('static');
    expect(scoped.target.locators.map((l) => l.strategy.kind)).toEqual(['text', 'css', 'bbox']);
  });

  it('static: a Cancel button under "Order 12345" keeps its role, css and bbox; the input-anchored relative goes', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: { orderId: { value: '12345', sensitive: false, description: 'Order', type: 'string' } } });
    const cancel = target(
      'button "Cancel order" (<button>)',
      { kind: 'role', role: 'button', name: 'Cancel order', exact: true },
      { kind: 'relative', anchor: { text: 'Order 12345' }, relation: 'below', tag: 'button', role: 'button' },
      { kind: 'css', selector: 'button#cancel' },
      { kind: 'bbox', x: 0.2, y: 0.4, w: 0.1, h: 0.03 },
    );
    const scoped = recorder.scopeTarget(cancel);
    expect(scoped.scope).toBe('static');
    expect(scoped.target.locators.map((l) => l.strategy.kind)).toEqual(['role', 'css', 'bbox']);
  });

  it('static: an input value slugged into a css id ("#savings-form") does not make the target input-scoped', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: { accountType: { value: 'savings', sensitive: false, description: 'Account type', type: 'string' } } });
    const submit = target(
      'button "Open account" (<button>)',
      { kind: 'role', role: 'button', name: 'Open account', exact: true },
      { kind: 'css', selector: 'form#savings-form > button' },
      { kind: 'bbox', x: 0.2, y: 0.5, w: 0.1, h: 0.03 },
    );
    const scoped = recorder.scopeTarget(submit);
    expect(scoped.scope).toBe('static');
    expect(scoped.target.locators.map((l) => l.strategy.kind)).toEqual(['role', 'css', 'bbox']);
    expect(scoped.target.locators[0]!.strategy).toEqual({ kind: 'role', role: 'button', name: 'Open account', exact: true });
  });

  it('static: a labelled field keeps its label and drops a weak neighbour anchored on the input', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: MEMBER_INPUT });
    const field = target(
      'textbox "Nickname" (<input>)',
      { kind: 'label', label: 'Nickname', exact: true },
      { kind: 'relative', anchor: { text: '12345' }, relation: 'right-of', tag: 'input' },
      { kind: 'css', selector: 'input[name="nick"]' },
    );
    const scoped = recorder.scopeTarget(field);
    expect(scoped.scope).toBe('static');
    expect(scoped.target.locators.map((l) => l.strategy.kind)).toEqual(['label', 'css']);
  });

  it("drops container anchors that are record data (a member's name, an address), keeping the legacy chain", () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: MEMBER_INPUT });
    const phone = target(
      'cell "(413) 555-0126" (<td>)',
      { kind: 'relative', anchor: { text: 'Phone' }, relation: 'right-of', tag: 'td' },
      { kind: 'relative', anchor: { text: 'Jane Q. Sample' }, relation: 'below', tag: 'td', within: 'table.detail' },
      { kind: 'relative', anchor: { text: '282 Mill St, Springfield, MA 01103' }, relation: 'below', tag: 'td', within: 'table.detail' },
      { kind: 'css', selector: 'tr:nth-of-type(5) > td:nth-of-type(2)' },
    );
    const scoped = recorder.scopeTarget(phone);
    expect(scoped.scope).toBe('legacy');
    const text = JSON.stringify(scoped.target.locators);
    expect(text).not.toContain('Jane');
    expect(text).not.toContain('Mill St');
    expect(scoped.target.locators.map((l) => l.strategy.kind)).toEqual(['relative', 'css']);
  });

  it('isPositional: bbox and structural css are position; ids, names and classes are identity', () => {
    const css = (selector: string): Locator => loc({ kind: 'css', selector });
    for (const sel of ['div:nth-of-type(3) > div > button', 'tr:nth-child(2)', 'ul > li:first-child', 'body > div > span', 'td > table > tbody > tr > td', 'div']) {
      expect(isPositional(css(sel)), sel).toBe(true);
    }
    for (const sel of ['#tabAccounts', 'input[name="memberId"]', 'input[type="text"][name="userId"]', 'span.title', 'form#search > button.go', 'div.card > span.price']) {
      expect(isPositional(css(sel)), sel).toBe(false);
    }
    expect(isPositional(loc({ kind: 'bbox', x: 0, y: 0, w: 0.1, h: 0.1 }))).toBe(true);
    expect(isPositional(loc({ kind: 'text', text: 'Go' }))).toBe(false);
  });

  it('anchor-input without a container: a table cell right of "{input.orderId}" keeps only that anchor', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: { orderId: { value: 'A-1001', sensitive: false, description: 'Order', type: 'string' } } });
    const status = target(
      'cell "Shipped" (<td>)',
      { kind: 'relative', anchor: { text: 'A-1001' }, relation: 'right-of', tag: 'td' },
      { kind: 'css', selector: 'tr:nth-of-type(2) > td:nth-of-type(2)' },
      { kind: 'bbox', x: 0.2, y: 0.2, w: 0.1, h: 0.03 },
    );
    const scoped = recorder.scopeTarget(status);
    expect(scoped.scope).toBe('anchor-input');
    expect(scoped.recordScoped).toBe(true);
    expect(scoped.target.locators.map((l) => l.strategy)).toEqual([{ kind: 'relative', anchor: { text: '{input.orderId}', exact: true }, relation: 'right-of', tag: 'td' }]);
  });

  it('repeated-input: a control whose static name is not unique keeps only its input-bound anchor', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: PRODUCT_INPUT });
    const add = target(
      'button "Add to cart" (<button>)',
      { kind: 'role', role: 'button', name: 'Add to cart', exact: true },
      { kind: 'relative', anchor: { text: 'Canvas Backpack' }, relation: 'below', tag: 'button', role: 'button', selector: 'button.add', within: 'div.card' },
      { kind: 'css', selector: 'button[name="add-to-cart-canvas-backpack"]' },
      { kind: 'bbox', x: 0.3, y: 0.2, w: 0.07, h: 0.03 },
    );
    // Unique on the page (the default): a static control, its own chain kept, the anchor dropped.
    const unique = recorder.scopeTarget(add);
    expect(unique.scope).toBe('static');
    expect(unique.hasInputAnchor).toBe(true);
    expect(unique.ownStatic.map((l) => l.strategy.kind)).toEqual(['role']);
    // Repeated in every card: record-scoped, only the anchor on the input survives.
    const repeated = recorder.scopeTarget(add, { ownNameUnique: false });
    expect(repeated.scope).toBe('repeated-input');
    expect(repeated.target.locators.map((l) => l.strategy)).toEqual([
      { kind: 'relative', anchor: { text: '{input.productName}', exact: true }, relation: 'below', tag: 'button', role: 'button', selector: 'button.add', within: 'div.card' },
    ]);
  });

  it("page: on a list page for the input a target loses its positional fallbacks; on the record's own page it keeps them", () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: MEMBER_INPUT });
    const balance = target(
      'cell "$1,234.56" (<td>)',
      { kind: 'relative', anchor: { text: 'Savings Balance' }, relation: 'right-of', tag: 'td' },
      { kind: 'css', selector: 'tr:nth-of-type(6) > td:nth-of-type(2)' },
      { kind: 'bbox', x: 0.15, y: 0.24, w: 0.17, h: 0.03 },
    );
    expect(recorder.scopeTarget(balance).scope).toBe('legacy'); // nowhere in particular yet
    recorder.noteLocation({ url: `${BASE_URL}/members/search?memberId=12345`, frames: [] });
    const onList = recorder.scopeTarget(balance);
    expect(onList.scope).toBe('page');
    expect(onList.recordScoped).toBe(true);
    expect(onList.target.locators.map((l) => l.strategy.kind)).toEqual(['relative']);
    // The record's own page lists nothing else: a position there still means this record.
    recorder.noteLocation({ url: `${BASE_URL}/members/12345`, frames: [] });
    expect(recorder.scopeTarget(balance).target.locators.map((l) => l.strategy.kind)).toEqual(['relative', 'css', 'bbox']);
  });

  it('specific: an own locator holding the input is kept whole and exact instead of narrowed', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: { id: { value: '4512', sensitive: false, description: 'Row id', type: 'string' } } });
    const row = target('clickable "Row for 4512" (<tr>)', { kind: 'text', text: 'Row for 4512', exact: true }, { kind: 'css', selector: 'tr:nth-of-type(1)' });
    expect(recorder.scopeTarget(row).target.locators.map((l) => l.strategy)).toEqual([{ kind: 'text', text: '{input.id}', exact: false, wholeWord: true }]);
    expect(recorder.scopeTarget(row, { specific: true }).target.locators.map((l) => l.strategy)).toEqual([{ kind: 'text', text: 'Row for {input.id}', exact: true }]);
  });

  describe('a role locator bound to an input is exact or not recorded', () => {
    const BOLT_INPUT = { productName: { value: 'Bolt', sensitive: false, description: 'Product name', type: 'string' as const } };

    it('the name is the input: recorded exact, whatever the surface said, so "Bolt" never finds "Bolt T-Shirt"', () => {
      const recorder = createRecorder({ baseUrl: BASE_URL, inputs: BOLT_INPUT });
      const link = target('link "Bolt" (<a>)', { kind: 'role', role: 'link', name: 'Bolt', exact: false }, { kind: 'css', selector: 'a.title:nth-of-type(1)' });
      const scoped = recorder.scopeTarget(link);
      expect(scoped.scope).toBe('own-input');
      expect(scoped.target.locators.map((l) => l.strategy)).toEqual([{ kind: 'role', role: 'link', name: '{input.productName}', exact: true }]);
    });

    it('the name holds the input among other text: no role locator; the target stays own-input and keeps its container anchor', () => {
      const logs: string[] = [];
      const recorder = createRecorder({ baseUrl: BASE_URL, inputs: BOLT_INPUT, onLog: (m) => logs.push(m) });
      const add: TargetDescriptor = {
        ...target(
          'button "Add Bolt to cart" (<button>)',
          { kind: 'role', role: 'button', name: 'Add Bolt to cart', exact: true },
          { kind: 'relative', anchor: { text: 'Bolt' }, relation: 'below', tag: 'button', role: 'button', selector: 'button.add', within: 'div.card' },
          { kind: 'css', selector: 'div.card:nth-of-type(2) button.add' },
          { kind: 'bbox', x: 0.1, y: 0.2, w: 0.05, h: 0.03 },
        ),
        snapshot: { tag: 'button', role: 'button', name: 'Add Bolt to cart', text: 'Add to cart' },
      };
      const scoped = recorder.scopeTarget(add);
      expect(scoped.scope).toBe('own-input');
      expect(scoped.target.locators.map((l) => l.strategy)).toEqual([
        { kind: 'relative', anchor: { text: '{input.productName}', exact: true }, relation: 'below', tag: 'button', role: 'button', selector: 'button.add', within: 'div.card' },
      ]);
      // The name's other words are not kept in the description or the snapshot either.
      expect(scoped.target.description).toBe('button below "{input.productName}" (<button>)');
      expect(scoped.target.snapshot?.name).toBe('{input.productName}');
      expect(logs.some((m) => m.includes('own-input target keeps 1 of 4'))).toBe(true);
    });

    it('nothing else names the control: it keeps no locator (discovery refuses it), never a position', () => {
      const recorder = createRecorder({ baseUrl: BASE_URL, inputs: BOLT_INPUT });
      const icon = target(
        'button "View details for Bolt" (<button>)',
        { kind: 'role', role: 'button', name: 'View details for Bolt', exact: true },
        { kind: 'css', selector: 'div.card:nth-of-type(2) > button' },
        { kind: 'bbox', x: 0.1, y: 0.2, w: 0.05, h: 0.03 },
      );
      const scoped = recorder.scopeTarget(icon);
      expect(scoped.scope).toBe('own-input');
      expect(scoped.recordScoped).toBe(true);
      expect(scoped.target.locators).toEqual([]);
    });

    it('specific: the whole name with the placeholder, exact', () => {
      const recorder = createRecorder({ baseUrl: BASE_URL, inputs: BOLT_INPUT });
      const icon = target('button "View details for Bolt" (<button>)', { kind: 'role', role: 'button', name: 'View details for Bolt', exact: false });
      expect(recorder.scopeTarget(icon, { specific: true }).target.locators.map((l) => l.strategy)).toEqual([
        { kind: 'role', role: 'button', name: 'View details for {input.productName}', exact: true },
      ]);
    });
  });

  it('drops an above-anchor on neighbouring text (record data) from every scope; keeps the adjacent label cell', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: MEMBER_INPUT });
    const notes = target(
      'textbox "Notes" (<textarea>)',
      { kind: 'role', role: 'textbox', name: 'Notes' },
      { kind: 'relative', anchor: { text: 'Called about overdraft fee on 9/12' }, relation: 'below', tag: 'textarea' },
      { kind: 'relative', anchor: { text: 'Notes' }, relation: 'right-of', tag: 'textarea' },
      { kind: 'css', selector: 'textarea[name="note"]' },
    );
    const kept = recorder.scopeTarget(notes).target.locators.map((l) => l.strategy);
    expect(JSON.stringify(kept)).not.toContain('overdraft');
    expect(kept.map((s) => s.kind)).toEqual(['role', 'relative', 'css']);
  });

  it('isPositional: sibling combinators, index-like classes and ids, and numbered attribute values are position', () => {
    const css = (selector: string): Locator => loc({ kind: 'css', selector });
    for (const sel of ['.list .item + .item', 'li.item ~ li.item', '[data-index="0"]', 'div.row-1', 'tr.odd', 'td.even', 'li.first', 'li.is-last', '#item-3', 'a[href="/members/10009"]', 'div[data-pos=3]']) {
      expect(isPositional(css(sel)), sel).toBe(true);
    }
    for (const sel of ['a[href="/members/{input.memberId}"]', 'input[name="memberId"]', 'div.h2-title', 'button.add-to-cart', 'a[href="/products"]']) {
      expect(isPositional(css(sel)), sel).toBe(false);
    }
  });

  it('isPositional and the validator agree on which input-bound selectors pick by position', () => {
    // The validator uses the same `isPositional` (schema/positional.ts) for
    // `unverified_input_binding`: an extract read through one input-bound css locator needs no
    // checkpoint exactly when that selector is not positional.
    const warns = (selector: string): boolean => {
      const result = validateCapability({
        schemaVersion: '1.0',
        id: 'read-value',
        version: '1.0.0',
        name: 'Read value',
        description: 'Read the value of {q}.',
        app: { vendor: 'Demo vendor', product: 'Demo Shop', surface: 'web', entryUrl: '{baseUrl}/' },
        status: 'draft',
        riskLevel: 'read',
        inputs: { q: { type: 'string', description: 'Record', required: true, sensitive: false } },
        outputs: { value: { type: 'string', description: 'Value' } },
        steps: [
          { id: 's01', name: 'Open the search', action: { type: 'navigate', url: '{baseUrl}/search?q={input.q}' }, risk: 'read' },
          { id: 's02', name: 'Read the value', action: { type: 'extract', target: target('the value', { kind: 'css', selector }), output: 'value' }, risk: 'read' },
        ],
        success: { condition: { kind: 'text_visible', text: 'Results' }, description: 'Read it.' },
        businessOutcomes: [],
        recoveryRules: [],
        provenance: { discoveredAt: '2026-01-01T00:00:00Z', discoveryRunId: 'run-1', recordedBy: 'llm' },
      });
      if (!result.ok) throw new Error(`${selector}: ${JSON.stringify(result.issues)}`);
      return result.warnings.some((w) => w.code === 'unverified_input_binding');
    };
    const cases: [string, boolean][] = [
      ['tr[data-id="{input.q}"] td.balance', false],
      ['a[href="/members/{input.q}"]', false],
      ['form#search-{input.q} > button.go', false],
      ['div[data-q="{input.q}"] li:nth-child(1)', true],
      ['div[data-q="{input.q}"] li:first-of-type', true],
      ['div[data-q="{input.q}"] > li', true],
      ['span[data-id="{input.q}"] + span', true],
      ['span[data-id="{input.q}"] ~ span.value', true],
      ['div.row-2 span[data-id="{input.q}"]', true],
      ['tr.odd td[data-id="{input.q}"]', true],
      ['li#item-3 span[data-id="{input.q}"]', true],
      ['li[data-index="3"] span[data-id="{input.q}"]', true],
      ["li[data-index='3'] span[data-id='{input.q}']", true],
    ];
    for (const [selector, positional] of cases) {
      expect(isPositional(loc({ kind: 'css', selector })), `isPositional ${selector}`).toBe(positional);
      expect(warns(selector), `validator ${selector}`).toBe(positional);
    }
  });

  it('a control with no own identity under an UNTRUSTED input-bearing heading is not anchor-input (it would be left with nothing)', () => {
    // The sub-account form's "-- Select --" dropdown under "Member: Jane Q. Sample (#12345)".
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: MEMBER_INPUT });
    const dropdown = target(
      'clickable "-- Select --" (<div>)',
      { kind: 'relative', anchor: { text: 'Member: Jane Q. Sample (#12345)' }, relation: 'below', tag: 'div' },
      { kind: 'css', selector: 'div.cw-dd-toggle' },
      { kind: 'bbox', x: 0.3, y: 0.3, w: 0.2, h: 0.03 },
    );
    expect(recorder.scopeTarget(dropdown).scope).toBe('legacy');
    // On the member's own page (the input in a path segment) the chain keeps its fallbacks.
    recorder.noteLocation({ url: `${BASE_URL}/members/12345/subaccounts/new`, frames: [] });
    const scoped = recorder.scopeTarget(dropdown);
    expect(scoped.scope).toBe('page');
    expect(scoped.target.locators.map((l) => l.strategy.kind)).toEqual(['css', 'bbox']);
    expect(JSON.stringify(scoped.target.locators)).not.toContain('Jane');
  });

  it('content-input: a row whose other cell holds the searched value scopes a View button to that cell, in its own column', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: { q: { value: 'Smithers', sensitive: false, description: 'Name', type: 'string' } } });
    const view = target(
      'button "View" (<button>)',
      { kind: 'role', role: 'button', name: 'View', exact: true },
      { kind: 'relative', anchor: { text: 'al.sm@example.test' }, relation: 'right-of', tag: 'button', role: 'button' },
      { kind: 'css', selector: 'tr:nth-of-type(2) > td:nth-of-type(3) > button' },
      { kind: 'bbox', x: 0.6, y: 0.3, w: 0.05, h: 0.03 },
    );
    const context = {
      ownText: 'View',
      rowCells: [
        { text: 'Al Smithers', relation: 'right-of' as const },
        { text: 'al.sm@example.test', relation: 'right-of' as const },
      ],
      cell: { tag: 'td', index: 2 },
      containerText: 'Al Smithers al.sm@example.test View',
      tag: 'button',
      role: 'button',
    };
    expect(recorder.scopeTarget(view).scope).toBe('static'); // no content: nothing says which record
    const scoped = recorder.scopeTarget(view, { context });
    expect(scoped.scope).toBe('content-input');
    expect(scoped.recordScoped).toBe(true);
    expect(scoped.target.locators.map((l) => l.strategy)).toEqual([
      { kind: 'relative', anchor: { text: '{input.q}', exact: false, wholeWord: true }, relation: 'right-of', tag: 'button', role: 'button', selector: 'td:nth-child(3) button' },
    ]);
    expect(JSON.stringify(scoped.target)).not.toContain('al.sm');
  });

  it('content-input: own text holding the input becomes a text locator; a container-only match leaves nothing (refused, not positional)', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: { id: { value: '4512', sensitive: false, description: 'Row', type: 'string' } } });
    const row = target('clickable "Row for 4512" (<tr>)', { kind: 'css', selector: 'tr:nth-of-type(1)' }, { kind: 'bbox', x: 0, y: 0.1, w: 0.5, h: 0.03 });
    const own = { ownText: 'Row for 4512', rowCells: [], cell: null, containerText: '', tag: 'tr' };
    expect(recorder.scopeTarget(row, { context: own }).target.locators.map((l) => l.strategy)).toEqual([{ kind: 'text', text: '{input.id}', exact: false, tag: 'tr', wholeWord: true }]);
    expect(recorder.scopeTarget(row, { context: own, specific: true }).target.locators.map((l) => l.strategy)).toEqual([{ kind: 'text', text: 'Row for {input.id}', exact: true, tag: 'tr' }]);
    const button = target('clickable "Open" (<div>)', { kind: 'css', selector: 'div.card:nth-of-type(2) > div' });
    const inCard = { ownText: 'Open', rowCells: [], cell: null, containerText: 'Order 4512 Placed today Open', tag: 'div' };
    const scoped = recorder.scopeTarget(button, { context: inCard });
    expect(scoped.scope).toBe('content-input');
    expect(scoped.target.locators).toEqual([]);
    // A sensitive input never decides membership by content.
    const secret = createRecorder({ baseUrl: BASE_URL, inputs: { id: { value: '4512', sensitive: true, description: 'Row', type: 'string' } } });
    expect(secret.scopeTarget(button, { context: inCard }).scope).toBe('legacy');
  });

  // A member's profile reached through a last-name search: the page URL (/members/10002) holds no
  // input, and only the profile table's text holds the last name.
  const LAST_NAME = { lastName: { value: 'Kowalczyk', sensitive: false, description: 'Last name', type: 'string' as const } };
  const SAVINGS_CELL = target(
    'cell "$12,500.00" (<td>)',
    { kind: 'relative', anchor: { text: 'Savings Balance' }, relation: 'right-of', tag: 'td' },
    { kind: 'css', selector: 'table:nth-of-type(2) > tbody > tr:nth-of-type(5) > td:nth-of-type(2)' },
    { kind: 'bbox', x: 0.4, y: 0.5, w: 0.1, h: 0.03 },
  );
  const profile = (labelUnique?: boolean) => ({
    ownText: '$12,500.00',
    rowCells: [{ text: 'Savings Balance', relation: 'right-of' as const, tag: 'td', index: 0 }],
    cell: { tag: 'td', index: 1 },
    containerText: 'Member Name Denise M. Kowalczyk Member Since 07/02/2001 Savings Balance $12,500.00',
    tag: 'td',
    ...(labelUnique !== undefined ? { labelUnique } : {}),
  });

  it('content-input from the container alone (a one-record detail view): a value keeps its own unique label anchor, nothing positional', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: LAST_NAME });
    const scoped = recorder.scopeTarget(SAVINGS_CELL, { context: profile(true) });
    expect(scoped.scope).toBe('content-input');
    expect(scoped.recordScoped).toBe(true); // still verified on the live page before recording
    expect(scoped.target.locators.map((l) => l.strategy)).toEqual([{ kind: 'relative', anchor: { text: 'Savings Balance' }, relation: 'right-of', tag: 'td' }]);
    // An older agent does not say whether the label is unique: the live verification decides.
    expect(recorder.scopeTarget(SAVINGS_CELL, { context: profile() }).target.locators).toHaveLength(1);
    expect(JSON.stringify(scoped.target)).not.toContain('Kowalczyk');
  });

  it('content-input from the container alone, with the label repeated on the page (several cards): nothing is kept, so it is refused', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: LAST_NAME });
    const scoped = recorder.scopeTarget(SAVINGS_CELL, { context: profile(false) });
    expect(scoped.scope).toBe('content-input');
    expect(scoped.target.locators).toEqual([]);
  });

  it("content-input from a row cell: the anchor is the column's static text with the placeholder (exact), in that column only; else a case-sensitive whole word", () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: { orderNo: { value: '2001', sensitive: false, description: 'Order', type: 'string' } } });
    const status = target('cell "Shipped" (<td>)', { kind: 'css', selector: 'tr:nth-of-type(4) > td:nth-of-type(3)' }, { kind: 'bbox', x: 0.5, y: 0.3, w: 0.1, h: 0.03 });
    const row = (shared?: { prefix: string; suffix: string }, masked?: true) => ({
      ownText: 'Shipped',
      rowCells: [
        { text: 'Order 2001', relation: 'right-of' as const, tag: 'td', index: 0, ...(shared ? { shared } : {}), ...(masked ? { masked } : {}) },
        { text: '05/04/2019', relation: 'right-of' as const, tag: 'td', index: 1 },
      ],
      cell: { tag: 'td', index: 2 },
      containerText: '',
      tag: 'td',
    });
    const anchorOf = (ctx: ReturnType<typeof row>) => {
      const s = recorder.scopeTarget(status, { context: ctx }).target.locators[0]!.strategy;
      if (s.kind !== 'relative') throw new Error(s.kind);
      return { anchor: s.anchor, selector: s.selector };
    };
    expect(anchorOf(row({ prefix: 'Order ', suffix: '' }))).toEqual({ anchor: { text: 'Order {input.orderNo}', exact: true, selector: 'td:nth-child(1)' }, selector: 'td:nth-child(3)' });
    // No shared text known (a one-row result), or the cell is masked: the whole word, case-sensitive, in that column.
    expect(anchorOf(row())).toEqual({ anchor: { text: '{input.orderNo}', exact: false, wholeWord: true, selector: 'td:nth-child(1)' }, selector: 'td:nth-child(3)' });
    expect(anchorOf(row({ prefix: 'Order ', suffix: '' }, true)).anchor).toEqual({ text: '{input.orderNo}', exact: false, wholeWord: true, selector: 'td:nth-child(1)' });
  });

  it('narrows a container anchor holding the input among other text to the placeholder, as a contains match', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: { q: { value: 'Smithers', sensitive: false, description: 'Name', type: 'string' } } });
    const email = target(
      'generic "al.sm@example.test" (<div>)',
      { kind: 'relative', anchor: { text: 'Al Smithers' }, relation: 'below', tag: 'div', selector: 'div.email', within: 'div.card' },
    );
    expect(recorder.scopeTarget(email).target.locators.map((l) => l.strategy)).toEqual([
      { kind: 'relative', anchor: { text: '{input.q}', exact: false, wholeWord: true }, relation: 'below', tag: 'div', selector: 'div.email', within: 'div.card' },
    ]);
  });

  it("applies the same scoping to a recovery rule's dismiss target and to an outcome's extract target", () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: PRODUCT_INPUT });
    const ok = target(
      'clickable "OK" (<div>)',
      { kind: 'text', text: 'OK', exact: true, tag: 'div' },
      { kind: 'relative', anchor: { text: 'Notice for Canvas Backpack' }, relation: 'below', tag: 'div' },
      { kind: 'relative', anchor: { text: 'Shop news' }, relation: 'below', tag: 'div', within: 'div.notice' },
      { kind: 'css', selector: 'div.notice > div.ok' },
    );
    const rule = recorder.recordRecovery({ triggerText: 'Shop news', title: 'Shop news', dismissTarget: ok, description: 'Dismiss the notice' });
    const click = rule.actions.find((a) => a.type === 'click');
    if (click?.type !== 'click') throw new Error('expected a click');
    expect(click.target.locators.map((l) => l.strategy.kind)).toEqual(['text', 'css']);

    const sanitized = recorder.sanitizeExtractedTarget(CARD_PRICE, 'price', '$29.99');
    if (!sanitized.ok) throw new Error(sanitized.error);
    const outcome = recorder.recordOutcome({
      name: 'sale_price',
      description: 'On sale',
      detectorText: 'Sale',
      returns: [{ output: 'price', target: sanitized.target, parse: 'currency', description: 'The sale price' }],
    });
    expect(outcome.extract![0]!.target.locators.map((l) => l.strategy)).toEqual([PRICE_ANCHOR]);
  });

  it('drops a css or relative locator whose selector or container encodes the extracted value, compared alnum-folded', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    const status = target(
      'generic "In transit" (<span>)',
      { kind: 'relative', anchor: { text: 'Order status' }, relation: 'right-of', tag: 'span', selector: 'span.state.state-in-transit' },
      { kind: 'relative', anchor: { text: 'Order status' }, relation: 'right-of', tag: 'span', within: 'div.order-in-transit' },
      { kind: 'relative', anchor: { text: 'Order status' }, relation: 'right-of', tag: 'span' },
      { kind: 'css', selector: 'span.state_in_transit' },
    );
    const r = recorder.sanitizeExtractedTarget(status, 'status', 'In transit');
    if (!r.ok) throw new Error(r.error);
    expect(r.target.locators.map((l) => l.strategy)).toEqual([{ kind: 'relative', anchor: { text: 'Order status' }, relation: 'right-of', tag: 'span' }]);
  });

  it('strips the value from the snapshot even when no locator carried it', () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: {} });
    const t: TargetDescriptor = {
      ...target('generic "In transit" (<span>)', { kind: 'relative', anchor: { text: 'Ref' }, relation: 'below' }),
      snapshot: { tag: 'span', name: 'In transit', text: 'In transit' },
    };
    const r = recorder.sanitizeExtractedTarget(t, 'status', 'In transit');
    if (!r.ok) throw new Error(r.error);
    expect(r.target.snapshot).toEqual({ tag: 'span' });
  });

  it("canonicalizes an input value inside a relative locator's selector and container", () => {
    const recorder = createRecorder({ baseUrl: BASE_URL, inputs: { sku: { value: 'SKU-4471', sensitive: false, description: 'SKU', type: 'string' } } });
    const d = target('price', { kind: 'relative', anchor: { text: 'SKU-4471' }, relation: 'right-of', selector: 'div[data-sku="SKU-4471"]', within: 'div[data-sku="SKU-4471"]' });
    expect(recorder.canonicalizeDescriptor(d).locators[0]!.strategy).toMatchObject({ selector: 'div[data-sku="{input.sku}"]', within: 'div[data-sku="{input.sku}"]' });
  });
});
