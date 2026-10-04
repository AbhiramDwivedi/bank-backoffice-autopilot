/**
 * Shared plumbing for the replay integration suite (replay*.test.ts). Not a test file itself.
 *
 * - `makeFakeClock()`: a clock that advances `now()` synchronously on `sleep()`, shared between a
 *   `FakeSurface` and `replayCapability`'s `clock` option so waits and timeouts run instantly.
 * - `loadExample()`: loads and validates the example capability. Tests clone it and edit fields
 *   to build small, focused variants.
 * - `runReplay(overrides)`: builds a `RunLogger` in a fresh temp directory and calls
 *   `replayCapability`, returning the result plus the parsed evidence.
 * - `makeScriptedEscalationHandler(...)`: a scripted `EscalationHandler` that records every
 *   request and can run a "human" callback on the raw surface before resolving.
 * - `wrapSurface(...)`: a counting `Surface` proxy that flags calls made while an escalation is
 *   pending and records every `act()` call's arguments.
 * - `cuCoreTargets()` / `humanReLogin()`: reuse the example capability's own locators so a
 *   scripted "human" can act on the raw FakeSurface during an escalation.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import {
  validateCapability,
  type Action,
  type Capability,
  type RunEvent,
  type Step,
  type TargetDescriptor,
} from '../schema/index.js';
import { createRunLogger, type RunLogger } from '../evidence/index.js';
import { createCuCoreSurface, type ActOptions, type Surface, type SurfaceAction } from '../surface/index.js';
import type { EscalationHandler, EscalationRequest, EscalationResolution } from '../session/index.js';
import { DEFAULT_PASSWORD, DEFAULT_USER_ID } from '@cu/mock-app/test-helpers';
import { replayCapability } from './replay.js';
import type { ReplayClock, ReplayOptions } from './types.js';

export const BASE_A = 'http://localhost:4173';
export const BASE_B = 'http://localhost:4174';
export const MOCK_USER = DEFAULT_USER_ID;
export const MOCK_PASSWORD = DEFAULT_PASSWORD;

// -------------------------------------------------------------------------------------------
// Fake clock
// -------------------------------------------------------------------------------------------

/** Advances `now()` by exactly `ms` on every `sleep()`, without any real delay. Structurally
 *  compatible with both `ReplayClock` (replay.ts) and `Clock` (surface/fake/surface.ts) -- pass the same
 *  instance to both so a run's simulated time is consistent everywhere. */
export function makeFakeClock(start = 0): ReplayClock {
  let now = start;
  return {
    now: () => now,
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

// -------------------------------------------------------------------------------------------
// Example capability
// -------------------------------------------------------------------------------------------

const EXAMPLE_URL = new URL('../../../../artifacts/examples/lookup-member-savings-balance.example.json', import.meta.url);

/** Loads and validates the example capability used as the default fixture across this suite.
 *  Throws if it fails `validateCapability`. */
export function loadExample(): Capability {
  const raw: unknown = JSON.parse(readFileSync(EXAMPLE_URL, 'utf8'));
  const res = validateCapability(raw);
  if (!res.ok) throw new Error(`example capability failed validateCapability: ${JSON.stringify(res.issues)}`);
  return res.capability;
}

// -------------------------------------------------------------------------------------------
// runReplay
// -------------------------------------------------------------------------------------------

/** Overrides for {@link runReplay}: any `ReplayOptions` field, plus an explicit `runId`. */
export interface RunReplayOverrides extends Partial<ReplayOptions> {
  runId?: string;
}

/** Everything a test typically wants after a run: the result, the surface used, the logged
 *  events, the parsed `result.json`, and the run's temp directory. */
export interface RunReplayReturn {
  result: Awaited<ReturnType<typeof replayCapability>>;
  surface: Surface;
  events: RunEvent[];
  resultJson: unknown;
  runDir: string;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  }
});

let runCounter = 0;

const TEST_SECRETS: Record<string, string> = { MOCK_USER, MOCK_PASSWORD };

function defaultSecretResolver(env: string): string | undefined {
  return TEST_SECRETS[env];
}

function readEvents(runDir: string): RunEvent[] {
  const raw = readFileSync(path.join(runDir, 'events.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RunEvent);
}

/** Builds a `RunLogger` in a fresh temp directory and calls `replayCapability`. Defaults:
 *  `capability` = `loadExample()`, `inputs` = `{memberId:'12345'}`, `baseUrl` = tenant A,
 *  `surface`/`clock` = a fresh `FakeSurface`/fake clock pair, `secret` reads the two mock
 *  credentials, `stepTimeoutMs` = 2000 (small, for fast deterministic timeout tests). Any of
 *  these -- and every other `ReplayOptions` field -- can be overridden. */
export async function runReplay(overrides: RunReplayOverrides = {}): Promise<RunReplayReturn> {
  const { runId: runIdOverride, ...rest } = overrides;
  const clock = rest.clock ?? makeFakeClock();
  const surface = rest.surface ?? createCuCoreSurface({ clock });
  const runId = runIdOverride ?? `test-run-${(runCounter += 1)}`;
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'replay-test-'));
  tempDirs.push(rootDir);
  const logger: RunLogger = createRunLogger({ runId, runKind: 'replay', rootDir });

  const opts: ReplayOptions = {
    stepTimeoutMs: 2000,
    ...rest,
    capability: rest.capability ?? loadExample(),
    inputs: rest.inputs ?? { memberId: '12345' },
    baseUrl: rest.baseUrl ?? BASE_A,
    secret: rest.secret ?? defaultSecretResolver,
    surface,
    clock,
    logger,
  };

  const result = await replayCapability(opts);

  const runDir = logger.dir;
  const events = readEvents(runDir);
  const resultJson: unknown = JSON.parse(readFileSync(path.join(runDir, 'result.json'), 'utf8'));

  return { result, surface, events, resultJson, runDir };
}

/** Absolute path to an evidence file recorded relative to `runDir` (e.g. `evidence.screenshot`);
 *  also asserts it actually exists on disk. */
export function evidencePath(runDir: string, relative: string): string {
  const abs = path.join(runDir, relative);
  if (!existsSync(abs)) throw new Error(`expected evidence file to exist: ${abs}`);
  return abs;
}

// -------------------------------------------------------------------------------------------
// Scripted EscalationHandler
// -------------------------------------------------------------------------------------------

/** How a scripted escalation handler (see {@link makeScriptedEscalationHandler}) should resolve
 *  the next request it receives. */
export interface ScriptedHandlerOptions {
  resumeFrom: 'current_step' | 'next_step' | 'abort';
  /** Passed through as `EscalationResolution.resumeAtStepId`. */
  resumeAtStepId?: string;
  by?: string;
  notes?: string;
  humanActions?: EscalationResolution['humanActions'];
  /** Runs before resolving -- simulates the human acting on the RAW (unwrapped) surface. */
  human?: (req: EscalationRequest) => void | Promise<void>;
}

/** A scripted handler plus every `EscalationRequest` it has received so far, in order. */
export interface ScriptedHandler {
  escalate: EscalationHandler;
  requests: EscalationRequest[];
}

/** A scripted `EscalationHandler`: records every request, runs an optional `human` callback
 *  (which should act on the raw, unwrapped surface -- see `wrapSurface`), then resolves.
 *  `pending`, when given, is set `true` for the duration of the handler (entry to just before
 *  return) so a `wrapSurface` wrapper can flag any call made through the WRAPPED surface while
 *  control notionally belongs to the human. `optionsOrFn` may be a function of the request and a
 *  0-based call index, for tests that escalate more than once. */
export function makeScriptedEscalationHandler(
  pending: { value: boolean } | undefined,
  optionsOrFn: ScriptedHandlerOptions | ((req: EscalationRequest, index: number) => ScriptedHandlerOptions),
): ScriptedHandler {
  const requests: EscalationRequest[] = [];
  let index = 0;

  const escalate: EscalationHandler = async (req) => {
    requests.push(req);
    if (pending) pending.value = true;
    try {
      const opts = typeof optionsOrFn === 'function' ? optionsOrFn(req, index) : optionsOrFn;
      index += 1;
      if (opts.human) await opts.human(req);
      const resolution: EscalationResolution = {
        interventionId: `intv-${index}`,
        resumeFrom: opts.resumeFrom,
        ...(opts.resumeAtStepId !== undefined ? { resumeAtStepId: opts.resumeAtStepId } : {}),
        humanActions: opts.humanActions ?? [],
        by: opts.by ?? 'test-human',
        ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
      };
      return resolution;
    } finally {
      if (pending) pending.value = false;
    }
  };

  return { escalate, requests };
}

// -------------------------------------------------------------------------------------------
// Surface wrapper: call counting + "pending" flag + act() capture
// -------------------------------------------------------------------------------------------

/** Options for {@link wrapSurface}. */
export interface WrapSurfaceOptions {
  /** Called with each `SurfaceAction` just before it reaches the underlying (raw) surface. Use it
   *  to inject a fault right before a specific action (e.g. expire the session exactly on a
   *  search click) by calling methods on the RAW surface (never on the wrapper) from inside. */
  beforeAct?: (action: SurfaceAction) => void | Promise<void>;
}

/** One recorded `act()` call: the action, the timeout it was given, and any `ActOptions`. */
export interface ActCallRecord {
  action: SurfaceAction;
  timeoutMs: number;
  opts?: ActOptions;
}

/** A `Surface` wrapped with call counting and act-call capture; see {@link wrapSurface}. */
export interface WrappedSurface {
  /** Pass this into `runReplay({surface: ...})` / `ReplayOptions.surface`. */
  surface: Surface;
  /** The underlying, unwrapped surface -- the scripted "human" acts on this directly so its own
   *  calls are never counted and never re-trigger `beforeAct`. */
  raw: Surface;
  /** Escalation-pending flag; toggled by `makeScriptedEscalationHandler`. */
  pending: { value: boolean };
  totalCalls: () => number;
  /** Calls made through the WRAPPED surface while `pending.value` was true. Should always be 0:
   *  replay must make no surface calls while an escalation is awaiting the human. */
  callsWhilePending: () => number;
  actCalls: () => ActCallRecord[];
}

const SURFACE_METHOD_NAMES: ReadonlySet<PropertyKey> = new Set<keyof Surface>([
  'observe',
  'resolve',
  'act',
  'readText',
  'check',
  'waitFor',
  'screenshot',
  'domSnapshot',
  'currentUrl',
  'frameUrls',
  'describeRef',
  'close',
]);

/** Wraps a `Surface` in a call-counting `Proxy`. See `WrappedSurface` for what it tracks. */
export function wrapSurface(raw: Surface, opts: WrapSurfaceOptions = {}): WrappedSurface {
  const pending = { value: false };
  let total = 0;
  let duringPending = 0;
  const actLog: ActCallRecord[] = [];

  const surface = new Proxy(raw, {
    get(target, prop, receiver) {
      const orig: unknown = Reflect.get(target, prop, receiver);
      if (typeof orig !== 'function' || !SURFACE_METHOD_NAMES.has(prop)) return orig;
      const fn = orig as (...args: unknown[]) => unknown;
      return async (...args: unknown[]) => {
        total += 1;
        if (pending.value) duringPending += 1;
        if (prop === 'act') {
          const [action, timeoutMs, actOpts] = args as [SurfaceAction, number, ActOptions | undefined];
          if (opts.beforeAct) await opts.beforeAct(action);
          actLog.push({ action, timeoutMs, opts: actOpts });
        }
        return fn.apply(target, args);
      };
    },
  }) as Surface;

  return {
    surface,
    raw,
    pending,
    totalCalls: () => total,
    callsWhilePending: () => duringPending,
    actCalls: () => [...actLog],
  };
}

// -------------------------------------------------------------------------------------------
// CU Core targets + scripted human re-login (session-expired escalation tests)
// -------------------------------------------------------------------------------------------

function stepById(cap: Capability, id: string): Step {
  const step = cap.steps.find((s) => s.id === id);
  if (!step) throw new Error(`test-helpers: no step "${id}" in capability`);
  return step;
}

function targetOf(action: Action): TargetDescriptor {
  if ('target' in action) return action.target;
  throw new Error(`test-helpers: action type "${action.type}" has no target`);
}

/** Target descriptors reused from the example capability's own login and search steps, so a
 *  scripted "human" can act on the raw surface with the same locators replay itself uses. */
export interface CuCoreTargets {
  userId: TargetDescriptor;
  password: TargetDescriptor;
  signOn: TargetDescriptor;
  memberId: TargetDescriptor;
  search: TargetDescriptor;
  maintOk: TargetDescriptor;
}

/** Reuses the example capability's OWN locators (rather than hand-rolling new ones) so a scripted
 *  "human" can act on the raw FakeSurface with the exact same vocabulary replay itself uses. */
function cuCoreTargets(cap: Capability = loadExample()): CuCoreTargets {
  const rule = cap.recoveryRules.find((r) => r.name === 'dismiss_maintenance_notice');
  if (!rule) throw new Error('test-helpers: example capability has no dismiss_maintenance_notice recovery rule');
  return {
    userId: targetOf(stepById(cap, 's02').action),
    password: targetOf(stepById(cap, 's03').action),
    signOn: targetOf(stepById(cap, 's04').action),
    memberId: targetOf(stepById(cap, 's05').action),
    search: targetOf(stepById(cap, 's06').action),
    maintOk: targetOf(rule.actions[0]!),
  };
}

async function typeInto(raw: Surface, target: TargetDescriptor, value: string): Promise<void> {
  const resolved = await raw.resolve(target, 2000);
  if (!resolved.found) throw new Error(`test-helpers: could not resolve ${target.description}`);
  const res = await raw.act({ type: 'type', target: { ref: resolved.ref }, value, clear: true }, 2000);
  if (!res.ok) throw new Error(`test-helpers: type into ${target.description} failed: ${res.error?.message ?? 'unknown error'}`);
}

async function clickOn(raw: Surface, target: TargetDescriptor): Promise<void> {
  const resolved = await raw.resolve(target, 2000);
  if (!resolved.found) throw new Error(`test-helpers: could not resolve ${target.description}`);
  const res = await raw.act({ type: 'click', target: { ref: resolved.ref } }, 2000);
  if (!res.ok) throw new Error(`test-helpers: click on ${target.description} failed: ${res.error?.message ?? 'unknown error'}`);
}

/** Options for {@link humanReLogin}. */
export interface HumanReLoginOptions {
  baseUrl: string;
  user: string;
  password: string;
  /** Retypes the member id after logging back in, if the caller asks for it. */
  memberId?: string;
  targets?: CuCoreTargets;
}

/** What the scripted "human" does while holding control of the RAW (unwrapped) surface after a
 *  session-expired escalation: re-authenticate, dismiss the maintenance interstitial if it is
 *  showing, and (if asked) retype the member id -- operating the same live session the automation
 *  was using. */
export async function humanReLogin(raw: Surface, opts: HumanReLoginOptions): Promise<void> {
  const targets = opts.targets ?? cuCoreTargets();
  await raw.act({ type: 'navigate', url: `${opts.baseUrl}/login` }, 2000);
  await typeInto(raw, targets.userId, opts.user);
  await typeInto(raw, targets.password, opts.password);
  await clickOn(raw, targets.signOn);
  if (await raw.check({ kind: 'text_visible', text: 'System Maintenance Notice', frame: [{ name: 'main' }] })) {
    await clickOn(raw, targets.maintOk);
  }
  if (opts.memberId !== undefined) {
    await typeInto(raw, targets.memberId, opts.memberId);
  }
}

/** Re-exported so test files don't need their own `fileURLToPath` plumbing if they ever need the
 *  directory this helper lives in (e.g. to read another fixture next to it). */
export const REPLAY_DIR = path.dirname(fileURLToPath(import.meta.url));
