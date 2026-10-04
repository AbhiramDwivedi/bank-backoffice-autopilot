/**
 * Security-relevant guarantees of naming/selectors/enumerate:
 *  - a password's value is never observable (redacted when non-empty, `undefined` when empty),
 *    whether typed by a user (`fill`) or set by a script (`.value =`), and the raw secret never
 *    appears anywhere in `enumerate()`'s JSON or `describe()`'s output;
 *  - page-controlled, XSS-hostile attribute/text values (test/fixtures/xss.html) can never make
 *    `enumerate()`/`describe()`/`structuralSelector()`/`closestClickable()` throw, execute, insert
 *    a DOM node, or emit an unbounded string -- these functions only ever *read* the page, never
 *    evaluate or render it.
 */
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enumerateJson, launchBrowser, MODES, type Mode, openPage, startServer, type TestServer } from './helpers.js';

let browser: Browser;
let server: TestServer;

beforeAll(async () => {
  browser = await launchBrowser();
  server = await startServer();
});

afterAll(async () => {
  await browser.close();
  await server.close();
});

const SECRET = 'super-secret-password-XYZ123';

describe.each(MODES)('password redaction [%s mode]', (mode: Mode) => {
  it('typed via fill(): redacted in enumerate() and describe(); the raw secret never appears', async () => {
    const { context, page } = await openPage(browser, server, mode, 'enum-login.html');
    try {
      await page.fill('input[name=password]', SECRET);

      const r = await enumerateJson(page);
      const password = r.data.find((d) => d.name === 'Password');
      expect(password, JSON.stringify(r.data, null, 2)).toBeDefined();
      expect(password!.value).toBe('[REDACTED]');
      expect(JSON.stringify(r)).not.toContain(SECRET);

      const described = await page.evaluate(() => {
        const agent = window.__cuAgent;
        if (!agent) throw new Error('window.__cuAgent is not installed');
        return agent.describe(document.querySelector('input[name=password]')!);
      });
      expect(JSON.stringify(described)).not.toContain(SECRET);
    } finally {
      await context.close();
    }
  });

  it('set via the JS .value PROPERTY: redacted in enumerate() and describe(); the raw secret never appears', async () => {
    const { context, page } = await openPage(browser, server, mode, 'enum-login.html');
    try {
      await page.evaluate((secret: string) => {
        const input = document.querySelector('input[name=password]') as HTMLInputElement;
        input.value = secret;
      }, SECRET);

      const r = await enumerateJson(page);
      const password = r.data.find((d) => d.name === 'Password');
      expect(password, JSON.stringify(r.data, null, 2)).toBeDefined();
      expect(password!.value).toBe('[REDACTED]');
      expect(JSON.stringify(r)).not.toContain(SECRET);

      const described = await page.evaluate(() => {
        const agent = window.__cuAgent;
        if (!agent) throw new Error('window.__cuAgent is not installed');
        return agent.describe(document.querySelector('input[name=password]')!);
      });
      expect(JSON.stringify(described)).not.toContain(SECRET);
    } finally {
      await context.close();
    }
  });

  it('empty password: value is undefined, never the redaction marker, in both enumerate() and describe()', async () => {
    const { context, page } = await openPage(browser, server, mode, 'enum-login.html');
    try {
      const r = await enumerateJson(page);
      const password = r.data.find((d) => d.name === 'Password');
      expect(password, JSON.stringify(r.data, null, 2)).toBeDefined();
      expect(password!.value).toBeUndefined();

      const described = await page.evaluate(() => {
        const agent = window.__cuAgent;
        if (!agent) throw new Error('window.__cuAgent is not installed');
        return agent.describe(document.querySelector('input[name=password]')!);
      });
      expect(JSON.stringify(described)).not.toContain('REDACTED');
    } finally {
      await context.close();
    }
  });
});

describe.each(MODES)('XSS-hostile input (test/fixtures/xss.html) [%s mode]', (mode: Mode) => {
  it('enumerate()/describe()/structuralSelector()/closestClickable() never throw, never execute, never insert a node, and every string is <=300 chars', async () => {
    const { context, page } = await openPage(browser, server, mode, 'xss.html');
    try {
      const dialogs: string[] = [];
      page.on('dialog', (d) => {
        dialogs.push(d.message());
        void d.dismiss();
      });

      const countBefore = await page.evaluate(() => document.getElementsByTagName('*').length);

      const result = await page.evaluate(() => {
        const agent = window.__cuAgent;
        if (!agent) throw new Error('window.__cuAgent is not installed');
        const hostileEls = Array.from(document.querySelectorAll('[data-xss]'));

        const perElement = hostileEls.map((el) => {
          const d = agent.describe(el);
          const sel = agent.structuralSelector(el);
          const closest = agent.closestClickable(el);
          const matches = sel ? document.querySelectorAll(sel) : null;
          return {
            id: el.id,
            describe: d,
            selector: sel,
            selectorMatchCount: matches ? matches.length : null,
            selectorMatchesSelf: matches ? matches.length === 1 && matches[0] === el : null,
            closestIsElementOrAncestor: closest === null || closest === el || closest.contains(el),
          };
        });

        const enumResult = agent.enumerate();
        return {
          perElement,
          enumData: enumResult.data,
          bodyText: enumResult.bodyText,
          pwned: (window as unknown as { __pwned?: unknown }).__pwned,
        };
      });

      expect(result.pwned, 'window.__pwned must stay undefined -- no payload ever executed').toBeUndefined();
      expect(dialogs, 'no dialog should ever fire').toEqual([]);

      const countAfter = await page.evaluate(() => document.getElementsByTagName('*').length);
      expect(countAfter, 'enumerate()/describe() must never insert or remove DOM nodes').toBe(countBefore);

      // Every string anywhere in enumerate()'s `data` (element fields, MAX_STRING-capped) and in
      // each element's describe() is bounded at MAX_STRING (300) chars. `bodyText` is exempt by
      // design (see types.ts's EnumerateResult.bodyText): it is a digest, capped at
      // maxBodyTextChars (default DEFAULT_MAX_BODY_TEXT = 8000), not a per-field cap.
      const allStrings: string[] = [];
      const collect = (v: unknown): void => {
        if (typeof v === 'string') allStrings.push(v);
        else if (Array.isArray(v)) v.forEach(collect);
        else if (v && typeof v === 'object') Object.values(v).forEach(collect);
      };
      collect(result.enumData);
      collect(result.perElement.map((p) => p.describe));
      for (const s of allStrings) expect(s.length, JSON.stringify(s.slice(0, 40) + '...')).toBeLessThanOrEqual(300);

      for (const p of result.perElement) {
        expect(p.closestIsElementOrAncestor, `${p.id}: closestClickable must be null, itself, or an ancestor`).toBe(true);
        if (p.selector) {
          expect(p.selectorMatchCount, `${p.id}: selector "${p.selector}"`).toBe(1);
          expect(p.selectorMatchesSelf, `${p.id}: selector "${p.selector}"`).toBe(true);
        }
      }
    } finally {
      await context.close();
    }
  });

  it('names equal the collapsed source attribute, truncated at 80 chars, for every payload kind', async () => {
    const { context, page } = await openPage(browser, server, mode, 'xss.html');
    try {
      const result = await page.evaluate(() => {
        const agent = window.__cuAgent;
        if (!agent) throw new Error('window.__cuAgent is not installed');
        const payloads = (window as unknown as { __xssPayloads: Record<string, string> }).__xssPayloads;
        const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
        const cases: { id: string; raw: string }[] = [
          { id: 'b-img', raw: payloads.PAYLOAD_IMG! },
          { id: 'b-script', raw: payloads.PAYLOAD_SCRIPT! },
          { id: 'b-quotes', raw: payloads.PAYLOAD_QUOTES! },
          { id: 'b-brackets', raw: payloads.PAYLOAD_BRACKETS! },
          { id: 'b-ws', raw: payloads.PAYLOAD_WHITESPACE! },
          { id: 'b-long', raw: payloads.PAYLOAD_LONG! },
          { id: 'b-rtl', raw: payloads.PAYLOAD_RTL! },
        ];
        return cases.map(({ id, raw }) => {
          const el = document.getElementById(id)!;
          const expected = collapse(raw).slice(0, 80);
          return { id, name: agent.describe(el).name, expected };
        });
      });
      for (const r of result) {
        expect(r.name, r.id).toBe(r.expected);
      }
    } finally {
      await context.close();
    }
  });
});
