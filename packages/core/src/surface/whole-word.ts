/**
 * The whole-word rule for a bound value inside a longer text, shared by every surface so the web,
 * desktop and fake resolvers cannot drift apart. Case-sensitive. The value counts when no letter or
 * digit touches it, and when no joiner (`- _ / @ ' . `) links it to the next letter or digit: a
 * hyphen does not end a word, so "A-1001" is not a whole word of "A-1001-B", nor "Smith" of
 * "Smith-Jones". It is still a whole word of "Lee Wong" and of "Lee, Ann". Callers pass text
 * already collapsed with `collapseWhitespace`.
 */
const ALNUM = /[\p{L}\p{N}]/u;
const JOINER = /[-_/@'’.]/;

function touches(text: string, edge: number, step: 1 | -1): boolean {
  const next = text[edge];
  if (next === undefined) return false;
  if (ALNUM.test(next)) return true;
  if (!JOINER.test(next)) return false;
  const beyond = text[edge + step];
  return beyond !== undefined && ALNUM.test(beyond);
}

export function holdsWholeWord(text: string, wanted: string): boolean {
  if (wanted === '') return false;
  for (let i = text.indexOf(wanted); i !== -1; i = text.indexOf(wanted, i + 1)) {
    if (!touches(text, i - 1, -1) && !touches(text, i + wanted.length, 1)) return true;
  }
  return false;
}
