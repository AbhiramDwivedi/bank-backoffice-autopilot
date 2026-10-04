/**
 * Integration: PlaywrightSurface against the real mock app (tenant A, default password),
 * through the 1998 login, the 2001 frameset, the 2005 search and the 2008 detail page.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '@cu/mock-app/app';
import type { FramePath, LocatorStrategy, TargetDescriptor } from '@cu/core/schema';
import { createPlaywrightSurface, type PlaywrightSurface } from './surface.js';

const MAIN: FramePath = [{ name: 'main' }];

function target(description: string, frame: FramePath, ...strategies: LocatorStrategy[]): TargetDescriptor {
  return { description, frame, locators: strategies.map((strategy) => ({ strategy, confidence: 0.5, source: 'recorded' as const })) };
}

describe('PlaywrightSurface x mock app (tenant A)', () => {
  let server: Server;
  let baseUrl: string;
  let surface: PlaywrightSurface;

  beforeAll(async () => {
    const app = createApp({ tenant: 'a', password: 'demo-pass-123' });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    surface = await createPlaywrightSurface({ headless: true, baseUrl });
  });

  afterAll(async () => {
    await surface?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it('logs in, searches 12345 and reads the savings balance through frames and legacy markup', async () => {
    // 1998 login: labels live in adjacent <td>s, the submit is an <input type=image> with no alt.
    expect((await surface.act({ type: 'navigate', url: `${baseUrl}/login` }, 10_000)).ok).toBe(true);

    const userId = await surface.act({ type: 'type', target: target('User ID', [], { kind: 'label', label: 'User ID' }), value: 'operator1' }, 10_000);
    expect(userId.ok).toBe(true);
    const pw = await surface.act({ type: 'type', target: target('Password', [], { kind: 'label', label: 'Password' }), value: 'demo-pass-123' }, 10_000);
    expect(pw.ok).toBe(true);

    const login = await surface.observe();
    const pwEl = login.elements.find((e) => e.tag === 'input' && e.name === 'Password');
    expect(pwEl, 'password input named via the adjacent-cell heuristic').toBeDefined();
    expect(pwEl!.value).toBe('[REDACTED]');
    expect(JSON.stringify(login.elements)).not.toContain('demo-pass-123');
    expect(login.textDigest).not.toContain('demo-pass-123');

    const imageButton = login.elements.find((e) => e.tag === 'input' && e.role === 'button');
    expect(imageButton).toBeDefined();
    const clicked = await surface.act({ type: 'click', target: { ref: imageButton!.ref } }, 10_000);
    expect(clicked.ok).toBe(true);

    // 2001 frameset: content lives in frame "main".
    expect(await surface.waitFor({ kind: 'url_matches', pattern: '/members/search', frame: MAIN }, 10_000)).toBe(true);

    // Maintenance interstitial (default ON): a div modal with an "OK" div-button inside frame main.
    if (await surface.waitFor({ kind: 'text_visible', text: 'System Maintenance Notice', frame: MAIN }, 3_000)) {
      const ok = await surface.act({ type: 'click', target: target('Maintenance OK', MAIN, { kind: 'text', text: 'OK', exact: true, tag: 'div' }) }, 10_000);
      expect(ok.ok).toBe(true);
      expect(await surface.waitFor({ kind: 'text_absent', text: 'System Maintenance Notice' }, 5_000)).toBe(true);
    }

    const shell = await surface.observe();
    expect(shell.frames.map((f) => JSON.stringify(f.path))).toContain(JSON.stringify(MAIN));
    const inMain = shell.elements.filter((e) => JSON.stringify(e.frame) === JSON.stringify(MAIN));
    expect(inMain.length).toBeGreaterThan(0);

    // 2005 search: adjacent-cell label, div.btn "Search".
    const typed = await surface.act({ type: 'type', target: target('Member ID', MAIN, { kind: 'label', label: 'Member ID' }), value: '12345' }, 10_000);
    expect(typed.ok).toBe(true);
    const search = await surface.act({ type: 'click', target: target('Search button', MAIN, { kind: 'text', text: 'Search', exact: true, tag: 'div' }) }, 10_000);
    expect(search.ok).toBe(true);
    expect(await surface.waitFor({ kind: 'url_matches', pattern: 'memberId=12345', frame: MAIN }, 10_000)).toBe(true);

    // Result row: text '12345' is a <td>; the resolver climbs to the tr[onclick].
    const rowRes = await surface.resolve(target('Result row 12345', MAIN, { kind: 'text', text: '12345', exact: true }), 10_000);
    expect(rowRes).toMatchObject({ found: true, strategyKind: 'text', strategyIndex: 0 });
    const row = await surface.act({ type: 'click', target: target('Result row 12345', MAIN, { kind: 'text', text: '12345', exact: true }) }, 10_000);
    expect(row.ok).toBe(true);
    expect(await surface.waitFor({ kind: 'url_matches', pattern: '/members/12345', frame: MAIN }, 10_000)).toBe(true);

    // 2008 detail: label/value table; read the value cell to the right of "Savings Balance".
    const balance = await surface.readText(
      target('Savings balance', MAIN, { kind: 'relative', anchor: { text: 'Savings Balance' }, relation: 'right-of', tag: 'td' }),
      10_000,
    );
    expect(balance).toEqual({ ok: true, text: '$1,234.56' });
  });
});
