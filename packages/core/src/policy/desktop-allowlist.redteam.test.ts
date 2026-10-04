/**
 * Allowlist attacks on desktop locations (`desktop://<process>/<window title>`).
 *
 * `new URL(x).origin` is the string "null" for every non-special scheme, so an allowlist that
 * compared desktop URLs by `URL.origin` would make every desktop app (and every `file:`/`blob:`
 * URL) equal to every other. These tests pin that the guard compares desktop locations by process
 * name, case-insensitively and exactly; that no desktop location is confusable with "null", with
 * another scheme or with an http origin; and that the policy-enforcing surface quarantines a
 * desktop surface that ends up in another process, exactly as it does a browser that ends up on
 * another origin.
 */
import { describe, expect, it } from 'vitest';
import type { Policy } from '../schema/index.js';
import { el, FakeSurface, scenario } from '../surface/index.js';
import { allowlistOrigin, createPolicyGuard, resolveRelativeUrl } from './guard.js';
import { DEFAULT_POLICY_PATH, loadPolicy } from './load.js';
import { withPolicy } from './enforcing-surface.js';

const webPolicy = loadPolicy(DEFAULT_POLICY_PATH);
const desktopPolicy: Policy = { ...webPolicy, name: 'desktop-test', allowedOrigins: ['desktop://tellerworkstation'], deniedPathPatterns: ['^/admin'] };
const guard = createPolicyGuard(desktopPolicy);
const TELLER = 'desktop://tellerworkstation/Teller%20Workstation%20-%20Member%20Lookup';

describe('desktop allowlist: exactly the named process', () => {
  it.each([
    ['the app with a window title', TELLER],
    ['the app with no window', 'desktop://tellerworkstation'],
    ['the app, trailing slash', 'desktop://tellerworkstation/'],
    ['different case (process names are case-insensitive)', 'desktop://TellerWorkstation/Teller'],
    ['the process name percent-encoded (the same name, spelled differently)', 'desktop://teller%77orkstation/Teller'],
    ['a tab or newline inside the scheme (a URL parser strips them; so do we)', 'desk\ttop://tellerworkstation/Teller'],
  ])('allows %s', (_label, url) => {
    expect(guard.checkUrl(url).allowed).toBe(true);
  });

  it.each([
    ['another process', 'desktop://calc/Calculator'],
    ['the name with .exe appended (another process name: the OS reports names without it)', 'desktop://tellerworkstation.exe/Teller'],
    ['a name that extends the allowed one', 'desktop://tellerworkstation2/Teller'],
    ['a prefix of the allowed name', 'desktop://tellerworkstatio/Teller'],
    ['a look-alike (Cyrillic o)', 'desktop://tellerw\u043erkstation/Teller'],
    ['a wildcard host', 'desktop://*/Teller'],
    ['an empty host', 'desktop:///Teller'],
    ['no authority at all', 'desktop:tellerworkstation'],
    ['credentials smuggling another name', 'desktop://tellerworkstation@calc/'],
    ['credentials before the allowed name', 'desktop://calc@tellerworkstation/'],
    ['a port', 'desktop://tellerworkstation:1/'],
    ['a query', 'desktop://tellerworkstation/x?y'],
    ['a fragment', 'desktop://tellerworkstation/x#y'],
    ['an encoded slash in the host', 'desktop://tellerworkstation%2Fx/'],
    ['a second path segment', 'desktop://tellerworkstation/a/b'],
    ['a malformed escape in the title', 'desktop://tellerworkstation/%E0%A4%A'],
  ])('denies %s', (_label, url) => {
    expect(guard.checkUrl(url).allowed).toBe(false);
  });

  it('applies path patterns to the decoded window title, so encoding cannot evade a deny pattern', () => {
    expect(guard.checkUrl('desktop://tellerworkstation/Admin%20Console').allowed).toBe(false);
    expect(guard.checkUrl('desktop://tellerworkstation/%41dmin').allowed).toBe(false);
    expect(guard.checkUrl('desktop://tellerworkstation/Not%20Admin').allowed).toBe(true);
  });

  it('an allowedPathPatterns list scopes the windows an app may be in', () => {
    const scoped = createPolicyGuard({ ...desktopPolicy, allowedPathPatterns: ['^/Teller Workstation - '] });
    expect(scoped.checkUrl(TELLER).allowed).toBe(true);
    expect(scoped.checkUrl('desktop://tellerworkstation/Export%20Wizard').allowed).toBe(false);
  });
});

describe('desktop origins are never confusable with "null", another scheme or an http origin', () => {
  it('allowlistOrigin gives each desktop process its own origin, and never "null"', () => {
    expect(allowlistOrigin('desktop://a/x')).toBe('desktop://a');
    expect(allowlistOrigin('desktop://b/x')).toBe('desktop://b');
    expect(allowlistOrigin('desktop://a/x')).not.toBe(allowlistOrigin('desktop://b/x'));
    expect(new URL('desktop://a').origin).toBe('null'); // the trap this module exists to avoid
    for (const url of ['desktop://a', 'file:///C:/x', 'blob:null/1', 'about:blank', 'data:text/plain,x', 'javascript:1', 'desktop:///x']) {
      expect(allowlistOrigin(url)).not.toBe('null');
    }
    expect(allowlistOrigin('file:///C:/x')).toBeUndefined();
    expect(allowlistOrigin('desktop:///x')).toBeUndefined();
  });

  it.each([
    ['file:', 'file:///C:/Windows/win.ini'],
    ['blob: (opaque "null" origin)', 'blob:null/0f0f'],
    ['about:blank', 'about:blank'],
    ['data:', 'data:text/html,x'],
    ['javascript:', 'javascript:alert(1)'],
    ['a look-alike scheme', 'desktop-x://tellerworkstation/'],
    ['an http URL with the process name as host', 'http://tellerworkstation/'],
    ['an https URL with the process name as host', 'https://tellerworkstation/'],
  ])('a desktop-only policy denies %s', (_label, url) => {
    expect(guard.checkUrl(url).allowed).toBe(false);
  });

  it.each([['file:///C:/'], ['blob:null/1'], ['desktop:///x'], ['desktop://a:1'], ['about:blank']])(
    'a policy entry %j with no usable origin fails loudly instead of silently allowing nothing',
    (entry) => {
      expect(() => createPolicyGuard({ ...webPolicy, allowedOrigins: [entry] })).toThrow(/neither an http\(s\) origin nor a desktop/);
    },
  );

  it('the web policy allows no desktop location, and a desktop policy no http origin', () => {
    const web = createPolicyGuard(webPolicy);
    expect(web.checkUrl('desktop://localhost/').allowed).toBe(false);
    expect(web.checkUrl(TELLER).allowed).toBe(false);
    expect(guard.checkUrl('http://localhost:4173/login').allowed).toBe(false);
    const both = createPolicyGuard({ ...webPolicy, allowedOrigins: ['http://localhost:4173', 'desktop://localhost'] });
    expect(both.checkUrl('desktop://localhost/x').allowed).toBe(true);
    expect(both.checkUrl('http://localhost:4173/x').allowed).toBe(true);
    expect(both.checkUrl('http://localhost/x').allowed).toBe(false);
    expect(both.checkUrl('desktop://localhost:4173/x').allowed).toBe(false);
  });
});

describe('irreversibleUrlPatterns see the window title as written, as well as the encoded URL', () => {
  const g = createPolicyGuard({ ...desktopPolicy, risk: { ...desktopPolicy.risk, irreversibleTextPatterns: [], irreversibleUrlPatterns: ['/Confirm Open Sub-Account$'] } });
  const dialog = 'desktop://tellerworkstation/Confirm%20Open%20Sub-Account';

  it('a pattern with the title spaces matches a click in that window', () => {
    expect(g.classifyRisk({ type: 'click', target: { ref: 'e1' } }, { targetName: 'OK', currentUrl: dialog })).toBe('irreversible');
  });

  it('and a navigate to it', () => {
    expect(g.classifyRisk({ type: 'navigate', url: dialog }, { currentUrl: TELLER })).toBe('irreversible');
  });

  it('an encoded-form pattern keeps matching too, and other windows do not', () => {
    const encoded = createPolicyGuard({ ...desktopPolicy, risk: { ...desktopPolicy.risk, irreversibleTextPatterns: [], irreversibleUrlPatterns: ['Confirm%20Open'] } });
    expect(encoded.classifyRisk({ type: 'click', target: { ref: 'e1' } }, { currentUrl: dialog })).toBe('irreversible');
    expect(g.classifyRisk({ type: 'click', target: { ref: 'e1' } }, { targetName: 'OK', currentUrl: TELLER })).toBe('reversible');
  });
});

describe('.exe in a desktop origin is refused with a clear message', () => {
  it('a policy entry naming the image file fails loudly, saying how to fix it', () => {
    expect(() => createPolicyGuard({ ...desktopPolicy, allowedOrigins: ['desktop://TellerWorkstation.exe'] })).toThrow(/without \.exe \(desktop:\/\/tellerworkstation\)/);
  });
});

describe('the guard and the desktop surface resolve a relative navigate the same way', () => {
  it('"/.." from a desktop location is the window titled "..", not the bare app', () => {
    expect(guard.checkAction({ type: 'navigate', url: '/..' }, { currentUrl: TELLER }).decision).toBe('allow');
    expect(resolveRelativeUrl('/..', TELLER)).toBe('desktop://tellerworkstation/..');
  });

  it('a UNC path or protocol-relative URL from a desktop location is refused', () => {
    for (const url of ['\\\\host\\share\\x', '//host/x']) expect(guard.checkAction({ type: 'navigate', url }, { currentUrl: TELLER }).decision).toBe('deny');
  });
});

describe('navigate decisions from a desktop location', () => {
  it('resolves a relative target against the current desktop location, staying in the same process', () => {
    const d = guard.checkAction({ type: 'navigate', url: '/Teller%20Workstation%20-%20Sign%20On' }, { currentUrl: TELLER });
    expect(d.decision).toBe('allow');
  });

  it.each([
    ['another process', 'desktop://calc/'],
    ['an http origin', 'http://localhost:4173/login'],
    ['a file URL', 'file:///C:/Windows/System32/calc.exe'],
  ])('denies navigating to %s', (_label, url) => {
    expect(guard.checkAction({ type: 'navigate', url }, { currentUrl: TELLER }).decision).toBe('deny');
  });
});

describe('withPolicy over a desktop surface', () => {
  function desktopScenario() {
    const box = { x: 10, y: 10, w: 80, h: 20 };
    return scenario()
      .screen('lookup', { url: TELLER, title: 'Member Lookup', elements: [el({ id: 'report', role: 'button', name: 'Run Report', tag: 'button', bbox: box })] })
      .on('click', { targetId: 'report' })
      .goto('other')
      .screen('other', { url: 'desktop://reportviewer/Report', title: 'Report', elements: [el({ id: 'close', role: 'button', name: 'Close', tag: 'button', bbox: box })] })
      .initial('lookup')
      .build();
  }

  it('quarantines a surface whose app hands over to another process, and refuses the next action', async () => {
    const events: string[] = [];
    const surface = withPolicy(new FakeSurface(desktopScenario()), guard, { onDecision: (e) => events.push(e.decision) });
    const click = await surface.act({ type: 'click', target: { ref: 'e1' } }, 1000);
    expect(click.ok).toBe(true);
    expect(surface.quarantined).toBe(true);
    expect(surface.quarantineReason).toContain('desktop://reportviewer');
    const next = await surface.act({ type: 'click', target: { ref: 'e1' } }, 1000);
    expect(next).toMatchObject({ ok: false, error: { code: 'policy_violation' } });
    expect(events).toContain('quarantine');
  });
});
