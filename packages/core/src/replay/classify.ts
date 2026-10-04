/**
 * classify.ts -- classifyFailure(ctx, signal): dialog -> session expired -> app error -> original.
 *
 * Design notes (things the contract in types.ts left to judgement):
 *
 * - The dialog branch's `observed` is always the fixed string "a native dialog is open".
 *   Reporting the actual dialog text would be more informative, but `observe()` must never be
 *   called while a dialog is open (a real browser can hang on it), and the `Surface` interface
 *   has no other way to read a dialog's message -- `check()` only returns a boolean. The fixed
 *   string is what ships until a future Surface variant exposes the dialog message some other way.
 * - The dialog branch's rewritten `message` embeds the *original* FailureCode by name (e.g.
 *   "...while classifying a checkpoint_failed failure...") so the original failure reason is not
 *   lost when a dialog interrupts classification.
 * - `originalCode` is only set, and the message/observed rewritten, when the code actually
 *   changes. A signal that already arrives as `unexpected_dialog` (the surface itself detected
 *   it) is left with its own message/observed once the dialog is confirmed still open, rather
 *   than being overwritten with the generic template above.
 */
import { collapseWhitespace } from '../surface/index.js';
import { NON_PAGE_CODES, type ClassifiedFailure, type ClassifyContext, type FailureSignal } from './types.js';

const EXCERPT_MAX = 300;

/** Case-insensitive substring search; returns the first signal from the list found in `text`. */
export function matchSignal(text: string, signals: readonly string[]): string | undefined {
  const haystack = text.toLowerCase();
  for (const signal of signals) {
    if (signal.length === 0) continue;
    if (haystack.includes(signal.toLowerCase())) return signal;
  }
  return undefined;
}

/**
 * Whitespace-collapsed excerpt of `text`, capped at `EXCERPT_MAX` chars. When `matched` is
 * given the window is centred on its first (case-insensitive) occurrence; otherwise the excerpt
 * starts at the beginning of the text.
 */
function buildExcerpt(text: string, matched: string | undefined): string {
  const collapsed = collapseWhitespace(text);
  if (collapsed.length <= EXCERPT_MAX) return collapsed;
  if (matched === undefined) return collapsed.slice(0, EXCERPT_MAX);
  const idx = collapsed.toLowerCase().indexOf(matched.toLowerCase());
  if (idx === -1) return collapsed.slice(0, EXCERPT_MAX);
  const centre = idx + Math.floor(matched.length / 2);
  let start = centre - Math.floor(EXCERPT_MAX / 2);
  if (start < 0) start = 0;
  if (start + EXCERPT_MAX > collapsed.length) start = collapsed.length - EXCERPT_MAX;
  return collapsed.slice(start, start + EXCERPT_MAX);
}

function classifyDialog(signal: FailureSignal): ClassifiedFailure {
  const observed = 'a native dialog is open';
  if (signal.code === 'unexpected_dialog') {
    return { ...signal, observed };
  }
  return {
    ...signal,
    code: 'unexpected_dialog',
    originalCode: signal.code,
    message: `a native dialog is open while classifying a ${signal.code} failure: ${signal.message}`,
    observed,
  };
}

function rewriteForPageMatch(signal: FailureSignal, newCode: 'session_expired' | 'app_error', matched: string, excerpt: string): ClassifiedFailure {
  if (newCode === signal.code) return { ...signal, textExcerpt: excerpt, matchedSignal: matched };
  const label = newCode === 'session_expired' ? 'session expired' : 'app error';
  return {
    ...signal,
    code: newCode,
    originalCode: signal.code,
    message: `${label} (page shows "${matched}") while ${signal.message}`,
    observed: excerpt,
    textExcerpt: excerpt,
    matchedSignal: matched,
  };
}

function keepOriginal(signal: FailureSignal, excerpt: string): ClassifiedFailure {
  if (signal.code === 'checkpoint_failed') {
    const observed = signal.observed === '' ? `page text: "${excerpt}"` : `${signal.observed}; page text: "${excerpt}"`;
    return { ...signal, observed, textExcerpt: excerpt };
  }
  return { ...signal, textExcerpt: excerpt };
}

/**
 * Order: dialog check (no `observe()` -- see file header) -> session-expired page text ->
 * app-error page text -> original code. `NON_PAGE_CODES` (replay-internal codes) are returned
 * unchanged with zero surface calls. Any surface error during classification returns the
 * original signal unchanged (classification never throws).
 */
export async function classifyFailure(ctx: ClassifyContext, signal: FailureSignal): Promise<ClassifiedFailure> {
  if (NON_PAGE_CODES.includes(signal.code)) return { ...signal };

  let dialogOpen: boolean;
  try {
    dialogOpen = await ctx.surface.check({ kind: 'dialog_open' });
  } catch {
    return { ...signal };
  }
  if (dialogOpen) return classifyDialog(signal);

  let textDigest: string;
  try {
    const observation = await ctx.surface.observe();
    textDigest = observation.textDigest;
  } catch {
    return { ...signal };
  }

  const sessionMatch = matchSignal(textDigest, ctx.sessionExpiredSignals);
  if (sessionMatch !== undefined) {
    return rewriteForPageMatch(signal, 'session_expired', sessionMatch, buildExcerpt(textDigest, sessionMatch));
  }
  const appErrorMatch = matchSignal(textDigest, ctx.appErrorSignals);
  if (appErrorMatch !== undefined) {
    return rewriteForPageMatch(signal, 'app_error', appErrorMatch, buildExcerpt(textDigest, appErrorMatch));
  }
  return keepOriginal(signal, buildExcerpt(textDigest, undefined));
}
