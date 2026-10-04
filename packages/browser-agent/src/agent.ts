/**
 * Builds the agent object and installs it as `window.__cuAgent`, once per document.
 *
 * Install is idempotent, so the same bundle can arrive twice (a driver's init script and the
 * app's own script tag, or two tags) and the page still has exactly one agent:
 *  - an installed agent with the same major version is reused as is when it is the same version
 *    or newer; an older one within the same major is replaced by this copy;
 *  - an installed agent with a different major is always replaced by this copy, and the conflict
 *    is logged once per document. The major is the compatibility contract, so whoever installs
 *    last gets the API it was built against: a driver that finds an app-shipped copy of another
 *    major re-installs its own, and the driver's copy is what it then talks to.
 * On every replacement the old agent's capture is stopped first, and restarted on the new agent
 * when it was active, so an upgrade never silently ends a capture session.
 *
 * Install touches the DOM exactly once: a `data-cu-agent="<version>"` attribute on <html>, so
 * presence is detectable without script. Nothing is inserted, so layout is unchanged.
 */
import { createCapture } from './capture.js';
import { AGENT_GLOBAL, DETECT_ATTRIBUTE } from './constants.js';
import { describe, elementAtPoint, enumerate, rect } from './enumerate.js';
import {
  accessibleName,
  adjacentCellLabel,
  collapse,
  findAdjacentCellControls,
  inferRole,
  isTextLeaf,
  isVisible,
  labelFor,
  ownText,
  stripColon,
} from './naming.js';
import { maskClear, maskClone, maskKindOf, maskKindsOf, maskMark, maskPlan, maskSheetCheck, maskTouches, maskVerify } from './mask.js';
import { closestClickable, isInteractive, structuralSelector } from './selectors.js';
import { createSink } from './sink.js';
import type { CuAgent, CuAgentLib } from './types.js';
import { AGENT_VERSION } from './version.js';

/** Marks, per window, that a version conflict was already logged. Symbol-keyed: invisible to page code that enumerates window. */
const WARNED = Symbol.for('cu-agent.version-conflict-logged');

function versionParts(v: string): number[] {
  return v.split('.').map((p) => parseInt(p, 10) || 0);
}

function majorOf(v: string): number {
  return versionParts(v)[0] ?? 0;
}

/** Negative when a < b, 0 when equal, positive when a > b (major.minor.patch). */
function compareVersions(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function warnOnce(message: string): void {
  const bag = window as unknown as Record<symbol, unknown>;
  if (bag[WARNED]) return;
  bag[WARNED] = true;
  try {
    console.warn(`[cu-agent] ${message}`);
  } catch {
    /* console unavailable */
  }
}

/** Sets the detection attribute on <html>, waiting for the root element if an init script runs before it exists. */
function markDocument(version: string): void {
  const mark = (): boolean => {
    const root = document.documentElement;
    if (!root) return false;
    root.setAttribute(DETECT_ATTRIBUTE, version);
    return true;
  };
  if (mark()) return;
  const observer = new MutationObserver(() => {
    if (mark()) observer.disconnect();
  });
  observer.observe(document, { childList: true });
}

/** The adapter's former in-page library surface, exposed here as `window.__cuAgent.lib`. Wrappers pin arity, so a caller's extra arguments (Array.map's index) never reach an options parameter. */
function createLib(): CuAgentLib {
  return Object.freeze({
    collapse: (s: unknown) => collapse(s),
    stripColon: (s: unknown) => stripColon(s),
    isVisible: (el: Element) => isVisible(el),
    inferRole: (el: Element) => inferRole(el),
    labelFor: (el: Element) => labelFor(el),
    adjacentCellLabel: (el: Element) => adjacentCellLabel(el),
    findAdjacentCellControls: (label: string, exact: boolean) => findAdjacentCellControls(label, exact),
    accessibleName: (el: Element) => accessibleName(el),
    ownText: (el: Element, max?: number) => ownText(el, max),
    isTextLeaf: (el: Element, textCache?: Map<Element, string>) => isTextLeaf(el, textCache),
    isInteractive: (el: Element) => isInteractive(el),
    closestClickable: (el: Node | null) => closestClickable(el),
    structuralSelector: (el: Element) => structuralSelector(el),
    describe: (el: Element) => describe(el),
    elementAtPoint: (x: number, y: number) => elementAtPoint(x, y),
    rect: (el: Element) => rect(el),
    enumerate: (opts?: Parameters<CuAgentLib['enumerate']>[0]) => enumerate(opts),
    maskPlan: (opts: Parameters<CuAgentLib['maskPlan']>[0]) => maskPlan(opts),
    maskMark: (nonce: string, ranges: Parameters<CuAgentLib['maskMark']>[1], fieldIdx: number[], kind: string) => maskMark(nonce, ranges, fieldIdx, kind),
    maskObserve: (opts: Parameters<CuAgentLib['maskObserve']>[0], enumerateOpts?: Parameters<CuAgentLib['enumerate']>[0]) => {
      const plan = maskPlan(opts);
      const enumeration = enumerate(enumerateOpts);
      return { plan, enumeration, kinds: maskKindsOf(opts.attr, opts.nonce, enumeration.els) };
    },
    maskObserveText: (opts: Parameters<CuAgentLib['maskObserveText']>[0]) => {
      const plan = maskPlan(opts);
      return { plan, text: document.body ? document.body.innerText : '' };
    },
    maskVerify: (nonce: string) => maskVerify(nonce),
    maskSheetCheck: (nonce: string, css: string) => maskSheetCheck(nonce, css),
    maskTouches: (nonce: string, el: Element) => maskTouches(nonce, el),
    maskClone: (nonce: string) => maskClone(nonce),
    maskClear: (attr: string, nonce: string) => maskClear(attr, nonce),
    maskKindOf: (el: Element, opts: Parameters<CuAgentLib['maskKindOf']>[1]) => maskKindOf(el, opts),
  });
}

/** A fresh agent for this document. Does not install it; see installAgent. */
export function createAgent(): CuAgent {
  const sink = createSink();
  const capture = createCapture(sink);
  const lib = createLib();
  return Object.freeze({
    version: AGENT_VERSION,
    enumerate: lib.enumerate,
    describe: lib.describe,
    closestClickable: lib.closestClickable,
    structuralSelector: lib.structuralSelector,
    capture,
    drain: () => sink.drain(),
    get events() {
      return sink.events;
    },
    lib,
  });
}

/** Publishes the agent; false when the page made `window.__cuAgent` unwritable. */
function setGlobal(agent: CuAgent): boolean {
  try {
    Object.defineProperty(window, AGENT_GLOBAL, { value: agent, writable: true, configurable: true, enumerable: false });
  } catch {
    try {
      window.__cuAgent = agent;
    } catch {
      /* non-configurable and non-writable, or a setter that throws */
    }
  }
  try {
    return window.__cuAgent === agent;
  } catch {
    return false;
  }
}

/** The installed agent as the page exposes it; undefined when absent or when reading it throws (a hostile getter). */
function readExisting(): Partial<CuAgent> | undefined {
  try {
    const v = window.__cuAgent as unknown;
    return v && typeof v === 'object' ? (v as Partial<CuAgent>) : undefined;
  } catch {
    return undefined;
  }
}

/** True when `agent`'s capture reports active; false when it cannot tell (an older or foreign agent). */
function captureWasActive(agent: Partial<CuAgent>): boolean {
  try {
    return typeof agent.capture?.isActive === 'function' && agent.capture.isActive() === true;
  } catch {
    return false;
  }
}

/**
 * Installs the agent as `window.__cuAgent` unless one of the same major and the same or a newer
 * version is present; returns the agent in effect. Never throws into the page: when the page has
 * made the global unwritable, it logs once and returns an agent that is not published.
 */
export function installAgent(): CuAgent {
  const existing = readExisting();
  let resumeCapture = false;
  if (existing && typeof existing.version === 'string') {
    const sameMajor = majorOf(existing.version) === majorOf(AGENT_VERSION);
    if (sameMajor && compareVersions(existing.version, AGENT_VERSION) >= 0) return existing as CuAgent;
    if (!sameMajor) warnOnce(`replacing agent ${existing.version} with ${AGENT_VERSION} (different major)`);
    resumeCapture = captureWasActive(existing);
    try {
      existing.capture?.stop();
    } catch {
      /* an old agent's stop failing must not block the replacement */
    }
  }
  const agent = createAgent();
  if (!setGlobal(agent)) {
    warnOnce(`cannot install agent ${AGENT_VERSION}: window.${AGENT_GLOBAL} is not writable`);
    return agent;
  }
  markDocument(agent.version);
  if (resumeCapture) agent.capture.start();
  return agent;
}
