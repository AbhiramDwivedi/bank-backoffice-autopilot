/**
 * Builds Relay's UI bundle with esbuild: `boot.ts` -> assets/boot.js (tiny, no imports),
 * `main.ts` -> assets/app.js (the UI bundle), and styles/app.css -> assets/app.css (the CSS
 * bundle, `@import`s resolved). Also copies index.html into the output directory on every
 * (re)build, including the initial one.
 *
 * Importing this module has no side effects: nothing runs until `buildUi()` is called. Run this
 * file directly (`tsx scripts/build.ts`) to build once, minified, and print output sizes.
 */
import * as esbuild from 'esbuild';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');
const UI_SRC = path.join(APP_ROOT, 'src', 'ui');
const DEFAULT_OUTDIR = path.join(APP_ROOT, 'dist');

/** Browsers Relay supports; esbuild lowers syntax (JS and CSS) that any of these can't run natively. */
const TARGET = ['es2022', 'chrome120', 'firefox120', 'safari16'];

export interface BuildUiOptions {
  /** Defaults to apps/relay/dist, resolved from this file's location (not the caller's cwd). */
  outdir?: string;
  minify?: boolean;
  /** Rebuilds on source changes via esbuild's file watcher; re-copies index.html each time. */
  watch?: boolean;
  sourcemap?: boolean;
}

export interface BuildUiResult {
  outdir: string;
  /** Stops watching (if watching) and releases the esbuild context. Safe to call once. */
  stop(): Promise<void>;
}

async function copyIndexHtml(outdir: string): Promise<void> {
  await fs.mkdir(outdir, { recursive: true });
  await fs.copyFile(path.join(UI_SRC, 'index.html'), path.join(outdir, 'index.html'));
}

/** Copies index.html after every successful build, including the first one and every rebuild esbuild's watcher triggers. */
function copyIndexHtmlPlugin(outdir: string): esbuild.Plugin {
  return {
    name: 'relay-copy-index-html',
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length === 0) {
          return copyIndexHtml(outdir).catch((err: unknown) => {
            console.error('relay build: failed to copy index.html', err);
          });
        }
        return undefined;
      });
    },
  };
}

export async function buildUi(opts: BuildUiOptions = {}): Promise<BuildUiResult> {
  const outdir = opts.outdir ? path.resolve(opts.outdir) : DEFAULT_OUTDIR;

  const ctx = await esbuild.context({
    entryPoints: [
      { in: path.join(UI_SRC, 'boot.ts'), out: 'assets/boot' },
      { in: path.join(UI_SRC, 'main.ts'), out: 'assets/app' },
      { in: path.join(UI_SRC, 'styles', 'app.css'), out: 'assets/app' },
    ],
    bundle: true,
    format: 'iife',
    target: TARGET,
    outdir,
    minify: opts.minify ?? false,
    sourcemap: opts.sourcemap ?? false,
    plugins: [copyIndexHtmlPlugin(outdir)],
  });

  await ctx.rebuild();
  if (opts.watch) await ctx.watch();

  return {
    outdir,
    async stop() {
      await ctx.dispose();
    },
  };
}

// ---- `tsx scripts/build.ts`: build once, minified, print sizes -------------------------------

async function fileSize(p: string): Promise<number> {
  try {
    return (await fs.stat(p)).size;
  } catch {
    return -1;
  }
}

function fmtSize(bytes: number): string {
  if (bytes < 0) return '(missing)';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function main(): Promise<void> {
  const result = await buildUi({ minify: true });
  await result.stop();
  console.log(`relay: built ${result.outdir}`);
  for (const f of ['assets/boot.js', 'assets/app.js', 'assets/app.css', 'index.html']) {
    const size = await fileSize(path.join(result.outdir, f));
    console.log(`  ${f.padEnd(18)} ${fmtSize(size)}`);
  }
}

const entryArg = process.argv[1];
if (entryArg !== undefined && import.meta.url === pathToFileURL(entryArg).href) {
  main().catch((err: unknown) => {
    console.error('relay build failed', err);
    process.exitCode = 1;
  });
}
