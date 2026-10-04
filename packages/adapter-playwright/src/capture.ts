/**
 * Human-action capture during handoff. Values are never captured.
 *
 * Mechanism: capture lives entirely in `@cu/browser-agent` (per-document
 * `window.__cuAgent.capture.start()/stop()/isActive()`, off by default in every new document; see
 * `packages/browser-agent/src/capture.ts`). This module is just plumbing:
 *  - `page.exposeBinding('__cuHumanAction', ...)` once per Page (exposeBinding throws if called
 *    twice on the same page). The binding forwards each `HumanActionRecord` to every capture
 *    session currently started on that page (a module-level WeakMap page -> listener set), so a
 *    second capture on the same page (a second surface borrowing it) records just like the
 *    first. The agent's sink calls this binding directly; nothing is buffered in the page while
 *    the binding is present.
 *  - `installAgentInitScript(page.context())` (idempotent) guarantees every future document gets
 *    the agent before any page script runs; `ensureAgent(frame)` covers a frame whose document
 *    already loaded.
 *  - `start()`/`stop()` toggle `window.__cuAgent.capture` in every current frame, and
 *    `frameattached`/`framenavigated` handlers keep re-establishing the agent (and, while active,
 *    capture) as frames come and go -- a new document always starts with capture off, per the
 *    agent's own contract.
 *  - `page.on('framenavigated', ...)` while active also emits the adapter's own `navigate`
 *    HumanAction directly (bypassing the in-page channel); an in-page `navigate` record (from the
 *    agent's own same-document navigation listener) is dropped here instead, to avoid a duplicate.
 */
import type { Frame, Page } from 'playwright';
import type { HumanAction } from '@cu/core/schema';
import type { HumanActionCapture } from '@cu/core/surface';
import type { HumanActionRecord, HumanActionTarget } from '@cu/browser-agent';
import { framePathOf } from './frames.js';
import { ensureAgent, installAgentInitScript } from './inpage.js';

const BINDING_NAME = '__cuHumanAction';

/** Receives one binding-delivered record and the frame it came from. */
type RecordListener = (raw: HumanActionRecord, frame: Frame) => void;

/** Per page: the capture sessions currently listening, and the one-time binding registration. */
interface PageBinding {
  listeners: Set<RecordListener>;
  registered: Promise<void>;
}

const pageBindings = new WeakMap<Page, PageBinding>();

/**
 * Registers the page's binding on first use (exposeBinding throws if called twice) and returns
 * its listener set. A failed registration is forgotten so the next start() retries it.
 */
async function bindingFor(page: Page): Promise<Set<RecordListener>> {
  let binding = pageBindings.get(page);
  if (!binding) {
    const listeners = new Set<RecordListener>();
    const registered: Promise<void> = page
      .exposeBinding(BINDING_NAME, (source, payload: HumanActionRecord) => {
        for (const listener of [...listeners]) {
          try {
            listener(payload, source.frame);
          } catch {
            /* one session's callback failing must not starve the others */
          }
        }
      })
      .then(
        () => undefined,
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          // Tolerate a binding some other code path already registered under this name.
          if (/already registered|already exists/i.test(msg)) return;
          pageBindings.delete(page);
          throw err;
        },
      );
    binding = { listeners, registered };
    pageBindings.set(page, binding);
  }
  await binding.registered;
  return binding.listeners;
}

/** In-page record types the adapter forwards as-is (a `navigate` record is dropped; see module header). */
const HUMAN_ACTION_TYPES = new Set(['click', 'input', 'keypress', 'submit']);
const CAPTURED_KEYS = new Set(['Enter', 'Tab', 'Escape']);

/**
 * `dropText` unconditionally omits `target.text`, regardless of what the record carries: for a
 * `keypress` record the key must travel only in `record.key`, never in `target.text` -- the page
 * is untrusted, so this holds even against a record that stuffs a key name (or anything else)
 * into `target.text` itself, legacy or hostile.
 */
function sanitizeTarget(t: HumanActionTarget | undefined, dropText: boolean): HumanAction['target'] {
  const out: HumanAction['target'] = {};
  if (!t) return out;
  if (typeof t.tag === 'string') out.tag = t.tag;
  if (typeof t.role === 'string') out.role = t.role;
  if (typeof t.name === 'string') out.name = t.name;
  if (!dropText && typeof t.text === 'string') out.text = t.text.length > 80 ? t.text.slice(0, 80) : t.text;
  if (typeof t.selector === 'string') out.selector = t.selector;
  return out;
}

function scrubTarget(t: HumanAction['target'], scrub: ((s: string) => string) | undefined): HumanAction['target'] {
  if (!scrub) return t;
  const out = { ...t };
  try {
    if (out.name !== undefined) out.name = scrub(out.name);
    if (out.text !== undefined) out.text = scrub(out.text);
  } catch {
    // A scrubber that fails must not let the raw text through.
    delete out.name;
    delete out.text;
  }
  return out;
}

function frameUrlOf(frame: Frame): string | undefined {
  try {
    return frame.isDetached() ? undefined : frame.url();
  } catch {
    return undefined;
  }
}

/** Options for {@link createHumanCapture}. */
export interface HumanCaptureOptions {
  /** Applied to a captured target's name and text (the surface's screen masking: masked content stays masked). */
  scrubText?: (s: string) => string;
}

/** Creates a human-action capture session bound to `page`. `start()`/`stop()` toggle listening. */
export function createHumanCapture(page: Page, opts: HumanCaptureOptions = {}): HumanActionCapture {
  let active = false;
  let onAction: ((a: HumanAction) => void) | undefined;
  let listenersAttached = false;

  /** Forwards one binding-delivered record. The page is untrusted: every field is validated before use. */
  function emit(raw: HumanActionRecord, frame: Frame): void {
    if (!active || !onAction) return;
    if (!raw || typeof raw !== 'object') return;
    if (raw.type === 'navigate') return; // the adapter's own framenavigated handler emits this; avoid a duplicate
    if (!HUMAN_ACTION_TYPES.has(raw.type)) return;
    const url = frameUrlOf(frame);
    const action: HumanAction = {
      ts: new Date().toISOString(),
      type: raw.type as HumanAction['type'],
      frame: framePathOf(frame),
      target: scrubTarget(sanitizeTarget(raw.target, raw.type === 'keypress'), opts.scrubText),
      ...(raw.valueRedacted !== undefined ? { valueRedacted: raw.valueRedacted } : {}),
      ...(typeof raw.key === 'string' && CAPTURED_KEYS.has(raw.key) ? { key: raw.key as HumanAction['key'] } : {}),
      ...(url !== undefined ? { url } : {}),
    };
    onAction(action);
  }

  /** Emits the adapter's own `navigate` action (a full-document navigation, never seen in-page). */
  function emitNavigate(frame: Frame): void {
    if (!active || !onAction) return;
    const url = frameUrlOf(frame);
    const action: HumanAction = {
      ts: new Date().toISOString(),
      type: 'navigate',
      frame: framePathOf(frame),
      target: {},
      ...(url !== undefined ? { url } : {}),
    };
    onAction(action);
  }

  /** window.__cuAgent.capture.start(), idempotent; guarded against the agent being absent. */
  async function evalCaptureStart(frame: Frame): Promise<void> {
    try {
      await frame.evaluate('window.__cuAgent && window.__cuAgent.capture.start()');
    } catch {
      /* frame navigating/detached; the next attach/navigate handles it */
    }
  }

  /** window.__cuAgent.capture.stop(), idempotent; guarded against the agent being absent. */
  async function evalCaptureStop(frame: Frame): Promise<void> {
    try {
      await frame.evaluate('window.__cuAgent && window.__cuAgent.capture.stop()');
    } catch {
      /* detached/navigating */
    }
  }

  async function handleFrameAttached(frame: Frame): Promise<void> {
    await ensureAgent(frame).catch(() => undefined);
    if (active) await evalCaptureStart(frame);
  }

  async function handleFrameNavigated(frame: Frame): Promise<void> {
    await ensureAgent(frame).catch(() => undefined);
    if (!active) return;
    await evalCaptureStart(frame);
    emitNavigate(frame);
  }

  const onFrameAttached = (frame: Frame): void => {
    void handleFrameAttached(frame);
  };
  const onFrameNavigated = (frame: Frame): void => {
    void handleFrameNavigated(frame);
  };

  /**
   * Bumped by every start() and stop(). A start() re-checks it after each await and returns
   * without registering anything further once it changed: a stop() (or a newer start()) arrived
   * while it was in flight, so its work belongs to a session that has already ended. Everything a
   * start() registers is registered synchronously right after such a check, and stop() removes it
   * synchronously, so a start() that finishes late never leaves its listener behind.
   */
  let generation = 0;

  return {
    async start(cb) {
      const gen = ++generation;
      const current = (): boolean => gen === generation;
      onAction = cb;
      active = true;
      await installAgentInitScript(page.context());
      if (!current()) return;
      const listeners = await bindingFor(page);
      if (!current()) return;
      listeners.add(emit);
      if (!listenersAttached) {
        listenersAttached = true;
        page.on('frameattached', onFrameAttached);
        page.on('framenavigated', onFrameNavigated);
      }
      for (const f of page.frames()) {
        await ensureAgent(f).catch(() => undefined);
        // Checked right before issuing the in-page start: a stop() that arrived meanwhile issues
        // its in-page stop after this point, so the frame ends up stopped.
        if (!current()) return;
        await evalCaptureStart(f);
      }
    },

    /** Idempotent, and safe to call while start() is still in flight (see `generation`). */
    async stop() {
      generation++;
      active = false;
      onAction = undefined;
      const listeners = pageBindings.get(page)?.listeners;
      listeners?.delete(emit);
      if (listenersAttached) {
        listenersAttached = false;
        page.off('frameattached', onFrameAttached);
        page.off('framenavigated', onFrameNavigated);
      }
      // In-page capture is per document, not per session: leave it on while another session on
      // this page still listens. Checked again before each frame, right before its in-page stop is
      // issued, so a session that starts meanwhile issues its in-page start after that stop.
      for (const f of page.frames()) {
        if (listeners && listeners.size > 0) break;
        await evalCaptureStop(f);
      }
    },
  };
}
