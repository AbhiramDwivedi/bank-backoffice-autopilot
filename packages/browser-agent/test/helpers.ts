/**
 * Test harness shared by every browser-agent test: an HTTP fixture server that serves each
 * fixture in both integration modes, and helpers to open a page in either mode.
 *
 *   /injected/<file>       the fixture as-is; the test injects the agent with addInitScript.
 *   /included/<file>       the fixture with `<script src="/static/cu-agent.js">` added to <head>,
 *                          as an app that ships the tag would serve it. Relative frame srcs stay
 *                          under /included/, so every frame document includes the tag too.
 *   /static/cu-agent.js    the built bundle (read per request).
 *
 * Two listeners on two ephemeral ports serve the same content: `baseUrl` and `altBaseUrl` are
 * different origins, for cross-origin frame tests.
 *
 * page.evaluate callbacks: use arrow functions with no named inner functions (the test transform
 * can add helpers that do not exist in the page), or pass a string.
 */
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import { AGENT_BUNDLE_PATH, agentSource } from '../src/index.js';
import type { EnumerateOptions, EnumerateResult } from '../src/types.js';

export const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** How the agent gets into the page. */
export type Mode = 'injected' | 'included';
export const MODES: readonly Mode[] = ['injected', 'included'];

/** The tag an including app adds. */
export const AGENT_TAG = '<script src="/static/cu-agent.js"></script>';

/** Inserts AGENT_TAG right after <head ...>; else after the doctype; else at the very start. */
export function withAgentTag(html: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + AGENT_TAG + html.slice(at);
  }
  const doctype = /<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype.index + doctype[0].length;
    return html.slice(0, at) + AGENT_TAG + html.slice(at);
  }
  return AGENT_TAG + html;
}

function contentType(file: string): string {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (file.endsWith('.map') || file.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  if (pathname === '/static/cu-agent.js' || pathname === '/static/cu-agent.js.map') {
    const file = pathname.endsWith('.map') ? `${AGENT_BUNDLE_PATH}.map` : AGENT_BUNDLE_PATH;
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': contentType(file) }).end(body);
    return;
  }
  const m = /^\/(injected|included)\/(.+)$/.exec(pathname);
  if (!m) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  const mode = m[1] as Mode;
  const file = path.normalize(path.join(FIXTURES_DIR, m[2] ?? ''));
  if (!file.startsWith(FIXTURES_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  const raw = await readFile(file);
  const body = mode === 'included' && file.endsWith('.html') ? withAgentTag(raw.toString('utf8')) : raw;
  res.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' }).end(body);
}

/** A running fixture server. */
export interface TestServer {
  /** http://127.0.0.1:<port> */
  baseUrl: string;
  /** The same content on a second port: a different origin from baseUrl. */
  altBaseUrl: string;
  /** URL of `file` (relative to test/fixtures) in `mode`, on baseUrl (or altBaseUrl when alt). */
  url(mode: Mode, file: string, alt?: boolean): string;
  close(): Promise<void>;
}

async function listen(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

/** Starts the fixture server on two ephemeral localhost ports. */
export async function startServer(): Promise<TestServer> {
  const a = await listen();
  const b = await listen();
  const close = (s: Server): Promise<void> => new Promise((resolve) => s.close(() => resolve()));
  return {
    baseUrl: a.baseUrl,
    altBaseUrl: b.baseUrl,
    url: (mode, file, alt) => `${alt ? b.baseUrl : a.baseUrl}/${mode}/${file}`,
    close: async () => {
      await Promise.all([close(a.server), close(b.server)]);
    },
  };
}

/** Launches headless Chromium. */
export function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

/** Options for openPage. */
export interface OpenOptions {
  /**
   * Installs a `__cuHumanAction` binding (as the Playwright adapter does) that receives each
   * record the sink sends, with the URL of the frame it came from.
   */
  binding?: (action: unknown, frameUrl: string) => void;
  /** Open on altBaseUrl instead of baseUrl. */
  alt?: boolean;
}

/** An opened page and the context that owns it; close the context when done. */
export interface Opened {
  context: BrowserContext;
  page: Page;
}

/**
 * Opens `file` in `mode`: 'injected' adds agentSource() as a context init script (every frame,
 * every navigation); 'included' relies on the served script tag.
 */
export async function openPage(browser: Browser, server: TestServer, mode: Mode, file: string, opts: OpenOptions = {}): Promise<Opened> {
  const context = await browser.newContext();
  const binding = opts.binding;
  if (binding) {
    await context.exposeBinding('__cuHumanAction', (source, action: unknown) => {
      binding(action, source.frame.url());
    });
  }
  if (mode === 'injected') await context.addInitScript({ content: agentSource() });
  const page = await context.newPage();
  await page.goto(server.url(mode, file, opts.alt));
  return { context, page };
}

/** JSON part of enumerate() (everything except the live `els`). */
export type EnumerateJson = Omit<EnumerateResult, 'els'>;

/** Runs `window.__cuAgent.enumerate(opts)` in `frame` and returns its JSON part. */
export function enumerateJson(frame: Frame | Page, opts?: EnumerateOptions): Promise<EnumerateJson> {
  return frame.evaluate((o) => {
    const agent = window.__cuAgent;
    if (!agent) throw new Error('window.__cuAgent is not installed');
    const r = agent.enumerate(o);
    return { data: r.data, viewport: r.viewport, bodyText: r.bodyText, ...(r.omitted !== undefined ? { omitted: r.omitted } : {}) };
  }, opts);
}
