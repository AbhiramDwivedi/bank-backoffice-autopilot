/**
 * Shared e2e harness: the REAL mock app in-process on ephemeral ports, a real headless Chromium,
 * and the system wired exactly like the CLI wires it (apps/cu/src/runtime/compose.ts). One browser per
 * test file (`launchBrowser` in beforeAll); each run gets its own browser context.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { chromium, type Browser, type Page } from 'playwright';
import { createApp } from '@cu/mock-app/app';
import type { TenantId } from '@cu/mock-app/tenant';
import { DEFAULT_PASSWORD, DEFAULT_USER_ID } from '@cu/mock-app/test-helpers';
import { loadPolicy, DEFAULT_POLICY_PATH } from '@cu/core/policy';
import type { Policy, ReplayResult } from '@cu/core/schema';
import {
  compose,
  loadRunCredentials,
  secretEnvNamesOf,
  type Composition,
  attachAutoOperator,
  type AutoOperatorMode,
  type RelayServerHandle,
} from '@cu/cli/runtime';
import { envCredentialProvider } from '@cu/core/credentials';
import { replayCapability } from '@cu/core/replay';
import { createPlaywrightSurface } from '@cu/adapter-playwright';
import { screenMaskOptionsFromPolicy } from '@cu/core/surface';

export const PASSWORD = DEFAULT_PASSWORD;
export const USER = DEFAULT_USER_ID;
export const EXAMPLE_ARTIFACT = path.resolve('artifacts/examples/lookup-member-savings-balance.example.json');

/** Loads and parses the reference example capability artifact. */
export function loadExample(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(EXAMPLE_ARTIFACT, 'utf8')) as Record<string, unknown>;
}

const TSX_CLI = path.resolve('node_modules/tsx/dist/cli.mjs');
const CU_CLI = path.resolve('apps/cu/src/index.ts');

/** The outcome of a CLI child-process invocation. */
export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawns the CLI as a real child process, the same way tests/e2e/cli.test.ts's own local
 * `runCli` does, exported here so other e2e files can reuse it without spawning via a shell
 * (Windows shell-quoting is otherwise a problem).
 */
export function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, CU_CLI, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, MOCK_PASSWORD: PASSWORD },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** A running mock-app instance under test, with helpers for toggling faults and resetting state. */
export interface MockServer {
  tenant: TenantId;
  /** http://localhost:<port> */
  baseUrl: string;
  /** Every request the app received (method + path), in order; includes /__faults calls made by tests. */
  requests: { method: string; path: string }[];
  setFaults(f: Record<string, unknown>): Promise<void>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** Starts a real mock-app instance for `tenant` on an ephemeral port and returns a handle to it. */
export async function startMock(tenant: TenantId): Promise<MockServer> {
  const requests: { method: string; path: string }[] = [];
  const outer = express();
  outer.use((req, _res, next) => {
    requests.push({ method: req.method, path: req.path });
    next();
  });
  outer.use(createApp({ tenant, password: PASSWORD }));
  // No host: dual-stack, so both 127.0.0.1 and ::1 (what "localhost" may resolve to) work.
  const server = await new Promise<Server>((resolve) => {
    const s = outer.listen(0, () => resolve(s));
  });
  const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  const post = async (p: string, body?: unknown): Promise<void> => {
    const res = await fetch(`${baseUrl}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    if (!res.ok) throw new Error(`${p} -> HTTP ${res.status}`);
  };
  return {
    tenant,
    baseUrl,
    requests,
    setFaults: (f) => post('/__faults', f),
    reset: () => post('/__reset'),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The default policy with allowedOrigins replaced by the ephemeral mock origins. */
export function policyFor(...baseUrls: string[]): Policy {
  const base = loadPolicy(DEFAULT_POLICY_PATH);
  return { ...base, allowedOrigins: baseUrls.map((u) => new URL(u).origin) };
}

/** Writes policyFor(...) as a YAML-compatible JSON file (JSON is valid YAML) for CLI subprocess tests. */
export function writePolicyFile(dir: string, ...baseUrls: string[]): string {
  const file = path.join(dir, 'policy.e2e.yaml');
  fs.writeFileSync(file, JSON.stringify(policyFor(...baseUrls), null, 2));
  return file;
}

/** Creates a fresh temporary directory for a run's evidence output. */
export function tempRunsDir(prefix = 'e2e-runs-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Launches a headless Chromium instance shared across a test file's runs. */
export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

/** Options for one end-to-end replay run through {@link replayOnce}. */
export interface ReplayRunOptions {
  browser: Browser;
  mock: MockServer;
  capability?: unknown;
  inputs: Record<string, unknown>;
  /** Replay override key (e.g. 'riverbend-fcu'), NOT the mock tenant id. */
  tenant?: string;
  runsDir: string;
  autoOperator?: AutoOperatorMode;
  /** Register the broker with an existing Relay console (case h). */
  operator?: RelayServerHandle;
  /** Called after composition, before replay starts (e.g. to start polling the operator API). */
  onComposed?: (c: Composition, page: Page) => void;
  stepTimeoutMs?: number;
  /** The run's policy (default: `policyFor(mock.baseUrl)`); its `redaction.screen` block masks the surface, as compose() does. */
  policy?: Policy;
}

/** The result of one {@link replayOnce} run, plus the composition and page it ran through. */
export interface ReplayRun {
  result: ReplayResult;
  c: Composition;
  runDir: string;
  /** The Playwright page the surface drives (what a human would operate in a headed window). */
  page: Page;
}

/** One replay against the real mock app, wired through compose(). Closes the context afterwards. */
export async function replayOnce(o: ReplayRunOptions): Promise<ReplayRun> {
  process.env.MOCK_USER ??= USER;
  process.env.MOCK_PASSWORD ??= PASSWORD;
  const capability = o.capability ?? loadExample();
  // Wired like runReplay: the artifact's credential names, loaded from the env provider up front.
  const credentials = await loadRunCredentials(envCredentialProvider(), secretEnvNamesOf(capability));
  const context = await o.browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: o.mock.baseUrl });
  const page = await context.newPage();
  const policy = o.policy ?? policyFor(o.mock.baseUrl);
  const raw = await createPlaywrightSurface({ page, screenMask: screenMaskOptionsFromPolicy(policy) });
  const c = await compose({
    runKind: 'replay',
    policy,
    runsDir: o.runsDir,
    baseUrl: o.mock.baseUrl,
    surface: raw,
    ownSurface: true,
    credentials,
    ...(o.operator ? { operator: { server: o.operator } } : {}),
  });
  const op = attachAutoOperator(c.broker, o.autoOperator ?? 'none', {
    baseUrl: o.mock.baseUrl,
    replay: { capability, inputs: o.inputs, ...(o.tenant !== undefined ? { tenant: o.tenant } : {}) },
    credentials,
  });
  try {
    o.onComposed?.(c, page);
    const result = await replayCapability({
      secret: (name) => credentials.get(name),
      capability,
      inputs: o.inputs,
      surface: c.surface,
      baseUrl: o.mock.baseUrl,
      ...(o.tenant !== undefined ? { tenant: o.tenant } : {}),
      policy: c.guard,
      replayRequiresApproved: c.policy.risk.replayRequiresApproved,
      logger: c.logger,
      escalate: c.escalate,
      ...(o.stepTimeoutMs !== undefined ? { stepTimeoutMs: o.stepTimeoutMs } : {}),
    });
    return { result, c, runDir: c.logger.dir, page };
  } finally {
    op?.stop();
    await op?.idle();
    await c.close();
    await context.close().catch(() => undefined);
  }
}

/** Every text file under the run dir (events.jsonl, result.json, dom/*.html, interventions/*.json). */
export function readRunText(runDir: string): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!e.name.endsWith('.png')) out.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(runDir);
  return out.join('\n');
}

/** Parses every line of a run's events.jsonl into structured events. */
export function readEvents(runDir: string): { kind: string; stepId?: string; data: Record<string, unknown> }[] {
  return fs
    .readFileSync(path.join(runDir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { kind: string; stepId?: string; data: Record<string, unknown> });
}
