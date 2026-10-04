/**
 * Package-level checks that need no browser: the built artifacts, package.json metadata, version
 * compatibility, a static security scan of every in-page source file, and a rebuild-on-demand
 * check that builds an isolated copy of the package rather than touching the real dist/ (other
 * test files read dist/ concurrently; this file must never delete or overwrite it).
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AGENT_BUNDLE_PATH,
  AGENT_VERSION,
  REDACTED_VALUE,
  agentSource,
  compareAgentVersions,
  isCompatibleAgentVersion,
  isCurrentAgentVersion,
} from '../src/index.js';

const PKG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.join(PKG_DIR, '..', '..');
const SRC_DIR = path.join(PKG_DIR, 'src');
const DIST_DIR = path.join(PKG_DIR, 'dist');

describe('agentSource()', () => {
  const source = agentSource();

  it('returns the bundle without a sourceMappingURL comment', () => {
    expect(source).not.toMatch(/sourceMappingURL/);
  });

  it('contains AGENT_VERSION', () => {
    expect(source).toContain(AGENT_VERSION);
  });
});

describe('dist/', () => {
  it('cu-agent.js is under 48 KB', () => {
    expect(statSync(AGENT_BUNDLE_PATH).size).toBeLessThan(49152);
  });

  it('cu-agent.d.ts exists', () => {
    expect(existsSync(path.join(DIST_DIR, 'cu-agent.d.ts'))).toBe(true);
  });

  it('the built bundle has no require( or import(', () => {
    const raw = readFileSync(AGENT_BUNDLE_PATH, 'utf8');
    expect(raw).not.toMatch(/\brequire\(/);
    expect(raw).not.toMatch(/\bimport\(/);
  });
});

describe('package.json', () => {
  const pkg = JSON.parse(readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')) as Record<string, unknown>;

  it('version matches AGENT_VERSION', () => {
    expect(pkg.version).toBe(AGENT_VERSION);
  });

  // esbuild rebuilds dist/ on demand (agentSource) on the Node side; nothing is bundled into the page.
  it('declares esbuild as its only dependency', () => {
    expect(Object.keys((pkg.dependencies ?? {}) as Record<string, string>)).toEqual(['esbuild']);
    expect(pkg.devDependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
  });
});

const CORE_CONSTANTS_PATH = path.join(REPO_ROOT, 'packages', 'core', 'src', 'schema', 'constants.ts');

describe('REDACTED_VALUE', () => {
  it('matches the repo marker in the core schema constants', () => {
    const text = readFileSync(CORE_CONSTANTS_PATH, 'utf8');
    const m = /REDACTED_VALUE\s*=\s*'([^']*)'/.exec(text);
    expect(m).not.toBeNull();
    expect(REDACTED_VALUE).toBe(m?.[1]);
  });
});

describe('isCompatibleAgentVersion()', () => {
  it('accepts a version with the same major', () => {
    expect(isCompatibleAgentVersion('1.4.2')).toBe(true);
  });

  it('rejects a different major', () => {
    expect(isCompatibleAgentVersion('2.0.0')).toBe(false);
    expect(isCompatibleAgentVersion('0.9.0')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isCompatibleAgentVersion(undefined)).toBe(false);
    expect(isCompatibleAgentVersion(42)).toBe(false);
  });
});

describe('isCurrentAgentVersion()', () => {
  const [major, minor] = AGENT_VERSION.split('.').map(Number) as [number, number];

  it('accepts this version and newer versions of the same major', () => {
    expect(isCurrentAgentVersion(AGENT_VERSION)).toBe(true);
    expect(isCurrentAgentVersion(`${major}.${minor + 1}.0`)).toBe(true);
  });

  it('rejects an older version of the same major, another major, and non-strings', () => {
    expect(minor).toBeGreaterThan(0); // the older-minor case below needs a minor to go back from
    expect(isCurrentAgentVersion(`${major}.${minor - 1}.9`)).toBe(false);
    expect(isCurrentAgentVersion(`${major + 1}.0.0`)).toBe(false);
    expect(isCurrentAgentVersion(undefined)).toBe(false);
  });

  it('orders versions numerically, not as strings', () => {
    expect(compareAgentVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareAgentVersions('1.0.0', '1.0')).toBe(0);
    expect(compareAgentVersions('1.0.9', '1.1.0')).toBeLessThan(0);
  });
});

// Every in-page source file except index.ts (the Node-side entry; it never runs in the page).
const IN_PAGE_FILES = readdirSync(SRC_DIR)
  .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
  .sort();

const FORBIDDEN_APIS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'innerHTML', pattern: /\binnerHTML\b/ },
  { name: 'outerHTML', pattern: /\bouterHTML\b/ },
  { name: 'insertAdjacentHTML(', pattern: /\binsertAdjacentHTML\s*\(/ },
  { name: 'document.write(', pattern: /\bdocument\.write\s*\(/ },
  { name: 'eval(', pattern: /\beval\s*\(/ },
  { name: 'new Function(', pattern: /\bnew\s+Function\s*\(/ },
  { name: 'string-argument setTimeout/setInterval', pattern: /\b(?:setTimeout|setInterval)\s*\(\s*['"`]/ },
  { name: 'appendChild(', pattern: /\.appendChild\s*\(/ },
  { name: 'insertBefore(', pattern: /\.insertBefore\s*\(/ },
  { name: 'append(', pattern: /\.append\s*\(/ },
  { name: 'prepend(', pattern: /\.prepend\s*\(/ },
  { name: 'replaceChildren(', pattern: /\.replaceChildren\s*\(/ },
];

describe('static security scan (src/*.ts, excluding index.ts)', () => {
  for (const file of IN_PAGE_FILES) {
    const text = readFileSync(path.join(SRC_DIR, file), 'utf8');
    for (const { name, pattern } of FORBIDDEN_APIS) {
      it(`${file} does not use ${name}`, () => {
        expect(pattern.test(text)).toBe(false);
      });
    }
  }
});

describe('capture and sink never read a field value', () => {
  for (const file of ['capture.ts', 'sink.ts']) {
    it(`${file} contains no .value`, () => {
      const text = readFileSync(path.join(SRC_DIR, file), 'utf8');
      expect(text.includes('.value')).toBe(false);
    });
  }
});

/** Every `from '...'`/bare `import '...'` specifier in a source file. */
function importSpecifiers(text: string): string[] {
  const specs = new Set<string>();
  for (const m of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) specs.add(m[1] as string);
  for (const m of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specs.add(m[1] as string);
  return [...specs];
}

describe('import boundaries', () => {
  const allFiles = readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts'));
  for (const file of allFiles) {
    it(`${file} imports only from './' (plus 'node:' if index.ts)`, () => {
      const text = readFileSync(path.join(SRC_DIR, file), 'utf8');
      const allowNode = file === 'index.ts';
      for (const spec of importSpecifiers(text)) {
        const ok = spec.startsWith('./') || (allowNode && spec.startsWith('node:'));
        expect(ok, `${file} imports '${spec}'`).toBe(true);
      }
    });
  }
});

describe('rebuild on demand (isolated copy)', () => {
  const tmpDir = path.join(PKG_DIR, `.tmp-build-${randomBytes(4).toString('hex')}`);

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds dist/cu-agent.js in an isolated copy, never touching the real dist/', () => {
    // Copied inside packages/browser-agent (not the OS temp dir) so esbuild's module resolution
    // still walks up to the repo root's node_modules exactly as it does for the real build.
    mkdirSync(tmpDir, { recursive: true });
    cpSync(path.join(PKG_DIR, 'build.mjs'), path.join(tmpDir, 'build.mjs'));
    cpSync(path.join(PKG_DIR, 'package.json'), path.join(tmpDir, 'package.json'));
    cpSync(SRC_DIR, path.join(tmpDir, 'src'), { recursive: true });

    // A tiny ESM harness, run in a child process, that imports the copy's own src/index.ts (a
    // .ts file, hence --import tsx/esm) and calls agentSource(). Node resolves --import 'tsx/esm'
    // from the repo root's node_modules regardless of cwd.
    const harnessPath = path.join(tmpDir, '.rebuild-harness.mjs');
    writeFileSync(
      harnessPath,
      [
        "import path from 'node:path';",
        "import { pathToFileURL } from 'node:url';",
        'const dir = process.argv[2];',
        "const mod = await import(pathToFileURL(path.join(dir, 'src', 'index.ts')).href);",
        'mod.agentSource();',
      ].join('\n'),
    );

    try {
      execFileSync(process.execPath, ['--import', 'tsx/esm', harnessPath, tmpDir], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      throw new Error(`rebuild harness failed: ${e.stderr || e.stdout || e.message}`, { cause: err });
    }

    expect(existsSync(path.join(tmpDir, 'dist', 'cu-agent.js'))).toBe(true);
  });
});
