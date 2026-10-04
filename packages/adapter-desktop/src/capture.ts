/**
 * Human-action capture for a desktop app during a handoff: UI Automation event facts from the
 * bridge, turned into the same `HumanAction` records the browser capture produces. What was acted
 * on, never what was typed: the bridge reports that a value changed and never the value, and this
 * module only ever emits `valueRedacted: true` for it.
 *
 * Translation (the bridge watches only windows of the attached process tree):
 *  - a window's title change, or a new window of the app        -> `navigate`, url = its desktop:// location
 *  - UIA Invoke / SelectionItem-selected / Toggle state change   -> `click`
 *  - a name-change notification on a button-like control that was
 *    already on screen                                           -> `click`. Windows Forms raises no UIA
 *    Invoke event for a mouse click (its legacy accessibility layer has none); Button.OnClick raises
 *    a name/state-change notification instead. The same notification fires for every button of a
 *    panel that has just become visible, so only controls present in the view taken before the
 *    event count, and one control clicking is reported once even when both signals arrive.
 *  - a value change on the focused, editable control             -> `input` (valueRedacted), coalesced per
 *    control: one record per burst of typing, not one per keystroke. A change on an unfocused or
 *    read-only control is the app updating itself and is not reported.
 */
import type { FramePath, HumanAction } from '@cu/core/schema';
import { formatDesktopUrl, type HumanActionCapture } from '@cu/core/surface';
import type { BridgeClient } from './bridge-client.js';
import { CT, type WireEvent, type WireHumanEvent } from './protocol.js';
import type { DesktopNode, DesktopView } from './tree.js';

/** Control types a name-change notification can mean "clicked" for. */
const CLICKABLE: ReadonlySet<number> = new Set([CT.Button, CT.CheckBox, CT.RadioButton, CT.MenuItem, CT.Hyperlink, CT.TabItem, CT.ListItem, CT.SplitButton]);
const CLICK_DEDUPE_MS = 400;
const INPUT_COALESCE_MS = 1500;
const REFRESH_DEBOUNCE_MS = 150;

/** What capture needs from the surface. */
export interface DesktopCaptureDeps {
  client: BridgeClient;
  /** A fresh view of the app. */
  snapshot: () => Promise<DesktopView>;
  /** The surface's masking, for the view an action is recorded against. Default: nothing masked. */
  redact?: (view: DesktopView | undefined) => CaptureRedaction;
  log?: (msg: string) => void;
}

/** How a recorded action shows names, free text, frame paths and locations under the surface's mask. */
export interface CaptureRedaction {
  name(node: DesktopNode): string;
  text(s: string): string;
  frame(frame: FramePath): FramePath;
  url(url: string): string;
}

const NO_REDACTION: CaptureRedaction = { name: (n) => n.name, text: (s) => s, frame: (f) => f, url: (u) => u };

/** Creates the desktop `HumanActionCapture`. */
export function createDesktopCapture(deps: DesktopCaptureDeps): HumanActionCapture {
  const log = deps.log ?? (() => undefined);
  let generation = 0;
  let onAction: ((a: HumanAction) => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let view: DesktopView | undefined;
  let known = new Set<string>();
  let refreshTimer: NodeJS.Timeout | undefined;
  const lastClick = new Map<string, number>();
  const lastInput = new Map<string, number>();

  async function refresh(gen: number): Promise<void> {
    try {
      const v = await deps.snapshot();
      if (gen !== generation) return;
      view = v;
      known = new Set(v.nodes.filter((n) => n.visible).map((n) => n.rid));
    } catch (err) {
      log(`capture: refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function scheduleRefresh(gen: number): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refresh(gen), REFRESH_DEBOUNCE_MS);
    refreshTimer.unref?.();
  }

  function windowOf(hwnd: number): { url?: string; frame: FramePath } {
    const w = view?.windows.find((x) => x.hwnd === hwnd);
    return w ? { url: w.url, frame: w.frame } : { frame: [] };
  }

  function emit(action: HumanAction): void {
    try {
      onAction?.(action);
    } catch {
      /* a consumer's failure must not stop capture */
    }
  }

  function redaction(): CaptureRedaction {
    return deps.redact ? deps.redact(view) : NO_REDACTION;
  }

  function targetOf(e: WireHumanEvent): { target: HumanAction['target']; frame: FramePath; url?: string } {
    const r = redaction();
    const node = view?.nodes.find((n) => n.rid === e.rid);
    if (node) {
      const w = windowOf(node.hwnd);
      const name = r.name(node);
      return {
        target: { tag: node.tag, role: node.role, ...(name ? { name } : {}) },
        frame: r.frame(node.frame),
        ...(w.url !== undefined ? { url: r.url(w.url) } : {}),
      };
    }
    const name = r.text(e.name.trim());
    return { target: name ? { name } : {}, frame: [] };
  }

  function handle(e: WireHumanEvent, gen: number): void {
    if (gen !== generation || !onAction) return;
    const now = Date.now();
    const ts = new Date(now).toISOString();
    switch (e.type) {
      case 'windowOpened':
      case 'nameChanged': {
        if (e.ct === CT.Window) {
          // The process of the window that fired: a descendant's window gets its own origin.
          const processName = e.processName ?? view?.windows.find((w) => w.hwnd === e.hwnd)?.processName;
          if (processName === undefined) break;
          const opened = e.type === 'windowOpened';
          const r = redaction();
          const frame: FramePath = opened && view?.main?.hwnd !== e.hwnd ? r.frame([{ name: e.name }]) : [];
          emit({ ts, type: 'navigate', frame, target: {}, url: r.url(formatDesktopUrl(processName, e.name)) });
          break;
        }
        if (e.type === 'nameChanged' && CLICKABLE.has(e.ct) && known.has(e.rid)) click(e, now, ts);
        break;
      }
      case 'invoked':
      case 'selected':
      case 'toggled':
        click(e, now, ts);
        break;
      case 'valueChanged': {
        if (!e.focused || e.readOnly === true) break;
        const last = lastInput.get(e.rid);
        lastInput.set(e.rid, now);
        if (last !== undefined && now - last < INPUT_COALESCE_MS) break;
        const t = targetOf(e);
        emit({ ts, type: 'input', frame: t.frame, target: t.target, valueRedacted: true, ...(t.url !== undefined ? { url: t.url } : {}) });
        break;
      }
    }
    scheduleRefresh(gen);
  }

  function click(e: WireHumanEvent, now: number, ts: string): void {
    const last = lastClick.get(e.rid);
    if (last !== undefined && now - last < CLICK_DEDUPE_MS) return;
    lastClick.set(e.rid, now);
    const t = targetOf(e);
    emit({ ts, type: 'click', frame: t.frame, target: t.target, ...(t.url !== undefined ? { url: t.url } : {}) });
  }

  return {
    async start(cb) {
      const gen = ++generation;
      onAction = cb;
      await refresh(gen);
      if (gen !== generation) return;
      unsubscribe?.();
      unsubscribe = deps.client.onEvent((ev: WireEvent) => {
        if (ev.event === 'human') handle(ev.data, gen);
      });
      await deps.client.call({ op: 'captureStart' });
    },

    async stop() {
      generation++;
      onAction = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      if (refreshTimer) clearTimeout(refreshTimer);
      lastClick.clear();
      lastInput.clear();
      if (deps.client.closed) return;
      try {
        await deps.client.call({ op: 'captureStop' });
      } catch (err) {
        log(`capture: stop failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
