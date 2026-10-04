/**
 * Builds the surface's view of a desktop app from one bridge snapshot: which window is the main
 * one and which is an open dialog, each element's role, accessible name, label, visible text,
 * frame path and geometry, the text digest, and the desktop:// location of every window.
 *
 * Mapping onto the artifact vocabulary (docs/design/desktop.md has the full table):
 *  - The main window is the frame `[]`. Every other visible window of the app (a dialog, a tool
 *    window) is a frame hop named by its title, and a named UIA Group (a Windows Forms GroupBox)
 *    adds a hop named by its caption, the way a frameset adds a hop per frame.
 *  - Geometry is in the main window's client coordinates, in screenshot pixels (physical pixels
 *    divided by the main window's DPI scale), so `bbox`/`relative` locators and the observation's
 *    boxes mean the same thing as on the web: a position on the screenshot the model sees.
 *  - Labels: UIA's LabeledBy when the app sets it; otherwise the nearest static text to the left
 *    (same row) or directly above, inside the same container. Win32 names an edit after the static
 *    that precedes it in z-order, which is often a different control's caption, so when that name
 *    disagrees with the geometric label the label is what the model is shown and the name is not
 *    used as a role locator (see descriptor.ts).
 *
 * Pure functions over plain data: no bridge, no I/O.
 */
import { collapseWhitespace } from '@cu/core/surface';
import { formatDesktopUrl, type BBox } from '@cu/core/surface';
import type { FrameHop, FramePath } from '@cu/core/schema';
import { CT, type WireElement, type WireRect, type WireSnapshot, type WireWindow } from './protocol.js';

/** ControlType id -> [role shown to the model, tag]. Roles follow ARIA names where one exists. */
const ROLES: Readonly<Record<number, readonly [string, string]>> = {
  [CT.Button]: ['button', 'button'],
  [CT.Calendar]: ['calendar', 'calendar'],
  [CT.CheckBox]: ['checkbox', 'checkbox'],
  [CT.ComboBox]: ['combobox', 'combobox'],
  [CT.Edit]: ['textbox', 'edit'],
  [CT.Hyperlink]: ['link', 'hyperlink'],
  [CT.Image]: ['img', 'image'],
  [CT.ListItem]: ['listitem', 'listitem'],
  [CT.List]: ['list', 'list'],
  [CT.Menu]: ['menu', 'menu'],
  [CT.MenuBar]: ['menubar', 'menubar'],
  [CT.MenuItem]: ['menuitem', 'menuitem'],
  [CT.ProgressBar]: ['progressbar', 'progressbar'],
  [CT.RadioButton]: ['radio', 'radiobutton'],
  [CT.ScrollBar]: ['scrollbar', 'scrollbar'],
  [CT.Slider]: ['slider', 'slider'],
  [CT.Spinner]: ['spinbutton', 'spinner'],
  [CT.StatusBar]: ['status', 'statusbar'],
  [CT.Tab]: ['tablist', 'tab'],
  [CT.TabItem]: ['tab', 'tabitem'],
  [CT.Text]: ['text', 'text'],
  [CT.ToolBar]: ['toolbar', 'toolbar'],
  [CT.ToolTip]: ['tooltip', 'tooltip'],
  [CT.Tree]: ['tree', 'tree'],
  [CT.TreeItem]: ['treeitem', 'treeitem'],
  [CT.Custom]: ['custom', 'custom'],
  [CT.Group]: ['group', 'group'],
  [CT.Thumb]: ['thumb', 'thumb'],
  [CT.DataGrid]: ['grid', 'datagrid'],
  [CT.DataItem]: ['row', 'dataitem'],
  [CT.Document]: ['document', 'document'],
  [CT.SplitButton]: ['button', 'splitbutton'],
  [CT.Window]: ['window', 'window'],
  [CT.Pane]: ['pane', 'pane'],
  [CT.Header]: ['header', 'header'],
  [CT.HeaderItem]: ['columnheader', 'headeritem'],
  [CT.Table]: ['table', 'table'],
  [CT.TitleBar]: ['titlebar', 'titlebar'],
  [CT.Separator]: ['separator', 'separator'],
};

/** Controls a person operates: listed first in an observation. */
const INTERACTIVE: ReadonlySet<number> = new Set([
  CT.Button, CT.CheckBox, CT.ComboBox, CT.Edit, CT.Hyperlink, CT.ListItem, CT.MenuItem, CT.RadioButton,
  CT.Slider, CT.Spinner, CT.TabItem, CT.TreeItem, CT.DataItem, CT.SplitButton, CT.Document,
]);
/** Controls that carry information but are not operated: listed after the interactive ones. */
const INFORMATIVE: ReadonlySet<number> = new Set([CT.Text, CT.Group, CT.Image, CT.HeaderItem, CT.StatusBar, CT.ProgressBar, CT.Calendar]);
/** Controls whose visible text is their value, not their name, and that a label describes. */
const VALUE_CONTROLS: ReadonlySet<number> = new Set([CT.Edit, CT.ComboBox, CT.Spinner, CT.Document, CT.Slider]);

/** One element of the app as the surface reasons about it. */
export interface DesktopNode {
  rid: string;
  /** Window handle of the top-level window holding the element. */
  hwnd: number;
  /** Index in `DesktopView.nodes`. */
  index: number;
  ct: number;
  role: string;
  tag: string;
  /** UIA Name, as the app reports it. */
  uiaName: string;
  /** Name shown to the model: the UIA name, or the label when the UIA name is missing or contradicts it. */
  name: string;
  /** The label describing this control (LabeledBy, else geometry), trailing colon removed. */
  label?: string;
  /** The element the label came from. */
  labelRid?: string;
  /** UIA LabeledBy, as reported. */
  labeledByRid?: string;
  /** True when the UIA name is a real name for the control, not a borrowed caption. */
  genuineName: boolean;
  /** AutomationId, only when it is developer-assigned (not a window handle the toolkit made up). */
  automationId?: string;
  /** Raw AutomationId as reported. */
  rawAutomationId: string;
  /** What a person sees on the control: its value for a value control, else its name. */
  text?: string;
  /** Value pattern value; never set for a password field. */
  value?: string;
  password: boolean;
  enabled: boolean;
  visible: boolean;
  focused: boolean;
  readOnly: boolean;
  isDefault: boolean;
  patterns: ReadonlySet<string>;
  /** Screenshot pixels, main window client origin. */
  bbox: BBox;
  /** Physical screen pixels. */
  screen: WireRect;
  frame: FramePath;
  interactive: boolean;
  informative: boolean;
  /** Index of the parent node in `nodes`, -1 when the parent is the window. */
  parent: number;
}

/** One visible window of the app. */
export interface DesktopWindowView {
  hwnd: number;
  title: string;
  processName: string;
  url: string;
  frame: FramePath;
  isMain: boolean;
  /** An owned window (or one UIA reports modal): a dialog of the main window. */
  isDialog: boolean;
  /** A dialog that blocks its owner: what `dialog_open` reports. */
  blocking: boolean;
  wire: WireWindow;
}

/** The whole app, as of one snapshot. */
export interface DesktopView {
  processName: string;
  windows: DesktopWindowView[];
  main?: DesktopWindowView;
  /** The topmost blocking dialog, if one is open. */
  dialog?: DesktopWindowView;
  nodes: DesktopNode[];
  /** Location of the main window (or the bare app origin when it has no window). */
  url: string;
  /** Main window client size in screenshot pixels. */
  viewport: { width: number; height: number };
  /** Main window client origin, physical pixels. */
  origin: WireRect;
  /** Physical pixels per screenshot pixel. */
  scale: number;
  skipped: WireSnapshot['skipped'];
}

/** Options for {@link buildView}. */
export interface BuildViewOptions {
  /** Keep this window as the main one while it is still open. */
  mainHwnd?: number;
  /** The app's process name; windows of other processes in the tree are never chosen as main. */
  processName: string;
}

/** Strips a trailing colon and collapses whitespace: "User ID:" -> "User ID". */
export function cleanLabel(s: string): string {
  return collapseWhitespace(s).replace(/\s*:\s*$/, '');
}

function roleOf(ct: number): readonly [string, string] {
  return ROLES[ct] ?? ['generic', `ct${ct}`];
}

/** A Win32 control without an AutomationId reports its window handle (decimal) instead. */
function stableAutomationId(e: WireElement): string | undefined {
  const aid = e.aid.trim();
  if (aid === '') return undefined;
  if (/^\d+$/.test(aid) && (e.hwnd === 0 || Number(aid) === e.hwnd)) return undefined;
  if (/^\d{5,}$/.test(aid)) return undefined;
  return aid;
}

function frameHopFor(title: string, index: number | undefined): FrameHop {
  return index === undefined ? { name: title } : { name: title, index };
}

/** Builds the view of one snapshot. */
export function buildView(snapshot: WireSnapshot, opts: BuildViewOptions): DesktopView {
  const wanted = opts.processName.toLowerCase();
  const visible = snapshot.windows.filter((w) => !w.minimized || w.hwnd === opts.mainHwnd);
  const handles = new Set(snapshot.windows.map((w) => w.hwnd));
  const ownedByApp = (w: WireWindow): boolean => w.owner !== 0 && handles.has(w.owner);
  const candidates = visible.filter((w) => !ownedByApp(w) && w.processName.toLowerCase() === wanted);
  const mainWire =
    candidates.find((w) => w.hwnd === opts.mainHwnd) ??
    candidates[0] ??
    snapshot.windows.find((w) => !ownedByApp(w) && w.processName.toLowerCase() === wanted);

  const scale = mainWire?.scale && mainWire.scale > 0 ? mainWire.scale : 1;
  const origin: WireRect = mainWire ? mainWire.client : { x: 0, y: 0, w: 0, h: 0 };
  const toShot = (r: WireRect): BBox => ({
    x: Math.round((r.x - origin.x) / scale),
    y: Math.round((r.y - origin.y) / scale),
    w: Math.round(r.w / scale),
    h: Math.round(r.h / scale),
  });

  // Window frames: the main window is [], every other window a hop named by its title.
  const titleCounts = new Map<string, number>();
  const windows: DesktopWindowView[] = [];
  const ordered = mainWire ? [mainWire, ...snapshot.windows.filter((w) => w !== mainWire)] : [...snapshot.windows];
  for (const w of ordered) {
    const isMain = w === mainWire;
    let frame: FramePath = [];
    if (!isMain) {
      const seen = titleCounts.get(w.title) ?? 0;
      titleCounts.set(w.title, seen + 1);
      frame = [frameHopFor(w.title, seen === 0 ? undefined : seen)];
    }
    const isDialog = !isMain && (ownedByApp(w) || w.modal);
    windows.push({
      hwnd: w.hwnd,
      title: w.title,
      processName: w.processName,
      url: formatDesktopUrl(w.processName, w.title),
      frame,
      isMain,
      isDialog,
      blocking: isDialog && (w.modal || !w.ownerEnabled),
      wire: w,
    });
  }
  // `snapshot.windows` is z-ordered topmost first; the first blocking dialog in that order is on top.
  const dialog = snapshot.windows.map((w) => windows.find((v) => v.wire === w)!).find((v) => v.blocking);

  const nodes: DesktopNode[] = [];
  for (const win of windows) {
    const els = win.wire.elements;
    const base = nodes.length;
    // Frame path per element: the window's frame plus every named group above it.
    const frames: FramePath[] = [];
    els.forEach((e, i) => {
      const parentFrame = e.parent >= 0 ? frames[e.parent]! : win.frame;
      const own = e.ct === CT.Group && e.name.trim() !== '' ? [...parentFrame, { name: collapseWhitespace(e.name) }] : parentFrame;
      frames[i] = own;
      // A group's own frame is its parent's: the hop applies to what is inside it.
      const elementFrame = e.ct === CT.Group ? parentFrame : own;
      const [role, tag] = roleOf(e.ct);
      const valueControl = VALUE_CONTROLS.has(e.ct);
      const value = e.password ? undefined : e.value;
      const text = valueControl ? value : collapseWhitespace(e.name) || undefined;
      nodes.push({
        rid: e.rid,
        hwnd: win.hwnd,
        index: base + i,
        ct: e.ct,
        role,
        tag,
        uiaName: e.name,
        name: collapseWhitespace(e.name),
        genuineName: e.name.trim() !== '',
        rawAutomationId: e.aid,
        ...(stableAutomationId(e) !== undefined ? { automationId: stableAutomationId(e)! } : {}),
        ...(e.labeledBy !== undefined ? { labeledByRid: e.labeledBy } : {}),
        ...(text !== undefined && text !== '' ? { text } : {}),
        ...(value !== undefined ? { value } : {}),
        password: e.password,
        enabled: e.enabled,
        visible: !e.offscreen && e.w > 0 && e.h > 0,
        focused: e.focused,
        readOnly: e.readOnly === true,
        isDefault: e.isDefault === true,
        patterns: new Set(e.patterns),
        bbox: toShot(e),
        screen: { x: e.x, y: e.y, w: e.w, h: e.h },
        frame: elementFrame,
        interactive: INTERACTIVE.has(e.ct) || (e.ct === CT.Custom && (e.patterns.includes('invoke') || e.patterns.includes('value'))),
        informative: INFORMATIVE.has(e.ct) && (e.name.trim() !== '' || e.ct === CT.Text),
        parent: e.parent >= 0 ? base + e.parent : -1,
      });
    });
  }
  assignLabels(nodes, scale);

  const main = windows.find((w) => w.isMain);
  const viewport = { width: Math.max(1, Math.round(origin.w / scale)), height: Math.max(1, Math.round(origin.h / scale)) };
  return {
    processName: mainWire?.processName ?? opts.processName,
    windows,
    ...(main ? { main } : {}),
    ...(dialog ? { dialog } : {}),
    nodes,
    url: main ? main.url : formatDesktopUrl(opts.processName),
    viewport,
    origin,
    scale,
    skipped: snapshot.skipped,
  };
}

function overlapsVertically(a: WireRect, b: WireRect): boolean {
  const ac = a.y + a.h / 2;
  const bc = b.y + b.h / 2;
  return (ac >= b.y - 2 && ac <= b.y + b.h + 2) || (bc >= a.y - 2 && bc <= a.y + a.h + 2);
}

/**
 * LabeledBy first; otherwise the nearest static text in the same container, to the left on the
 * same row, else directly above. Statics get a row label too (the static to their left), which is
 * what "Checking Balance: $310.00" needs for masking and relative anchors. Distances are in
 * physical pixels, scaled by `scale` so the thresholds mean the same on any display.
 */
function assignLabels(nodes: DesktopNode[], scale: number): void {
  const byRid = new Map(nodes.map((n) => [n.rid, n]));
  const statics = nodes.filter((n) => n.ct === CT.Text && n.visible && n.name !== '');
  for (const n of nodes) {
    if (!n.visible) continue;
    const labelable = VALUE_CONTROLS.has(n.ct) || n.ct === CT.Text || n.ct === CT.List;
    if (!labelable) continue;
    let source: DesktopNode | undefined;
    // UIA LabeledBy is honoured only for value controls; a static is never "labeled by" anything.
    if (n.ct !== CT.Text && n.labeledByRid !== undefined) {
      const lb = byRid.get(n.labeledByRid);
      if (lb && lb.name !== '') source = lb;
    }
    if (!source) {
      const siblings = statics.filter((s) => s !== n && s.parent === n.parent && s.hwnd === n.hwnd);
      const left = siblings
        .filter((s) => s.screen.x + s.screen.w <= n.screen.x + 4 * scale && overlapsVertically(s.screen, n.screen))
        .map((s) => ({ s, d: n.screen.x - (s.screen.x + s.screen.w) }))
        .filter((c) => c.d < 300 * scale)
        .sort((a, b) => a.d - b.d)[0]?.s;
      const above =
        n.ct === CT.Text
          ? undefined
          : siblings
              .filter((s) => s.screen.y + s.screen.h <= n.screen.y + 4 * scale && s.screen.x >= n.screen.x - 24 * scale && s.screen.x <= n.screen.x + n.screen.w)
              .map((s) => ({ s, d: n.screen.y - (s.screen.y + s.screen.h) }))
              .filter((c) => c.d < 40 * scale)
              .sort((a, b) => a.d - b.d)[0]?.s;
      source = left ?? above;
    }
    if (!source) continue;
    const label = cleanLabel(source.name);
    if (label === '') continue;
    n.label = label;
    n.labelRid = source.rid;
  }
  for (const n of nodes) {
    if (!VALUE_CONTROLS.has(n.ct)) continue;
    // A field is shown by its label text without the trailing colon ("User ID", not "User ID:").
    const uia = cleanLabel(n.uiaName);
    n.name = uia;
    if (n.label !== undefined && uia !== n.label) {
      // The toolkit borrowed some other control's caption (or none): show the label instead.
      n.genuineName = false;
      n.name = n.label;
    }
  }
}

/** The text a person sees in one window or frame, in tree order, whitespace-collapsed. */
export function digestOf(view: DesktopView, nodes: readonly DesktopNode[], maskedText: (n: DesktopNode) => string | undefined): string {
  const parts: string[] = [];
  const titles = new Set<number>();
  for (const n of nodes) {
    if (!n.visible) continue;
    if (!titles.has(n.hwnd)) {
      titles.add(n.hwnd);
      const w = view.windows.find((x) => x.hwnd === n.hwnd);
      if (w && w.title) parts.push(w.title);
    }
    const shown = maskedText(n);
    if (shown !== undefined && shown !== '') parts.push(shown);
  }
  return collapseWhitespace(parts.join(' '));
}
