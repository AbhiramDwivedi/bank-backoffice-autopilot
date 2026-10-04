/**
 * URL shapes no recorded flow legitimately uses, refused before any resolution.
 *
 * A URL parser resolves `\\host\share\x` or `//host/x` against the current http(s) page into an
 * http(s) URL on some host, which an allowlist check then judges; a browser handed the *raw* string
 * treats the first as a UNC path and loads a `file:` page. Backslashes are also read as slashes in
 * special-scheme URLs (`http:\\evil\x`). None of these shapes appears in a capability, so every
 * navigation check refuses them outright, on the string after the same preprocessing a URL parser
 * applies (outer control characters trimmed, tab/CR/LF removed: `/\t/host` is `//host`).
 *
 * Shared by the policy guard and both surfaces so they agree on what is refused.
 */

/** What a WHATWG URL parser does before parsing: outer C0 controls and spaces trimmed, tab/CR/LF removed. */
export function urlPreprocess(url: string): string {
  let start = 0;
  let end = url.length;
  while (start < end && url.charCodeAt(start) <= 0x20) start++;
  while (end > start && url.charCodeAt(end - 1) <= 0x20) end--;
  return url.slice(start, end).replace(/[\t\n\r]/g, '');
}

/** Why `url` is refused before resolution, or undefined when its shape is acceptable. */
export function urlShapeRefusal(url: string): string | undefined {
  const s = urlPreprocess(url);
  if (s.includes('\\')) return 'a URL with a backslash (a UNC path, or a disguised slash) is never navigated to';
  if (s.startsWith('//')) return 'a protocol-relative URL (//host/...) is never navigated to';
  return undefined;
}

/**
 * Key names that activate the focused control, normalized: Enter (also `"\r"`, `"\n"`, `Return`),
 * NumpadEnter, and Space (also `" "`, `Spacebar`). Named keys compare case-insensitively; nothing
 * is trimmed (a trimmed `"\r"` would vanish). Returns the canonical name, or undefined for a key
 * that does not commit.
 */
export function committingKey(key: string): 'Enter' | 'NumpadEnter' | 'Space' | undefined {
  if (key === '\r' || key === '\n' || key === '\r\n') return 'Enter';
  if (key === ' ') return 'Space';
  switch (key.toLowerCase()) {
    case 'enter':
    case 'return':
      return 'Enter';
    case 'numpadenter':
      return 'NumpadEnter';
    case 'space':
    case 'spacebar':
      return 'Space';
    default:
      return undefined;
  }
}

/** The key a surface should press for `key`: a committing key in its canonical name, anything else unchanged. */
export function normalizeKeyName(key: string): string {
  return committingKey(key) ?? key;
}
