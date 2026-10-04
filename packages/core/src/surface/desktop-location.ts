/**
 * Desktop locations: how a surface over a native application reports "where it is" in the URL
 * vocabulary the rest of the runtime (conditions, policy, evidence, Relay) already speaks.
 *
 *   desktop://<process name>/<window title>
 *
 * The host is the target process's image name as the OS reports it (no `.exe`), lower-cased
 * (Windows process names are case-insensitive, and WHATWG URL parsing keeps an opaque host's case,
 * so two spellings of one app would otherwise be two "origins"), percent-encoded. The path is the
 * window title, percent-encoded as a single segment (`encodeURIComponent`), so a title containing
 * `/`, `?` or `#` stays one segment and a desktop URL never has a query or fragment. A title that is
 * exactly `.` or `..` has its dots encoded as `%2E`; such a URL must be read with
 * {@link parseDesktopUrl}, not `new URL()`, which would resolve the dot segment away.
 * `desktop://<process>` with an empty path means "the application, no particular window".
 *
 * This lives in core, not in the desktop adapter, because the policy guard and the composition
 * root must agree with the adapter on what the origin of a desktop location is, and core imports
 * no adapter. `URL.origin` is the string "null" for every non-special scheme, so origin
 * comparisons on desktop URLs must go through {@link desktopOrigin}, never `new URL(x).origin`.
 */

import { urlPreprocess } from './url-shape.js';

/** The URL scheme of a desktop location, as `URL.protocol` reports it. */
export const DESKTOP_PROTOCOL = 'desktop:';

/** A parsed desktop location. */
export interface DesktopLocation {
  /** Process name, lower-cased and decoded, exactly as the URL names it. Never empty. */
  processName: string;
  /** Decoded window title; undefined when the location names no window. */
  title?: string;
}

/**
 * Canonical spelling of a process name taken from the OS or a URL host: trimmed, lower-cased.
 * Nothing is stripped: `foo` and `foo.exe` are different names (a process whose image is
 * `foo.exe.exe` is reported as `foo.exe`). Use {@link processNameFromImage} for user input that
 * may name an image file.
 */
export function normalizeProcessName(name: string): string {
  return name.trim().toLowerCase();
}

/** A process name from an image file name a person typed (`TellerWorkstation.exe`): drops one trailing `.exe`. */
export function processNameFromImage(image: string): string {
  return normalizeProcessName(image).replace(/\.exe$/, '');
}

/** `desktop://<process>`: the allowlist identity of every location in that process. */
export function desktopOrigin(processName: string): string {
  return `desktop://${encodeURIComponent(normalizeProcessName(processName))}`;
}

function encodeTitle(title: string): string {
  // "." and ".." are dot segments a URL parser would resolve away; keep them as titles.
  if (title === '.' || title === '..') return title.replace(/\./g, '%2E');
  return encodeURIComponent(title);
}

/** Formats a desktop location URL; `title` undefined formats the bare origin. */
export function formatDesktopUrl(processName: string, title?: string): string {
  const origin = desktopOrigin(processName);
  return title === undefined ? origin : `${origin}/${encodeTitle(title)}`;
}

/** True when `url` uses the desktop scheme (it may still be malformed; see {@link parseDesktopUrl}). */
export function isDesktopUrl(url: string): boolean {
  return /^desktop:/i.test(urlPreprocess(url));
}

/**
 * Parses a desktop location. Undefined for anything that is not a well-formed one: another scheme,
 * no process name, credentials, a port, a query or fragment, more than one path segment, or a
 * malformed percent-escape. Strict on purpose: the policy guard denies whatever this rejects.
 *
 * Parsed by hand after the same preprocessing a URL parser applies (leading/trailing C0 controls
 * and spaces trimmed, tab/CR/LF removed), so what is checked is what any consumer would see, and a
 * `.`/`..` title survives.
 */
export function parseDesktopUrl(url: string): DesktopLocation | undefined {
  const r = parseDesktop(url);
  return 'problem' in r ? undefined : r;
}

/**
 * Why `url` is not a well-formed desktop location, in words a person can act on; undefined when it
 * is one. Used for the policy and `--base-url` error messages.
 */
export function desktopUrlProblem(url: string): string | undefined {
  const r = parseDesktop(url);
  return 'problem' in r ? r.problem : undefined;
}

function parseDesktop(url: string): DesktopLocation | { problem: string } {
  const s = urlPreprocess(url);
  const m = /^desktop:\/\/([^/?#]*)(?:\/([^?#]*))?$/i.exec(s);
  if (!m) return { problem: `'${url}' is not desktop://<process>/<window title> (no authority, a query or a fragment)` };
  const host = m[1]!;
  const path = m[2];
  // Credentials, a port, or anything else that is not a plain host.
  if (/[@:\\\s[\]]/.test(host)) return { problem: `'${url}' has credentials, a port or another character a process name cannot have` };
  let processName: string;
  let title: string | undefined;
  try {
    processName = normalizeProcessName(decodeURIComponent(host));
    if (path === undefined || path === '') title = undefined;
    else {
      if (path.includes('/')) return { problem: `'${url}' has more than one path segment (a window title is one segment)` };
      title = decodeURIComponent(path);
    }
  } catch {
    return { problem: `'${url}' has a malformed percent-escape` };
  }
  if (processName === '' || processName.includes('/')) return { problem: `'${url}' names no process` };
  // The OS reports process names without the image extension; an origin that keeps it would never
  // match the app, so it is refused with the fix spelled out rather than failing closed silently.
  if (processName.endsWith('.exe')) {
    return { problem: `'${url}' names the image file: write the process name without .exe (${desktopOrigin(processName.slice(0, -4))})` };
  }
  return title === undefined ? { processName } : { processName, title };
}

/**
 * Resolves `url` against a desktop location the way the surface and the guard both must: an
 * absolute URL as written, `/<title>` and `<title>` as that window of the same process, with no
 * dot-segment resolution (a title of `..` is a title). Undefined when `base` is not a desktop
 * location or `url` is an absolute URL of another scheme (the caller resolves those itself).
 */
export function resolveDesktopRelative(url: string, base: string): string | undefined {
  const s = urlPreprocess(url);
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return isDesktopUrl(s) ? s : undefined;
  const loc = parseDesktopUrl(base);
  if (!loc) return undefined;
  const path = s.startsWith('/') ? s.slice(1) : s;
  return `${desktopOrigin(loc.processName)}/${path}`;
}

/**
 * The location with its title decoded: `desktop://<process>/<title as shown>`. Policy URL patterns
 * are matched against this form as well as the encoded URL, so an author can write a window title
 * with its spaces. Undefined for anything that is not a desktop location.
 */
export function decodedDesktopLocation(url: string): string | undefined {
  const loc = parseDesktopUrl(url);
  if (!loc) return undefined;
  return `${desktopOrigin(loc.processName)}/${loc.title ?? ''}`;
}
