import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { describe, expect, it } from 'vitest';
import { BridgeCallError, BridgeClient, startUiaBridge, type BridgeChild } from './bridge-client.js';

/** A scripted bridge on the other end of a pair of streams. */
function pair(): { client: BridgeClient; requests: Record<string, unknown>[]; reply: (obj: unknown) => void; end: () => void } {
  const toBridge = new PassThrough();
  const fromBridge = new PassThrough();
  const client = new BridgeClient(fromBridge, toBridge, { defaultTimeoutMs: 200 });
  const requests: Record<string, unknown>[] = [];
  readline.createInterface({ input: toBridge }).on('line', (l) => requests.push(JSON.parse(l) as Record<string, unknown>));
  return {
    client,
    requests,
    reply: (obj) => fromBridge.write(`${JSON.stringify(obj)}\n`),
    end: () => fromBridge.end(),
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe('BridgeClient', () => {
  it('numbers requests and matches answers by id, in any order', async () => {
    const { client, requests, reply } = pair();
    const a = client.call({ op: 'snapshot' });
    const b = client.call({ op: 'key', key: 'Enter' });
    await tick();
    expect(requests.map((r) => [r.id, r.op])).toEqual([
      [1, 'snapshot'],
      [2, 'key'],
    ]);
    reply({ id: 2, ok: true, result: { hwnd: 7 } });
    reply({ id: 1, ok: true, result: { windows: [] } });
    await expect(b).resolves.toEqual({ hwnd: 7 });
    await expect(a).resolves.toEqual({ windows: [] });
  });

  it('rejects with the bridge error code', async () => {
    const { client, reply } = pair();
    const p = client.call({ op: 'act', rid: '1', kind: 'invoke' });
    await tick();
    reply({ id: 1, ok: false, error: { code: 'out_of_scope', message: 'not yours' } });
    await expect(p).rejects.toMatchObject({ name: 'BridgeCallError', code: 'out_of_scope', message: 'not yours' });
  });

  it('times out a call the bridge never answers, and drops the late answer', async () => {
    const { client, reply } = pair();
    await expect(client.call({ op: 'snapshot' }, 50)).rejects.toMatchObject({ code: 'timeout' });
    reply({ id: 1, ok: true, result: {} });
    await tick();
    // The channel still works afterwards.
    const next = client.call({ op: 'hello' });
    await tick();
    reply({ id: 2, ok: true, result: { protocol: 1, bridgePid: 3 } });
    await expect(next).resolves.toMatchObject({ protocol: 1 });
  });

  it('fails every pending call when the bridge goes away, and refuses new ones', async () => {
    const { client, end } = pair();
    const p = client.call({ op: 'snapshot' }, 5000);
    end();
    await expect(p).rejects.toMatchObject({ code: 'closed' });
    expect(client.closed).toBe(true);
    await expect(client.call({ op: 'hello' })).rejects.toBeInstanceOf(BridgeCallError);
  });

  it('delivers events, resolves ready, ignores lines that are not JSON, and survives a throwing listener', async () => {
    const { client, reply } = pair();
    const seen: string[] = [];
    client.onEvent(() => {
      throw new Error('listener bug');
    });
    client.onEvent((e) => seen.push(e.event));
    reply({ event: 'ready', data: { protocol: 1, bridgePid: 9 } });
    reply('not json at all');
    reply({ event: 'human', data: { type: 'invoked' } });
    await expect(client.ready()).resolves.toMatchObject({ bridgePid: 9 });
    await tick();
    expect(seen).toEqual(['ready', 'human']);
  });

  it('a fatal event closes the client', async () => {
    const { client, reply } = pair();
    const p = client.call({ op: 'snapshot' }, 5000);
    reply({ event: 'fatal', data: 'COMException: boom' });
    await expect(p).rejects.toMatchObject({ code: 'closed', message: expect.stringContaining('boom') });
  });
});

/** A fake bridge child process: answers `ready`, then ignores everything (a hung bridge). */
class HungChild extends EventEmitter implements BridgeChild {
  readonly pid = 1234;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills = 0;
  constructor(
    private readonly obeysStdinEof: boolean,
    ready = true,
  ) {
    super();
    if (ready) this.stdout.write(`${JSON.stringify({ event: 'ready', data: { protocol: 1, bridgePid: 1234 } })}\n`);
    this.stdin.on('finish', () => {
      if (this.obeysStdinEof) this.exit(0, null);
    });
  }
  kill(): boolean {
    this.kills++;
    this.exit(null, 'SIGTERM');
    return true;
  }
  private exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

describe('BridgeProcess: no orphaned bridge', () => {
  it('a bridge that exits on stdin EOF is not killed', async () => {
    const child = new HungChild(true);
    const bridge = await startUiaBridge({ spawnChild: () => child });
    await bridge.close(500);
    expect(bridge.hasExited).toBe(true);
    expect(child.kills).toBe(0);
  });

  it('a bridge that ignores shutdown and EOF is killed after the grace period', async () => {
    const child = new HungChild(false);
    const bridge = await startUiaBridge({ spawnChild: () => child });
    await bridge.close(100);
    expect(child.kills).toBe(1);
    expect(bridge.hasExited).toBe(true);
  });

  it('a bridge that never reports ready fails the start and is killed, with its stderr in the error', async () => {
    const child = new HungChild(false, false);
    child.stderr.write('Add-Type : compilation failed');
    await expect(startUiaBridge({ spawnChild: () => child, startTimeoutMs: 100 })).rejects.toThrow(/did not start[\s\S]*compilation failed/);
    expect(child.kills).toBe(1);
  });
});
