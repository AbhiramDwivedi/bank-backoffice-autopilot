import { afterEach, describe, expect, it } from 'vitest';
import { HumanAction as HumanActionSchema, type HumanAction } from '@cu/core/schema';
import { createFakeTeller, type FakeBridge, type FakeTellerApp } from './fake-bridge.js';
import { CT, type WireHumanEvent } from './protocol.js';
import { createDesktopSurface, type DesktopSurface } from './surface.js';
import type { DesktopScreenMask } from './mask.js';

let surface: DesktopSurface | undefined;
afterEach(async () => {
  await surface?.close();
  surface = undefined;
});

async function capturing(mask?: DesktopScreenMask): Promise<{ s: DesktopSurface; app: FakeTellerApp; bridge: FakeBridge; actions: HumanAction[] }> {
  const { app, bridge } = createFakeTeller();
  const s = await createDesktopSurface({ processName: 'TellerWorkstation', attachPid: app.pid, bridge: bridge.connection(), ...(mask ? { mask } : {}) });
  surface = s;
  const actions: HumanAction[] = [];
  await s.humanCapture.start((a) => actions.push(a));
  return { s, app, bridge, actions };
}

const ev = (e: Partial<WireHumanEvent> & Pick<WireHumanEvent, 'type' | 'rid'>): WireHumanEvent => ({
  ct: CT.Button,
  name: '',
  aid: '',
  hwnd: 0,
  password: false,
  focused: false,
  ...e,
});
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

describe('desktop human-action capture', () => {
  it('turns the bridge on and off', async () => {
    const { s, bridge } = await capturing();
    expect(bridge.capturing).toBe(true);
    await s.humanCapture.stop();
    expect(bridge.capturing).toBe(false);
  });

  it('reports a click on a control that was on screen, with what it is, never more', async () => {
    const { bridge, actions } = await capturing();
    bridge.emitHuman(ev({ type: 'nameChanged', rid: '42.6', name: 'Sign On' }));
    await settle();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'click', frame: [], target: { tag: 'button', role: 'button', name: 'Sign On' }, url: 'desktop://tellerworkstation/Teller%20Workstation%20-%20Sign%20On' });
    expect(HumanActionSchema.safeParse(actions[0]).success).toBe(true);
  });

  it('ignores name changes of buttons that just appeared (a panel being shown), and reports a real Invoke event', async () => {
    const { bridge, actions } = await capturing();
    bridge.emitHuman(ev({ type: 'nameChanged', rid: '42.13', name: 'Find' })); // not on the sign-on screen
    await settle();
    expect(actions).toHaveLength(0);
    bridge.emitHuman(ev({ type: 'invoked', rid: '42.99', name: 'Toolbar Save' }));
    await settle();
    expect(actions).toEqual([expect.objectContaining({ type: 'click', target: { name: 'Toolbar Save' } })]);
  });

  it('reports one click when a control raises both an Invoke event and a name change', async () => {
    const { bridge, actions } = await capturing();
    bridge.emitHuman(ev({ type: 'invoked', rid: '42.6', name: 'Sign On' }));
    bridge.emitHuman(ev({ type: 'nameChanged', rid: '42.6', name: 'Sign On' }));
    await settle();
    expect(actions.filter((a) => a.type === 'click')).toHaveLength(1);
  });

  it('typing: one redacted input record per burst on the focused field; app updates of other fields are not reported', async () => {
    const { bridge, actions } = await capturing();
    for (let i = 0; i < 5; i++) bridge.emitHuman(ev({ type: 'valueChanged', rid: '42.5', ct: CT.Edit, name: 'Password:', password: true, focused: true, readOnly: false }));
    bridge.emitHuman(ev({ type: 'valueChanged', rid: '42.3', ct: CT.Edit, name: 'User ID:', focused: false, readOnly: false }));
    bridge.emitHuman(ev({ type: 'valueChanged', rid: '42.33', ct: CT.Edit, name: 'Savings Balance:', focused: true, readOnly: true }));
    await settle();
    expect(actions).toEqual([expect.objectContaining({ type: 'input', valueRedacted: true, target: { tag: 'edit', role: 'textbox', name: 'Password' } })]);
    expect(JSON.stringify(actions)).not.toMatch(/value"\s*:/);
  });

  it('a window title change or a new window of the app is navigation to its desktop:// location', async () => {
    const { bridge, actions } = await capturing();
    bridge.emitHuman(ev({ type: 'nameChanged', rid: '42.1001', ct: CT.Window, hwnd: 1001, name: 'Teller Workstation - Member Lookup', processName: 'TellerWorkstation' }));
    bridge.emitHuman(ev({ type: 'windowOpened', rid: '42.2002', ct: CT.Window, hwnd: 2002, name: 'Confirm Open Sub-Account', processName: 'TellerWorkstation' }));
    await settle();
    expect(actions).toEqual([
      expect.objectContaining({ type: 'navigate', frame: [], url: 'desktop://tellerworkstation/Teller%20Workstation%20-%20Member%20Lookup' }),
      expect.objectContaining({ type: 'navigate', frame: [{ name: 'Confirm Open Sub-Account' }], url: 'desktop://tellerworkstation/Confirm%20Open%20Sub-Account' }),
    ]);
  });

  it('a new window whose own title matches a text pattern: neither its title nor its location is recorded', async () => {
    const { bridge, actions } = await capturing({ maskTextPatterns: ['sub-account'] });
    bridge.emitHuman(ev({ type: 'windowOpened', rid: '42.2002', ct: CT.Window, hwnd: 2002, name: 'Confirm Open Sub-Account', processName: 'TellerWorkstation' }));
    await settle();
    expect(actions).toHaveLength(1);
    expect(JSON.stringify(actions)).not.toMatch(/Sub-Account|Sub-Account/i);
    expect(actions[0]).toMatchObject({ type: 'navigate', frame: [{ index: 0 }], url: 'desktop://tellerworkstation/%5BMASKED%5D' });
  });

  it('a new window whose title carries a string masked on screen has that string scrubbed from its hop and location', async () => {
    // "User ID:" is a static on the sign-on screen; the pattern masks it.
    const { bridge, actions } = await capturing({ maskTextPatterns: ['^user id:$'] });
    bridge.emitHuman(ev({ type: 'windowOpened', rid: '42.2003', ct: CT.Window, hwnd: 2003, name: 'Reset User ID: operator1', processName: 'TellerWorkstation' }));
    await settle();
    expect(actions).toHaveLength(1);
    expect(JSON.stringify(actions)).not.toMatch(/User ID|User%20ID/);
    expect(actions[0]).toMatchObject({ type: 'navigate', frame: [{ index: 0 }], url: 'desktop://tellerworkstation/Reset%20%5BMASKED%5D%20operator1' });
  });

  it("a window of a descendant process is recorded under that process's own origin, not the app's", async () => {
    const { bridge, actions } = await capturing();
    bridge.emitHuman(ev({ type: 'windowOpened', rid: '50.7', ct: CT.Window, hwnd: 7007, name: 'Report', processName: 'ReportViewer' }));
    await settle();
    expect(actions).toEqual([expect.objectContaining({ type: 'navigate', url: 'desktop://reportviewer/Report' })]);
  });

  it('nothing is reported after stop()', async () => {
    const { s, bridge, actions } = await capturing();
    await s.humanCapture.stop();
    bridge.capturing = true; // even if the bridge kept sending
    bridge.emitHuman(ev({ type: 'invoked', rid: '42.6', name: 'Sign On' }));
    await settle();
    expect(actions).toHaveLength(0);
  });
});
