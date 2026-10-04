/**
 * FakeSurface's screen-masking support: a `masked` element spec and an `omitScreenshot` screen
 * behave the way a masking surface does, so agent and replay code can be tested against the
 * contract without a browser.
 */
import { describe, expect, it } from 'vitest';
import { FakeSurface } from './fake/surface.js';
import { el, scenario } from './fake/scenario.js';
import { isOmittedScreenshot } from './omitted.js';

function build() {
  return new FakeSurface(
    scenario()
      .screen('detail', {
        url: 'http://app.local/members/7',
        title: 'Member 7 - Pat Example',
        elements: [
          el({ id: 'nameLabel', role: 'cell', name: 'Member Name', text: 'Member Name', tag: 'td', row: 'r1', bbox: { x: 10, y: 10, w: 100, h: 20 } }),
          el({ id: 'name', role: 'cell', name: 'Pat Example', text: 'Pat Example', tag: 'td', row: 'r1', rowAnchorText: 'Member Name', bbox: { x: 120, y: 10, w: 100, h: 20 }, masked: 'member_name' }),
          el({ id: 'heading', role: 'heading', name: 'Member: Pat Example', text: 'Member: Pat Example', tag: 'h2', bbox: { x: 10, y: 0, w: 300, h: 10 } }),
          el({ id: 'nick', role: 'textbox', name: 'Nickname', tag: 'input', value: 'pn-77', bbox: { x: 10, y: 40, w: 100, h: 20 }, masked: 'input' }),
          el({ id: 'mid', role: 'cell', name: '7', text: '7', tag: 'td', bbox: { x: 10, y: 70, w: 100, h: 20 } }),
        ],
      })
      .screen('secret', { url: 'http://app.local/ssn', title: 'SSN', elements: [], omitScreenshot: true })
      .onAny('navigate', { url: 'http://app.local/ssn' })
      .goto('secret')
      .build(),
  );
}

describe('FakeSurface screen masking', () => {
  it('observe(): placeholders and the masked flag on masked specs, masked text replaced elsewhere, descriptor clean', async () => {
    const s = build();
    const obs = await s.observe();
    const name = obs.elements.find((e) => e.ref === 'e2')!;
    expect(name).toMatchObject({ masked: true, name: '[MASKED:member_name]', text: '[MASKED:member_name]' });
    expect(JSON.stringify(name.descriptor)).not.toContain('Pat Example');
    expect(obs.elements.find((e) => e.ref === 'e3')!.text).toBe('Member: [MASKED:member_name]');
    expect(obs.elements.find((e) => e.ref === 'e4')).toMatchObject({ masked: true, value: '[MASKED:input]', name: 'Nickname' });
    expect(obs.title).toBe('Member 7 - [MASKED:member_name]');
    expect(JSON.stringify(obs)).not.toContain('Pat Example');
    expect(JSON.stringify(obs)).not.toContain('pn-77');
  });

  it('readText() and conditions see the real page; describeRef() and domSnapshot() the masked view', async () => {
    const s = build();
    expect(await s.readText({ ref: 'e2' }, 100)).toEqual({ ok: true, text: 'Pat Example', masked: true });
    expect(await s.readText({ ref: 'e5' }, 100)).toEqual({ ok: true, text: '7' });
    expect(await s.check({ kind: 'text_visible', text: 'Pat Example' })).toBe(true);
    expect(await s.describeRef('e2')).toMatchObject({ name: '[MASKED:member_name]', text: '[MASKED:member_name]' });
    const dom = await s.domSnapshot();
    expect(dom).not.toContain('Pat Example');
    expect(dom).not.toContain('pn-77');
    expect(dom).toContain('[MASKED:member_name]');
  });

  it('omitScreenshot: observe() carries no screenshot and screenshot() returns the marked placeholder', async () => {
    const s = build();
    expect((await s.observe()).screenshotPng).toBeDefined();
    await s.act({ type: 'navigate', url: 'http://app.local/ssn' }, 100);
    expect((await s.observe()).screenshotPng).toBeUndefined();
    expect(isOmittedScreenshot(await s.screenshot())).toBe(true);
  });
});
