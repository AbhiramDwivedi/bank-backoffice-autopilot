/**
 * Red team: text leaves, container anchors and the recorder-only context under screen masking, on
 * the real Chromium surface (fixture shared with @cu/browser-agent's tests).
 *
 * Text leaves (1.4.0) are a new place for page text to leave the surface, and container anchors a
 * new place for one element's text to sit in another element's locator. Each case masks one piece
 * of PII and checks it appears nowhere in the observation -- element texts and names, every
 * locator (anchor text, `within`, `selector`), descriptions, snapshots, the digest -- while the
 * recorder-only context (`recordContextOf`) still holds the real row text and is never part of
 * the observation itself.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveScreenMask, type ScreenMaskConfig } from '@cu/core/schema';
import type { Observation, ScreenMaskOptions } from '@cu/core/surface';
import { createPlaywrightSurface, type PlaywrightSurface } from './surface.js';
import { type FixtureServer, startFixtureServer } from './test-helpers.js';

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer();
});

afterAll(async () => {
  await server.close();
});

function mask(config: Partial<ScreenMaskConfig>): ScreenMaskOptions {
  return { config: { ...resolveScreenMask(undefined), ...config }, textPatterns: [] };
}

async function openMasked(file: string, config: Partial<ScreenMaskConfig>): Promise<PlaywrightSurface> {
  const surface = await createPlaywrightSurface({ headless: true, screenMask: mask(config) });
  await surface.page.goto(server.url(file));
  return surface;
}

const text = (obs: Observation): string => JSON.stringify({ title: obs.title, elements: obs.elements, textDigest: obs.textDigest });

describe('text leaves and anchors through screen masking (real surface)', () => {
  it('a masked price leaf shows the placeholder, is flagged, and keeps only the anchor on its (unmasked) product name', async () => {
    const surface = await openMasked('enum-leaves.html', { maskSelectors: ['.price'] });
    try {
      const obs = await surface.observe();
      const all = text(obs);
      for (const v of ['$29.99', '29.99', '$9.99', '$49.99', '$80.00', '$120.00']) expect(all, `${v} leaked`).not.toContain(v);
      const prices = obs.elements.filter((e) => e.masked === true && e.tag === 'div' && e.text?.startsWith('[MASKED'));
      expect(prices.length).toBeGreaterThanOrEqual(3);
      const backpack = prices.find((e) => e.descriptor.locators.some((l) => l.strategy.kind === 'relative' && l.strategy.anchor.text === 'Canvas Backpack'));
      expect(backpack, 'the price keeps its container anchor on the product name').toBeDefined();
      expect(backpack!.descriptor.locators.some((l) => l.strategy.kind === 'text')).toBe(false);
      // Still addressable, and its real text is read locally.
      const read = await surface.readText({ ref: backpack!.ref }, 2_000);
      expect(read.ok && read.text).toBe('$29.99');
      expect(read.ok && read.masked).toBe(true);
    } finally {
      await surface.close();
    }
  });

  it('a masked anchor candidate (the product name) is in no locator, description or snapshot of any element', async () => {
    const surface = await openMasked('enum-leaves.html', { maskSelectors: ['.name'] });
    try {
      const obs = await surface.observe();
      const all = text(obs);
      for (const v of ['Canvas Backpack', 'Bike Light', 'Fleece Jacket', 'Gift Set', 'Mini Mug', 'Trail Tent']) expect(all, `${v} leaked`).not.toContain(v);
      // The prices are still listed (unmasked), with no relative locator anchored on a name.
      const price = obs.elements.find((e) => e.text === '$29.99')!;
      expect(price).toBeDefined();
      expect(price.descriptor.locators.filter((l) => l.strategy.kind === 'relative' && /Backpack|Bike|Fleece/.test(l.strategy.anchor.text))).toEqual([]);
    } finally {
      await surface.close();
    }
  });

  it('masked row data: no name or e-mail in the observation, while recordContextOf still holds the real row for the recorder', async () => {
    const surface = await openMasked('enum-leaves.html', { maskLabels: ['name', 'e-?mail'] });
    try {
      const obs = await surface.observe();
      const all = text(obs);
      for (const v of ['Al Smithers', 'al.sm@example.test', 'Bo Lee', 'bo.l@example.test']) expect(all, `${v} leaked`).not.toContain(v);
      expect(all).not.toContain('recordContext');
      const view = obs.elements.find((e) => e.role === 'button' && e.name === 'View')!;
      expect(view.descriptor.locators.every((l) => l.strategy.kind !== 'relative' || !/@|Smithers/.test(l.strategy.anchor.text))).toBe(true);
      const context = surface.recordContextOf(view.ref);
      expect(context?.rowCells.map((c) => c.text)).toEqual(['Al Smithers', 'al.sm@example.test']);
      expect(context?.ownTextMasked).toBeUndefined(); // "View" itself is not masked
      const cell = obs.elements.find((e) => e.tag === 'td' && e.masked === true && e.text === '[MASKED:name]');
      expect(cell, 'the name cell is listed, masked').toBeDefined();
      expect(surface.recordContextOf(cell!.ref)?.ownTextMasked).toBe(true);
    } finally {
      await surface.close();
    }
  });

  it('the cap and the omitted count hold through the masked enumeration', async () => {
    const surface = await openMasked('enum-leaves-cap.html', { maskSelectors: ['#amount'] });
    try {
      const obs = await surface.observe();
      expect(obs.elements).toHaveLength(150);
      expect(obs.elementsOmitted).toBe(204 - 150);
      expect(obs.elements[0]!.name).toBe('Continue');
      expect(text(obs)).not.toContain('$42.00');
    } finally {
      await surface.close();
    }
  });
});
