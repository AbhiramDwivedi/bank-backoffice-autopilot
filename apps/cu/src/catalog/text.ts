/**
 * Text helpers for capability search and the progressive-disclosure listing: a tokenizer, a
 * plural-only stemmer, and the one-line description rule. Pure functions, no I/O, no dependencies.
 *
 * Decisions worth knowing:
 *  - The stemmer folds plurals and nothing else. `-ing` / `-ed` rules were tried and dropped: in a
 *    credit-union domain they merge "savings" with "save" and "checking" with "check", which
 *    misranks the headline queries. A plural-only stemmer has a few misses ("statuses" does not
 *    meet "status") and no known harmful merges.
 *  - Tokenization is Unicode-aware (NFKC, letter/number classes, lower-cased) and splits
 *    kebab-case, snake_case and camelCase, so `lookup-member-savings-balance`,
 *    `lookup_member_savings_balance` and `savingsBalance` all index and query the same way, and
 *    accented text ("Müller", "café") matches itself. There is no transliteration (café does not
 *    match cafe) and no CJK word segmentation (a run of CJK characters is one token that matches
 *    only the identical run).
 */

/** Words too common in capability text to discriminate between capabilities. Kept short on purpose. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'its',
  'me', 'my', 'of', 'on', 'or', 'please', 'the', 'their', 'then', 'to', 'with',
]);

/**
 * Plural stemmer for lower-case words: `-ies` to `-y` (length > 4), `-sses` to `-ss`,
 * `-xes/-zes/-ches/-shes` drop `es`, and a plain trailing `s` is dropped except after `ss`, `us`
 * or `is` (status, access, analysis) and after `as` unless the word has 5+ letters (so `visas`,
 * `areas`, `quotas` meet their singulars while `gas` and `has` are left alone). Words that contain
 * digits or have 2 or fewer characters are returned unchanged. The result is an index key, not a
 * word.
 */
export function stem(word: string): string {
  if (/\d/u.test(word) || [...word].length <= 2) return word;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('sses')) return word.slice(0, -2);
  if (/(?:x|z|ch|sh)es$/u.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !/(?:ss|us|is)$/u.test(word)) {
    if (word.endsWith('as') && word.length < 5) return word;
    return word.slice(0, -1);
  }
  return word;
}

/**
 * Splits text into lower-case word tokens: NFKC-normalised; camelCase, kebab-case, snake_case,
 * spaces and punctuation all separate words; letters and numbers of any script are word
 * characters. Drops tokens shorter than 2 characters (code points) and stop words. Does NOT stem
 * (see `tokenize`); this is the surface form, used for prefix matching and for showing "matched
 * terms".
 */
export function rawTokens(text: string): string[] {
  return text
    .normalize('NFKC')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .map((t) => t.toLowerCase())
    .filter((t) => [...t].length >= 2 && !STOP_WORDS.has(t));
}

/** `rawTokens` followed by `stem`: the keys the search index is built from. */
export function tokenize(text: string): string[] {
  return rawTokens(text).map(stem);
}

/** Default cap for `oneLineDescription`, in characters including the trailing "...". */
export const ONE_LINE_MAX = 120;

/** Lower-case words that end in a period without ending the sentence. */
const NON_TERMINAL_WORDS = new Set(['e.g', 'i.e', 'vs', 'no', 'approx', 'inc', 'ltd', 'co', 'dr', 'mr', 'mrs', 'ms', 'st', 'u.s', 'u.k']);

/**
 * The deterministic one-line description shown at level 1 of progressive disclosure:
 *  1. collapse all whitespace runs to single spaces and trim;
 *  2. take the text up to and including the first sentence end: a `.`, `!` or `?` that is followed
 *     by the end of the text, or by whitespace and then an upper-case letter or a digit. A period
 *     after a single letter ("Q.") or one of `e.g`, `i.e`, `vs`, `no`, `approx`, `inc`, `ltd`,
 *     `co`, `dr`, `mr`, `mrs`, `ms`, `st`, `u.s`, `u.k` does not end it. This is a heuristic, good
 *     enough for descriptions written as prose; an unlisted abbreviation followed by a capital
 *     ("Ref. Number") still splits there;
 *  3. if that is longer than `max`, cut at the last word boundary that leaves room for "..." and
 *     append it (a single over-long word is hard-cut). When `max` is under 4 there is no room for
 *     "...": the text is hard-cut to `max` characters without it.
 * A trailing period is kept. The result never exceeds `max` characters.
 */
export function oneLineDescription(description: string, max: number = ONE_LINE_MAX): string {
  const text = description.replace(/\s+/g, ' ').trim();
  let end = text.length;
  const re = /[.!?](?=$|\s+[\p{Lu}\p{N}])/gu;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (text[m.index] === '.') {
      const before = text.slice(0, m.index);
      const lastWord = (/(\S+)$/u.exec(before)?.[1] ?? '').toLowerCase();
      if (/^\p{L}$/u.test(lastWord) || NON_TERMINAL_WORDS.has(lastWord)) continue;
    }
    end = m.index + 1;
    break;
  }
  const sentence = text.slice(0, end);
  if (sentence.length <= max) return sentence;
  if (max < 4) return sentence.slice(0, Math.max(0, max));
  const room = max - 3;
  const cut = sentence.slice(0, room);
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace > 0 && sentence[room] !== ' ' ? cut.slice(0, lastSpace) : cut.trimEnd();
  return `${base.replace(/[\s,;:.-]+$/, '')}...`;
}
