/**
 * Server-Sent Events hub for `GET /api/events`. See apps/relay/src/shared/api.ts for the wire
 * format (`RelayEventMap`, `ResetEvent`) and docs/design/relay.md.
 *
 * Ids are `${bootId}.${seq}`: `bootId` is 8 random hex chars generated once per hub instance (so
 * a client's `Last-Event-ID` from a previous server process is always recognizably foreign), and
 * `seq` increments from 1 on every publish. A bounded ring buffer holds the last `bufferSize`
 * events so a reconnecting client can replay what it missed; when it can't (an id from a
 * different boot, a malformed id, an id ahead of what this hub has produced, or one older than
 * anything left in the buffer) the hub sends a single `reset` event instead and the client
 * refetches its snapshot over REST.
 */
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { RelayEventType } from '../shared/api.js';

export interface EventHubOptions {
  /** How many recent events to keep for replay. Default 500. */
  bufferSize?: number;
  /** Interval between `: keep-alive` comments sent to every open connection. Default 15000. */
  keepAliveMs?: number;
  /** Advertised via the SSE `retry:` field on every new connection. Default 2000. */
  retryMs?: number;
}

export interface EventHub {
  /** Publishes one event to every connected client and the replay buffer. Returns its id. */
  publish(type: RelayEventType, data: unknown): string;
  /** Starts (or resumes, replaying from `lastEventId`) an SSE stream on `res`. */
  connect(req: Request, res: Response, lastEventId?: string): void;
  /** The id of the most recently published event, or `${bootId}.0` if none has been published yet. */
  lastEventId(): string;
  clientCount(): number;
  /** Ends every currently open stream, but keeps the hub accepting new connections and keeps the
   *  ring buffer: a disconnected client (a real browser reconnecting its `EventSource`, or a test
   *  that cannot otherwise force an already-open connection closed) comes back with its last
   *  `Last-Event-ID` and replays what it missed, same as a network blip. */
  disconnectAll(): void;
  /** Ends every open stream, stops the keep-alive timer, and refuses further `connect()` calls (503 JSON). Idempotent. */
  close(): void;
}

interface BufferedEvent {
  id: string;
  seq: number;
  type: string;
  payload: string;
}

interface Client {
  res: Response;
}

/** One MiB: past this, a slow/stalled client is dropped rather than let its buffer grow forever. It reconnects and replays. */
const BACKPRESSURE_LIMIT_BYTES = 1024 * 1024;

function randomBootId(): string {
  return randomBytes(4).toString('hex');
}

function formatMessage(id: string | undefined, type: string, payload: string): string {
  let msg = '';
  if (id !== undefined) msg += `id: ${id}\n`;
  msg += `event: ${type}\n`;
  // `payload` is JSON.stringify output, which never contains a raw newline (JSON escapes control
  // characters), so this loop normally runs once; it stays correct if that ever changes.
  for (const line of payload.split('\n')) msg += `data: ${line}\n`;
  msg += '\n';
  return msg;
}

function parseEventId(raw: string): { bootId: string; seq: number } | undefined {
  const match = /^([0-9a-f]{8})\.(\d+)$/.exec(raw);
  const id = match?.[1];
  const seqText = match?.[2];
  if (id === undefined || seqText === undefined) return undefined;
  const seq = Number.parseInt(seqText, 10);
  if (!Number.isSafeInteger(seq) || seq < 0) return undefined;
  return { bootId: id, seq };
}

export function createEventHub(opts: EventHubOptions = {}): EventHub {
  const bufferSize = opts.bufferSize ?? 500;
  const keepAliveMs = opts.keepAliveMs ?? 15000;
  const retryMs = opts.retryMs ?? 2000;

  const bootId = randomBootId();
  let seq = 0;
  const buffer: BufferedEvent[] = [];
  const clients = new Set<Client>();
  let closed = false;

  function writeToClient(client: Client, message: string): void {
    try {
      client.res.write(message);
    } catch {
      clients.delete(client);
      return;
    }
    if (client.res.writableLength > BACKPRESSURE_LIMIT_BYTES) {
      try {
        client.res.end();
      } catch {
        // already gone
      }
      clients.delete(client);
    }
  }

  const keepAliveTimer = setInterval(() => {
    for (const client of clients) writeToClient(client, ': keep-alive\n\n');
  }, keepAliveMs);
  (keepAliveTimer as unknown as { unref?: () => void }).unref?.();

  function publish(type: RelayEventType, data: unknown): string {
    seq += 1;
    const id = `${bootId}.${seq}`;
    const event: BufferedEvent = { id, seq, type, payload: JSON.stringify(data) };
    buffer.push(event);
    if (buffer.length > bufferSize) buffer.shift();
    const message = formatMessage(event.id, event.type, event.payload);
    for (const client of clients) writeToClient(client, message);
    return id;
  }

  function replay(res: Response, lastEventId: string): void {
    const parsed = parseEventId(lastEventId);
    if (parsed === undefined || parsed.bootId !== bootId || parsed.seq > seq) {
      res.write(formatMessage(undefined, 'reset', JSON.stringify({ reason: 'unknown_event_id' })));
      return;
    }
    const oldest = buffer[0];
    if (oldest !== undefined && parsed.seq < oldest.seq - 1) {
      res.write(formatMessage(undefined, 'reset', JSON.stringify({ reason: 'buffer_overflow' })));
      return;
    }
    for (const event of buffer) {
      if (event.seq > parsed.seq) res.write(formatMessage(event.id, event.type, event.payload));
    }
  }

  function connect(req: Request, res: Response, lastEventId?: string): void {
    if (closed) {
      res.status(503).json({ error: { code: 'unavailable', message: 'the event stream is shutting down' } });
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(`retry: ${retryMs}\n\n`);

    if (lastEventId !== undefined) replay(res, lastEventId);

    const client: Client = { res };
    clients.add(client);
    req.on('close', () => {
      clients.delete(client);
    });
  }

  function lastEventId(): string {
    return `${bootId}.${seq}`;
  }

  function disconnectAll(): void {
    for (const client of clients) {
      try {
        client.res.end();
      } catch {
        // already gone
      }
    }
    clients.clear();
  }

  function close(): void {
    if (closed) return;
    closed = true;
    disconnectAll();
    clearInterval(keepAliveTimer);
  }

  return { publish, connect, lastEventId, clientCount: () => clients.size, disconnectAll, close };
}
