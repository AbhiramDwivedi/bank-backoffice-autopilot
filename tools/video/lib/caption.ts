/**
 * A small unobtrusive caption strip injected into the TOP-LEVEL document of a live:* page (never
 * into a frame), naming what is currently on screen. Attached to `document.documentElement`
 * rather than `document.body` so it also works on the workstation's HTML 4 <frameset> pages
 * (whose "body" element, per the HTML DOM, is the <frameset> itself and does not reliably render
 * arbitrary appended block children).
 */
import type { Page } from 'playwright';

const CAPTION_ID = '__video_caption_strip__';

/** Sets (creating on first use) the bottom caption strip's text on `page`'s top document. */
const current = new WeakMap<Page, string>();

/** Sets the caption strip and keeps it: it is re-applied after every top-level navigation of the page. */
export async function setCaption(page: Page, text: string): Promise<void> {
  if (!current.has(page)) {
    page.on('load', () => {
      const t = current.get(page);
      if (t !== undefined) void applyCaption(page, t).catch(() => undefined);
    });
  }
  current.set(page, text);
  await applyCaption(page, text).catch(() => undefined);
}

async function applyCaption(page: Page, text: string): Promise<void> {
  await page.evaluate(
    ({ id, text: t }) => {
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement('div');
        el.id = id;
        // CSSOM, not a style attribute: a CSP without 'unsafe-inline' (Relay's) blocks
        // setAttribute('style', ...) but not writes to element.style.
        Object.assign(el.style, {
          position: 'fixed',
          left: '0',
          right: '0',
          bottom: '0',
          margin: '0',
          padding: '10px 22px',
          background: 'rgba(12,16,20,0.88)',
          color: '#eef2f6',
          font: '600 18px/1.3 system-ui,Segoe UI,sans-serif',
          zIndex: '2147483647',
          textAlign: 'center',
          pointerEvents: 'none',
        });
        document.documentElement.appendChild(el);
      }
      el.textContent = t;
    },
    { id: CAPTION_ID, text },
  );
}

/** Removes the caption strip, if present. */
export async function clearCaption(page: Page): Promise<void> {
  current.delete(page);
  await page.evaluate((id) => {
    document.getElementById(id)?.remove();
  }, CAPTION_ID);
}
