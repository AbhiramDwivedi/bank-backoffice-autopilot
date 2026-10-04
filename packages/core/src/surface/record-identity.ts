/**
 * The comparison behind a record identity check on a read (`ExtractAction.identity`). Discovery
 * makes it once, on the page it records from, to decide whether to record the check; replay makes
 * it again on the page it reads from. Both sides use this one function, so a value that passes at
 * record time passes on the same page at replay.
 *
 * The input's value is a whole word of the container's text, by the same rule row anchors use
 * (`holdsWholeWord`): "Smith" is not found in "Al Smithers", "12345" not in "123456", and "A-1001"
 * not in "A-1001-B". It is case-sensitive, like the recorder's record membership, and whitespace
 * is collapsed on both sides. An empty value is never shown.
 */
import { collapseWhitespace } from './conditions.js';
import { holdsWholeWord } from './whole-word.js';

/** True when `value` occurs in `text` as a whole word. */
export function recordTextShows(text: string, value: string): boolean {
  const v = collapseWhitespace(value);
  if (v === '') return false;
  return holdsWholeWord(collapseWhitespace(text), v);
}
