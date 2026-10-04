/**
 * Node-side entry for drivers (the Playwright adapter) and servers (the mock app): the agent's
 * types, its version and wire constants, and `agentSource()`, the built bundle as text.
 *
 * Nothing here runs in the page. The page runs dist/cu-agent.js, built from src/entry.ts.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_VERSION } from './version.js';

export type * from './types.js';
export { AGENT_VERSION } from './version.js';
export { selectForCap, TEXT_SHARE, type CapEntry } from './cap.js';
export {
  ACTION_BINDING,
  ACTION_MESSAGE_TYPE,
  AGENT_GLOBAL,
  DETECT_ATTRIBUTE,
  EVENT_BUFFER_MAX,
  MASK_KIND_ATTR,
  MASK_PAINT_ATTR,
  MAX_STRING,
  REDACTED_VALUE,
} from './constants.js';

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const SRC_DIR = path.join(PKG_DIR, 'src');
const BUILD_SCRIPT = path.join(PKG_DIR, 'build.mjs');

/** Absolute path of the built bundle (dist/cu-agent.js). */
export const AGENT_BUNDLE_PATH = path.join(PKG_DIR, 'dist', 'cu-agent.js');

let cachedSource: string | undefined;

function mtimeOrMinus1(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

/** Newest mtime among the files that feed the bundle (src/*.ts and build.mjs); -1 if none exist. */
function newestInputMtime(): number {
  let newest = mtimeOrMinus1(BUILD_SCRIPT);
  let names: string[];
  try {
    names = readdirSync(SRC_DIR);
  } catch {
    return newest;
  }
  for (const name of names) {
    if (name.endsWith('.ts')) newest = Math.max(newest, mtimeOrMinus1(path.join(SRC_DIR, name)));
  }
  return newest;
}

/**
 * The agent bundle as script text, for `page.addInitScript({ content })` and
 * `frame.evaluate(...)`. Builds dist/ first when it is missing or older than src/, then caches
 * the text for the life of the process. The trailing `sourceMappingURL` comment is removed: an
 * injected copy runs at the page's URL, where that relative map path does not exist.
 */
export function agentSource(): string {
  if (cachedSource !== undefined) return cachedSource;
  if (mtimeOrMinus1(AGENT_BUNDLE_PATH) < newestInputMtime()) {
    execFileSync(process.execPath, [BUILD_SCRIPT], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  const text = readFileSync(AGENT_BUNDLE_PATH, 'utf8');
  cachedSource = text.replace(/\n?\/\/# sourceMappingURL=\S*\s*$/, '\n');
  return cachedSource;
}

/** Major number of a semantic version string; NaN when it has none. */
export function majorOf(version: string): number {
  const m = /^(\d+)\./.exec(version);
  return m ? Number(m[1]) : Number.NaN;
}

/**
 * True when an agent already installed in a page (its `window.__cuAgent.version`) can be reused
 * by this driver: same major as AGENT_VERSION.
 */
export function isCompatibleAgentVersion(version: unknown): boolean {
  return typeof version === 'string' && majorOf(version) === majorOf(AGENT_VERSION);
}

/**
 * Negative when `a` is older than `b`, 0 when equal, positive when newer, comparing
 * major.minor.patch numerically (a missing or non-numeric part counts as 0). The same ordering the
 * in-page install uses to decide whether an installed agent is kept.
 */
export function compareAgentVersions(a: string, b: string): number {
  const pa = a.split('.').map((p) => parseInt(p, 10) || 0);
  const pb = b.split('.').map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * True when an installed agent can be used as is by a driver built against AGENT_VERSION: same
 * major and not older. An older agent of the same major lacks API added since (for example
 * `lib.findAdjacentCellControls`), so a driver installs its own copy over it, which the in-page
 * install accepts (it replaces an older same-major agent).
 */
export function isCurrentAgentVersion(version: unknown): boolean {
  return isCompatibleAgentVersion(version) && compareAgentVersions(version as string, AGENT_VERSION) >= 0;
}
