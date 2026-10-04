/**
 * Which locators find an element by where it is rather than by what it is. Shared by the recorder
 * (a record's target keeps no positional locator), replay (a positional fallback never settles an
 * ambiguity, and never answers a read the chain could name) and the validator
 * (`positional_only_target`). Judged on the locator as recorded, before input binding: a bound
 * `a[href="/members/12345"]` would read as positional, its recorded form
 * `a[href="/members/{input.memberId}"]` is identity.
 */
import type { Locator, TargetDescriptor } from './locator.js';

const INPUT_PLACEHOLDER_RE = /\{input\.[A-Za-z_][A-Za-z0-9_]*\}/;

/** Structural pseudo-classes: a selector using one picks an element by its position. */
const STRUCTURAL_PSEUDO_RE = /:(?:nth-(?:last-)?(?:child|of-type)|first-(?:child|of-type)|last-(?:child|of-type)|only-(?:child|of-type))\b/i;

/** A class or id naming a position rather than an identity: a bare number or one ending in one
 *  (`row-1`, `item_3`), or odd/even/first/last (`tr.odd`, `.is-first`). */
const INDEX_NAME_RE = /^(?:\d+|.*[-_]\d+|(?:.*[-_])?(?:odd|even|first|last))$/i;

/** An attribute value naming a position or one record: a bare number, or one ending in a number
 *  after a separator (`[data-index="0"]`, `a[href="/members/10009"]`). */
const INDEX_VALUE_RE = /(?:^|[^A-Za-z0-9])\d+$/;

/**
 * True for a locator that finds an element by where it is rather than by what it is:
 *  - a `bbox`;
 *  - a `css` selector with a structural pseudo-class (`:nth-of-type`, `:first-child`, ...);
 *  - one with a sibling combinator (`.item + .item`, `~`): it picks by what comes before;
 *  - one with any compound step that is a bare tag (`body > div > div`), naming no id, class or
 *    attribute;
 *  - one whose class or id names a position (`.row-1`, `tr.odd`, `#item-3`), or whose attribute
 *    value is or ends in a number (`[data-index="0"]`, `a[href="/members/10009"]`, which pins one
 *    record). An attribute holding a run input was canonicalized to its placeholder first, so
 *    `a[href="/members/{input.memberId}"]` is identity, bound to the input.
 * `#tabAccounts`, `input[name="memberId"]`, `span.title` and `form#search > button.go` are identity.
 */
export function isPositional(l: Locator): boolean {
  const s = l.strategy;
  if (s.kind === 'bbox') return true;
  if (s.kind !== 'css') return false;
  const sel = s.selector;
  if (STRUCTURAL_PSEUDO_RE.test(sel)) return true;
  const values: string[] = [];
  const bare = sel.replace(/\[([^\]=]+)(?:[~|^$*]?=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]/g, (_m, _n, a, b, c) => {
    values.push(a ?? b ?? c ?? '');
    return '[]';
  });
  if (/[+~]/.test(bare)) return true;
  if (values.some((v) => v !== '' && !INPUT_PLACEHOLDER_RE.test(v) && INDEX_VALUE_RE.test(v))) return true;
  for (const m of bare.matchAll(/[#.]([A-Za-z0-9_-]+)/g)) if (INDEX_NAME_RE.test(m[1]!)) return true;
  const compounds = bare.split(/\s*[>\s,]\s*/).filter((c) => c !== '');
  return compounds.some((c) => !/[#.[]/.test(c));
}

/** True when every locator of the chain is positional: nothing in it names the element. */
export function isPositionalOnly(target: TargetDescriptor): boolean {
  return target.locators.every(isPositional);
}
