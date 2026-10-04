/**
 * A web surface never reaches a desktop location. A `desktop://<process>/<title>` URL is a
 * location of a native app driven through UI Automation; handed to Chromium it would at best fail
 * and at worst be passed to whatever external protocol handler is registered for the scheme. The
 * Playwright surface refuses every non-http(s) absolute URL itself, whatever the policy says, and
 * a web run's policy is narrowed to its http origin anyway (packages/core/src/policy/
 * desktop-allowlist.redteam.test.ts). Also pins that the desktop-only `automation_id` locator kind
 * is a miss on the web, so a chain recorded with one falls through to the next locator.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPolicyGuard, loadPolicy, DEFAULT_POLICY_PATH, withPolicy } from '@cu/core/policy';
import type { TargetDescriptor } from '@cu/core/schema';
import { createPlaywrightSurface, type PlaywrightSurface } from './surface.js';

let browser: Browser;
let server: Server;
let base: string;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/confirm') {
      // A focused irreversible button: any committing key fires it.
      res.end('<!doctype html><title>confirm</title><button id="c" onclick="document.title=\'fired\'">Confirm transfer</button><script>document.getElementById("c").focus()</script>');
      return;
    }
    res.end('<!doctype html><title>t</title><button id="go">Go</button>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
});

async function surfaceAt(url: string): Promise<PlaywrightSurface> {
  const s = await createPlaywrightSurface({ browser });
  expect((await s.act({ type: 'navigate', url }, 5000)).ok).toBe(true);
  return s;
}

describe('a web surface never navigates to a desktop location', () => {
  it.each([
    ['a desktop app location', 'desktop://tellerworkstation/Teller%20Workstation%20-%20Sign%20On'],
    ['the bare desktop origin', 'desktop://tellerworkstation'],
    ['an upper-case desktop scheme', 'DESKTOP://tellerworkstation/'],
    ['a file: URL', 'file:///C:/Windows/win.ini'],
    ['some other registered protocol', 'ms-settings:privacy'],
    ['a tab inside the desktop scheme', 'desk\ttop://tellerworkstation/'],
    ['a tab inside the file scheme', 'fi\tle:///C:/Windows/win.ini'],
    ['a newline inside the scheme', 'fi\nle:///C:/Windows/win.ini'],
    ['a carriage return inside the scheme', 'desk\rtop://tellerworkstation/'],
    ['mixed case', 'FiLe:///C:/Windows/win.ini'],
    ['leading control characters', '\u0001\u0002 file:///C:/Windows/win.ini'],
    ['a javascript: URL', 'java\tscript:alert(1)'],
    ['an about: page other than about:blank', 'about:settings'],
  ])('refuses %s with navigation_failed, the page left where it was', async (_label, url) => {
    const s = await surfaceAt(`${base}/`);
    try {
      // Refused before Chromium is ever handed the URL (headed, it could launch a protocol handler).
      const goto = vi.spyOn(s.page, 'goto');
      const r = await s.act({ type: 'navigate', url }, 3000);
      expect(r).toMatchObject({ ok: false, error: { code: 'navigation_failed' } });
      expect(goto).not.toHaveBeenCalled();
      expect(await s.currentUrl()).toBe(`${base}/`);
    } finally {
      await s.close();
    }
  });

  it('even under a policy that lists the desktop origin, a web run cannot get there', async () => {
    const policy = { ...loadPolicy(DEFAULT_POLICY_PATH), allowedOrigins: [base, 'desktop://tellerworkstation'] };
    const s = withPolicy(await surfaceAt(`${base}/`), createPolicyGuard(policy));
    try {
      const r = await s.act({ type: 'navigate', url: 'desktop://tellerworkstation/' }, 3000);
      expect(r.ok).toBe(false);
      expect(await s.currentUrl()).toBe(`${base}/`);
    } finally {
      await s.close();
    }
  });
});

describe('a UNC path or protocol-relative URL never reaches Chromium', () => {
  const unsafe = [
    ['a UNC path to the page host', () => `\\\\127.0.0.1\\c$\\Windows\\win.ini`],
    ['a UNC path to another host', () => '\\\\fileserver\\share\\x'],
    ['a mixed-slash UNC path', () => '\\/127.0.0.1/c$/x'],
    ['a protocol-relative URL', () => '//127.0.0.1/x'],
    ['a protocol-relative URL hidden by a tab', () => '/\t/127.0.0.1/x'],
    ['a backslash scheme separator', () => 'http:\\\\127.0.0.1\\x'],
  ] as const;

  it.each(unsafe)('%s: refused from an http page and from the blank start page, goto never called', async (_label, make) => {
    for (const start of ['page', 'blank'] as const) {
      const s = await createPlaywrightSurface({ browser, baseUrl: base });
      try {
        if (start === 'page') expect((await s.act({ type: 'navigate', url: `${base}/` }, 5000)).ok).toBe(true);
        const before = await s.currentUrl();
        const goto = vi.spyOn(s.page, 'goto');
        expect(await s.act({ type: 'navigate', url: make() }, 3000)).toMatchObject({ ok: false, error: { code: 'navigation_failed' } });
        expect(goto).not.toHaveBeenCalled();
        expect(await s.currentUrl()).toBe(before);
      } finally {
        await s.close();
      }
    }
  });

  it('under a policy allowing the page host on port 80 too, the UNC navigate is denied before it runs, and no file: page loads', async () => {
    const policy = { ...loadPolicy(DEFAULT_POLICY_PATH), allowedOrigins: [base, 'http://127.0.0.1'] };
    const raw = await surfaceAt(`${base}/`);
    const goto = vi.spyOn(raw.page, 'goto');
    const s = withPolicy(raw, createPolicyGuard(policy));
    try {
      const r = await s.act({ type: 'navigate', url: '\\\\127.0.0.1\\c$\\Windows\\win.ini' }, 3000);
      expect(r).toMatchObject({ ok: false, error: { code: 'policy_violation' } });
      expect(goto).not.toHaveBeenCalled();
      expect(await s.currentUrl()).toBe(`${base}/`);
      expect(s.quarantined).toBe(false);
    } finally {
      await s.close();
    }
  });

  it('goto is handed the URL that was checked, never the raw string', async () => {
    const s = await createPlaywrightSurface({ browser, baseUrl: base });
    try {
      const goto = vi.spyOn(s.page, 'goto');
      expect((await s.act({ type: 'navigate', url: ' /other?x=1 ' }, 3000)).ok).toBe(true);
      expect(goto.mock.calls[0]![0]).toBe(`${base}/other?x=1`);
    } finally {
      await s.close();
    }
  });
});

describe('committing keys: the guard and the surface agree', () => {
  const policy = (): ReturnType<typeof loadPolicy> => ({ ...loadPolicy(DEFAULT_POLICY_PATH), allowedOrigins: [base] });

  it.each(['\r', '\n', 'Return', 'Enter', 'NumpadEnter', ' ', 'Space', 'Spacebar'])(
    'press(%j) on a focused "Confirm transfer" button is refused under policy, and the button does not fire',
    async (key) => {
      const raw = await surfaceAt(`${base}/confirm`);
      const s = withPolicy(raw, createPolicyGuard(policy()));
      try {
        expect(await s.act({ type: 'press', key }, 3000)).toMatchObject({ ok: false, error: { code: 'policy_violation' } });
        expect(await raw.page.title()).toBe('confirm');
      } finally {
        await s.close();
      }
    },
  );

  it.each(['\r', 'Return', 'Spacebar'])('unguarded, press(%j) is pressed as the committing key the guard classified it as', async (key) => {
    const s = await surfaceAt(`${base}/confirm`);
    try {
      expect((await s.act({ type: 'press', key }, 3000)).ok).toBe(true);
      expect(await s.page.title()).toBe('fired');
    } finally {
      await s.close();
    }
  });
});

describe('what a web surface does navigate to', () => {
  it('ABOUT:BLANK is refused, deliberately: only the exact about:blank the surface starts on is allowed', async () => {
    const s = await surfaceAt(`${base}/`);
    try {
      expect(await s.act({ type: 'navigate', url: 'ABOUT:BLANK' }, 3000)).toMatchObject({ ok: false, error: { code: 'navigation_failed' } });
      expect((await s.act({ type: 'navigate', url: 'about:blank' }, 3000)).ok).toBe(true);
    } finally {
      await s.close();
    }
  });

  it('http(s), a relative path (resolved against the base URL), and exactly about:blank', async () => {
    const s = await createPlaywrightSurface({ browser, baseUrl: base });
    try {
      expect((await s.act({ type: 'navigate', url: '/other' }, 3000)).ok).toBe(true);
      expect(await s.currentUrl()).toBe(`${base}/other`);
      expect((await s.act({ type: 'navigate', url: 'about:blank' }, 3000)).ok).toBe(true);
      expect((await s.act({ type: 'navigate', url: `${base}/` }, 3000)).ok).toBe(true);
    } finally {
      await s.close();
    }
  });
});

describe('automation_id on the web', () => {
  it('is a miss, so the chain falls through to the next locator', async () => {
    const s = await surfaceAt(`${base}/`);
    try {
      const target: TargetDescriptor = {
        description: 'Go button',
        frame: [],
        locators: [
          { strategy: { kind: 'automation_id', id: 'go' }, confidence: 0.95, source: 'recorded' },
          { strategy: { kind: 'css', selector: '#go' }, confidence: 0.3, source: 'recorded' },
        ],
      };
      const r = await s.resolve(target, 2000);
      expect(r).toMatchObject({ found: true, strategyIndex: 1, strategyKind: 'css' });
    } finally {
      await s.close();
    }
  });
});
