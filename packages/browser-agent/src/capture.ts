/**
 * Human-action capture for this document. Off by default; `start()`/`stop()` toggle a set of
 * capture-phase listeners on `document` (plus same-document navigation listeners) that turn DOM
 * events into `HumanActionRecord`s and hand them to a `Sink`. Never reads or reports a field
 * value: `describe(el, { valueFree: true })` supplies identity only (tag/role/name/text/selector),
 * and every `HumanActionRecord` carries `valueRedacted: true`.
 *
 * `framePath()` is exported on its own because it is also useful to a caller that just wants to
 * know where in the frame tree this document sits, without turning capture on.
 */
import { cap } from './naming.js';
import { closestClickable } from './selectors.js';
import { describe } from './enumerate.js';
import type { Sink } from './sink.js';
import type { CapturedKey, CaptureControl, FrameHop, HumanActionRecord, HumanActionTarget, HumanActionType } from './types.js';

const FIELD_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const CAPTURED_KEYS = new Set<string>(['Enter', 'Tab', 'Escape']);

/** This document's position in the frame tree: hops from the top document ([] = top). */
export interface FramePathResult {
  path: FrameHop[];
  /** True when an ancestor could not be read (cross-origin boundary): `path` stops there, short of the true top. */
  truncated: boolean;
}

/**
 * Walks from `window` up to `window.top`, naming each hop by its frame element's `name` attribute
 * (or `id`, or the window's own `name` when there is no readable frame element) or, failing that,
 * its index among the parent's child frames. Stops and reports `truncated` the moment an ancestor
 * cannot be read: once a window is cross-origin to this document, every property but the handful
 * the platform exposes cross-origin (`parent`, `top`, `length`, indexed frame access) throws.
 */
export function framePath(): FramePathResult {
  const top = window.top;
  const hops: FrameHop[] = [];
  let w: Window = window;
  while (w !== top) {
    try {
      const parent = w.parent;
      let name = '';
      const frameEl = w.frameElement;
      if (frameEl) {
        name = frameEl.getAttribute('name') || frameEl.id || '';
      } else {
        name = w.name || '';
      }
      if (name) {
        hops.unshift({ name: cap(name) });
      } else {
        let index = -1;
        const len = parent.length;
        for (let i = 0; i < len; i++) {
          if (frameAt(parent, i) === w) {
            index = i;
            break;
          }
        }
        hops.unshift({ index });
      }
      w = parent;
    } catch {
      return { path: hops, truncated: true };
    }
  }
  return { path: hops, truncated: false };
}

function isElement(node: Node | null): node is Element {
  return !!node && node.nodeType === 1;
}

/** `window[i]`: indexed frame access is a WindowProxy exotic-object behaviour lib.dom.d.ts does not model. */
function frameAt(win: Window, i: number): Window | undefined {
  return (win as unknown as Record<number, Window>)[i];
}

function isField(el: Element | null): boolean {
  return !!el && FIELD_TAGS.has(el.tagName);
}

/** Builds a `HumanActionTarget` for `target`, as HEAD did: identity only, never a value. */
function describeTarget(target: EventTarget | null, useClickable: boolean, includeText = true): HumanActionTarget {
  const node: Node | null = target instanceof Node ? target : null;
  const resolved = useClickable ? (closestClickable(node) ?? node) : node;
  if (!isElement(resolved)) return {};
  // valueFree: never reads a value property, and takes no text from an editable region or a container holding one.
  const d = describe(resolved, { valueFree: true });
  const out: HumanActionTarget = {};
  if (d.tag) out.tag = cap(d.tag);
  if (d.role) out.role = cap(d.role);
  if (d.name) out.name = cap(d.name);
  if (includeText && d.text) out.text = cap(d.text, 80);
  if (d.selector) out.selector = cap(d.selector);
  return out;
}

/**
 * Wraps a listener so it never throws into the page. The agent may share a document with
 * third-party scripts that break DOM built-ins; a failure there must not surface as an uncaught
 * error in the host app's own error reporting. The browser already isolates listener exceptions
 * from the page's handlers; this also keeps them out of `window.onerror`.
 */
function guarded(fn: (e: Event) => void): (e: Event) => void {
  return (e: Event) => {
    try {
      fn(e);
    } catch {
      /* drop this record; never disturb the page */
    }
  };
}

/** Turns capture on/off for this document, and reports captured records to `sink`. */
export function createCapture(sink: Sink): CaptureControl {
  let active = false;
  let lastFieldEl: Element | null = null;
  let lastUrl = '';
  let usingNavigationApi = false;

  function emit(type: HumanActionType, target: HumanActionTarget, key?: CapturedKey): void {
    const fp = framePath();
    const record: HumanActionRecord = {
      ts: new Date().toISOString(),
      type,
      frame: fp.path,
      target,
      valueRedacted: true,
      url: cap(location.href),
    };
    if (fp.truncated) record.frameTruncated = true;
    if (key) record.key = key;
    sink.send(record);
  }

  const onClick = guarded(function onClickRaw(e: Event): void {
    emit('click', describeTarget(e.target, true));
  });

  const onFocusIn = guarded(function onFocusInRaw(): void {
    lastFieldEl = null;
  });

  const onFieldChange = guarded(function onFieldChangeRaw(e: Event): void {
    const el = e.target instanceof Element ? e.target : null;
    if (!isField(el) || el === lastFieldEl) return;
    lastFieldEl = el;
    emit('input', describeTarget(el, false, false));
  });

  const onKeydown = guarded(function onKeydownRaw(e: Event): void {
    const key = (e as KeyboardEvent).key;
    if (!CAPTURED_KEYS.has(key)) return;
    // The key travels only in `record.key` (below), never in `target.text`: whatever
    // `describeTarget` found (or didn't -- an editable target reports no text) stands as is.
    const target = describeTarget(e.target, false);
    emit('keypress', target, key as CapturedKey);
  });

  const onSubmit = guarded(function onSubmitRaw(e: Event): void {
    emit('submit', describeTarget(e.target, false));
  });

  const onNavigate = guarded(function onNavigateRaw(): void {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    emit('navigate', {});
  });

  function addNavigationListener(): void {
    const nav = window.navigation;
    if (nav) {
      usingNavigationApi = true;
      nav.addEventListener('navigatesuccess', onNavigate);
      return;
    }
    usingNavigationApi = false;
    window.addEventListener('popstate', onNavigate);
    window.addEventListener('hashchange', onNavigate);
  }

  function removeNavigationListener(): void {
    if (usingNavigationApi) {
      window.navigation?.removeEventListener('navigatesuccess', onNavigate);
      return;
    }
    window.removeEventListener('popstate', onNavigate);
    window.removeEventListener('hashchange', onNavigate);
  }

  return {
    start(): void {
      if (active) return;
      active = true;
      lastFieldEl = null;
      lastUrl = location.href;
      document.addEventListener('click', onClick, true);
      document.addEventListener('focusin', onFocusIn, true);
      document.addEventListener('input', onFieldChange, true);
      document.addEventListener('change', onFieldChange, true);
      document.addEventListener('keydown', onKeydown, true);
      document.addEventListener('submit', onSubmit, true);
      addNavigationListener();
    },

    stop(): void {
      if (!active) return;
      active = false;
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('input', onFieldChange, true);
      document.removeEventListener('change', onFieldChange, true);
      document.removeEventListener('keydown', onKeydown, true);
      document.removeEventListener('submit', onSubmit, true);
      removeNavigationListener();
      lastFieldEl = null;
    },

    isActive(): boolean {
      return active;
    },
  };
}
