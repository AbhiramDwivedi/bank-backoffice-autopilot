/**
 * Test-only helpers: a tiny static HTTP server for fixture pages (frames need real URLs), serving
 * the browser-agent bundle at `/cu-agent.js` for app-included-mode fixtures. Not imported by
 * production code.
 *
 * Fixtures come from two directories: this package's own `fixtures/` (pages only the adapter
 * tests use) first, then `@cu/browser-agent`'s `test/fixtures/` (pages both packages' tests use),
 * so a shared page exists exactly once in the repo.
 */
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Page } from 'playwright';
import { AGENT_VERSION, agentSource, majorOf } from '@cu/browser-agent';

/** Fixtures only the adapter's tests use. */
export const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
/** Fixtures shared with `@cu/browser-agent`'s own tests. */
export const SHARED_FIXTURES_DIR = path.join(path.dirname(createRequire(import.meta.url).resolve('@cu/browser-agent/package.json')), 'test', 'fixtures');

/** Version the bundle is re-stamped with at `/cu-agent-next-major.js`: the next major after AGENT_VERSION. */
export const NEXT_MAJOR_VERSION = `${majorOf(AGENT_VERSION) + 1}.0.0`;

/** The agent bundle re-stamped as NEXT_MAJOR_VERSION: what an app shipping another major's copy serves. */
function nextMajorSource(): string {
  const literal = JSON.stringify(AGENT_VERSION);
  const src = agentSource();
  if (!src.includes(literal)) throw new Error(`agent bundle has no ${literal} literal to re-stamp`);
  return src.split(literal).join(JSON.stringify(NEXT_MAJOR_VERSION));
}

/** Resolves `pathname` inside `dir`; undefined when it would escape it. */
function inside(dir: string, pathname: string): string | undefined {
  const file = path.normalize(path.join(dir, pathname));
  return file.startsWith(dir + path.sep) ? file : undefined;
}

async function readFixture(pathname: string): Promise<Buffer> {
  for (const dir of [FIXTURES_DIR, SHARED_FIXTURES_DIR]) {
    const file = inside(dir, pathname);
    if (!file) continue;
    try {
      return await readFile(file);
    } catch {
      /* not in this directory; try the next */
    }
  }
  throw new Error(`no fixture ${pathname}`);
}

/** A running fixture HTTP server: build request URLs against it and close it when done. */
export interface FixtureServer {
  baseUrl: string;
  url(file: string): string;
  close(): Promise<void>;
}

/**
 * Serves the fixture directories on an ephemeral localhost port, plus the browser-agent bundle at
 * `/cu-agent.js` and the same bundle re-stamped as the next major at `/cu-agent-next-major.js`.
 * Unknown paths -> 404.
 */
export async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (pathname === '/cu-agent.js' || pathname === '/cu-agent-next-major.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(pathname === '/cu-agent.js' ? agentSource() : nextMajorSource());
      return;
    }
    readFixture(pathname)
      .then((body) => {
        res.writeHead(200, { 'content-type': pathname.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
        res.end(body);
      })
      .catch(() => res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    url: (file: string) => `${baseUrl}/${file}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The colour fixture pages paint every piece of PII in (`.pii { color: #ff00aa }`). */
export const PII_RGB: readonly [number, number, number] = [255, 0, 170];

/**
 * Pixels of `png` within `tolerance` (per channel) of `rgb`, counted over the WHOLE image by
 * decoding it in a browser canvas: a masking test asserts this is 0, not that one sampled point
 * happens to be painted. A glyph's anti-aliased edge pixels blend toward the background, so the
 * tolerance only admits pixels that are clearly the PII colour.
 */
export async function countColor(decoder: Page, png: Buffer, rgb: readonly [number, number, number] = PII_RGB, tolerance = 40): Promise<number> {
  return decoder.evaluate(
    async ([b64, target, tol]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const g = canvas.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, img.width, img.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i]! - target[0]!) <= tol && Math.abs(d[i + 1]! - target[1]!) <= tol && Math.abs(d[i + 2]! - target[2]!) <= tol) n++;
      }
      return n;
    },
    [png.toString('base64'), [...rgb], tolerance] as const,
  );
}
