/**
 * Text extraction parsing (parseExtracted) and output-spec coercion (coerceOutput).
 * Pure, synchronous, no I/O. See docs/design/replay.md and packages/core/src/replay/types.ts.
 */
import type { JsonType, ParseMode } from '../schema/index.js';
import type { InputValue, ParseResult } from './types.js';

function collapseWhitespace(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Keeps digits, '.', '-'; drops everything else (currency symbols, commas, letters, spaces). */
function stripToNumeric(s: string): string {
  return s.replace(/[^0-9.-]/g, '');
}

function hasDigit(s: string): boolean {
  return /[0-9]/.test(s);
}

/**
 * Parses one extracted string per a step/outcome `extract` action's `parse` mode.
 * Always whitespace-collapses + trims the raw text first.
 */
export function parseExtracted(raw: string, parse: ParseMode | undefined, pattern: string | undefined): ParseResult {
  const text = collapseWhitespace(raw);
  const mode = parse ?? 'text';

  switch (mode) {
    case 'text': {
      if (text === '') return { ok: false, reason: 'no text' };
      return { ok: true, value: text };
    }

    case 'number': {
      const stripped = stripToNumeric(text);
      if (!hasDigit(stripped)) return { ok: false, reason: `no digits found in "${text}"` };
      const n = Number(stripped);
      if (!Number.isFinite(n)) return { ok: false, reason: `"${text}" is not a finite number` };
      return { ok: true, value: n };
    }

    case 'currency': {
      // Accounting negative: a value wholly wrapped in parens, e.g. "($12.00)".
      let inner = text;
      let negative = false;
      if (inner.startsWith('(') && inner.endsWith(')')) {
        negative = true;
        inner = inner.slice(1, -1);
      }
      // "-$12.00" carries its own sign through stripToNumeric; "USD 1,234.56" loses the
      // letters/spaces and keeps the digits, '.', and any '-'.
      const stripped = stripToNumeric(inner);
      if (!hasDigit(stripped)) return { ok: false, reason: `no digits found in "${text}"` };
      let n = Number(stripped);
      if (!Number.isFinite(n)) return { ok: false, reason: `"${text}" is not a finite number` };
      if (negative) n = -Math.abs(n);
      return { ok: true, value: n };
    }

    case 'regex': {
      if (pattern === undefined) return { ok: false, reason: 'regex parse requires a pattern' };
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (err) {
        return { ok: false, reason: `invalid regex pattern /${pattern}/: ${err instanceof Error ? err.message : String(err)}` };
      }
      const m = re.exec(text);
      if (!m) return { ok: false, reason: `text "${text}" does not match pattern ${pattern}` };
      // A capture group's slot is undefined when the pattern has no group, or when an
      // optional group didn't participate in the match; fall back to the whole match.
      const value = m.length > 1 && m[1] !== undefined ? m[1] : m[0];
      return { ok: true, value };
    }

    default: {
      const _exhaustive: never = mode;
      return { ok: false, reason: `unknown parse mode "${String(_exhaustive)}"` };
    }
  }
}

/** Coerces an already-extracted InputValue to the JsonType declared by an OutputSpec. */
export function coerceOutput(value: InputValue, type: JsonType): ParseResult {
  switch (type) {
    case 'number': {
      if (typeof value === 'number') {
        return Number.isFinite(value) ? { ok: true, value } : { ok: false, reason: `${String(value)} is not a finite number` };
      }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        const n = Number(trimmed);
        if (trimmed !== '' && Number.isFinite(n)) return { ok: true, value: n };
      }
      return { ok: false, reason: `expected number, got ${JSON.stringify(value)}` };
    }

    case 'string': {
      if (typeof value === 'string') return { ok: true, value };
      if (typeof value === 'number' || typeof value === 'boolean') return { ok: true, value: String(value) };
      return { ok: false, reason: `expected string, got ${JSON.stringify(value)}` };
    }

    case 'boolean': {
      if (typeof value === 'boolean') return { ok: true, value };
      if (typeof value === 'string') {
        const s = value.toLowerCase();
        if (s === 'true' || s === 'yes') return { ok: true, value: true };
        if (s === 'false' || s === 'no') return { ok: true, value: false };
      }
      return { ok: false, reason: `expected boolean, got ${JSON.stringify(value)}` };
    }

    default: {
      const _exhaustive: never = type;
      return { ok: false, reason: `unknown output type "${String(_exhaustive)}"` };
    }
  }
}
