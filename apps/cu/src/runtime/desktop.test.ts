/**
 * Desktop wiring in the composition root and the CLI: the base URL's scheme selects the surface,
 * the run's policy is narrowed to the desktop origin, and the fail-fast checks understand
 * desktop://<process>. Runs on every OS: the desktop surface here is the fake bridge's.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { createDesktopSurface, createFakeTeller, FakeBridgeError } from '@cu/adapter-desktop';
import { credentialSet } from '@cu/core/credentials';
import { loadPolicy } from '@cu/core/policy';
import type { Policy } from '@cu/core/schema';
import { baseUrlPolicyError } from '../base-url-policy.js';
import { globalsOf, parsePid } from '../globals.js';
import { compose, runPolicy, type Composition } from './compose.js';
import { createDesktopRunSurface } from './desktop.js';

const DESKTOP_POLICY = path.resolve('policies/desktop.yaml');
const desktopPolicy: Policy = loadPolicy(DESKTOP_POLICY);
const webPolicy: Policy = loadPolicy(path.resolve('policies/default.yaml'));

let c: Composition | undefined;
afterEach(async () => {
  await c?.close();
  c = undefined;
});

describe('runPolicy and baseUrlPolicyError understand desktop origins', () => {
  it('narrows a desktop run to its own process origin', () => {
    const both: Policy = { ...desktopPolicy, allowedOrigins: ['desktop://tellerworkstation', 'desktop://other', 'http://localhost:4173'] };
    expect(runPolicy(both, 'desktop://TellerWorkstation').allowedOrigins).toEqual(['desktop://tellerworkstation']);
    expect(runPolicy(both, 'http://localhost:4173/login').allowedOrigins).toEqual(['http://localhost:4173']);
  });

  it('refuses a desktop base URL the policy does not name, and never treats two desktop apps as one "null" origin', () => {
    expect(() => runPolicy(desktopPolicy, 'desktop://calc')).toThrow(/desktop:\/\/calc is not in policy/);
    expect(() => runPolicy(webPolicy, 'desktop://tellerworkstation')).toThrow(/not in policy/);
    expect(() => runPolicy(desktopPolicy, 'file:///C:/')).toThrow(/neither an http\(s\) URL nor a desktop/);
  });

  it('fails fast with the desktop origin in the message', () => {
    expect(baseUrlPolicyError('desktop://tellerworkstation', DESKTOP_POLICY)).toBeUndefined();
    expect(baseUrlPolicyError('desktop://calc', DESKTOP_POLICY)).toBe(`origin desktop://calc is not in policy ${DESKTOP_POLICY} allowedOrigins; add it or pass --policy`);
    expect(baseUrlPolicyError('desktop://tellerworkstation', 'policies/default.yaml')).toMatch(/origin desktop:\/\/tellerworkstation is not in policy/);
    expect(baseUrlPolicyError('desktop:///x', DESKTOP_POLICY)).toMatch(/must be an http\(s\) URL or a desktop:\/\/<process-name>/);
  });

  it('a --base-url naming the image file (.exe) is refused with the reason, not a bare "not allowed"', () => {
    expect(baseUrlPolicyError('desktop://tellerworkstation.exe', DESKTOP_POLICY)).toMatch(/desktop:\/\/<process-name> location: .*without \.exe/);
  });
});

describe('the base URL scheme selects the surface', () => {
  const runsDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'cu-desktop-compose-'));

  it('composes an injected desktop surface under the narrowed desktop policy, with policy enforced on it', async () => {
    const { app, bridge } = createFakeTeller();
    const raw = await createDesktopSurface({ processName: 'TellerWorkstation', attachPid: app.pid, bridge: bridge.connection() });
    c = await compose({ runKind: 'replay', policy: desktopPolicy, runsDir: runsDir(), baseUrl: 'desktop://tellerworkstation', surface: raw, ownSurface: true });
    expect(c.policy.allowedOrigins).toEqual(['desktop://tellerworkstation']);
    expect(await c.surface.currentUrl()).toBe('desktop://tellerworkstation/Teller%20Workstation%20-%20Sign%20On');
    // A navigate out of the app's process is denied by the guard before it reaches the surface.
    const r = await c.surface.act({ type: 'navigate', url: 'desktop://calc/' }, 1000);
    expect(r).toMatchObject({ ok: false, error: { code: 'policy_violation' } });
  });

  it('a desktop base URL without --app-command or --attach-pid fails before anything starts', async () => {
    await expect(compose({ runKind: 'replay', policy: desktopPolicy, runsDir: runsDir(), baseUrl: 'desktop://tellerworkstation' })).rejects.toThrow(
      /needs --app-command "<command line>" to start the app, or --attach-pid/,
    );
    await expect(createDesktopRunSurface('desktop://tellerworkstation', { launch: 'x.exe', attachPid: 1 })).rejects.toThrow(/either --app-command or --attach-pid/);
  });

  it('--app-command with an http base URL is refused rather than silently ignored', async () => {
    await expect(
      compose({ runKind: 'replay', policy: webPolicy, runsDir: runsDir(), baseUrl: 'http://localhost:4173', desktop: { launch: 'notepad.exe' } }),
    ).rejects.toThrow(/apply only to a desktop:\/\/<process> --base-url/);
  });
});

describe('compose wires the desktop surface to the run', () => {
  const runsDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'cu-desktop-compose-'));

  it("the surface's diagnostics land in the run's events", async () => {
    const { app, bridge } = createFakeTeller();
    app.screenshot = () => {
      throw new FakeBridgeError('failed', 'capture went wrong');
    };
    c = await compose({
      runKind: 'replay',
      policy: desktopPolicy,
      runsDir: runsDir(),
      baseUrl: 'desktop://tellerworkstation',
      desktop: { attachPid: app.pid, bridge: bridge.connection() },
    });
    await c.surface.screenshot();
    const dir = c.logger.dir;
    await c.close();
    c = undefined;
    const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    expect(events).toContain('desktop-surface');
    expect(events).toContain('capture went wrong');
  });

  it("the policy's redaction.screen block reaches the desktop surface: masked values stay out of the observation and the policy events", async () => {
    const { app, bridge } = createFakeTeller();
    c = await compose({
      runKind: 'discovery',
      policy: desktopPolicy,
      runsDir: runsDir(),
      baseUrl: 'desktop://tellerworkstation',
      desktop: { attachPid: app.pid, bridge: bridge.connection() },
    });
    const s = c.surface;
    let obs = await s.observe();
    const ref = (role: string, name: string): string => obs.elements.find((e) => e.role === role && e.name === name)!.ref;
    await s.act({ type: 'type', target: { ref: ref('textbox', 'User ID') }, value: 'operator1' }, 5000);
    await s.act({ type: 'type', target: { ref: ref('textbox', 'Password') }, value: 'demo-pass-123' }, 5000);
    await s.act({ type: 'click', target: { ref: ref('button', 'Sign On') } }, 5000);
    obs = await s.observe();
    await s.act({ type: 'type', target: { ref: ref('textbox', 'Member ID') }, value: '12345', pressEnter: true }, 5000);
    obs = await s.observe();
    // desktop.yaml: maskInputs all and the Tax ID / Address / Phone labels.
    for (const value of ['900-25-2345', '282 Mill St', '$1,234.56']) expect(JSON.stringify(obs), value).not.toContain(value);
    expect(obs.elements.find((e) => e.name === 'Tax ID')?.masked).toBe(true);
    // The model still reads it, flagged masked.
    expect(await s.readText({ ref: ref('textbox', 'Tax ID') }, 2000)).toEqual({ ok: true, text: '900-25-2345', masked: true });
    await s.act({ type: 'click', target: { ref: ref('textbox', 'Tax ID') } }, 2000);
    const dir = c.logger.dir;
    await c.close();
    c = undefined;
    const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    expect(events).toContain('policy');
    for (const value of ['900-25-2345', '282 Mill St']) expect(events, value).not.toContain(value);
  });

  it("a launched app does not inherit the run's secret env names (nor the model key)", async () => {
    const { bridge } = createFakeTeller();
    bridge.delayMs = 1500; // let the child write its environment before the attach is refused
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cu-desktop-env-')), 'names.txt');
    process.env.CU_TEST_RUN_SECRET_NAME = 'value-that-must-not-leak';
    process.env.RUN_SECRET_FOR_TEST = 'run-secret';
    try {
      await expect(
        compose({
          runKind: 'replay',
          policy: desktopPolicy,
          runsDir: runsDir(),
          baseUrl: 'desktop://tellerworkstation',
          credentials: credentialSet({ RUN_SECRET_FOR_TEST: 'run-secret' }),
          desktop: {
            launch: { command: process.execPath, args: ['-e', "require('fs').writeFileSync(process.argv[1], Object.keys(process.env).join('\\n'))", out] },
            bridge: bridge.connection(),
          },
        }),
      ).rejects.toThrow(/no running process/);
    } finally {
      delete process.env.CU_TEST_RUN_SECRET_NAME;
      delete process.env.RUN_SECRET_FOR_TEST;
    }
    const names = fs.readFileSync(out, 'utf8').split('\n').map((n) => n.toUpperCase());
    expect(names).not.toContain('RUN_SECRET_FOR_TEST');
    expect(names).not.toContain('CU_TEST_RUN_SECRET_NAME');
    expect(names.some((n) => n.startsWith('ANTHROPIC_'))).toBe(false);
    expect(names).toContain('PATH');
  });
});

describe('global flags', () => {
  function parse(argv: string[]): ReturnType<typeof globalsOf> {
    const program = new Command();
    program.exitOverride();
    program.option('--base-url <url>').option('--app-command <line>').option('--attach-pid <pid>', '', parsePid);
    let g: ReturnType<typeof globalsOf> | undefined;
    program.command('x').action((_o: unknown, cmd: Command) => {
      g = globalsOf(cmd);
    });
    program.parse(['node', 'cu', ...argv]);
    return g!;
  }

  it('--app-command and --attach-pid land in GlobalOptions.desktop', () => {
    expect(parse(['--base-url', 'desktop://tellerworkstation', '--app-command', '"C:\\Apps\\teller.exe" --x', 'x']).desktop).toEqual({ launch: '"C:\\Apps\\teller.exe" --x' });
    expect(parse(['--attach-pid', '4242', 'x']).desktop).toEqual({ attachPid: 4242 });
    expect(parse(['x']).desktop).toBeUndefined();
    expect(() => parsePid('12abc')).toThrow(/process id/);
  });
});
