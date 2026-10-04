import http, { createServer, type Server } from 'node:http';
import express, { type Express } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createEventHub, type EventHub } from './events.js';

interface Harness {
  hub: EventHub;
  url: string;
  close(): Promise<void>;
}

function startHarness(hub: EventHub): Promise<{ url: string; server: Server; app: Express }> {
  const app = express();
  app.get('/events', (req, res) => {
    const lastEventId = typeof req.query.lastEventId === 'string' ? req.query.lastEventId : undefined;
    const headerLastEventId = req.headers['last-event-id'];
    hub.connect(req, res, typeof headerLastEventId === 'string' ? headerLastEventId : lastEventId);
  });
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/events`, server, app });
    });
  });
}

async function makeHarness(hub: EventHub): Promise<Harness> {
  const { url, server } = await startHarness(hub);
  return {
    hub,
    url,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** A raw SSE client: connects with `http.request`, accumulates the decoded body, and exposes a
 *  poll-until helper (SSE is a live stream, not a one-shot response). */
class SseClient {
  buffer = '';
  private req: http.ClientRequest;
  private closed = false;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.req = http.request(url, { headers }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        this.buffer += chunk;
      });
    });
    this.req.end();
  }

  async waitUntil(predicate: (buf: string) => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.buffer)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for condition; buffer so far:\n${this.buffer}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.req.destroy();
  }
}

let harnesses: Harness[] = [];
let clients: SseClient[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  clients = [];
  for (const h of harnesses) {
    h.hub.close();
    await h.close();
  }
  harnesses = [];
});

describe('createEventHub', () => {
  it('lastEventId() is `${bootId}.0` before anything is published, and advances with each publish', () => {
    const hub = createEventHub();
    const first = hub.lastEventId();
    expect(first).toMatch(/^[0-9a-f]{8}\.0$/);
    const id1 = hub.publish('control', { x: 1 });
    expect(id1).toBe(`${first.split('.')[0]}.1`);
    expect(hub.lastEventId()).toBe(id1);
    const id2 = hub.publish('control', { x: 2 });
    expect(id2).toBe(`${first.split('.')[0]}.2`);
    hub.close();
  });

  it('a connected client receives events published after it connects, in SSE wire format', async () => {
    const hub = createEventHub();
    const h = await makeHarness(hub);
    harnesses.push(h);

    const client = new SseClient(h.url);
    clients.push(client);
    await client.waitUntil((b) => b.includes('retry:'));

    hub.publish('intervention', { change: 'created', intervention: { id: 'abc' } });
    await client.waitUntil((b) => b.includes('event: intervention'));

    expect(client.buffer).toContain('event: intervention\n');
    expect(client.buffer).toContain('data: {"change":"created","intervention":{"id":"abc"}}\n');
    expect(hub.clientCount()).toBe(1);
  });

  it('replays buffered events after Last-Event-ID (header)', async () => {
    const hub = createEventHub();
    const id1 = hub.publish('control', { n: 1 });
    hub.publish('control', { n: 2 });
    const id3 = hub.publish('control', { n: 3 });
    const h = await makeHarness(hub);
    harnesses.push(h);

    const client = new SseClient(h.url, { 'Last-Event-ID': id1 });
    clients.push(client);
    await client.waitUntil((b) => b.includes(id3));

    expect(client.buffer).not.toContain(`data: {"n":1}`); // id1 itself is the client's position, not replayed
    expect(client.buffer).toContain(`data: {"n":2}`);
    expect(client.buffer).toContain(`data: {"n":3}`);
  });

  it('replays buffered events after ?lastEventId= (query)', async () => {
    const hub = createEventHub();
    const id1 = hub.publish('control', { n: 1 });
    hub.publish('control', { n: 2 });
    const h = await makeHarness(hub);
    harnesses.push(h);

    const client = new SseClient(`${h.url}?lastEventId=${encodeURIComponent(id1)}`);
    clients.push(client);
    await client.waitUntil((b) => b.includes(`data: {"n":2}`));
    expect(client.buffer).not.toContain(`data: {"n":1}`);
  });

  it('sends a reset event (no id) for a Last-Event-ID from a foreign boot', async () => {
    const hub = createEventHub();
    hub.publish('control', { n: 1 });
    const h = await makeHarness(hub);
    harnesses.push(h);

    const client = new SseClient(h.url, { 'Last-Event-ID': 'deadbeef.3' });
    clients.push(client);
    await client.waitUntil((b) => b.includes('event: reset'));

    expect(client.buffer).toContain('event: reset\ndata: {"reason":"unknown_event_id"}');
    // No `id:` line immediately precedes the reset event.
    const resetIdx = client.buffer.indexOf('event: reset');
    const before = client.buffer.slice(0, resetIdx);
    const lastLines = before.split('\n\n').filter(Boolean).pop() ?? '';
    expect(lastLines).not.toMatch(/^id: /m);
  });

  it('sends a reset event for an id evicted from a small buffer (buffer_overflow)', async () => {
    const hub = createEventHub({ bufferSize: 2 });
    const id1 = hub.publish('control', { n: 1 });
    hub.publish('control', { n: 2 });
    hub.publish('control', { n: 3 }); // evicts n:1 from the size-2 buffer
    hub.publish('control', { n: 4 });
    const h = await makeHarness(hub);
    harnesses.push(h);

    const client = new SseClient(h.url, { 'Last-Event-ID': id1 });
    clients.push(client);
    await client.waitUntil((b) => b.includes('event: reset'));
    expect(client.buffer).toContain('data: {"reason":"buffer_overflow"}');
  });

  it('a malformed Last-Event-ID also resets', async () => {
    const hub = createEventHub();
    hub.publish('control', { n: 1 });
    const h = await makeHarness(hub);
    harnesses.push(h);

    const client = new SseClient(h.url, { 'Last-Event-ID': 'not-a-valid-id' });
    clients.push(client);
    await client.waitUntil((b) => b.includes('event: reset'));
    expect(client.buffer).toContain('unknown_event_id');
  });

  it('sends a keep-alive comment on the configured interval', async () => {
    const hub = createEventHub({ keepAliveMs: 30 });
    const h = await makeHarness(hub);
    harnesses.push(h);
    const client = new SseClient(h.url);
    clients.push(client);
    await client.waitUntil((b) => b.includes(': keep-alive'), 1000);
  });

  it('close() ends every open stream and resolves; further connects get 503 JSON', async () => {
    const hub = createEventHub();
    const h = await makeHarness(hub);
    harnesses.push(h);
    const client = new SseClient(h.url);
    clients.push(client);
    await client.waitUntil((b) => b.includes('retry:'));
    expect(hub.clientCount()).toBe(1);

    hub.close();
    // The client's own stream ends (server called res.end()).
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (hub.clientCount() === 0) resolve();
        else setTimeout(check, 10);
      };
      check();
    });

    const res = await fetch(h.url);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('unavailable');
  });

  it('disconnectAll() ends open streams but keeps accepting connections and keeps the buffer, so a reconnect with Last-Event-ID replays', async () => {
    const hub = createEventHub();
    const h = await makeHarness(hub);
    harnesses.push(h);

    let ended = false;
    const first = http.request(h.url, (res) => {
      res.on('end', () => {
        ended = true;
      });
      res.resume();
    });
    first.end();
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (hub.clientCount() === 1) resolve();
        else setTimeout(check, 10);
      };
      check();
    });
    const lastId = hub.lastEventId();

    hub.disconnectAll();
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (ended && hub.clientCount() === 0) resolve();
        else setTimeout(check, 10);
      };
      check();
    });

    // The hub is still accepting new connections (disconnectAll never calls close()).
    const stillOpen = await fetch(h.url);
    expect(stillOpen.status).toBe(200);
    await stillOpen.body?.cancel();

    hub.publish('control', { after: 'disconnect' });

    const reconnected = new SseClient(h.url, { 'Last-Event-ID': lastId });
    clients.push(reconnected);
    await reconnected.waitUntil((b) => b.includes('"after":"disconnect"'));
    expect(reconnected.buffer).not.toContain('event: reset');
  });

  it('id includes the type discriminator correctly and lastEventId() reflects the latest publish across types', () => {
    const hub = createEventHub();
    hub.publish('heartbeat', { runId: 'r', interventionId: 'i', at: '2026-01-01T00:00:00.000Z', lease: { ms: 1, anchorAt: 'a', expiresAt: 'b' } });
    const id = hub.publish('reset', { reason: 'unknown_event_id' });
    expect(hub.lastEventId()).toBe(id);
    hub.close();
  });
});
