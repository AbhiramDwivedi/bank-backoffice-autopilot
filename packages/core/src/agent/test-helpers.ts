/**
 * Shared helpers for the discovery agent's test suites.
 *
 * FakeSurface refs are positional per screen and valid only for the observation they were shown
 * in (see packages/core/src/surface/fake.ts), so a scripted LLM turn cannot hardcode a ref -- it must read the
 * current turn's ELEMENTS section (formatted by `formatElementLine` in ./prompt.ts) and find the
 * ref it wants by role + name/text substring. That keeps the tests robust to unrelated edits in
 * the fake-scenario fixtures: element names and roles may change, but the *shape* of the ELEMENTS
 * line format is what's parsed here.
 */
import { readFileSync } from 'node:fs';

/** One `ELEMENTS:` line parsed out of a turn's request text. */
export interface ParsedElement {
  ref: string;
  role: string;
  name: string;
  frame: string;
  text?: string;
  value?: string;
  disabled: boolean;
}

const ELEMENT_LINE_RE = /^\[(e\d+)]\s+(\S+)\s+"([^"]*)"\s+\(frame:\s*([^)]*)\)(.*)$/;

/** Parses every `ELEMENTS:` line out of a turn's full request text (system + message text, per
 *  `requestText` in ./scripted-llm.ts). Lines that don't match the `[eN] role "name" (frame: f)`
 *  shape (i.e. everything outside the ELEMENTS section) are silently skipped. */
function parseElements(text: string): ParsedElement[] {
  const out: ParsedElement[] = [];
  for (const line of text.split('\n')) {
    const m = ELEMENT_LINE_RE.exec(line);
    if (!m) continue;
    const [, ref, role, name, frame, rest] = m;
    const textMatch = /text="([^"]*)"/.exec(rest!);
    const valueMatch = /value="([^"]*)"/.exec(rest!);
    out.push({
      ref: ref!,
      role: role!,
      name: name!,
      frame: frame!.trim(),
      ...(textMatch ? { text: textMatch[1] } : {}),
      ...(valueMatch ? { value: valueMatch[1] } : {}),
      disabled: /(?:^|\s)disabled(?:\s|$)/.test(rest!),
    });
  }
  return out;
}

/** Constraints for {@link findRef}: every given field must match. */
export interface FindRefQuery {
  role?: string;
  /** Substring match against the element's accessible name. */
  nameIncludes?: string;
  /** Substring match against the element's visible text. */
  textIncludes?: string;
  /** Substring match against the element's frame label (e.g. "main", "top"). */
  frameIncludes?: string;
}

/** Finds the ref of the (first) element in `text`'s ELEMENTS section matching every given
 *  constraint. Throws a descriptive error (naming what was searched for and what was actually on
 *  screen) rather than returning undefined, so a scenario mismatch fails loudly at the point of
 *  use instead of producing a confusing "Unknown ref" from the agent loop. */
export function findRef(text: string, query: FindRefQuery): string {
  const elements = parseElements(text);
  const match = elements.find((e) => {
    if (query.role !== undefined && e.role !== query.role) return false;
    if (query.nameIncludes !== undefined && !e.name.includes(query.nameIncludes)) return false;
    if (query.textIncludes !== undefined && !(e.text ?? '').includes(query.textIncludes)) return false;
    if (query.frameIncludes !== undefined && !e.frame.includes(query.frameIncludes)) return false;
    return true;
  });
  if (!match) {
    const have = elements.map((e) => `${e.role}:"${e.name}"(${e.frame})`).join(', ');
    throw new Error(`test helper: no element matched ${JSON.stringify(query)}. On screen: ${have || '(none)'}`);
  }
  return match.ref;
}

// -------------------------------------------------------------------------------------------
// Small evidence-file readers.
// -------------------------------------------------------------------------------------------

/** Reads a file as UTF-8 text. */
export function readTextFile(path: string): string {
  return readFileSync(path, 'utf8');
}

/** One JSON value per non-empty line (events.jsonl / transcript.jsonl). */
export function readJsonlFile(path: string): unknown[] {
  const raw = readTextFile(path).trim();
  if (raw.length === 0) return [];
  return raw.split('\n').map((line) => JSON.parse(line));
}
