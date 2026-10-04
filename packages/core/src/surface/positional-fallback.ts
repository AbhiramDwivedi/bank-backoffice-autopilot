/**
 * The replay rule for a target's fallback chain: replay never settles an ambiguity by position, and
 * never reads by position when the chain has a named way to find the value.
 *
 * A surface resolves a chain by "first unique match wins", and reports what missed before the
 * winner (`Resolution.tried`). This module decides, from that report, whether the winner may be
 * used. It is refused when the winning locator is positional (`isPositional`: a bbox, a structural
 * css) and either
 *
 *  (a) an earlier locator that names the element (anything not positional) matched several
 *      candidates. The chain could not tell which one was meant, so a position must not pick one:
 *      at replay, where the page lists other records, it would pick whatever sits there. Any use.
 *  (b) the target is read (`extract`) and the chain holds any locator that names the element. None
 *      of them found it, so nothing ties the element at that position to the value that was
 *      recorded. An action that falls back to a position still has its checkpoint; a read has
 *      nothing after it.
 *
 * A chain of positional locators only is not refused here: there is nothing to compare a position
 * against (the validator warns about such a read, `positional_only_target`).
 *
 * Positional-ness is judged on the target AS RECORDED, before input binding. Pure; no surface call.
 */
import { isPositional, type TargetDescriptor } from '../schema/index.js';
import type { TriedStrategy } from './types.js';

/** The part of a found `Resolution` the rule reads. */
export interface FoundLocator {
  strategyIndex: number;
  tried: readonly TriedStrategy[];
}

/** Why a resolved target was not used, in the three strings a typed step failure carries. */
export interface PositionalFallbackRefusal {
  /** `ambiguous`: rule (a). `positional_read`: rule (b). */
  reason: 'ambiguous' | 'positional_read';
  /** The positional locator that won and was not used. */
  winner: { index: number; kind: string };
  /** Rule (a): the naming locator that matched several candidates. */
  ambiguous?: { index: number; kind: string; matches?: number };
  expected: string;
  observed: string;
  message: string;
}

function triedSummary(tried: readonly TriedStrategy[]): string {
  return tried.map((t) => `${t.strategyKind}: ${t.error}`).join('; ');
}

/**
 * Applies the rule to one resolution. `recorded` is the target before input binding; `found` is
 * what the surface reported for its bound form. `read`: the element's text is the result (an
 * `extract`). Returns undefined when the winner may be used.
 */
export function positionalFallbackRefusal(recorded: TargetDescriptor, found: FoundLocator, opts: { read: boolean }): PositionalFallbackRefusal | undefined {
  const winning = recorded.locators[found.strategyIndex];
  if (winning === undefined || !isPositional(winning)) return undefined;
  const winner = { index: found.strategyIndex, kind: winning.strategy.kind };
  const notUsed = `the positional ${winner.kind} locator at depth ${winner.index} matched and was not used`;

  for (let i = 0; i < found.strategyIndex; i++) {
    const t = found.tried[i];
    const locator = recorded.locators[i];
    if (t?.ambiguous !== true || locator === undefined || isPositional(locator)) continue;
    const kind = locator.strategy.kind;
    const count = t.matches !== undefined ? `${t.matches} candidates` : 'several candidates';
    return {
      reason: 'ambiguous',
      winner,
      ambiguous: { index: i, kind, ...(t.matches !== undefined ? { matches: t.matches } : {}) },
      expected: `exactly one match for a locator that names "${recorded.description}"`,
      observed: `${count} matched its ${kind} locator (${triedSummary(found.tried)}); ${notUsed}`,
      message: `${count} matched the ${kind} locator of "${recorded.description}"; replay does not settle an ambiguity by position (${winner.kind} fallback at depth ${winner.index} not used)`,
    };
  }

  if (opts.read) {
    const naming = recorded.locators.map((l, i) => ({ i, kind: l.strategy.kind, positional: isPositional(l) })).filter((l) => !l.positional);
    if (naming.length > 0) {
      // A naming locator listed after the winner was never tried: the chain is in the wrong order.
      const untried = naming.filter((l) => l.i > found.strategyIndex).map((l) => l.kind);
      const why =
        untried.length === 0
          ? `no locator that names it matched (${triedSummary(found.tried)})`
          : `the locators that name it (${untried.join(', ')}) come after the positional one and were not tried`;
      return {
        reason: 'positional_read',
        winner,
        expected: `"${recorded.description}" found by a locator that names it (${naming.map((l) => l.kind).join(', ')}) before its value is read`,
        observed: `${why}; ${notUsed}`,
        message: `a positional fallback (${winner.kind} at depth ${winner.index}) was not used for a read of "${recorded.description}": ${untried.length === 0 ? 'none of the locators that name it matched' : 'no locator that names it was tried before it'}`,
      };
    }
  }
  return undefined;
}
