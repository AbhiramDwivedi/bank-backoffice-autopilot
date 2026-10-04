/**
 * apps/cu/src/catalog/search.ts: BM25F ranking on small synthetic catalogs where the expected
 * order is obvious, deprecated/draft handling, prefix matching, determinism, and the shipped
 * artifacts as a smoke test through the real loader.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from './index.js';
import { buildSearchIndex, type Searchable } from './search.js';

interface Spec {
  id: string;
  name?: string;
  description?: string;
  status?: Searchable['status'];
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
  outcomes?: Record<string, string>;
  app?: { vendor?: string; product?: string; tenant?: string };
}

/** A minimal entry; everything not given is neutral filler that shares no words with the tests' queries. */
function entry(s: Spec): Searchable {
  const rec = (r: Record<string, string> = {}): Record<string, { type: 'string'; description: string; required: boolean; sensitive: boolean }> =>
    Object.fromEntries(Object.entries(r).map(([k, d]) => [k, { type: 'string' as const, description: d, required: true, sensitive: false }]));
  return {
    id: s.id,
    version: '1.0.0',
    name: s.name ?? 'Filler zzz',
    description: s.description ?? 'Filler qqq.',
    status: s.status ?? 'approved',
    riskLevel: 'read',
    capability: {
      inputs: rec(s.inputs),
      outputs: Object.fromEntries(Object.entries(s.outputs ?? {}).map(([k, d]) => [k, { type: 'string' as const, description: d }])),
      businessOutcomes: Object.entries(s.outcomes ?? {}).map(([name, description]) => ({
        name,
        description,
        detector: { kind: 'element_visible', target: { description: 'x', strategies: [] } },
        returns: {},
      })) as unknown as Searchable['capability']['businessOutcomes'],
      app: { vendor: s.app?.vendor ?? 'Vendorco', product: s.app?.product ?? 'Productco', surface: 'web', entryUrl: '{baseUrl}/', ...(s.app?.tenant !== undefined ? { tenant: s.app.tenant } : {}) },
    },
  };
}

const ids = (hits: { id: string }[]): string[] => hits.map((h) => h.id);

describe('search ranking', () => {
  it('ranks a name/id match above a description-only match', () => {
    const index = buildSearchIndex([
      entry({ id: 'cap-a', name: 'Filler one', description: 'Eventually sends a wire to another institution.' }),
      entry({ id: 'wire-transfer', name: 'Wire transfer', description: 'Moves funds.' }),
      entry({ id: 'cap-c', name: 'Filler two' }),
    ]);
    expect(ids(index.search('wire'))).toEqual(['wire-transfer', 'cap-a']);
  });

  it('ranks a description match above an output-name match above an app-metadata match', () => {
    const index = buildSearchIndex([
      entry({ id: 'by-app', app: { vendor: 'Ledger Corp' } }),
      entry({ id: 'by-output', outputs: { ledger: 'The value.' } }),
      entry({ id: 'by-description', description: 'Reads the ledger.' }),
      entry({ id: 'none' }),
    ]);
    expect(ids(index.search('ledger'))).toEqual(['by-description', 'by-output', 'by-app']);
  });

  it('weights a rare term above a common one', () => {
    const index = buildSearchIndex([
      entry({ id: 'common-1', description: 'Handles member records.' }),
      entry({ id: 'common-2', description: 'Handles member cards.' }),
      entry({ id: 'common-3', description: 'Handles member loans.' }),
      entry({ id: 'only-rare', description: 'Handles escheat filings.' }),
      entry({ id: 'both', description: 'Handles member escheat filings.' }),
    ]);
    const hits = index.search('member escheat');
    expect(hits[0]?.id).toBe('both');
    // Equal field, equal tf: the single-document term "escheat" beats the three-document term "member".
    expect(hits[1]?.id).toBe('only-rare');
    expect(ids(hits).slice(2)).toEqual(['common-1', 'common-2', 'common-3']); // tie -> id order
  });

  it('finds the shipped capability from kebab-case, camelCase, snake_case and plain-language queries', () => {
    const index = buildSearchIndex([
      entry({
        id: 'lookup-member-savings-balance',
        name: 'Look Up Member Savings Balance',
        description: 'Searches for a member and returns the savings balance.',
      }),
      entry({ id: 'open-subaccount', name: 'Open Subaccount', description: 'Opens a share sub-account.' }),
    ]);
    for (const q of ['lookup-member-savings-balance', 'lookupMemberSavingsBalance', 'savingsBalance', 'lookup_member_savings_balance', 'savings balances', 'What is the balance?']) {
      expect(index.search(q)[0]?.id, q).toBe('lookup-member-savings-balance');
    }
  });

  it('finds a capability whose only mention of the query word is an output name, and says so', () => {
    const index = buildSearchIndex([
      entry({ id: 'cap-out', outputs: { savingsBalance: 'Dollars.' } }),
      entry({ id: 'cap-other', outputs: { branchCode: 'Digits.' } }),
    ]);
    const hits = index.search('balance');
    expect(ids(hits)).toEqual(['cap-out']);
    expect(hits[0]?.matched).toEqual([{ field: 'outputs', terms: ['balance'] }]);
  });

  it('indexes inputs, business outcomes and tenant keys', () => {
    const index = buildSearchIndex([
      entry({ id: 'cap-in', inputs: { memberId: 'Numeric identifier.' } }),
      entry({ id: 'cap-bo', outcomes: { member_not_found: 'No such member exists.' } }),
      entry({ id: 'cap-tenant', app: { tenant: 'northwind' } }),
    ]);
    expect(ids(index.search('identifier'))).toEqual(['cap-in']);
    expect(ids(index.search('not found'))).toEqual(['cap-bo']);
    expect(ids(index.search('northwind'))).toEqual(['cap-tenant']);
    expect(index.search('northwind')[0]?.matched).toEqual([{ field: 'app', terms: ['northwind'] }]);
  });

  it('returns nothing, not a guess, when no term matches', () => {
    const index = buildSearchIndex([entry({ id: 'cap-a', name: 'Wire transfer' }), entry({ id: 'cap-b', name: 'Card block' })]);
    expect(index.search('pineapple')).toEqual([]);
    expect(index.search('the of and')).toEqual([]); // stop words only
    expect(index.search('')).toEqual([]);
    expect(buildSearchIndex([]).search('wire')).toEqual([]);
  });

  it('reports which fields and which query words matched', () => {
    const index = buildSearchIndex([entry({ id: 'wire-transfer', name: 'Wire transfer', description: 'Sends a wire and a receipt.', outputs: { receipt: 'Text.' } })]);
    const [hit] = index.search('wire receipt');
    expect(hit?.matched).toEqual([
      { field: 'id', terms: ['wire'] },
      { field: 'name', terms: ['wire'] },
      { field: 'description', terms: ['receipt', 'wire'] },
      { field: 'outputs', terms: ['receipt'] },
    ]);
    expect(hit?.rank).toBe(1);
    expect(hit?.score).toBeGreaterThan(0);
  });

  it('ranks "savings" to the savings capability, not to a "save" capability (no -ing stemming)', () => {
    const index = buildSearchIndex([
      entry({ id: 'save-member-note', name: 'Save member note', description: 'Saves a free-text note on the member record.' }),
      entry({ id: 'lookup-member-savings-balance', name: 'Look up member savings balance', description: 'Returns the savings balance.' }),
    ]);
    const hits = index.search('savings');
    expect(ids(hits)).toEqual(['lookup-member-savings-balance']); // the "save" capability is not a match at all
    expect(hits[0]?.matched.find((m) => m.field === 'id')?.terms).toEqual(['savings']);
  });

  it('"checking balance" prefers a savings/checking lookup over stop-check-payment', () => {
    const index = buildSearchIndex([
      entry({ id: 'stop-check-payment', name: 'Stop check payment', description: 'Places a stop on a paper check.' }),
      entry({ id: 'lookup-checking-balance', name: 'Look up checking balance', description: 'Returns the checking account balance.' }),
    ]);
    expect(ids(index.search('checking balance'))).toEqual(['lookup-checking-balance']);
  });

  it('matches non-ASCII text against itself, including CJK runs, and does not mangle it', () => {
    const index = buildSearchIndex([
      entry({ id: 'cap-cafe', name: 'Café Müller lookup' }),
      entry({ id: 'cap-cjk', name: '口座残高 照会' }),
      entry({ id: 'cap-plain', name: 'Cafe lookup' }),
    ]);
    expect(ids(index.search('Müller café'))).toEqual(['cap-cafe']);
    expect(ids(index.search('MÜLLER'))).toEqual(['cap-cafe']);
    expect(ids(index.search('口座残高'))).toEqual(['cap-cjk']);
    expect(index.search('口座残高')[0]?.matched).toEqual([{ field: 'name', terms: ['口座残高'] }]);
    expect(index.search('残高')).toEqual([]); // no CJK segmentation: a different run does not match
  });

  it('applies approvedOnly: drafts and deprecated are both dropped', () => {
    const index = buildSearchIndex([
      entry({ id: 'cap-approved', name: 'Wire', status: 'approved' }),
      entry({ id: 'cap-draft', name: 'Wire', status: 'draft' }),
      entry({ id: 'cap-old', name: 'Wire', status: 'deprecated' }),
    ]);
    expect(ids(index.search('wire', { approvedOnly: true }))).toEqual(['cap-approved']);
    expect(ids(index.search('wire', { approvedOnly: true, includeDeprecated: true }))).toEqual(['cap-approved']);
  });

  it('applies topK', () => {
    const index = buildSearchIndex(['a', 'b', 'c', 'd'].map((s) => entry({ id: `cap-${s}`, name: 'Wire' })));
    expect(ids(index.search('wire', { topK: 2 }))).toEqual(['cap-a', 'cap-b']);
    expect(index.search('wire', { topK: 2 }).map((h) => h.rank)).toEqual([1, 2]);
    expect(index.search('wire', { topK: 0 })).toEqual([]);
  });
});

describe('prefix matching', () => {
  const index = buildSearchIndex([
    entry({ id: 'lookup-member-savings-balance', name: 'Look up savings balance' }),
    entry({ id: 'open-subaccount', name: 'Open subaccount' }),
  ]);

  it('matches the last query token as a prefix', () => {
    expect(ids(index.search('savin'))).toEqual(['lookup-member-savings-balance']);
    expect(ids(index.search('member bal'))).toEqual(['lookup-member-savings-balance']);
    expect(ids(index.search('open su'))[0]).toBe('open-subaccount');
  });

  it('reports a prefix-only hit with the typed fragment as the matched term', () => {
    const [hit] = index.search('savin');
    expect(hit?.matched).toEqual([
      { field: 'id', terms: ['savin'] },
      { field: 'name', terms: ['savin'] },
    ]);
  });

  it('does not add score for a prefix of a word already typed in full ("balance bal" scores like "balance")', () => {
    expect(index.search('balance bal')[0]?.score).toBe(index.search('balance')[0]?.score);
    expect(index.search('balance balan')[0]?.score).toBe(index.search('balance')[0]?.score);
  });

  it('does not prefix-match earlier tokens', () => {
    expect(index.search('savin balance').map((h) => h.id)).toEqual(['lookup-member-savings-balance']);
    // "savin" is not the last token, so on its own it contributes nothing; "balance" does the matching.
    const only = index.search('savin balance')[0]!;
    expect(only.matched.every((m) => !m.terms.includes('savin'))).toBe(true);
  });

  it('ranks an exact match above a prefix-only match', () => {
    const idx = buildSearchIndex([entry({ id: 'cap-exact', name: 'Card' }), entry({ id: 'cap-prefix', name: 'Cardholder' })]);
    expect(ids(idx.search('card'))).toEqual(['cap-exact', 'cap-prefix']);
  });
});

describe('deprecated and draft handling', () => {
  const index = buildSearchIndex([
    entry({ id: 'cap-approved', name: 'Wire transfer', status: 'approved' }),
    entry({ id: 'cap-draft', name: 'Wire transfer', status: 'draft' }),
    entry({ id: 'cap-old', name: 'Wire transfer', status: 'deprecated' }),
  ]);

  it('excludes deprecated by default and includes drafts, marked by status', () => {
    const hits = index.search('wire');
    expect(ids(hits)).toEqual(['cap-approved', 'cap-draft']);
    expect(hits.map((h) => h.status)).toEqual(['approved', 'draft']);
  });

  it('includes deprecated on request', () => {
    expect(ids(index.search('wire', { includeDeprecated: true }))).toEqual(['cap-approved', 'cap-draft', 'cap-old']);
  });

  it('scores identically whether or not deprecated entries are filtered (df is catalog-wide)', () => {
    const a = index.search('wire').map((h) => h.score);
    const b = index.search('wire', { includeDeprecated: true }).map((h) => h.score);
    expect(a).toEqual(b.slice(0, 2));
  });
});

describe('determinism', () => {
  it('returns byte-identical results for the same query, across calls and across freshly built indexes', () => {
    const specs = ['wire', 'card', 'loan', 'member', 'balance'].map((w, i) => entry({ id: `cap-${w}`, name: `Handle ${w}`, description: `Does ${w} work for member ${i}.` }));
    const q = 'member work balance card';
    const a = buildSearchIndex(specs);
    expect(JSON.stringify(a.search(q))).toBe(JSON.stringify(a.search(q)));
    expect(JSON.stringify(a.search(q))).toBe(JSON.stringify(buildSearchIndex(specs).search(q)));
  });

  it('breaks score ties by id, regardless of load order', () => {
    const mk = (id: string): Searchable => entry({ id, name: 'Wire' });
    const forward = buildSearchIndex([mk('cap-b'), mk('cap-a'), mk('cap-c')]).search('wire');
    const reverse = buildSearchIndex([mk('cap-c'), mk('cap-a'), mk('cap-b')]).search('wire');
    expect(ids(forward)).toEqual(['cap-a', 'cap-b', 'cap-c']);
    expect(ids(reverse)).toEqual(['cap-a', 'cap-b', 'cap-c']);
  });
});

describe('shipped artifacts through the real loader', () => {
  const catalog = loadCatalog(path.resolve('artifacts'));

  it('finds lookup-member-savings-balance from a plain-language request and from its output name', () => {
    expect(catalog.search('what is the savings balance for a member')[0]?.id).toBe('lookup-member-savings-balance');
    expect(catalog.search('balance')[0]?.id).toBe('lookup-member-savings-balance');
    expect(catalog.search('lookupMemberSavingsBalance')[0]?.id).toBe('lookup-member-savings-balance');
  });

  it('returns nothing for an unrelated request', () => {
    expect(catalog.search('order a pizza')).toEqual([]);
  });
});
