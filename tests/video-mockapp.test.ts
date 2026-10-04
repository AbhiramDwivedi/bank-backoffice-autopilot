/**
 * The video recorder's fault helper (tools/video/lib/mockapp.ts) against the real mock app on an
 * ephemeral port: it must honour the `rejected` list the way `replay --fault` does, and its
 * snapshot must not carry a running chaos config back (restoring it would rewind the streams).
 * No browser. Lives under tests/ because tools/video has no vitest project of its own.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '@cu/mock-app/app';
import { setFaults } from '@cu/video/lib/mockapp.js';

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function start(): Promise<string> {
  const s = createApp({ tenant: 'a' }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => s.once('listening', () => resolve()));
  server = s;
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

describe('tools/video setFaults', () => {
  it('throws, naming the keys, when the mock app rejects part of the body', async () => {
    const base = await start();
    await expect(setFaults({ chaos: { seed: 1, failSearch: 5 } }, base)).rejects.toThrow('the mock app rejected chaos.failSearch');
    await expect(setFaults({ failSerch: true }, base)).rejects.toThrow('the mock app rejected failSerch');
  });

  it('returns a snapshot without a running chaos config unless the body sets chaos', async () => {
    const base = await start();
    await setFaults({ chaos: { seed: 9, failSearch: 0.5 } }, base);
    expect(await setFaults({ failSearch: true }, base)).not.toHaveProperty('chaos');
    expect(await setFaults({ chaos: null }, base)).toMatchObject({ chaos: { seed: 9, failSearch: 0.5 } });
  });
});
