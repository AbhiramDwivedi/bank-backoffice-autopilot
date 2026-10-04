/**
 * Shared plumbing for Relay's red-team suite (console.redteam.test.ts, human-action.redteam.test.ts).
 * Everything here drives the REAL stack: a real `SessionBroker` on a `FakeSurface`, registered with
 * a real `startRelayServer` over real HTTP -- never a fake port. See docs/design/relay.md
 * ("Security perimeter") and apps/relay/src/server/app.redteam.test.ts (the guard-only coverage
 * this suite extends with end-to-end attacks).
 *
 * Kept apart from test/support/fixtures.ts and core-testing.ts: it reuses their exports but adds
 * nothing to them.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createRunLogger,
  createSessionBroker,
  el,
  FakeSurface,
  newRunId,
  scenario,
  type SessionBroker,
} from '../support/core-testing.js';
import { makeFakeCapture, type FakeCapture } from '../support/fixtures.js';
import { startRelayServer, type RelayServerHandle, type StartRelayServerOptions } from '../../src/server/index.js';

// ---- HTTP request helpers ----------------------------------------------------------------------

export function jsonBody(body: unknown): { method: 'POST'; headers: { 'Content-Type': string }; body: string } {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/**
 * Sends a raw request with a forged `Host` (and optionally other headers fetch cannot set, like
 * `Sec-Fetch-Site`), the same trick app.redteam.test.ts uses: `fetch()` refuses to set `Host`
 * itself (it's a forbidden header), so this drives the socket directly.
 */
export function rawRequest(port: number, method: string, requestPath: string, host: string, extraHeaders: string[] = [], body?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const headers = [`Host: ${host}`, ...extraHeaders];
      if (body !== undefined) headers.push(`Content-Length: ${Buffer.byteLength(body)}`);
      headers.push('Connection: close');
      socket.write(`${method} ${requestPath} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n${body ?? ''}`);
    });
    let data = '';
    socket.on('data', (d) => (data += d.toString()));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

// ---- Static dir (index.html + assets) for a real startRelayServer, no dependency on dist/ ------

export function makeStaticDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'relay-redteam-static-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body><!--RELAY_BOOTSTRAP--></body></html>');
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1);');
  return dir;
}

/** `startRelayServer` over a throwaway static dir; `close()` also removes that dir. */
export async function startRealRelayServer(brokers: SessionBroker[], opts: Omit<StartRelayServerOptions, 'port' | 'brokers' | 'staticDir'> = {}): Promise<RelayServerHandle> {
  const staticDir = makeStaticDir();
  const handle = await startRelayServer({ ...opts, port: 0, brokers, staticDir });
  const originalClose = handle.close.bind(handle);
  return {
    ...handle,
    async close(): Promise<void> {
      await originalClose();
      rmSync(staticDir, { recursive: true, force: true });
    },
  };
}

// ---- A broker with registered secret values (fixtures.ts's makeBrokerFixture has no such option) -

function buildScenario() {
  return scenario()
    .screen('start', {
      url: 'http://cu-core.local/members/90001',
      title: 'Member 90001',
      elements: [el({ id: 'btn', role: 'button', name: 'Continue', tag: 'button', bbox: { x: 0, y: 0, w: 10, h: 10 } })],
    })
    .on('click', { targetId: 'btn' })
    .goto('start')
    .build();
}

export interface SecretBrokerFixture {
  broker: SessionBroker;
  capture: FakeCapture;
  surface: FakeSurface;
  runDir: string;
  dispose(): void;
}

/** Same shape as fixtures.ts's `makeBrokerFixture`, plus `secretValues` (for human-action.redteam.test.ts). */
export function makeSecretBrokerFixture(secretValues: string[], opts: { interventionLeaseMs?: number } = {}): SecretBrokerFixture {
  const runId = newRunId();
  const rootDir = mkdtempSync(path.join(tmpdir(), 'relay-redteam-secret-'));
  const logger = createRunLogger({ runId, runKind: 'replay', rootDir });
  const surface = new FakeSurface(buildScenario());
  const capture = makeFakeCapture();
  const broker = createSessionBroker({
    surface,
    logger,
    runId,
    runKind: 'replay',
    capture,
    sessionLabel: `redteam session ${runId}`,
    secretValues: () => secretValues,
    ...(opts.interventionLeaseMs !== undefined ? { interventionLeaseMs: opts.interventionLeaseMs } : {}),
  });
  let disposed = false;
  return {
    broker,
    capture,
    surface,
    runDir: logger.dir,
    dispose() {
      if (disposed) return;
      disposed = true;
      broker.dispose();
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

/** Reads a `.jsonl` evidence file (mirrors packages/core/src/agent/test-helpers.ts's helper of the
 *  same name, reimplemented here rather than reaching into another core module for one function). */
export function readJsonlFile(filePath: string): unknown[] {
  const text = readFileSync(filePath, 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

/** Polls `GET /api/interventions/:id` until `humanActions.length >= count`, or throws. Avoids
 *  racing the adapter's 250ms captured-action poll (see broker-adapter.ts). */
export async function waitForActionCount(url: string, id: string, count: number, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${url}/api/interventions/${id}`);
    const body = (await res.json()) as { humanActions?: unknown[] };
    if ((body.humanActions?.length ?? 0) >= count) return body as Record<string, unknown>;
    if (Date.now() >= deadline) throw new Error(`waitForActionCount: never reached ${count} action(s) within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ---- A minimal SSE client (Node's EventSource is undici's, but reading the stream by hand lets
// tests read a few events then abort deterministically). --------------------------------------

export interface SseFrame {
  id?: string;
  event: string;
  data: unknown;
}

export interface SseSession {
  /** Every byte received so far, undecoded -- used to assert a secret/PII value never appears on the wire. */
  raw(): string;
  /** Every frame parsed so far. */
  frames(): SseFrame[];
  /** Waits until `predicate(frames())` is true, or throws after `timeoutMs`. */
  waitFor(predicate: (frames: SseFrame[]) => boolean, timeoutMs?: number): Promise<void>;
  /** Aborts the underlying connection. Safe to call more than once. */
  close(): void;
}

function parseSseBuffer(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  const chunks = buffer.split('\n\n');
  const rest = chunks.pop() ?? '';
  for (const chunk of chunks) {
    if (chunk.trim().length === 0) continue;
    let id: string | undefined;
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of chunk.split('\n')) {
      if (line.startsWith('id: ')) id = line.slice(4);
      else if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
      // ': keep-alive' comments and 'retry: N' are ignored here; tests don't need them.
    }
    if (dataLines.length === 0) continue;
    const raw = dataLines.join('\n');
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      // leave as the raw string (e.g. a malformed payload would still be observable)
    }
    frames.push({ id, event, data });
  }
  return { frames, rest };
}

/** Opens `GET {url}/api/events` and pumps it in the background. Call `close()` in the test/afterEach. */
export async function connectSse(url: string, opts: { headers?: Record<string, string> } = {}): Promise<SseSession> {
  const controller = new AbortController();
  const res = await fetch(`${url}/api/events`, { headers: opts.headers, signal: controller.signal });
  const frames: SseFrame[] = [];
  let raw = '';
  let buffer = '';
  let pumping = true;
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();

  const pump = (async (): Promise<void> => {
    if (reader === undefined) return;
    try {
      while (pumping) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        raw += chunk;
        buffer += chunk;
        const parsed = parseSseBuffer(buffer);
        buffer = parsed.rest;
        frames.push(...parsed.frames);
      }
    } catch {
      // aborted/closed -- expected on close()
    }
  })();

  return {
    raw: () => raw,
    frames: () => frames.slice(),
    async waitFor(predicate, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(frames)) {
        if (Date.now() >= deadline) throw new Error(`SseSession.waitFor: condition not met within ${timeoutMs}ms (saw ${frames.length} frame(s))`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    close() {
      if (!pumping) return;
      pumping = false;
      controller.abort();
      void pump;
    },
  };
}
