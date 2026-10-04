/**
 * Deep redaction for evidence data. Redaction happens at the sink (the run logger and artifact
 * emission), not at the point data is produced: this module takes an arbitrary JS value (event
 * data, a DOM snapshot, a `ReplayResult`) and returns a redacted deep copy, never touching the
 * original.
 *
 * Two independent mechanisms, both always active:
 * 1. Sensitive keys — a property whose key looks like it holds a secret has its whole value
 *    replaced with `[REDACTED:<key>]`, regardless of the value's type.
 * 2. Patterns — every string leaf (including array entries and stringified numbers/bigints) is
 *    scanned for secret/PII-shaped substrings (SSN, card numbers, bearer tokens, local filesystem
 *    paths, plus anything a Policy adds), and matches are replaced inline.
 *
 * `RedactorOptions.sensitiveKeys` / `.patterns` are merged with the defaults, never replace them:
 * a caller can only add redaction, never remove it. Key matching is case-insensitive and
 * normalizes by lowercasing and stripping `-`/`_`, then matches as a substring — except the
 * literal key `pin`, matched only as the whole normalized key, since substring matching would
 * flag ordinary words like `shipping` or `opinion`.
 */
import { REDACTED_VALUE, type Policy } from '../schema/index.js';

/** A regex-based redaction rule applied to every string leaf. */
export interface RedactionPattern {
  name: string;
  /** String sources are compiled with flags 'gi' (policy convention: case-insensitive). A
   *  RegExp instance is used as-is except the 'g' flag is added if missing (so `.replace` finds
   *  every occurrence, not just the first). */
  regex: string | RegExp;
  /** Defaults to `[REDACTED:<name>]`. */
  replacement?: string;
}

/** Extra sensitive keys and patterns for `createRedactor`, merged with the built-in defaults. */
export interface RedactorOptions {
  /** Merged with {@link DEFAULT_SENSITIVE_KEYS} — defaults are always applied, never replaced. */
  sensitiveKeys?: string[];
  /** Merged with {@link DEFAULT_PATTERNS} — defaults are always applied, never replaced. */
  patterns?: RedactionPattern[];
}

/** Returns a redacted deep copy of `value`; never mutates the input. */
export type Redactor = (value: unknown) => unknown;

/** Object keys whose values are always fully replaced, regardless of type. */
export const DEFAULT_SENSITIVE_KEYS: readonly string[] = [
  'password',
  'passwd',
  'token',
  'secret',
  'authorization',
  'cookie',
  'set-cookie',
  'apikey',
  'api_key',
  'ssn',
  'pin',
];

/**
 * Matches a local, absolute filesystem path: a Windows drive path (`C:\...` or `C:/...`), a UNC
 * path (`\\server\share\...`), or a POSIX path rooted at a well-known top-level directory
 * (`/home/`, `/Users/`, `/root/`, `/tmp/`, `/var/`, `/etc/`, `/opt/`, `/private/`, `/mnt/`,
 * `/usr/`, `/srv/`). Exported (not just used inline) so `apps/relay/src/server/errors.ts` can
 * strip the same shape out of an error message before it ever reaches the redactor.
 *
 * Deliberately does NOT match:
 * - `http(s)://host/path` — the drive-letter branch requires the letter not be preceded by
 *   another word character, which excludes the `p` in `http:` / `s` in `https:`; the POSIX
 *   branch's root names never match a URL's own path segments (`/transfer`, `/accounts/123`).
 * - a run-dir-relative evidence path (`shots/3.png`, `dom/3.html`) — those never start with a
 *   drive letter, `\\`, or one of the POSIX root names.
 * - a CSS selector's `/` (`a[href="/accounts/123"]`) — `accounts` is not a recognized root name.
 * - a date (`2026/09/26`) or a fraction (`1/2`) — neither has a drive letter or a root name.
 *
 * Conservative by design: an absolute path outside these well-known roots (e.g. `/data/x`) is not
 * caught. See docs/design/security-review.md ("Limits of the guardrail model").
 */
export const FILESYSTEM_PATH_PATTERN: RegExp =
  /(?:(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^\s"'<>|]*)|(?:\\\\[^\s\\]+\\[^\s\\]+(?:\\[^\s\\]+)*)|(?:(?<![\w:./])[\\/](?:home|Users|root|tmp|var|etc|opt|private|mnt|usr|srv)[\\/][^\s"'<>|]*)/gi;

export const DEFAULT_PATTERNS: readonly RedactionPattern[] = [
  { name: 'ssn', regex: '\\b\\d{3}-\\d{2}-\\d{4}\\b', replacement: '[REDACTED:ssn]' },
  // 13-19 digits total, digits optionally separated by a single space or dash (covers grouped
  // "4111 1111 1111 1111" / "4111-1111-1111-1111" and ungrouped "4111111111111111"). Deliberately
  // requires a run this long so it never fires on ISO timestamps, small numbers, or 5-digit
  // member ids like 12345.
  { name: 'card', regex: '\\b(?:\\d[ -]?){12,18}\\d\\b', replacement: '[REDACTED:card]' },
  { name: 'token', regex: '\\bBearer\\s+\\S+', replacement: 'Bearer [REDACTED:token]' },
  { name: 'path', regex: FILESYSTEM_PATH_PATTERN, replacement: '[REDACTED:path]' },
];

/** Lowercase and strip separators so `X-Auth-Token`, `x_auth_token`, `xAuthToken` all compare equal. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

/**
 * `pin` matches only the whole normalised key (see module doc for why); every other sensitive
 * key matches as a substring of the normalised field name.
 */
function isSensitiveKey(key: string, sensitiveKeysNormalized: readonly string[]): boolean {
  const normalized = normalizeKey(key);
  for (const sk of sensitiveKeysNormalized) {
    if (sk === 'pin' ? normalized === 'pin' : normalized.includes(sk)) return true;
  }
  return false;
}

interface CompiledPattern {
  name: string;
  regex: RegExp;
  replacement: string;
}

function compilePattern(p: RedactionPattern): CompiledPattern {
  const replacement = p.replacement ?? `[REDACTED:${p.name}]`;
  if (typeof p.regex === 'string') {
    return { name: p.name, regex: new RegExp(p.regex, 'gi'), replacement };
  }
  const flags = p.regex.flags.includes('g') ? p.regex.flags : `${p.regex.flags}g`;
  return { name: p.name, regex: new RegExp(p.regex.source, flags), replacement };
}

function applyPatterns(input: string, compiled: readonly CompiledPattern[]): string {
  let out = input;
  for (const c of compiled) {
    out = out.replace(c.regex, c.replacement);
  }
  return out;
}

/** Converts a `Policy['redaction']['patterns']` entry list into {@link RedactionPattern}s. */
export function redactionPatternsFromPolicy(p: Policy['redaction']['patterns']): RedactionPattern[] {
  return p.map((entry) => ({ name: entry.name, regex: entry.regex, replacement: entry.replacement }));
}

interface Ctx {
  sensitiveKeysNormalized: readonly string[];
  patterns: readonly CompiledPattern[];
  /** Objects currently being visited on the current DFS path, to detect cycles. */
  ancestors: WeakSet<object>;
}

/**
 * Keys are scanned with the same pattern set as values: a secret-shaped string used as a
 * property name (e.g. `{[ssn]: name}`, a compact lookup-by-id structure someone logs by hand) is
 * redacted in the key position too, not just the value. `sensitiveKeys` matching is unaffected
 * (it already matches on the key), so this only ever adds coverage.
 *
 * Trade-off: two distinct original keys that happen to match the same pattern (e.g. two
 * different SSNs) collapse to the same redacted key (`"[REDACTED:ssn]"`), so one entry silently
 * overwrites the other in `out`. Evidence is redacted for safety, not for completeness, the same
 * reasoning behind the card pattern's deliberate over-redaction.
 */
function redactKey(key: string, ctx: Ctx): string {
  return applyPatterns(key, ctx.patterns);
}

function redactPlainObjectEntries(obj: Record<string, unknown>, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value === 'function' || typeof value === 'symbol') continue; // dropped
    const sensitive = isSensitiveKey(key, ctx.sensitiveKeysNormalized);
    const outKey = sensitive ? key : redactKey(key, ctx);
    out[outKey] = sensitive ? `[REDACTED:${key}]` : redactValue(value, ctx);
  }
  return out;
}

function redactValue(value: unknown, ctx: Ctx): unknown {
  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t === 'string') return applyPatterns(value as string, ctx.patterns);
  if (t === 'boolean') return value;
  if (t === 'bigint') return applyPatterns((value as bigint).toString(), ctx.patterns);
  if (t === 'function' || t === 'symbol') return undefined; // dropped by caller in normal traversal
  if (t === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) return n;
    const s = String(n);
    const replaced = applyPatterns(s, ctx.patterns);
    return replaced === s ? n : replaced;
  }

  if (value instanceof Date) return applyPatterns(value.toISOString(), ctx.patterns);
  if (Buffer.isBuffer(value)) return `[binary ${value.length} bytes]`;
  if (value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`;

  if (typeof value === 'object') {
    const obj = value;
    if (ctx.ancestors.has(obj)) return '[Circular]';

    if (Array.isArray(obj)) {
      ctx.ancestors.add(obj);
      const out = obj
        .filter((el) => typeof el !== 'function' && typeof el !== 'symbol')
        .map((el) => redactValue(el, ctx));
      ctx.ancestors.delete(obj);
      return out;
    }

    if (obj instanceof Map) {
      ctx.ancestors.add(obj);
      const out: Record<string, unknown> = {};
      for (const [rawKey, rawValue] of obj.entries()) {
        if (typeof rawValue === 'function' || typeof rawValue === 'symbol') continue;
        const key = String(rawKey);
        const sensitive = isSensitiveKey(key, ctx.sensitiveKeysNormalized);
        const outKey = sensitive ? key : redactKey(key, ctx);
        out[outKey] = sensitive ? `[REDACTED:${key}]` : redactValue(rawValue, ctx);
      }
      ctx.ancestors.delete(obj);
      return out;
    }

    if (obj instanceof Set) {
      ctx.ancestors.add(obj);
      const out = Array.from(obj.values())
        .filter((el) => typeof el !== 'function' && typeof el !== 'symbol')
        .map((el) => redactValue(el, ctx));
      ctx.ancestors.delete(obj);
      return out;
    }

    ctx.ancestors.add(obj);
    const out = redactPlainObjectEntries(obj as Record<string, unknown>, ctx);
    ctx.ancestors.delete(obj);
    return out;
  }

  return value;
}

/** Builds a `Redactor` combining the built-in sensitive keys and patterns with `opts`. */
export function createRedactor(opts: RedactorOptions = {}): Redactor {
  const sensitiveKeysNormalized = Array.from(
    new Set([...DEFAULT_SENSITIVE_KEYS, ...(opts.sensitiveKeys ?? [])].map(normalizeKey)),
  );
  const patterns = [...DEFAULT_PATTERNS, ...(opts.patterns ?? [])].map(compilePattern);

  return (value: unknown): unknown => {
    const ctx: Ctx = { sensitiveKeysNormalized, patterns, ancestors: new WeakSet<object>() };
    return redactValue(value, ctx);
  };
}

/** A known value to scrub, with an optional replacement of its own. */
export interface ScrubValue {
  value: string;
  placeholder?: string;
}

/** Options for `createValueScrubber`. */
export interface ValueScrubberOptions {
  /** Values shorter than this are ignored. Defaults to 1. */
  minLength?: number;
  /** Replacement for a value registered without its own placeholder. Defaults to {@link REDACTED_VALUE}. */
  placeholder?: string;
  /** Also scrub number and bigint leaves; a leaf that contains a value becomes a string. Defaults to false. */
  numbers?: boolean;
}

/**
 * Replaces known plaintext values (bound secrets, sensitive inputs) wherever they appear. Matching
 * is a case-insensitive literal substring match in a single pass over the input, longest value
 * first, so an echoed value in another case is caught, a short value never pre-empts a longer one
 * that contains it, and a replacement is never matched again. Placeholders already in the input
 * (`[REDACTED]`, `[REDACTED:<name>]`, and every registered placeholder) are kept whole, so
 * scrubbing twice gives the same result as scrubbing once.
 *
 * Each value's encoded forms are matched too: `encodeURIComponent`, the `+`-for-space query form,
 * the form encoding `URLSearchParams` produces (which also encodes `! ' ( ) ~`), every
 * non-alphanumeric character percent-encoded (hex digits in either case), and the HTML-escaped
 * form. So a value that lands in a URL (a query string, a navigated-to address) or in markup is
 * caught there.
 */
export interface ValueScrubber {
  /** Registers another value. Values shorter than `minLength` are ignored. */
  add(value: string, placeholder?: string): void;
  text(s: string): string;
  /**
   * Returns a deep copy with every content string leaf scrubbed. Object keys and Buffers are left
   * as-is, and so are structural fields (see {@link isStructuralField}): ids, timestamps,
   * enumerations and evidence paths, so a scrubbed record still parses and still addresses the
   * same run, step and files.
   */
  deep<T>(value: T): T;
  /** The registered raw values. */
  values(): string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every character outside `[A-Za-z0-9]` as `%XX` UTF-8 bytes. */
function percentEncodeAll(value: string): string {
  let out = '';
  for (const ch of value) {
    if (/[A-Za-z0-9]/.test(ch)) {
      out += ch;
      continue;
    }
    for (const byte of Buffer.from(ch, 'utf8')) out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function htmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The raw value plus the forms it takes inside a URL or markup. A value that encodes to itself
 * adds nothing. Hex digits need no lower-case variant: matching is case-insensitive.
 */
function encodedForms(value: string): string[] {
  const forms = [value, htmlEscape(value)];
  try {
    const uri = encodeURIComponent(value);
    forms.push(uri, uri.replace(/%20/g, '+'), new URLSearchParams({ x: value }).toString().slice(2), percentEncodeAll(value));
  } catch {
    // A lone surrogate cannot be URI-encoded; the raw and HTML forms are still matched.
  }
  return [...new Set(forms)];
}

/** A placeholder the redactors write: `[REDACTED]` or `[REDACTED:<name>]`. */
const GENERIC_PLACEHOLDER_SOURCE = '\\[REDACTED(?::[^\\]\\s]{1,64})?\\]';

/** Keys whose string value is an identifier: never scrubbed, so records keep addressing the same run, step and holder. */
const ID_KEYS: ReadonlySet<string> = new Set([
  'id',
  'runId',
  'stepId',
  'afterStepId',
  'capabilityId',
  'capabilityVersion',
  'interventionId',
  'discoveryRunId',
  'heldBy',
  'holder',
  'by',
]);
/** Keys whose value is an enumeration member, kept when it looks like one (a lower-case word). */
const ENUM_KEYS: ReadonlySet<string> = new Set([
  'kind',
  'code',
  'status',
  'state',
  'type',
  'runKind',
  'resumeFrom',
  'from',
  'to',
  'change',
  'strategyKind',
  'captureMode',
  'resolution',
]);
/** Keys whose value is a run-dir-relative evidence path, kept when it looks like one. */
const PATH_KEYS: ReadonlySet<string> = new Set(['screenshot', 'dom', 'screenshotPath', 'evidencePath']);
/** Keys whose object value holds caller-named fields (a result's outputs, an outcome's data): everything under them is content. */
const CONTENT_CONTAINER_KEYS: ReadonlySet<string> = new Set(['outputs', 'data']);

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const ENUM_VALUE = /^[a-z][a-z_]*$/;
const RELATIVE_EVIDENCE_PATH = /^[\w-][\w.-]*(?:\/[\w.-]+)*\.(?:png|html|json|jpe?g)$/;

/**
 * Whether the string `value` under `key` is structural rather than content: an id
 * ({@link ID_KEYS}), a timestamp (`ts`, `at` or any `...At` key holding an ISO date-time), an
 * enumeration member ({@link ENUM_KEYS} holding a lower-case word) or a run-dir-relative evidence
 * path ({@link PATH_KEYS}). A deep scrub leaves numbers alone unless asked, so counters and
 * durations need no entry.
 */
export function isStructuralField(key: string, value: string): boolean {
  if (ID_KEYS.has(key)) return true;
  if ((key === 'ts' || key === 'at' || /[a-z]At$/.test(key)) && ISO_TIMESTAMP.test(value)) return true;
  if (ENUM_KEYS.has(key) && ENUM_VALUE.test(value)) return true;
  if (PATH_KEYS.has(key) && RELATIVE_EVIDENCE_PATH.test(value) && !value.split('/').includes('..')) return true;
  return false;
}

interface CompiledScrub {
  /** Every placeholder, then every form of every value (longest first), as one alternation. */
  re: RegExp;
  /** Lower-cased form to the placeholder that replaces it. */
  byForm: Map<string, string>;
  /** Matches exactly one placeholder: such a match is left in place. */
  keep: RegExp;
}

/** Creates a {@link ValueScrubber} seeded with `initial`. */
export function createValueScrubber(initial: Iterable<string | ScrubValue> = [], opts: ValueScrubberOptions = {}): ValueScrubber {
  const minLength = Math.max(1, opts.minLength ?? 1);
  const fallback = opts.placeholder ?? REDACTED_VALUE;
  const entries = new Map<string, string>();
  let compiledState: CompiledScrub | undefined;

  function add(value: string, placeholder?: string): void {
    if (value.length < minLength || entries.has(value)) return;
    entries.set(value, placeholder ?? fallback);
    compiledState = undefined;
  }

  function compiled(): CompiledScrub | undefined {
    if (entries.size === 0) return undefined;
    if (compiledState === undefined) {
      const byForm = new Map<string, string>();
      for (const [value, placeholder] of entries) {
        for (const form of encodedForms(value)) {
          const k = form.toLowerCase();
          if (!byForm.has(k)) byForm.set(k, placeholder);
        }
      }
      const placeholders = [...new Set([fallback, ...entries.values()])].sort((a, b) => b.length - a.length).map(escapeRegExp);
      const keepSource = [GENERIC_PLACEHOLDER_SOURCE, ...placeholders].join('|');
      const forms = [...byForm.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
      // Placeholders come first, so one already in the text is consumed whole and never re-matched.
      compiledState = { re: new RegExp(`${keepSource}|${forms.join('|')}`, 'gi'), byForm, keep: new RegExp(`^(?:${keepSource})$`, 'i') };
    }
    return compiledState;
  }

  function text(s: string): string {
    const c = compiled();
    if (c === undefined || s.length === 0) return s;
    return s.replace(c.re, (match) => (c.keep.test(match) ? match : (c.byForm.get(match.toLowerCase()) ?? fallback)));
  }

  function walk(value: unknown, contentOnly: boolean): unknown {
    if (typeof value === 'string') return text(value);
    if (opts.numbers === true && (typeof value === 'number' || typeof value === 'bigint')) {
      const asText = String(value);
      const scrubbed = text(asText);
      return scrubbed === asText ? value : scrubbed;
    }
    if (value === null || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
    if (Array.isArray(value)) return value.map((v) => walk(v, contentOnly));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!contentOnly && typeof v === 'string' && isStructuralField(k, v)) out[k] = v;
      else out[k] = walk(v, contentOnly || CONTENT_CONTAINER_KEYS.has(k));
    }
    return out;
  }

  for (const v of initial) {
    if (typeof v === 'string') add(v);
    else add(v.value, v.placeholder);
  }

  return {
    add,
    text,
    deep: <T>(value: T): T => walk(value, false) as T,
    values: () => [...entries.keys()],
  };
}

/** One markup token: a comment, a tag (a quoted attribute value may contain `>`), or the text up to the next `<`. */
const MARKUP_TOKEN = /<!--[\s\S]*?(?:-->|$)|<(?:"[^"]*"|'[^']*'|[^'">])*>?|[^<]+/g;
/** An attribute value inside a tag: double-quoted, single-quoted or bare. */
const ATTRIBUTE_VALUE = /(=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/**
 * Scrubs registered values out of an HTML document's text, comments and attribute values only.
 * Tag names, attribute names and `<meta http-equiv>` tags (the snapshot's Content-Security-Policy)
 * are never changed, so scrubbing cannot alter the document's structure or weaken its policy.
 */
export function scrubMarkup(html: string, scrubber: ValueScrubber): string {
  return html.replace(MARKUP_TOKEN, (token) => {
    if (!token.startsWith('<')) return scrubber.text(token);
    if (token.startsWith('<!--')) return `<!--${scrubber.text(token.slice(4))}`;
    if (/^<meta\b/i.test(token) && /\shttp-equiv\s*=/i.test(token)) return token;
    return token.replace(ATTRIBUTE_VALUE, (_m, eq: string, dq?: string, sq?: string, bare?: string) => {
      if (dq !== undefined) return `${eq}"${scrubber.text(dq)}"`;
      if (sq !== undefined) return `${eq}'${scrubber.text(sq)}'`;
      return `${eq}${scrubber.text(bare ?? '')}`;
    });
  });
}

/** Options for `createRunRedactor`: the policy-driven keys and patterns, plus the run's own known values. */
export interface RunRedactorOptions extends RedactorOptions {
  /**
   * The run's known plaintext values (resolved secrets, sensitive input values). Read on every
   * call, so a value that only becomes known mid-run still counts from then on.
   */
  values?: () => readonly string[];
  /** Values shorter than this are ignored. Defaults to 3. */
  minValueLength?: number;
}

/** A {@link Redactor} that also redacts an HTML document without changing its markup. */
export interface RunRedactor extends Redactor {
  /** The key and pattern redaction over the whole document, then the run's values out of its text and attribute values only (see {@link scrubMarkup}). */
  html(html: string): string;
}

/**
 * One redactor for everything a run exposes: evidence files, intervention records, and the
 * operator console's payloads. Applies `createRedactor(opts)` (sensitive keys and patterns, which
 * also flattens Dates, Maps, Sets and binary data to plain JSON values), then scrubs every known
 * value of the run (see {@link ValueScrubber}) out of the result's content string leaves. Numbers
 * and structural fields (ids, timestamps, enumerations, evidence paths) are left as they are, so a
 * redacted `ReplayResult` or intervention still parses and still points at the same run and files.
 * Redacting an already-redacted value changes nothing.
 */
export function createRunRedactor(opts: RunRedactorOptions = {}): RunRedactor {
  const base = createRedactor(opts);
  const minLength = opts.minValueLength ?? 3;
  let cacheKey: string | undefined;
  let scrubber: ValueScrubber | undefined;

  function currentScrubber(): ValueScrubber | undefined {
    const values = opts.values?.() ?? [];
    if (values.length === 0) return undefined;
    const key = values.join('\u0000');
    if (key !== cacheKey || scrubber === undefined) {
      cacheKey = key;
      scrubber = createValueScrubber(values, { minLength });
    }
    return scrubber;
  }

  const redact = (value: unknown): unknown => {
    const redacted = base(value);
    const s = currentScrubber();
    return s === undefined ? redacted : s.deep(redacted);
  };
  return Object.assign(redact, {
    html(html: string): string {
      const patterned = base(html);
      const out = typeof patterned === 'string' ? patterned : html;
      const s = currentScrubber();
      return s === undefined ? out : scrubMarkup(out, s);
    },
  });
}
