/**
 * Static guarantee: nothing in the desktop adapter or the mock desktop app can synthesize global
 * input or take the foreground. Fails if any of the Win32/.NET calls that do appears in code (not
 * comments) anywhere under packages/adapter-desktop or apps/mock-desktop: C#, PowerShell or
 * TypeScript, tests included. The runtime check is the integration tests' foreground assertion.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = [path.resolve(HERE, '..'), path.resolve(HERE, '..', '..', '..', 'apps', 'mock-desktop')];
const FORBIDDEN = ['SendInput', 'SendKeys', 'keybd_event', 'mouse_event', 'SetForegroundWindow', 'SetFocus', 'BringWindowToTop', 'AttachThreadInput', 'ShowWindow'];
const PATTERN = new RegExp(`\\b(${FORBIDDEN.join('|')})\\b`);
const SELF = fileURLToPath(import.meta.url);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.(cs|ps1|ts|mts|js)$/.test(e.name) && path.resolve(p) !== SELF) out.push(p);
  }
  return out;
}

/** Drops comments that are whole lines or blocks; code with a trailing comment is still scanned. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<#[\s\S]*?#>/g, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|#|\*)/.test(line))
    .join('\n');
}

describe('no synthesized global input, no activation', () => {
  const files = ROOTS.flatMap(sources);

  it('scans the bridge, the surface and the mock app', () => {
    const names = files.map((f) => path.basename(f));
    for (const expected of ['UiaBridge.cs', 'uia-bridge.ps1', 'surface.ts', 'TellerWorkstation.cs', 'teller.ps1']) expect(names).toContain(expected);
  });

  it.each(FORBIDDEN)('%s appears in no code', (api) => {
    const hits = files.filter((f) => new RegExp(`\\b${api}\\b`).test(code(fs.readFileSync(f, 'utf8'))));
    expect(hits.map((f) => path.relative(process.cwd(), f))).toEqual([]);
  });

  it('the scanner itself catches a call', () => {
    expect(PATTERN.test(code('var x = 1;\n[DllImport("user32.dll")] static extern uint SendInput(uint n, IntPtr p, int s);'))).toBe(true);
    expect(PATTERN.test(code('// Nothing here calls SendInput\n/* or SetFocus */'))).toBe(false);
  });
});
