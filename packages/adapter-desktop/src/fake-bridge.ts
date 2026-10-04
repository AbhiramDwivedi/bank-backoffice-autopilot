/**
 * An in-process fake of the UIA bridge, speaking the real JSON-lines protocol over a pair of
 * streams, plus `FakeTellerApp`: a model of apps/mock-desktop (Teller Workstation) with the same
 * controls, names, AutomationIds, quirks and geometry the real bridge reports for it (a 200% DPI
 * display: physical rectangles are twice the app's own pixels).
 *
 * This is what lets the whole desktop surface (tree building, locators, descriptors, conditions,
 * masking, dialogs, capture translation) and the CLI wiring be tested on any OS, including the
 * Linux CI. Only the bridge itself and the real app need Windows; their tests are the
 * `*.integration.test.ts` files and tests/e2e/desktop.test.ts.
 */
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { BridgeClient } from './bridge-client.js';
import type { BridgeConnection } from './surface.js';
import { CT, type WireElement, type WireErrorCode, type WireHumanEvent, type WireRequest, type WireResults, type WireScreenshot, type WireSnapshot, type WireWindow } from './protocol.js';

/** Thrown by a fake app to answer a request with a bridge error. */
export class FakeBridgeError extends Error {
  constructor(
    readonly code: WireErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** What a fake app must answer. */
export interface FakeDesktopApp {
  readonly pid: number;
  readonly processName: string;
  snapshot(): WireSnapshot;
  act(req: Extract<WireRequest, { op: 'act' }>): WireResults['act'];
  key(req: Extract<WireRequest, { op: 'key' }>): WireResults['key'];
  screenshot(req: Extract<WireRequest, { op: 'screenshot' }>): WireScreenshot;
}

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** The fake bridge: answers the protocol for one fake app. */
export class FakeBridge {
  /** Every request received, in order (the `id` stripped). */
  readonly requests: WireRequest[] = [];
  private readonly toBridge = new PassThrough();
  private readonly fromBridge = new PassThrough();
  readonly client: BridgeClient;
  private attachedPid: number | undefined;
  capturing = false;
  closed = false;
  /** Artificial delay before every answer, ms. */
  delayMs = 0;

  constructor(readonly app: FakeDesktopApp) {
    this.client = new BridgeClient(this.fromBridge, this.toBridge);
    const lines = readline.createInterface({ input: this.toBridge });
    lines.on('line', (line) => void this.onLine(line));
    this.write({ event: 'ready', data: { protocol: 1, bridgePid: 1 } });
  }

  /** A `BridgeConnection` for `createDesktopSurface({ bridge })`. */
  connection(): BridgeConnection {
    return { client: this.client, close: () => this.close() };
  }

  /** Pushes a human-action fact, as the real bridge does while capture is on. */
  emitHuman(e: WireHumanEvent): void {
    if (this.capturing) this.write({ event: 'human', data: e });
  }

  async close(): Promise<void> {
    await this.client.close();
    this.closed = true;
    this.fromBridge.end();
  }

  private write(obj: unknown): void {
    if (!this.fromBridge.writableEnded) this.fromBridge.write(`${JSON.stringify(obj)}\n`);
  }

  private async onLine(line: string): Promise<void> {
    const msg = JSON.parse(line) as { id: number } & WireRequest;
    const { id, ...req } = msg;
    this.requests.push(req as WireRequest);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    try {
      this.write({ id, ok: true, result: this.dispatch(req as WireRequest) });
    } catch (err) {
      const code = err instanceof FakeBridgeError ? err.code : 'failed';
      this.write({ id, ok: false, error: { code, message: err instanceof Error ? err.message : String(err) } });
    }
  }

  private dispatch(req: WireRequest): unknown {
    if (req.op === 'hello') return { protocol: 1, bridgePid: 1 };
    if (req.op === 'shutdown') return { protocol: 1 };
    if (req.op === 'attach') {
      if (this.attachedPid !== undefined && this.attachedPid !== req.pid) throw new FakeBridgeError('already_attached', `bound to ${this.attachedPid}`);
      if (req.pid !== this.app.pid) throw new FakeBridgeError('not_found', `no running process with id ${req.pid}`);
      if (req.killOnClose && (req.launchedBy === undefined || req.launchedAfter === undefined)) {
        throw new FakeBridgeError('bad_request', 'killOnClose needs launchedBy and launchedAfter');
      }
      this.attachedPid = req.pid;
      return { protocol: 1, bridgePid: 1, pid: req.pid, processName: this.app.processName };
    }
    if (this.attachedPid === undefined) throw new FakeBridgeError('not_attached', 'attach to a process first');
    switch (req.op) {
      case 'snapshot':
        return this.app.snapshot();
      case 'act':
        return this.app.act(req);
      case 'key':
        return this.app.key(req);
      case 'screenshot':
        return this.app.screenshot(req);
      case 'captureStart':
        this.capturing = true;
        return true;
      case 'captureStop':
        this.capturing = false;
        return true;
      case 'foreground':
        return { owned: false };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// FakeTellerApp
// ---------------------------------------------------------------------------------------------

interface Member {
  id: string;
  name: string;
  address: string;
  phone: string;
  taxId: string;
  savings: string;
  checking: string;
  restricted?: boolean;
}

const MEMBERS: Member[] = [
  { id: '12345', name: 'Jane Q. Sample', address: '282 Mill St, Springfield, MA 01103', phone: '(413) 555-0126', taxId: '900-25-2345', savings: '$1,234.56', checking: '$310.00' },
  { id: '10001', name: 'Harold T. Abernathy', address: '170 Elm St, Springfield, MA 01103', phone: '(413) 555-0110', taxId: '900-21-0001', savings: '$4,822.10', checking: '$915.44' },
  { id: '90001', name: 'Restricted X. Insider', address: '1 Vault Rd', phone: '(413) 555-0199', taxId: '900-11-0001', savings: '$9,999.99', checking: '$999.99', restricted: true },
];

/** Fault switches of the fake teller, as apps/mock-desktop's MOCK_DESKTOP_FAULTS. */
export interface FakeTellerFaults {
  failLookup?: boolean;
  /** One-shot: the next action lands on the sign-on screen with the expiry banner. */
  expireSession?: boolean;
}

type Screen = 'signon' | 'lookup' | 'detail';

/** Options for {@link FakeTellerApp}. */
export interface FakeTellerOptions {
  /** Physical pixels per app pixel. Default 2 (a 200% display, as on the development machine). */
  scale?: number;
  /** Add a visible window of another process in the owned tree (a launcher console, say). */
  launcherWindow?: boolean;
  user?: string;
  password?: string;
}

/** A model of Teller Workstation as the real bridge reports it. */
export class FakeTellerApp implements FakeDesktopApp {
  readonly pid = 4242;
  readonly processName = 'TellerWorkstation';
  static readonly MAIN = 1001;
  static readonly DIALOG = 2002;
  screen: Screen = 'signon';
  dialogOpen = false;
  faults: FakeTellerFaults = {};
  readonly values = new Map<string, string>();
  /** Every value ever set through the bridge, by rid (tests assert what was typed where). */
  readonly typed: { rid: string; value: string }[] = [];
  readonly keys: { key: string; rid?: string; hwnd?: number }[] = [];
  lastScreenshot: Extract<WireRequest, { op: 'screenshot' }> | undefined;
  private signOnError = false;
  private expired = false;
  private lookupMessage = '';
  private detailStatus = '';
  private member: Member | undefined;
  private nextRef = 1000001;
  private readonly scale: number;
  private readonly origin = { x: 1000, y: 500 };

  constructor(private readonly opts: FakeTellerOptions = {}) {
    this.scale = opts.scale ?? 2;
  }

  private get user(): string {
    return this.opts.user ?? 'operator1';
  }

  private get password(): string {
    return this.opts.password ?? 'demo-pass-123';
  }

  // --- model --------------------------------------------------------------------------------

  private el(rid: string, ct: number, name: string, box: [number, number, number, number], extra: Partial<WireElement> = {}, parent = -1): WireElement {
    const s = this.scale;
    const [x, y, w, h] = box;
    const isValue = ct === CT.Edit;
    const hwnd = extra.hwnd ?? Number(rid.split('.')[1]) * 1000;
    return {
      rid,
      parent,
      ct,
      name,
      aid: extra.aid ?? String(hwnd),
      cls: ct === CT.Edit ? 'WindowsForms10.EDIT.app.0' : ct === CT.Button ? 'WindowsForms10.BUTTON.app.0' : 'WindowsForms10.STATIC.app.0',
      help: '',
      x: this.origin.x + x * s,
      y: this.origin.y + y * s,
      w: w * s,
      h: h * s,
      password: false,
      enabled: !this.dialogOpen,
      offscreen: false,
      focusable: ct !== CT.Text,
      focused: false,
      hwnd,
      patterns: [...(ct === CT.Button ? ['invoke'] : []), ...(isValue ? ['value'] : []), 'legacy'],
      ...(isValue && !extra.password ? { value: this.values.get(rid) ?? '' } : {}),
      ...(isValue ? { readOnly: false } : {}),
      isDefault: false,
      ...extra,
    };
  }

  private mainElements(): WireElement[] {
    const E = CT.Edit;
    const T = CT.Text;
    const B = CT.Button;
    switch (this.screen) {
      case 'signon':
        return [
          this.el('42.1', T, 'TELLER WORKSTATION  v3.1  -  AUTHORIZED USE ONLY', [16, 12, 400, 16]),
          ...(this.expired ? [this.el('42.8', T, 'Your session has expired. Please sign on again.', [16, 36, 400, 16], { aid: 'lblExpired' })] : []),
          this.el('42.2', T, 'User ID:', [16, 70, 80, 16]),
          this.el('42.3', E, 'User ID:', [110, 67, 160, 20], { aid: 'txtUserId' }),
          this.el('42.4', T, 'Password:', [16, 100, 80, 16]),
          this.el('42.5', E, 'Password:', [110, 97, 160, 20], { password: true }),
          this.el('42.6', B, 'Sign On', [110, 130, 90, 24], { aid: 'btnSignOn', isDefault: true }),
          ...(this.signOnError ? [this.el('42.7', T, 'Invalid user ID or password.', [110, 164, 300, 16])] : []),
        ];
      case 'lookup':
        return [
          // Created before its label: Win32 names it after an unrelated caption.
          this.el('42.10', E, 'Invalid user ID or password.', [110, 47, 120, 20]),
          this.el('42.11', T, 'MEMBER LOOKUP', [16, 12, 300, 16]),
          this.el('42.12', T, 'Member ID:', [16, 50, 80, 16]),
          this.el('42.13', B, 'Find', [240, 45, 70, 24], { isDefault: true }),
          this.el('42.14', B, 'Sign Off', [330, 260, 90, 24], { aid: 'btnSignOff' }),
          this.el('42.15', T, this.lookupMessage, [16, 90, 410, 32], { aid: 'lblLookupMessage' }),
        ];
      case 'detail': {
        const m = this.member!;
        const ro = { readOnly: true };
        const els: WireElement[] = [
          this.el('42.20', T, 'MEMBER DETAIL', [16, 8, 200, 16]),
          this.el('42.21', T, `Member ${m.id} - ${m.name}`, [16, 26, 400, 16], { aid: 'lblMemberHeader' }),
          this.el('42.22', CT.Group, 'Contact Information', [12, 48, 416, 110]),
        ];
        const g1 = 2;
        const contact: [string, string, string, string | undefined][] = [
          ['Name:', m.name, '42.24', undefined],
          ['Address:', m.address, '42.26', undefined],
          ['Phone:', m.phone, '42.28', undefined],
          ['Tax ID:', m.taxId, '42.30', 'txtTaxId'],
        ];
        contact.forEach(([label, value, rid, aid], i) => {
          const y = 48 + 20 + i * 23;
          els.push(this.el(`42.${23 + i * 2}`, T, label, [22, y, 70, 16], {}, g1));
          this.values.set(rid, value);
          els.push(this.el(rid, E, label, [102, y - 3, 300, 20], { ...ro, ...(aid ? { aid } : {}) }, g1));
        });
        els.push(this.el('42.31', CT.Group, 'Balances', [12, 162, 416, 66]));
        const g2 = els.length - 1;
        this.values.set('42.33', m.savings);
        els.push(
          this.el('42.32', T, 'Savings Balance:', [22, 182, 100, 16], {}, g2),
          this.el('42.33', E, 'Savings Balance:', [132, 179, 120, 20], { ...ro, aid: 'txtSavings' }, g2),
          this.el('42.34', T, 'Checking Balance:', [22, 205, 100, 16], {}, g2),
          this.el('42.35', T, m.checking, [132, 205, 120, 16], {}, g2),
          this.el('42.36', B, 'Open Sub-Account...', [12, 236, 130, 24], { aid: 'btnOpenSubAccount' }),
          this.el('42.37', B, 'New Lookup', [150, 236, 90, 24]),
          this.el('42.38', T, this.detailStatus, [12, 268, 416, 16], { aid: 'lblDetailStatus' }),
        );
        return els;
      }
    }
  }

  private title(): string {
    if (this.screen === 'signon') return `Teller Workstation - ${this.expired ? 'Session Expired' : 'Sign On'}`;
    if (this.screen === 'lookup') return this.lookupMessage.startsWith('Application Error') ? 'Teller Workstation - Application Error' : 'Teller Workstation - Member Lookup';
    return `Teller Workstation - Member ${this.member!.id}`;
  }

  private window(hwnd: number, title: string, client: [number, number, number, number], elements: WireElement[], extra: Partial<WireWindow> = {}): WireWindow {
    const [x, y, w, h] = client;
    return {
      hwnd,
      pid: this.pid,
      processName: this.processName,
      title,
      className: 'WindowsForms10.Window.8.app.0',
      rect: { x: x - 16, y: y - 60, w: w + 32, h: h + 76 },
      client: { x, y, w, h },
      owner: 9999, // the hidden parking window Windows Forms gives a form with no taskbar button
      ownerEnabled: true,
      enabled: !this.dialogOpen,
      minimized: false,
      modal: false,
      scale: this.scale,
      rid: `42.${hwnd}`,
      elements,
      ...extra,
    };
  }

  snapshot(): WireSnapshot {
    const s = this.scale;
    const windows: WireWindow[] = [];
    if (this.dialogOpen) {
      const m = this.member!;
      const dx = this.origin.x + 50 * s;
      const dy = this.origin.y + 95 * s;
      const at = (x: number, y: number, w: number, h: number): [number, number, number, number] => [(dx - this.origin.x) / s + x, (dy - this.origin.y) / s + y, w, h];
      const prev = this.dialogOpen;
      this.dialogOpen = false; // dialog controls are enabled
      const els = [
        this.el('43.1', CT.Text, `Open a new Share Savings sub-account for member ${m.id}? This cannot be undone.`, at(12, 14, 316, 32)),
        this.el('43.2', CT.Button, 'Open Sub-Account', at(120, 70, 120, 24), { isDefault: true }),
        this.el('43.3', CT.Button, 'Cancel', at(248, 70, 80, 24)),
      ];
      this.dialogOpen = prev;
      windows.push(
        this.window(FakeTellerApp.DIALOG, 'Confirm Open Sub-Account', [dx, dy, 340 * s, 110 * s], els, {
          owner: FakeTellerApp.MAIN,
          ownerEnabled: false,
          enabled: true,
          modal: true,
        }),
      );
    }
    windows.push(this.window(FakeTellerApp.MAIN, this.title(), [this.origin.x, this.origin.y, 440 * s, 300 * s], this.mainElements().filter((e) => e.ct !== CT.Text || e.name !== '')));
    if (this.opts.launcherWindow) {
      windows.push({
        ...this.window(3003, 'Launcher', [10, 10, 200, 100], [this.el('44.1', CT.Text, 'Starting...', [0, 0, 100, 16])]),
        pid: 4243,
        processName: 'powershell',
        owner: 0,
      });
    }
    return { rootPid: this.pid, pids: [this.pid], windows, skipped: [] };
  }

  // --- behaviour ----------------------------------------------------------------------------

  private find(rid: string): WireElement {
    for (const w of this.snapshot().windows) {
      const e = w.elements.find((x) => x.rid === rid);
      if (e) return e;
      if (w.rid === rid) return { ...w.elements[0]!, rid, ct: CT.Window, patterns: ['window'] };
    }
    throw new FakeBridgeError('stale', `no element ${rid}`);
  }

  private consumeExpiry(): boolean {
    if (!this.faults.expireSession) return false;
    this.faults.expireSession = false;
    this.toSignOn(true);
    return true;
  }

  private toSignOn(expired: boolean): void {
    this.screen = 'signon';
    this.expired = expired;
    this.signOnError = false;
    this.values.delete('42.3');
    this.values.delete('42.5');
    this.member = undefined;
  }

  private click(rid: string): void {
    switch (rid) {
      case '42.6':
        if (this.values.get('42.3') === this.user && this.values.get('42.5') === this.password) {
          this.screen = 'lookup';
          this.expired = false;
          this.lookupMessage = '';
          this.values.set('42.10', '');
        } else {
          this.signOnError = true;
          this.values.set('42.5', '');
        }
        return;
      case '42.13': {
        if (this.consumeExpiry()) return;
        if (this.faults.failLookup) {
          this.lookupMessage = 'Application Error: ORA-01017 member service unavailable. Contact the help desk.';
          return;
        }
        const id = (this.values.get('42.10') ?? '').trim();
        const m = MEMBERS.find((x) => x.id === id);
        if (!id) this.lookupMessage = 'Enter a member ID.';
        else if (!m) this.lookupMessage = `No member found with ID ${id}.`;
        else if (m.restricted) this.lookupMessage = `Access denied: member record ${id} is restricted.`;
        else {
          this.member = m;
          this.detailStatus = '';
          this.screen = 'detail';
        }
        return;
      }
      case '42.14':
        this.toSignOn(false);
        return;
      case '42.36':
        if (this.consumeExpiry()) return;
        this.dialogOpen = true;
        return;
      case '42.37':
        if (this.consumeExpiry()) return;
        this.screen = 'lookup';
        this.lookupMessage = '';
        this.values.set('42.10', '');
        return;
      case '43.2':
        this.dialogOpen = false;
        this.detailStatus = `Sub-account SA-${this.nextRef++} opened for member ${this.member!.id}.`;
        return;
      case '43.3':
        this.dialogOpen = false;
        return;
    }
  }

  act(req: Extract<WireRequest, { op: 'act' }>): WireResults['act'] {
    const e = this.find(req.rid);
    switch (req.kind) {
      case 'setValue':
        if (e.readOnly) throw new FakeBridgeError('read_only', 'the control is read-only');
        if (!e.patterns.includes('value')) throw new FakeBridgeError('no_pattern', 'the control does not support the UIA Value pattern');
        this.values.set(req.rid, req.value ?? '');
        this.typed.push({ rid: req.rid, value: req.value ?? '' });
        return { done: true };
      case 'invoke':
        if (!e.patterns.includes('invoke')) throw new FakeBridgeError('no_pattern', 'the control does not support the UIA Invoke pattern');
        if (this.dialogOpen && !req.rid.startsWith('43.')) throw new FakeBridgeError('disabled', 'the button is disabled');
        this.click(req.rid);
        return { done: true, via: 'bn_clicked' };
      case 'closeWindow':
        if (req.rid === `42.${FakeTellerApp.DIALOG}`) this.dialogOpen = false;
        return { done: true };
      default:
        throw new FakeBridgeError('no_pattern', `the fake teller does not support ${req.kind}`);
    }
  }

  key(req: Extract<WireRequest, { op: 'key' }>): WireResults['key'] {
    this.keys.push({ key: req.key, ...(req.rid !== undefined ? { rid: req.rid } : {}), ...(req.hwnd !== undefined ? { hwnd: req.hwnd } : {}) });
    if (req.key === 'Enter') {
      if (this.dialogOpen) this.click('43.2');
      else if (this.screen === 'signon') this.click('42.6');
      else if (this.screen === 'lookup') this.click('42.13');
    }
    if (req.key === 'Escape' && this.dialogOpen) this.click('43.3');
    return { hwnd: FakeTellerApp.MAIN };
  }

  screenshot(req: Extract<WireRequest, { op: 'screenshot' }>): WireScreenshot {
    this.lastScreenshot = req;
    const s = this.scale;
    return {
      png: ONE_PIXEL_PNG,
      origin: { x: this.origin.x, y: this.origin.y, w: 440 * s, h: 300 * s },
      scale: s,
      width: 440,
      height: 300,
      masked: (req.maskRids ?? []).length,
      minimized: false,
    };
  }
}

/** A fake bridge over a fresh fake teller. */
export function createFakeTeller(opts: FakeTellerOptions = {}): { app: FakeTellerApp; bridge: FakeBridge } {
  const app = new FakeTellerApp(opts);
  return { app, bridge: new FakeBridge(app) };
}
