/**
 * Orchestrator behind `npm run video:build`.
 *
 * (a) refuse to start if ports 4183 (mock app) or 4310 (Relay console) are already listening
 * (b) start the mock app (tenant a) on 4183, wait for /login to return 200
 * (c) write VIDEO_POLICY with ports remapped 4173->4183, 4174->4184
 * (d) narrate -> record (or placeholder.ts fallback) -> assemble
 *     record.ts's CLI runs start Relay in-process on 4310 for the handoff clips (its UI is
 *     built into apps/relay/dist on demand, the first time it's needed)
 * (e) always stop the mock app, verify 4183 is free again
 * (f) print total wall time
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { REPO_ROOT, VIDEO_DIR } from './lib/script.js';
import { VIDEO_POLICY, VIDEO_PORTS } from './lib/contracts.js';

const MOCK_PORT = VIDEO_PORTS.tenantA; // 4183
const OPERATOR_PORT = VIDEO_PORTS.operator; // Relay console, 4310

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    let settled = false;
    const done = (result: boolean): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

async function waitForHttp200(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = new Error('never attempted');
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
      lastErr = new Error(`status ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for 200 from ${url}: ${String(lastErr)}`);
}

function writeVideoPolicy(): void {
  const src = path.join(REPO_ROOT, 'policies', 'default.yaml');
  const content = readFileSync(src, 'utf8');
  const patched = content.replaceAll('localhost:4173', 'localhost:4183').replaceAll('localhost:4174', 'localhost:4184');
  mkdirSync(path.dirname(VIDEO_POLICY), { recursive: true });
  writeFileSync(VIDEO_POLICY, patched);
  console.log(`wrote ${VIDEO_POLICY} (ports remapped 4173->4183, 4174->4184)`);
}

function startMockApp(): ChildProcess {
  const tsxCli = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const serverEntry = path.join(REPO_ROOT, 'apps', 'mock-app', 'server.ts');
  return spawn(process.execPath, [tsxCli, serverEntry], {
    cwd: REPO_ROOT,
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_TENANT: 'a' },
    stdio: 'inherit',
  });
}

async function stopMockApp(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  child.kill();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const wallStart = Date.now();

  if (await isPortListening(MOCK_PORT)) {
    throw new Error(`port ${MOCK_PORT} is already in use; stop whatever is listening on it and retry`);
  }
  if (await isPortListening(OPERATOR_PORT)) {
    throw new Error(`port ${OPERATOR_PORT} is already in use; stop whatever is listening on it and retry`);
  }

  const mockApp = startMockApp();
  try {
    await waitForHttp200(`http://localhost:${String(MOCK_PORT)}/login`, 30000);
    console.log(`mock app up on ${MOCK_PORT}`);

    writeVideoPolicy();

    const t0 = Date.now();
    const { narrate } = await import('./narrate.js');
    await narrate();
    console.log(`narrate: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const t1 = Date.now();
    const recordPath = path.join(VIDEO_DIR, 'record.ts');
    if (existsSync(recordPath)) {
      // record.ts is owned by another agent; import it via a non-literal specifier so tsc
      // (NodeNext module resolution) doesn't require the module to exist/typecheck here.
      const recordSpecifier: string = './record.js';
      const recordModule = (await import(recordSpecifier)) as { record: () => Promise<void> };
      await recordModule.record();
    } else {
      console.log('record.ts not found yet, falling back to placeholder.ts for testing');
      const { placeholder } = await import('./placeholder.js');
      await placeholder();
    }
    console.log(`record: ${((Date.now() - t1) / 1000).toFixed(1)}s`);

    const t2 = Date.now();
    const { assemble } = await import('./assemble.js');
    await assemble();
    console.log(`assemble: ${((Date.now() - t2) / 1000).toFixed(1)}s`);
  } finally {
    await stopMockApp(mockApp);
    // The OS can take a moment to release the listener after the process exits.
    let stillUp = await isPortListening(MOCK_PORT);
    for (let i = 0; stillUp && i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      stillUp = await isPortListening(MOCK_PORT);
    }
    if (stillUp) {
      console.error(`WARNING: port ${MOCK_PORT} still listening after stopping mock app`);
    } else {
      console.log(`port ${MOCK_PORT} is free`);
    }
  }

  console.log(`total wall time: ${((Date.now() - wallStart) / 1000).toFixed(1)}s`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
