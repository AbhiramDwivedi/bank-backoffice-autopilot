/**
 * Deterministic, local, dependency-free keyword search over capability metadata: BM25F ranking
 * over per-field token statistics. No embeddings, no model call; the same query over the same
 * catalog always returns the same ordered, explained result.
 *
 * Model: each capability is a document with weighted fields (id, name, description, outputs,
 * business outcomes, inputs, app/tenant metadata). BM25F sums a length-normalised, weighted term
 * frequency across fields, saturates it (k1), and multiplies by inverse document frequency over
 * the loaded catalog, so a term that names one capability outweighs a term every capability
 * shares. Query terms are OR-ed: a capability matching one of three terms still appears, just
 * lower. A query with no matching term returns nothing; it never falls back to a guess.
 *
 * The last query token is also prefix-matched against the vocabulary (for interactive use:
 * "savin" finds "savings") at half weight. A document's contribution per query token is the best
 * of its exact and prefix matches, never their sum.
 *
 * Scale: the index is one in-memory inverted index built in a single pass over the entries
 * (see docs/design/capability-selection.md for measured numbers). It is not persisted.
 */
import type { Capability } from '@cu/core/schema';
import { rawTokens, stem } from './text.js';

/** The fields indexed, in the order they are reported in `SearchHit.matched`. */
export const SEARCH_FIELDS = ['id', 'name', 'description', 'outputs', 'outcomes', 'inputs', 'app'] as const;
/** One of `SEARCH_FIELDS`. */
export type SearchField = (typeof SEARCH_FIELDS)[number];

/** BM25F field weights: id and name highest, then description, then outputs/outcomes/inputs, then app/tenant metadata. */
export const FIELD_WEIGHTS: Readonly<Record<SearchField, number>> = {
  id: 4,
  name: 4,
  description: 2,
  outputs: 1.2,
  outcomes: 1.2,
  inputs: 1,
  app: 0.6,
};

const K1 = 1.2;
const B = 0.75;
const PREFIX_WEIGHT = 0.5;
/** Default number of hits returned by search and by the `--query` shortlist. */
export const DEFAULT_TOP_K = 10;

/** What the index reads from a catalog entry. `CatalogEntry` satisfies it structurally. */
export interface Searchable {
  id: string;
  version: string;
  name: string;
  description: string;
  status: 'draft' | 'approved' | 'deprecated';
  riskLevel: string;
  capability: Pick<Capability, 'inputs' | 'outputs' | 'businessOutcomes' | 'app'> & Partial<Pick<Capability, 'overrides'>>;
}

/** Options for `SearchIndex.search`. */
export interface SearchOptions {
  /** Maximum number of hits; default `DEFAULT_TOP_K`. */
  topK?: number;
  /** Include deprecated capabilities (excluded by default). */
  includeDeprecated?: boolean;
  /** Only `approved` capabilities (drops drafts as well as deprecated; wins over `includeDeprecated`). */
  approvedOnly?: boolean;
}

/** One search result, with the reason it matched. */
export interface SearchHit {
  /** 1-based position in this result list. */
  rank: number;
  id: string;
  version: string;
  name: string;
  status: Searchable['status'];
  riskLevel: string;
  /** BM25F score, rounded to 4 decimals; only comparable within one query over one catalog. */
  score: number;
  /** Fields that matched, in `SEARCH_FIELDS` order, each with the query words that hit it. */
  matched: { field: SearchField; terms: string[] }[];
}

/** A built index over a fixed set of entries. */
export interface SearchIndex {
  /** Number of capabilities indexed (deprecated included; they are filtered at query time). */
  size: number;
  search(query: string, opts?: SearchOptions): SearchHit[];
}

function fieldTexts(e: Searchable): Record<SearchField, string> {
  const c = e.capability;
  const named = (rec: Record<string, { description: string }>): string =>
    Object.entries(rec)
      .map(([n, s]) => `${n} ${s.description}`)
      .join(' ');
  const tenants = [c.app.tenant, ...(c.overrides ?? []).map((o) => o.tenant)].filter((t): t is string => t !== undefined);
  return {
    id: e.id,
    name: e.name,
    description: e.description,
    outputs: named(c.outputs),
    outcomes: c.businessOutcomes.map((o) => `${o.name} ${o.description}`).join(' '),
    inputs: named(c.inputs),
    app: [c.app.vendor, c.app.product, c.app.surface, ...tenants].join(' '),
  };
}

interface Posting {
  doc: number;
  /** Term frequency per field, indexed like `SEARCH_FIELDS`. */
  tf: number[];
}

/** Builds a search index over `entries`. Pure; cost is linear in total metadata text. */
export function buildSearchIndex(entries: readonly Searchable[]): SearchIndex {
  const n = entries.length;
  const postings = new Map<string, Posting[]>();
  const vocab = new Map<string, string>(); // raw token -> stem, for prefix expansion
  const lengths: number[][] = []; // [doc][field]
  const fieldTotals = SEARCH_FIELDS.map(() => 0);

  entries.forEach((entry, doc) => {
    const texts = fieldTexts(entry);
    const docLengths: number[] = [];
    const tfByTerm = new Map<string, number[]>();
    SEARCH_FIELDS.forEach((field, f) => {
      const raws = rawTokens(texts[field]);
      docLengths.push(raws.length);
      fieldTotals[f] = (fieldTotals[f] ?? 0) + raws.length;
      for (const raw of raws) {
        const s = stem(raw);
        vocab.set(raw, s);
        let tf = tfByTerm.get(s);
        if (tf === undefined) {
          tf = SEARCH_FIELDS.map(() => 0);
          tfByTerm.set(s, tf);
        }
        tf[f] = (tf[f] ?? 0) + 1;
      }
    });
    lengths.push(docLengths);
    for (const [term, tf] of tfByTerm) {
      let list = postings.get(term);
      if (list === undefined) {
        list = [];
        postings.set(term, list);
      }
      list.push({ doc, tf });
    }
  });

  // Average field length over the documents that HAVE the field: averaging over all documents
  // would make a rarely-populated field (say, outputs) look "long" for the few that fill it in and
  // punish exactly those documents.
  const avgLen = fieldTotals.map((t, f) => {
    const populated = lengths.filter((l) => (l[f] ?? 0) > 0).length;
    return populated > 0 ? t / populated : 0;
  });
  const idf = (df: number): number => Math.log(1 + (n - df + 0.5) / (df + 0.5));

  function bm25f(p: Posting): number {
    let weighted = 0;
    SEARCH_FIELDS.forEach((field, f) => {
      const tf = p.tf[f] ?? 0;
      if (tf === 0) return;
      const len = lengths[p.doc]?.[f] ?? 0;
      const avg = avgLen[f] ?? 0;
      const norm = avg > 0 ? 1 - B + (B * len) / avg : 1;
      weighted += (FIELD_WEIGHTS[field] * tf) / norm;
    });
    return weighted / (K1 + weighted);
  }

  function search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const topK = opts.topK ?? DEFAULT_TOP_K;
    const raws = rawTokens(query);
    if (raws.length === 0 || topK < 1) return [];

    // One group per distinct query stem: the stems it may match, with weights.
    interface Group {
      label: string;
      stems: Map<string, number>;
    }
    // A prefix expansion must not re-score a word the user already typed in full ("balance bal").
    const exactStems = new Set(raws.map(stem));
    const groups = new Map<string, Group>();
    raws.forEach((raw, i) => {
      const s = stem(raw);
      let g = groups.get(s);
      if (g === undefined) {
        g = { label: raw, stems: new Map([[s, 1]]) };
        groups.set(s, g);
      }
      if (i === raws.length - 1 && [...raw].length >= 2) {
        for (const [word, wordStem] of vocab) {
          if (word.startsWith(raw) && !exactStems.has(wordStem) && !g.stems.has(wordStem)) g.stems.set(wordStem, PREFIX_WEIGHT);
        }
      }
    });

    const scores = new Map<number, number>();
    const hitTerms = new Map<number, Map<SearchField, Set<string>>>();
    for (const group of groups.values()) {
      const best = new Map<number, number>(); // doc -> best weighted contribution for this group
      const bestPosting = new Map<number, Posting>();
      for (const [term, weight] of group.stems) {
        const list = postings.get(term);
        if (list === undefined) continue;
        const w = idf(list.length) * weight;
        for (const p of list) {
          const c = w * bm25f(p);
          if (c > (best.get(p.doc) ?? 0)) {
            best.set(p.doc, c);
            bestPosting.set(p.doc, p);
          }
        }
      }
      for (const [doc, c] of best) {
        scores.set(doc, (scores.get(doc) ?? 0) + c);
        const p = bestPosting.get(doc)!;
        let perField = hitTerms.get(doc);
        if (perField === undefined) {
          perField = new Map();
          hitTerms.set(doc, perField);
        }
        SEARCH_FIELDS.forEach((field, f) => {
          if ((p.tf[f] ?? 0) === 0) return;
          let set = perField!.get(field);
          if (set === undefined) {
            set = new Set();
            perField!.set(field, set);
          }
          set.add(group.label);
        });
      }
    }

    const ranked: { doc: number; score: number }[] = [];
    for (const [doc, score] of scores) {
      const e = entries[doc]!;
      if (opts.approvedOnly === true && e.status !== 'approved') continue;
      if (e.status === 'deprecated' && opts.includeDeprecated !== true) continue;
      ranked.push({ doc, score: Math.round(score * 1e4) / 1e4 });
    }
    ranked.sort((a, b) => b.score - a.score || (entries[a.doc]!.id < entries[b.doc]!.id ? -1 : entries[a.doc]!.id > entries[b.doc]!.id ? 1 : 0));

    return ranked.slice(0, topK).map(({ doc, score }, i) => {
      const e = entries[doc]!;
      const perField = hitTerms.get(doc) ?? new Map<SearchField, Set<string>>();
      return {
        rank: i + 1,
        id: e.id,
        version: e.version,
        name: e.name,
        status: e.status,
        riskLevel: e.riskLevel,
        score,
        matched: SEARCH_FIELDS.filter((f) => perField.has(f)).map((field) => ({ field, terms: [...perField.get(field)!].sort() })),
      };
    });
  }

  return { size: n, search };
}
