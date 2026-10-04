/**
 * Agent installation and detection for the Playwright driver.
 *
 * The adapter's in-page code is `@cu/browser-agent`, a standalone package: helpers at
 * `window.__cuAgent.lib`, plus `window.__cuAgent.enumerate()`/`capture`. The adapter installs it
 * (or reuses an installed one). There are two integration modes:
 *  - injection: this driver's own init script installs the agent into every new document, before
 *    any page script runs (`installAgentInitScript` / `agentInjectionSource`).
 *  - app-included: the app ships `<script src=".../cu-agent.js">` itself. `installAgent()` (inside
 *    the bundle) is idempotent: an already-installed same-major agent of the same or a newer
 *    version is reused as is, so when the app's own script runs after this driver's init script it
 *    sees the driver's copy and installs nothing new, leaving no trace of its own. An app copy of a
 *    different major replaces the driver's (the last installer wins), and a page can also hold an
 *    older same-major copy (installed before this driver attached), so `ensureAgent` re-installs
 *    the driver's copy before any use and verifies the result: this driver only ever talks to an
 *    agent of its own major that is at least its own version (`isCurrentAgentVersion`).
 *
 * `agentInjectionSource()` wraps `agentSource()` (the built bundle text, from `@cu/browser-agent`)
 * with a small marker so the driver can later tell whether the *app's own* `<script>` tag ran
 * during a document's load: only a classic `<script>` element's synchronous execution sets
 * `document.currentScript`; a Playwright `evaluate`/`addInitScript` call never does. The marker
 * installs a one-shot accessor on `window.__cuAgent` that records the first time anything reads
 * the global while a page `<script>` is executing, then keeps serving the same agent instance
 * (the accessor never changes which object comes back, only whether the read is *noted*).
 *
 * Both the marker and the bundle are built as a single plain-JS string, never a TS function passed
 * to evaluate: functions given to `frame.evaluate`/`addInitScript` are serialized with
 * `toString()`, and TS/esbuild transforms can inject references (e.g. `__name` helpers) that do
 * not exist in the page. A string is exactly what runs.
 */
import type { BrowserContext, Frame } from 'playwright';
import { AGENT_VERSION, agentSource, isCurrentAgentVersion } from '@cu/browser-agent';

let cachedInjectionSource: string | undefined;

/**
 * The script this driver injects: installs `@cu/browser-agent` and marks that *this* injection is
 * the one that installed it (as opposed to the app's own script tag reusing it). Cached for the
 * life of the process.
 */
export function agentInjectionSource(): string {
  if (cachedInjectionSource !== undefined) return cachedInjectionSource;
  const header = '(function () {\n  var before; try { before = window.__cuAgent; } catch (e) {}\n';
  const marker =
    '\n;try {\n' +
    '    var agent = window.__cuAgent;\n' +
    "    var K = Symbol.for('cu-agent.driver');\n" +
    '    if (agent && typeof agent === \'object\' && agent !== before && !(window[K] && window[K].agent === agent)) {\n' +
    "      var replaced; try { replaced = before && typeof before.version === 'string' ? before.version : undefined; } catch (e) {}\n" +
    '      var state = { agent: agent, appScript: false, replaced: replaced };\n' +
    '      Object.defineProperty(window, K, { value: state, configurable: true });\n' +
    "      Object.defineProperty(window, '__cuAgent', {\n" +
    '        configurable: true, enumerable: false,\n' +
    '        get: function () { try { if (document.currentScript) state.appScript = true; } catch (e) {} return agent; },\n' +
    "        set: function (v) { Object.defineProperty(window, '__cuAgent', { value: v, writable: true, configurable: true, enumerable: false }); }\n" +
    '      });\n' +
    '    }\n' +
    '  } catch (e) {}\n' +
    '})();\n';
  cachedInjectionSource = header + agentSource() + marker;
  return cachedInjectionSource;
}

const READ_VERSION_JS =
  '(function () { try { var a = window.__cuAgent; return a && a.version; } catch (e) { return undefined; } })()';

/**
 * Thrown by `ensureAgent` when the frame still has no agent this driver can use after installing
 * one: absent, of another major, or older than this driver's copy (e.g. the page made
 * `window.__cuAgent` unwritable).
 */
export class AgentVersionError extends Error {
  override readonly name = 'AgentVersionError';
  constructor(
    /** What the frame reports after the install attempt (undefined when absent or unreadable). */
    readonly installedVersion: string | undefined,
    /** URL of the frame, when it could be read. */
    readonly frameUrl?: string,
  ) {
    super(
      `browser-agent ${installedVersion === undefined ? 'is absent' : `version ${JSON.stringify(installedVersion.slice(0, 40))} cannot be used`} after installing ${AGENT_VERSION} into the frame${frameUrl === undefined ? '' : ` ${JSON.stringify(frameUrl.slice(0, 200))}`} (needs the same major, not older)`,
    );
  }
}

function frameUrlOrUndefined(frame: Frame): string | undefined {
  try {
    return frame.url();
  } catch {
    return undefined;
  }
}

/**
 * Installs the agent in `frame` unless it already holds one of this driver's major that is not
 * older than this driver's copy (cheap version check first). An older same-major agent lacks API
 * this driver calls (e.g. `lib.findAdjacentCellControls`), so it is replaced like one of another
 * major; the in-page install replaces an older same-major agent. Then re-reads the version and
 * throws `AgentVersionError` when the frame still does not hold a usable agent. A frame error
 * (navigating/detached) propagates to the caller.
 */
export async function ensureAgent(frame: Frame): Promise<void> {
  if (isCurrentAgentVersion(await frame.evaluate(READ_VERSION_JS))) return;
  await frame.evaluate(agentInjectionSource());
  const after: unknown = await frame.evaluate(READ_VERSION_JS);
  if (!isCurrentAgentVersion(after)) throw new AgentVersionError(typeof after === 'string' ? after : undefined, frameUrlOrUndefined(frame));
}

/** Contexts that already have the agent's init script added (addInitScript has no "already added" check of its own). */
const initScriptInstalled = new WeakSet<BrowserContext>();

/** Adds the driver's init script to `context` exactly once, so every new document in every frame gets the agent before page scripts run. */
export async function installAgentInitScript(context: BrowserContext): Promise<void> {
  if (initScriptInstalled.has(context)) return;
  initScriptInstalled.add(context);
  await context.addInitScript({ content: agentInjectionSource() });
}

/** Where a frame's agent came from: the app's own script tag, this driver's injection, or absent. */
export type AgentSource = 'app' | 'injected' | 'none';

/** What `detectAgent()` found for one frame. */
export interface AgentDetection {
  present: boolean;
  version?: string;
  source: AgentSource;
  /** True when an agent is present that this driver uses as is: same major, not older (`isCurrentAgentVersion`); false when absent, of another major, or older. */
  compatible: boolean;
  /** Version of an agent this driver's injection replaced in this document (an app-shipped copy of another major, or an older one of the same major). */
  replacedVersion?: string;
}

/**
 * Detects the agent installed in `frame`: present/absent, version, and whether it was the app's
 * own `<script>` tag (vs. this driver's injection) that installed it. Waits for
 * `domcontentloaded` first so a synchronous `<script>` tag in `<head>` has had a chance to run.
 * Every field the page reports is untrusted (a hostile page can spoof `window.__cuAgent`), so
 * every value is validated Node-side before being trusted.
 */
export async function detectAgent(frame: Frame): Promise<AgentDetection> {
  const absent: AgentDetection = { present: false, source: 'none', compatible: false };
  await frame.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
  try {
    const raw: unknown = await frame.evaluate(`(function () {
      try {
        var a = window.__cuAgent;
        if (!a || typeof a.version !== 'string') return { present: false };
        var st = window[Symbol.for('cu-agent.driver')];
        var injected = !!st && st.agent === a && !st.appScript;
        var replaced = injected && typeof st.replaced === 'string' ? st.replaced : undefined;
        return { present: true, version: a.version, source: injected ? 'injected' : 'app', replaced: replaced };
      } catch (e) { return { present: false }; }
    })()`);
    if (!raw || typeof raw !== 'object') return absent;
    const r = raw as { present?: unknown; version?: unknown; source?: unknown; replaced?: unknown };
    if (!r.present || typeof r.version !== 'string') return absent;
    if (r.source !== 'app' && r.source !== 'injected') return absent;
    const version = r.version.slice(0, 40);
    return {
      present: true,
      version,
      source: r.source,
      compatible: isCurrentAgentVersion(version),
      ...(typeof r.replaced === 'string' ? { replacedVersion: r.replaced.slice(0, 40) } : {}),
    };
  } catch {
    return absent;
  }
}
