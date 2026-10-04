/**
 * The real UIA bridge against the real Teller Workstation (apps/mock-desktop). Windows only;
 * skipped elsewhere (CI is Linux, where surface.test.ts covers the same flows against the fake).
 *
 * The person using this machine may be clicking around while this runs, so nothing here depends on
 * which window is in the foreground: the app windows open small, non-activating, at the screen's
 * bottom-right edge, every action is a UIA pattern or a message posted to the app's own window,
 * and every app this file starts is ended in afterAll/afterEach (and by the bridge's job object if
 * the run dies).
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { HumanAction, TargetDescriptor } from '@cu/core/schema';
import type { Observation, ObservedElement } from '@cu/core/surface';
import { buildTeller, createFaultFile, tellerLaunch, TELLER_DATA, TELLER_PASSWORD, TELLER_PROCESS, TELLER_SCRIPT, TELLER_USER, type FaultFile } from '@cu/mock-desktop/launch';
import { startUiaBridge, type BridgeProcess } from './bridge-client.js';
import { processAlive } from './launch.js';
import { createDesktopSurface, type DesktopSurface } from './surface.js';
import { decodePng, ON_WINDOWS } from './test-helpers.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function find(obs: Observation, role: string, name: string): ObservedElement {
  const el = obs.elements.find((e) => e.role === role && e.name === name);
  if (!el) throw new Error(`no ${role} "${name}" in ${obs.elements.map((e) => `${e.role}:${e.name}`).join(', ')}`);
  return el;
}

/** Every surface this file has open: the foreground check below runs against all of them. */
const live = new Set<DesktopSurface>();

async function launch(
  opts: { faultFile?: FaultFile; mask?: Parameters<typeof createDesktopSurface>[0]['mask']; env?: NodeJS.ProcessEnv } = {},
): Promise<DesktopSurface> {
  const s = await createDesktopSurface({
    processName: TELLER_PROCESS,
    launch: tellerLaunch({ ...(opts.faultFile ? { faultFile: opts.faultFile } : {}), ...(opts.env ? { env: opts.env } : {}) }),
    ...(opts.mask ? { mask: opts.mask } : {}),
  });
  live.add(s);
  const close = s.close.bind(s);
  s.close = async () => {
    live.delete(s);
    await close();
  };
  return s;
}

// After every real-bridge test, in every describe: typing, clicking, posting keys and the modal
// dialog never bring an app this file started to the foreground. (Fails only if someone clicks a
// test window itself while the file runs.)
afterEach(async () => {
  for (const s of [...live]) expect(await s.appHasForeground(), 'a test app took the foreground').toBe(false);
});

async function signOnReally(s: DesktopSurface): Promise<void> {
  const obs = await s.observe();
  expect(await s.act({ type: 'type', target: { ref: find(obs, 'textbox', 'User ID').ref }, value: TELLER_USER }, 5000)).toMatchObject({ ok: true });
  expect(await s.act({ type: 'type', target: { ref: find(obs, 'textbox', 'Password').ref }, value: TELLER_PASSWORD }, 5000)).toMatchObject({ ok: true });
  expect(await s.act({ type: 'click', target: { ref: find(obs, 'button', 'Sign On').ref } }, 5000)).toMatchObject({ ok: true });
  expect(await s.waitFor({ kind: 'text_visible', text: 'MEMBER LOOKUP' }, 5000)).toBe(true);
}

async function lookUp(s: DesktopSurface, id: string): Promise<Observation> {
  const obs = await s.observe();
  expect(await s.act({ type: 'type', target: { ref: find(obs, 'textbox', 'Member ID').ref }, value: id, pressEnter: true }, 5000)).toMatchObject({ ok: true });
  await sleep(300);
  return s.observe();
}

describe.skipIf(!ON_WINDOWS)('real bridge x real Teller Workstation', () => {
  let s: DesktopSurface;
  let faults: FaultFile;

  beforeAll(async () => {
    faults = createFaultFile();
    s = await launch({ faultFile: faults, mask: { maskLabels: ['^tax id$'] } });
  });
  afterAll(async () => {
    await s?.close();
  });

  it('observes the sign-on window: location, controls, labels, AutomationIds, a real screenshot', async () => {
    const obs = await s.observe();
    expect(obs.url).toBe('desktop://tellerworkstation/Teller%20Workstation%20-%20Sign%20On');
    expect(find(obs, 'textbox', 'User ID').descriptor.locators[0]!.strategy).toEqual({ kind: 'automation_id', id: 'txtUserId' });
    expect(find(obs, 'button', 'Sign On').descriptor.locators[0]!.strategy).toEqual({ kind: 'automation_id', id: 'btnSignOn' });
    const pw = find(obs, 'textbox', 'Password');
    expect(pw.descriptor.locators.map((l) => l.strategy.kind)).not.toContain('automation_id'); // its id is a window handle
    const png = decodePng(obs.screenshotPng!);
    expect(png.width).toBe(440);
    expect(png.height).toBe(300);
  });

  it('every element resolves through its own descriptor at depth 0', async () => {
    const obs = await s.observe();
    for (const el of obs.elements) {
      const r = await s.resolve(el.descriptor, 0);
      expect(r, `${el.role} "${el.name}"`).toMatchObject({ found: true, strategyIndex: 0 });
    }
  });

  it('resolves by every strategy kind', async () => {
    const t = (strategy: TargetDescriptor['locators'][number]['strategy']): TargetDescriptor => ({ description: 't', frame: [], locators: [{ strategy, confidence: 0.5, source: 'recorded' }] });
    const kinds: TargetDescriptor['locators'][number]['strategy'][] = [
      { kind: 'automation_id', id: 'btnSignOn' },
      { kind: 'role', role: 'button', name: 'Sign On', exact: true },
      { kind: 'label', label: 'User ID' },
      { kind: 'text', text: 'Sign On', tag: 'button' },
      { kind: 'relative', anchor: { text: 'Password:' }, relation: 'right-of', role: 'textbox' },
    ];
    for (const k of kinds) expect(await s.resolve(t(k), 1000), k.kind).toMatchObject({ found: true, strategyKind: k.kind });
    const obs = await s.observe();
    const bbox = find(obs, 'button', 'Sign On').descriptor.locators.find((l) => l.strategy.kind === 'bbox')!.strategy;
    expect(await s.resolve(t(bbox), 0)).toMatchObject({ found: true, strategyKind: 'bbox' });
  });

  it('paints typed fields and the password over in the screenshot', async () => {
    let obs = await s.observe();
    await s.act({ type: 'type', target: { ref: find(obs, 'textbox', 'User ID').ref }, value: TELLER_USER }, 5000);
    await s.act({ type: 'type', target: { ref: find(obs, 'textbox', 'Password').ref }, value: TELLER_PASSWORD }, 5000);
    obs = await s.observe();
    const png = decodePng(obs.screenshotPng!);
    for (const name of ['User ID', 'Password']) {
      const b = find(obs, 'textbox', name).bbox;
      for (const [x, y] of [
        [b.x + 3, b.y + b.h / 2],
        [b.x + b.w / 2, b.y + b.h / 2],
        [b.x + b.w - 3, b.y + b.h / 2],
      ] as const) {
        expect(png.pixel(x, y).slice(0, 3), `${name} at ${x},${y}`).toEqual([127, 127, 127]);
      }
    }
    // The button is not painted.
    const btn = find(obs, 'button', 'Sign On').bbox;
    expect(png.pixel(btn.x + 4, btn.y + btn.h / 2).slice(0, 3)).not.toEqual([127, 127, 127]);
    // A typed value is masked in the text channel too (as on the web surface).
    expect(find(obs, 'textbox', 'User ID').value).toBe('[MASKED]');
    expect(find(obs, 'textbox', 'Password').value).toBe('[REDACTED]');
  });

  it('signs on, looks up a member by posting Enter, reads the balance; masks the labeled Tax ID in text', async () => {
    const obs0 = await s.observe();
    await s.act({ type: 'click', target: { ref: find(obs0, 'button', 'Sign On').ref } }, 5000);
    expect(await s.waitFor({ kind: 'url_matches', pattern: 'Member%20Lookup$' }, 5000)).toBe(true);
    const obs = await lookUp(s, '12345');
    expect(obs.url).toBe('desktop://tellerworkstation/Teller%20Workstation%20-%20Member%2012345');
    const savings = find(obs, 'textbox', 'Savings Balance');
    expect(savings.frame).toEqual([{ name: 'Balances' }]);
    expect(await s.readText(savings.descriptor, 2000)).toEqual({ ok: true, text: '$1,234.56' });
    expect(find(obs, 'textbox', 'Tax ID').value).toBe('[MASKED]');
    expect(obs.textDigest).not.toContain('900-25-2345');
    const png = decodePng(obs.screenshotPng!);
    const tax = find(obs, 'textbox', 'Tax ID').bbox;
    expect(png.pixel(tax.x + tax.w / 2, tax.y + tax.h / 2).slice(0, 3)).toEqual([127, 127, 127]);
  });

  it('handles the modal confirmation: dialog_open, unexpected_dialog outside it, cancel, then accept', async () => {
    let obs = await s.observe();
    await s.act({ type: 'click', target: { ref: find(obs, 'button', 'Open Sub-Account...').ref } }, 5000);
    expect(await s.waitFor({ kind: 'dialog_open', messagePattern: 'sub-account for member 12345' }, 5000)).toBe(true);
    obs = await s.observe();
    expect(obs.dialog).toMatchObject({ type: 'confirm' });
    expect(find(obs, 'button', 'Cancel').frame).toEqual([{ name: 'Confirm Open Sub-Account' }]);
    expect(await s.act({ type: 'click', target: { ref: find(obs, 'button', 'New Lookup').ref } }, 2000)).toMatchObject({ ok: false, error: { code: 'unexpected_dialog' } });
    expect(await s.act({ type: 'dismiss_dialog', accept: false }, 5000)).toMatchObject({ ok: true });
    expect(await s.waitFor({ kind: 'not', of: { kind: 'dialog_open' } }, 5000)).toBe(true);
    obs = await s.observe();
    await s.act({ type: 'click', target: { ref: find(obs, 'button', 'Open Sub-Account...').ref } }, 5000);
    expect(await s.waitFor({ kind: 'dialog_open' }, 5000)).toBe(true);
    expect(await s.act({ type: 'dismiss_dialog', accept: true }, 5000)).toMatchObject({ ok: true });
    expect(await s.waitFor({ kind: 'text_visible', text: 'Sub-account SA-1000001 opened for member 12345.' }, 5000)).toBe(true);
  });

  it('reports the application-error and session-expired faults as on-screen text replay can classify', async () => {
    let obs = await s.observe();
    await s.act({ type: 'click', target: { ref: find(obs, 'button', 'New Lookup').ref } }, 5000);
    faults.set({ failLookup: true });
    await lookUp(s, '12345');
    expect(await s.waitFor({ kind: 'text_visible', text: 'Application Error' }, 5000)).toBe(true);
    faults.set({ expireSession: true });
    obs = await s.observe();
    await s.act({ type: 'click', target: { ref: find(obs, 'button', 'Find').ref } }, 5000);
    expect(await s.waitFor({ kind: 'text_visible', text: 'Your session has expired' }, 5000)).toBe(true);
    faults.clear();
  });
});

describe.skipIf(!ON_WINDOWS)('scope: another window on the desktop is invisible and unreachable', () => {
  let a: DesktopSurface;
  let b: DesktopSurface;
  beforeAll(async () => {
    a = await launch();
    b = await launch();
    await signOnReally(b); // b now shows MEMBER LOOKUP; a still shows Sign On
  });
  afterAll(async () => {
    await a?.close();
    await b?.close();
  });

  it("a's observation, locators and navigation never reach b's window, though both are the same program", async () => {
    const obs = await a.observe();
    expect(obs.url).toContain('Sign%20On');
    expect(obs.textDigest).not.toContain('MEMBER LOOKUP');
    expect(obs.frames).toEqual([]);
    expect(obs.elements.some((e) => e.name === 'Find')).toBe(false);
    const find: TargetDescriptor = { description: 'Find', frame: [], locators: [{ strategy: { kind: 'role', role: 'button', name: 'Find' }, confidence: 1, source: 'recorded' }] };
    expect((await a.resolve(find, 500)).found).toBe(false);
    expect(await a.act({ type: 'navigate', url: 'desktop://tellerworkstation/Teller%20Workstation%20-%20Member%20Lookup' }, 500)).toMatchObject({
      ok: false,
      error: { code: 'navigation_failed' },
    });
    expect(await a.frameUrls()).toEqual([obs.url]);
  });

  it("the bridge refuses b's elements and windows by id even when asked directly", async () => {
    const bView = await b.view(true);
    const bFind = bView.nodes.find((n) => n.name === 'Find')!;
    const probe = await startUiaBridge();
    try {
      await probe.client.call({ op: 'attach', pid: a.rootPid });
      await expect(probe.client.call({ op: 'act', rid: bFind.rid, kind: 'invoke' })).rejects.toMatchObject({ code: 'stale' });
      await expect(probe.client.call({ op: 'key', key: 'Enter', hwnd: bView.main!.hwnd })).rejects.toMatchObject({ code: 'out_of_scope' });
      await expect(probe.client.call({ op: 'screenshot', hwnd: bView.main!.hwnd })).rejects.toMatchObject({ code: 'out_of_scope' });
      await expect(probe.client.call({ op: 'attach', pid: b.rootPid })).rejects.toMatchObject({ code: 'already_attached' });
      const snap = await probe.client.call({ op: 'snapshot' });
      expect(snap.windows.map((w) => w.hwnd)).not.toContain(bView.main!.hwnd);
    } finally {
      await probe.close();
    }
    // b is untouched.
    expect((await b.observe()).textDigest).toContain('MEMBER LOOKUP');
  });
});


/** Every string anywhere in a value (an observation, a snapshot), for "appears nowhere" checks. */
function allStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out));
  else if (v !== null && typeof v === 'object' && !Buffer.isBuffer(v)) Object.values(v).forEach((x) => allStrings(x, out));
  return out;
}

describe.skipIf(!ON_WINDOWS)('a masked static value appears nowhere', () => {
  let s: DesktopSurface;
  afterAll(async () => {
    await s?.close();
  });

  it('not in names, texts, locators, snapshots, the digest or domSnapshot; readText still reads it', async () => {
    s = await launch({ mask: { maskLabels: ['^checking balance$'] } });
    await signOnReally(s);
    const obs = await lookUp(s, '12345');
    expect(allStrings(obs).filter((x) => x.includes('$310.00'))).toEqual([]);
    const masked = obs.elements.filter((e) => e.masked);
    expect(masked).toHaveLength(1);
    expect(masked[0]).toMatchObject({ role: 'text', name: '[MASKED]' });
    expect(masked[0]!.descriptor.locators.some((l) => l.strategy.kind === 'text')).toBe(false);
    expect(await s.domSnapshot()).not.toContain('$310.00');
    expect(await s.readText({ ref: masked[0]!.ref }, 2000)).toEqual({ ok: true, text: '$310.00', masked: true });
    expect(await s.resolve(masked[0]!.descriptor, 1000)).toMatchObject({ found: true });
  });
});

/** Re-parents `child` into `parent`'s client area at (0,0) and returns its physical screen rectangle. */
function reparent(child: number, parent: number): { x: number; y: number; w: number; h: number } {
  const script = `
Add-Type -Namespace P -Name W -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr SetParent(System.IntPtr c, System.IntPtr p);
[DllImport("user32.dll")] public static extern bool MoveWindow(System.IntPtr h, int x, int y, int w, int hh, bool r);
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr c);
[StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out R r);
'@
[void][P.W]::SetProcessDpiAwarenessContext([System.IntPtr](-4))
[void][P.W]::SetParent([System.IntPtr]${child}, [System.IntPtr]${parent})
[void][P.W]::MoveWindow([System.IntPtr]${child}, 0, 0, 520, 360, $true)
$r = New-Object 'P.W+R'
[void][P.W]::GetWindowRect([System.IntPtr]${child}, [ref]$r)
"$($r.L),$($r.T),$($r.Rt),$($r.B)"`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/).pop()!;
  const [l, t, r, b] = out.split(',').map(Number) as [number, number, number, number];
  return { x: l, y: t, w: r - l, h: b - t };
}

describe.skipIf(!ON_WINDOWS)("another process's window hosted inside the app is neither read nor shown", () => {
  let a: DesktopSurface;
  let b: DesktopSurface;
  afterAll(async () => {
    await a?.close();
    await b?.close();
  });

  it("b's main window re-parented into a: a's observation lists none of it, and a's screenshot paints it over", async () => {
    a = await launch();
    b = await launch();
    await signOnReally(b); // b shows MEMBER LOOKUP and a Find button; a shows Sign On
    const aView = await a.view(true);
    const bView = await b.view(true);
    const rect = reparent(bView.main!.hwnd, aView.main!.hwnd);
    await sleep(300);
    const obs = await a.observe();
    expect(obs.textDigest).not.toContain('MEMBER LOOKUP');
    expect(obs.elements.some((e) => e.name === 'Find' || e.name === 'Sign Off')).toBe(false);
    expect(allStrings(obs).some((x) => x.includes('MEMBER LOOKUP'))).toBe(false);
    expect(await a.domSnapshot()).not.toContain('MEMBER LOOKUP');
    const findButton: TargetDescriptor = { description: 'Find', frame: [], locators: [{ strategy: { kind: 'role', role: 'button', name: 'Find' }, confidence: 1, source: 'recorded' }] };
    expect((await a.resolve(findButton, 300)).found).toBe(false);
    // The hosted window's area of a's screenshot is the mask colour.
    const view = await a.view(true);
    const png = decodePng(obs.screenshotPng!);
    const cx = Math.round((rect.x + rect.w / 2 - view.origin.x) / view.scale);
    const cy = Math.round((rect.y + rect.h / 2 - view.origin.y) / view.scale);
    expect(cx).toBeGreaterThan(0);
    expect(cy).toBeGreaterThan(0);
    expect(png.pixel(Math.min(cx, png.width - 1), Math.min(cy, png.height - 1)).slice(0, 3)).toEqual([127, 127, 127]);
  });
});

describe.skipIf(!ON_WINDOWS)('the wire protocol never carries a password value back', () => {
  let s: DesktopSurface;
  afterAll(async () => {
    await s?.close();
  });

  it('a password typed through the bridge is absent from every line the bridge writes', async () => {
    s = await launch();
    const secret = 'Unique-Pass-90817';
    const probe = await startUiaBridge();
    let raw = '';
    probe.child.stdout!.on('data', (d: Buffer) => {
      raw += d.toString();
    });
    try {
      await probe.client.call({ op: 'attach', pid: s.rootPid });
      const before = await probe.client.call({ op: 'snapshot' });
      const pw = before.windows[0]!.elements.find((e) => e.password)!;
      await probe.client.call({ op: 'act', rid: pw.rid, kind: 'setValue', value: secret });
      const after = await probe.client.call({ op: 'snapshot' });
      await probe.client.call({ op: 'screenshot', hwnd: after.windows[0]!.hwnd });
      const pwAfter = after.windows[0]!.elements.find((e) => e.password)!;
      expect('value' in pwAfter).toBe(false);
    } finally {
      await probe.close();
    }
    expect(raw.length).toBeGreaterThan(1000);
    expect(raw).not.toContain(secret);
  });

  it('every string the bridge reports is cut at 1000 characters', async () => {
    const obs = await s.observe();
    await s.act({ type: 'type', target: { ref: find(obs, 'textbox', 'User ID').ref }, value: 'x'.repeat(5000) }, 5000);
    // A typed value is masked in observations, so the bridge's cut is read off the view itself.
    const view = await s.view(true);
    expect(view.nodes.find((n) => n.automationId === 'txtUserId')?.value).toBe('x'.repeat(1000));
  });
});

describe.skipIf(!ON_WINDOWS)('attach refuses what it must not own', () => {
  it('a process the user cannot open is reported as access denied, not as missing', async () => {
    const probe = await startUiaBridge();
    try {
      await expect(probe.client.call({ op: 'attach', pid: 4 })).rejects.toMatchObject({ code: 'access_denied' });
    } finally {
      await probe.close();
    }
  });

  it('killOnClose is refused for a process the runtime did not launch (a recycled or foreign pid), and the process is left alone', async () => {
    const launchedAfter = Date.now();
    // Started through an intermediary, so its parent is not this process.
    const starter = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `$p = Start-Process -FilePath '${buildTeller()}' -ArgumentList '"${TELLER_DATA}"' -PassThru; $p.Id`],
      { windowsHide: true, env: { ...process.env, MOCK_DESKTOP_QUIET: '1', MOCK_DESKTOP_WATCH_PID: String(process.pid) } },
    );
    let out = '';
    starter.stdout.on('data', (d: Buffer) => (out += d.toString()));
    await new Promise((r) => starter.once('exit', r));
    const pid = Number(out.trim());
    expect(pid).toBeGreaterThan(0);
    await sleep(1500);
    const probe = await startUiaBridge();
    try {
      await expect(probe.client.call({ op: 'attach', pid, killOnClose: true })).rejects.toMatchObject({ code: 'bad_request' });
      await expect(probe.client.call({ op: 'attach', pid, killOnClose: true, launchedBy: process.pid, launchedAfter })).rejects.toMatchObject({ code: 'not_launched' });
      // Not owned, so attach plainly and close its window the way its close box would.
      await probe.client.call({ op: 'attach', pid });
      const snap = await probe.client.call({ op: 'snapshot' });
      expect(processAlive(pid)).toBe(true); // the refused attach adopted nothing that dies with the bridge
      await probe.client.call({ op: 'act', rid: snap.windows[0]!.rid, kind: 'closeWindow' });
    } finally {
      await probe.close();
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && processAlive(pid)) await sleep(200);
    expect(processAlive(pid)).toBe(false);
  });
});

describe.skipIf(!ON_WINDOWS)('the interop cache is verified, not trusted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-uia-cache-'));
  const versionDir = (): string => {
    const dirs = fs.readdirSync(root).filter((d) => !d.startsWith('staging-'));
    expect(dirs).toHaveLength(1);
    return path.join(root, dirs[0]!);
  };
  async function startAndStop(opts: { cacheRoot?: string } = { cacheRoot: root }): Promise<void> {
    const b = await startUiaBridge(opts);
    await b.client.call({ op: 'hello' });
    await b.close();
  }
  afterAll(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* a DLL still held by an exiting bridge: the temp directory is cleaned later */
    }
  });
  const sha256 = (file: string): string =>
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-FileHash -LiteralPath '${file}' -Algorithm SHA256).Hash`], { encoding: 'utf8', windowsHide: true }).trim();

  it('a planted DLL is regenerated, not loaded', async () => {
    await startAndStop();
    const dll = path.join(versionDir(), 'Interop.UIAutomationClient.dll');
    fs.writeFileSync(dll, 'MZ not the generated assembly');
    await startAndStop(); // would fail to load the planted file if it were trusted
    expect(fs.readFileSync(dll).subarray(0, 40).toString()).not.toContain('not the generated');
    expect(sha256(dll)).toBe(fs.readFileSync(`${dll}.sha256`, 'utf8').trim());
  });

  it('a cache directory left without its DLL is replaced, not nested into', async () => {
    const dir = versionDir();
    fs.rmSync(path.join(dir, 'Interop.UIAutomationClient.dll'));
    await startAndStop();
    await startAndStop(); // and the next start loads it from the cache directly
    expect(fs.existsSync(path.join(versionDir(), 'Interop.UIAutomationClient.dll'))).toBe(true);
    expect(fs.readdirSync(versionDir()).filter((d) => d.startsWith('staging-'))).toEqual([]);
  });

  it('the ambient environment cannot point the bridge at a planted cache, even one with a matching hash', async () => {
    // What a .env file in the working directory could set: a cache root holding a garbage DLL
    // with its own correct hash recorded next to it.
    const planted = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-uia-planted-'));
    const version = path.basename(versionDir());
    fs.mkdirSync(path.join(planted, version));
    const dll = path.join(planted, version, 'Interop.UIAutomationClient.dll');
    fs.writeFileSync(dll, 'MZ planted');
    fs.writeFileSync(`${dll}.sha256`, sha256(dll));
    const before = process.env.CU_UIA_BRIDGE_CACHE;
    process.env.CU_UIA_BRIDGE_CACHE = planted;
    try {
      await startAndStop({}); // the default cache; loading the planted file would fail the start
    } finally {
      if (before === undefined) delete process.env.CU_UIA_BRIDGE_CACHE;
      else process.env.CU_UIA_BRIDGE_CACHE = before;
    }
    expect(fs.readFileSync(dll, 'utf8')).toBe('MZ planted');
    expect(fs.readdirSync(planted)).toEqual([version]);
  });

  it('nor point the mock launcher at a planted exe', () => {
    const planted = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-teller-planted-'));
    // A valid-looking cache there (built through the explicit option, so it verifies)...
    expect(buildTeller({ cacheRoot: planted }).startsWith(planted)).toBe(true);
    // ...is still not used when only the environment names it.
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', TELLER_SCRIPT, '-BuildOnly'], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, MOCK_DESKTOP_CACHE: planted },
    });
    expect(out.trim().split(/\r?\n/).pop()!.trim().startsWith(planted)).toBe(false);
  });
});

describe.skipIf(!ON_WINDOWS)('human-action capture through UIA events', () => {
  let s: DesktopSurface;
  let human: BridgeProcess;
  afterAll(async () => {
    await human?.close();
    await s?.close();
  });

  it('records what a person (played by a second UIA client) clicked and where they went, never what they typed', async () => {
    s = await launch();
    const actions: HumanAction[] = [];
    await s.humanCapture.start((x) => actions.push(x));
    human = await startUiaBridge();
    await human.client.call({ op: 'attach', pid: s.rootPid });
    const snap = await human.client.call({ op: 'snapshot' });
    const els = snap.windows[0]!.elements;
    await human.client.call({ op: 'act', rid: els.find((e) => e.aid === 'txtUserId')!.rid, kind: 'setValue', value: TELLER_USER });
    await human.client.call({ op: 'act', rid: els.find((e) => e.password)!.rid, kind: 'setValue', value: TELLER_PASSWORD });
    await human.client.call({ op: 'act', rid: els.find((e) => e.aid === 'btnSignOn')!.rid, kind: 'invoke' });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !actions.some((x) => x.type === 'navigate')) await sleep(100);
    await s.humanCapture.stop();
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'click', target: expect.objectContaining({ role: 'button', name: 'Sign On' }) }),
        expect.objectContaining({ type: 'navigate', url: 'desktop://tellerworkstation/Teller%20Workstation%20-%20Member%20Lookup' }),
      ]),
    );
    const serialized = JSON.stringify(actions);
    expect(serialized).not.toContain(TELLER_PASSWORD);
    expect(serialized).not.toContain(TELLER_USER);
  });

  /**
   * The value-change fact itself, on the wire. A focused field (what a person's typing lands in)
   * cannot be produced in this test without activating the app's window, which the foreground rule
   * forbids (tried: the app's own Focus() took the foreground), so the input record a focused change
   * becomes is pinned against the fake bridge (capture.test.ts); here the real bridge proves the
   * fact it emits for a typed field carries no value, and that an unfocused change is not reported
   * as a person's input.
   */
  it('a value change reaches the runtime as a fact: the event names the field and never carries the value', async () => {
    const app = await launch();
    const watcher = await startUiaBridge();
    const typist = await startUiaBridge();
    let raw = '';
    watcher.child.stdout!.on('data', (d: Buffer) => {
      raw += d.toString();
    });
    const facts: Record<string, unknown>[] = [];
    watcher.client.onEvent((e) => {
      if (e.event === 'human') facts.push(e.data as unknown as Record<string, unknown>);
    });
    const actions: HumanAction[] = [];
    try {
      await watcher.client.call({ op: 'attach', pid: app.rootPid });
      await typist.client.call({ op: 'attach', pid: app.rootPid });
      await watcher.client.call({ op: 'captureStart' });
      await app.humanCapture.start((x) => actions.push(x));
      const els = (await typist.client.call({ op: 'snapshot' })).windows[0]!.elements;
      const userId = els.find((e) => e.aid === 'txtUserId')!;
      const typed = 'Typed-Value-55120';
      await typist.client.call({ op: 'act', rid: userId.rid, kind: 'setValue', value: typed });
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !facts.some((f) => f.type === 'valueChanged' && f.rid === userId.rid)) await sleep(100);
      const fact = facts.find((f) => f.type === 'valueChanged' && f.rid === userId.rid);
      expect(fact).toMatchObject({ type: 'valueChanged', ct: 50004, aid: 'txtUserId', password: false });
      expect(Object.keys(fact!).some((k) => /value/i.test(k) && k !== 'valueChanged')).toBe(false);
      expect(raw).toContain('valueChanged');
      expect(raw).not.toContain(typed);
      // Nobody focused the field: the surface does not call this a person's input.
      expect(actions.filter((a) => a.type === 'input')).toEqual([]);
      expect(JSON.stringify(actions)).not.toContain(typed);
    } finally {
      await app.humanCapture.stop().catch(() => undefined);
      await watcher.close();
      await typist.close();
      await app.close();
    }
  });
});

describe.skipIf(!ON_WINDOWS)('no orphans', () => {
  it('close() ends the bridge and the launched app', async () => {
    const s = await launch();
    const appPid = s.rootPid;
    const bridgePid = s.bridgePid!;
    expect(processAlive(appPid)).toBe(true);
    expect(processAlive(bridgePid)).toBe(true);
    await s.close();
    await sleep(500);
    expect(processAlive(bridgePid)).toBe(false);
    expect(processAlive(appPid)).toBe(false);
  });

  it('a bridge that dies without close() takes the launched app with it (kill-on-close job)', async () => {
    const s = await launch();
    const appPid = s.rootPid;
    try {
      s.killBridgeForTest(); // through the bridge's own process handle, never a pid lookup
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && processAlive(appPid)) await sleep(200);
      expect(processAlive(appPid)).toBe(false);
    } finally {
      await s.close();
    }
  });

  it('attaching (instead of launching) leaves the app running on close', async () => {
    const owner = await launch();
    try {
      const attached = await createDesktopSurface({ processName: TELLER_PROCESS, attachPid: owner.rootPid });
      await attached.close();
      await sleep(300);
      expect(processAlive(owner.rootPid)).toBe(true);
    } finally {
      await owner.close();
    }
  });
});
