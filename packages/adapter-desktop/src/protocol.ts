/**
 * The wire protocol between the TypeScript surface and the UIA bridge (bridge/UiaBridge.cs).
 * JSON lines over stdio: requests carry an `id`, responses echo it, events carry none.
 *
 * Coordinates are physical screen pixels, exactly as UI Automation reports them; `scale` on a
 * window is how many physical pixels one pixel of that window's own rendering covers (2 for a
 * DPI-unaware app on a 200% display). Element values are absent for password fields, always: the
 * bridge never reads them. Every string the bridge reports (names, values, titles, AutomationIds,
 * help text) is cut at 1000 characters. Only elements of the attached process tree are reported:
 * another process's window hosted inside the app is neither walked nor shown.
 *
 * Everything here is plain data so a fake bridge (`fake-bridge.ts`) can speak the same protocol
 * in-process, on any OS.
 */

/** One UI Automation element of an owned window, pre-order, with its parent's index. */
export interface WireElement {
  /** UIA RuntimeId, dot-joined. Stable while the element exists. */
  rid: string;
  /** Index of the parent in the window's `elements`, -1 for a direct child of the window. */
  parent: number;
  /** UIA ControlType id (50000 = Button, 50004 = Edit, ...). */
  ct: number;
  name: string;
  /** UIA AutomationId; for a Win32 control without one, the toolkit may report its window handle. */
  aid: string;
  cls: string;
  help: string;
  x: number;
  y: number;
  w: number;
  h: number;
  password: boolean;
  enabled: boolean;
  offscreen: boolean;
  focusable: boolean;
  focused: boolean;
  /** Native window handle of the element itself, 0 for a windowless element. */
  hwnd: number;
  /** Supported patterns: invoke, value, toggle, selectionItem, selection, expandCollapse, window, legacy. */
  patterns: string[];
  /** RuntimeId of the element UIA's LabeledBy points at, when it has one. */
  labeledBy?: string;
  /** Value pattern value. Never present for a password field. */
  value?: string;
  readOnly?: boolean;
  toggle?: 'on' | 'off' | 'indeterminate';
  selected?: boolean;
  expanded?: boolean;
  /** MSAA "default" state: the button Enter activates. */
  isDefault?: boolean;
}

/** A screen rectangle in physical pixels. */
export interface WireRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One visible top-level window of the owned process tree. */
export interface WireWindow {
  hwnd: number;
  pid: number;
  processName: string;
  title: string;
  className: string;
  rect: WireRect;
  /** The client area, in screen coordinates. */
  client: WireRect;
  /** Owner window handle (0 = none). A Windows Forms main form may have a hidden owner. */
  owner: number;
  ownerEnabled: boolean;
  enabled: boolean;
  minimized: boolean;
  modal: boolean;
  /** Physical pixels per pixel of this window's own rendering. Absent from older bridges: 1. */
  scale?: number;
  rid: string;
  elements: WireElement[];
}

/** `snapshot` result: every visible window of the owned process tree. */
export interface WireSnapshot {
  rootPid: number;
  pids: number[];
  /** Topmost first (z-order). */
  windows: WireWindow[];
  /** Windows that could not be read this time (closing, or the app not answering). */
  skipped: { hwnd: number; title: string; error: string }[];
}

/** `screenshot` result. */
export interface WireScreenshot {
  /** Base64 PNG of the main window's client area with the app's other windows composited on top. */
  png: string;
  /** The main window's client area, physical screen pixels. */
  origin: WireRect;
  /** Physical pixels per screenshot pixel. */
  scale: number;
  width: number;
  height: number;
  /** How many rectangles were painted over. */
  masked: number;
  minimized: boolean;
}

/** UIA pattern operations `act` can run. */
export type WireActKind = 'invoke' | 'toggle' | 'select' | 'expand' | 'collapse' | 'legacyDefault' | 'closeWindow' | 'setValue' | 'selectOption';

/** Requests, by op. */
export type WireRequest =
  | { op: 'hello' }
  /**
   * Binds the bridge to one process tree. `killOnClose` (own it: end it when the bridge ends)
   * requires `launchedBy` (the runtime's pid, the app's parent) and `launchedAfter` (epoch ms just
   * before the launch); the bridge refuses (`not_launched`) a process that is not that child.
   */
  | { op: 'attach'; pid: number; killOnClose?: boolean; launchedBy?: number; launchedAfter?: number }
  | { op: 'snapshot' }
  | { op: 'act'; rid: string; kind: WireActKind; value?: string; blockMs?: number }
  | { op: 'key'; key: string; rid?: string; hwnd?: number }
  /** No typed value ever travels here: fields to paint are named by rid. */
  | { op: 'screenshot'; hwnd: number; maskRids?: string[]; maskRects?: string[] }
  | { op: 'captureStart' }
  | { op: 'captureStop' }
  /** Whether the foreground window belongs to the attached tree (tests pin "never takes focus" with it). */
  | { op: 'foreground' }
  | { op: 'shutdown' };

/** Result type of each op. */
export interface WireResults {
  hello: { protocol: number; bridgePid: number; pid?: number };
  attach: { protocol: number; bridgePid: number; pid: number; processName?: string };
  snapshot: WireSnapshot;
  act: { done: boolean; via?: string };
  key: { hwnd: number };
  screenshot: WireScreenshot;
  captureStart: boolean;
  captureStop: boolean;
  foreground: { owned: boolean };
  shutdown: { protocol: number };
}

/** Error codes the bridge answers with. */
export type WireErrorCode =
  | 'bad_request'
  | 'access_denied'
  | 'not_launched'
  | 'not_attached'
  | 'already_attached'
  | 'not_found'
  | 'stale'
  | 'out_of_scope'
  | 'no_pattern'
  | 'pattern_failed'
  | 'read_only'
  | 'disabled'
  | 'option_not_found'
  | 'unsupported_key'
  | 'uia_error'
  | 'failed';

/** A UIA fact observed while capture is on. Never carries a value. */
export interface WireHumanEvent {
  type: 'invoked' | 'selected' | 'toggled' | 'valueChanged' | 'nameChanged' | 'windowOpened';
  ct: number;
  name: string;
  aid: string;
  hwnd: number;
  rid: string;
  password: boolean;
  focused: boolean;
  readOnly?: boolean;
  /** Process image name (no `.exe`) of the element that fired. */
  processName?: string;
}

/** Messages the bridge pushes without a request. */
export type WireEvent =
  | { event: 'ready'; data: WireResults['hello'] }
  | { event: 'human'; data: WireHumanEvent }
  | { event: 'fatal'; data: string };

/** UIA control type ids this adapter names. */
export const CT = {
  Button: 50000,
  Calendar: 50001,
  CheckBox: 50002,
  ComboBox: 50003,
  Edit: 50004,
  Hyperlink: 50005,
  Image: 50006,
  ListItem: 50007,
  List: 50008,
  Menu: 50009,
  MenuBar: 50010,
  MenuItem: 50011,
  ProgressBar: 50012,
  RadioButton: 50013,
  ScrollBar: 50014,
  Slider: 50015,
  Spinner: 50016,
  StatusBar: 50017,
  Tab: 50018,
  TabItem: 50019,
  Text: 50020,
  ToolBar: 50021,
  ToolTip: 50022,
  Tree: 50023,
  TreeItem: 50024,
  Custom: 50025,
  Group: 50026,
  Thumb: 50027,
  DataGrid: 50028,
  DataItem: 50029,
  Document: 50030,
  SplitButton: 50031,
  Window: 50032,
  Pane: 50033,
  Header: 50034,
  HeaderItem: 50035,
  Table: 50036,
  TitleBar: 50037,
  Separator: 50038,
} as const;
