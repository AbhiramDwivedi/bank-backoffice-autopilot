/**
 * `startOperatorDemo`/`runOperatorDemo` -- a self-contained walkthrough of the human-in-the-loop
 * handoff, no real browser required. Drives a `FakeSurface` (the cu-core scenario) through sign-on
 * and a member lookup that lands on a restricted member, escalates, starts the Relay console so a
 * human can take control and resolve it, then simulates the caller's re-verification step once the
 * operator hands back. The console is Relay (`@cu/relay`, mounted via `startRelayConsole`). Run via
 * `cu operator --demo` (apps/cu/src/commands/operator.ts), in-process.
 *
 * If anything fails after the console started (the scripted walkthrough, or the escalation itself),
 * the console is stopped and the broker disposed before the error propagates, so no listening
 * server is left keeping the process alive.
 */
import { createCuCoreSurface, type ObservedElement, type Observation, type Surface } from '@cu/core/surface';
import { createRunLogger, newRunId } from '@cu/core/evidence';
import { createSessionBroker, type EscalationResolution } from '@cu/core/session';
import { startRelayConsole } from '../runtime/index.js';

// cu-core's legacy-table screens give a label <td> the same accessible name as the control next
// to it (e.g. a "User ID" cell AND the "User ID" textbox), so matching by name alone can pick the
// label instead of the control. Prefer an interactive role when more than one element shares a name.
const INTERACTIVE_ROLES = new Set(['textbox', 'combobox', 'searchbox', 'button', 'link', 'clickable', 'checkbox', 'radio', 'tab', 'menuitem']);

function findByName(obs: Observation, name: string): ObservedElement {
  const matches = obs.elements.filter((e) => e.name === name);
  if (matches.length === 0) throw new Error(`demo: element not found on screen: ${JSON.stringify(name)} (url ${obs.url})`);
  return matches.find((e) => INTERACTIVE_ROLES.has(e.role)) ?? matches[0]!;
}

async function clickByName(surface: Surface, name: string): Promise<void> {
  const obs = await surface.observe();
  const el = findByName(obs, name);
  const result = await surface.act({ type: 'click', target: { ref: el.ref } }, 5000);
  if (!result.ok) throw new Error(`demo: click ${JSON.stringify(name)} failed: ${result.error?.message}`);
}

async function typeByName(surface: Surface, name: string, value: string): Promise<void> {
  const obs = await surface.observe();
  const el = findByName(obs, name);
  const result = await surface.act({ type: 'type', target: { ref: el.ref }, value, clear: true }, 5000);
  if (!result.ok) throw new Error(`demo: type into ${JSON.stringify(name)} failed: ${result.error?.message}`);
}

/** For controls the cu-core scenario gives no stable visible name (e.g. the sign-on button is a
 *  bare `<input type=image name=login>` with no `alt`, so its accessible name is the meaningless
 *  HTML `name` attribute "login") -- match on role/shape instead of text. */
async function clickWhere(surface: Surface, predicate: (e: ObservedElement) => boolean, description: string): Promise<void> {
  const obs = await surface.observe();
  const el = obs.elements.find(predicate);
  if (!el) throw new Error(`demo: element not found on screen: ${description} (url ${obs.url})`);
  const result = await surface.act({ type: 'click', target: { ref: el.ref } }, 5000);
  if (!result.ok) throw new Error(`demo: click ${description} failed: ${result.error?.message}`);
}

/** Per cu-core.ts's scenario doc: GET /members/90001 is the one seeded restricted member. */
const RESTRICTED_MEMBER_ID = '90001';

const noop = (_line: string): void => {
  /* swallowed by default */
};

/** Options for {@link startOperatorDemo}. */
export interface StartOperatorDemoOptions {
  port: number;
  /** Default 'runs' (mirrors DEFAULT_RUNS_DIR). */
  runsDir?: string;
  /** Serve a pre-built Relay UI from here instead of building one on demand. */
  staticDir?: string;
  /** One-line progress messages, in the order the walkthrough produces them. Default: swallowed. */
  log?: (line: string) => void;
  /** The surface the walkthrough drives. Default: a fresh cu-core FakeSurface. */
  surface?: Surface;
}

/** A running operator demo: the console it started, where its evidence landed, and how the
 *  escalation it raised was (or will be) resolved. */
export interface OperatorDemoHandle {
  url: string;
  runDir: string;
  /**
   * Settles once a human (or a test acting as one) hands back or aborts the open intervention.
   * On a hand-back (not abort) this calls `broker.resumed()` first: re-verification after
   * hand-back is the caller's job in real replay/agent code, but this demo just trusts it.
   */
  resolution: Promise<EscalationResolution>;
  /** Stops the Relay console and disposes the session broker. Idempotent. */
  close(): Promise<void>;
}

/**
 * Drives a `FakeSurface` to an escalation (an access-denied screen for the one seeded restricted
 * member), starts a Relay console for it, and resolves once that intervention is open (visible to
 * `GET /api/interventions?status=open`) -- not once it is resolved, so a caller can immediately
 * act on it. Rejects (with the console stopped) if the walkthrough or the escalation fails first.
 */
export async function startOperatorDemo(opts: StartOperatorDemoOptions): Promise<OperatorDemoHandle> {
  const log = opts.log ?? noop;
  const surface = opts.surface ?? createCuCoreSurface();
  const runId = newRunId();
  const logger = createRunLogger({ runId, runKind: 'replay', rootDir: opts.runsDir ?? 'runs' });

  const broker = createSessionBroker({
    surface,
    logger,
    runId,
    runKind: 'replay',
    sessionLabel: 'FakeSurface demo (no real browser)',
  });

  let handle: Awaited<ReturnType<typeof startRelayConsole>>;
  try {
    handle = await startRelayConsole({
      port: opts.port,
      brokers: [broker],
      leaseMs: broker.leaseMs,
      log,
      ...(opts.staticDir !== undefined ? { staticDir: opts.staticDir } : {}),
    });
  } catch (err) {
    broker.dispose();
    throw err;
  }

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await handle.close();
    broker.dispose();
  }

  let unsubscribe: (() => void) | undefined;
  try {
    log(`Operator console: ${handle.url}`);
    log(`Evidence folder: ${logger.dir}`);

    // Simulated automation driving the SAME surface the operator will take over, via the guarded
    // broker.surface -- never the raw one -- exactly like replay/agent code would.
    await typeByName(broker.surface, 'User ID', 'operator1');
    await typeByName(broker.surface, 'Password', 'demo-pass-123');
    await clickWhere(broker.surface, (e) => e.role === 'button', 'the sign-on button');

    // Tenant A shows a one-time maintenance interstitial right after sign-on.
    const afterSignOn = await broker.surface.observe();
    if (afterSignOn.elements.some((e) => e.name === 'OK')) {
      await clickByName(broker.surface, 'OK');
    }

    await typeByName(broker.surface, 'Member ID', RESTRICTED_MEMBER_ID);
    await clickByName(broker.surface, 'Search');
    await clickWhere(
      broker.surface,
      (e) => e.role === 'clickable' && e.name.startsWith(RESTRICTED_MEMBER_ID),
      `the search result row for member ${RESTRICTED_MEMBER_ID}`,
    );

    // Landed on the access-denied screen instead of the member profile: unrecoverable, escalate.
    const stuck = await broker.surface.observe();
    log(`Automation stuck on ${stuck.url}; escalating for a human.`);
    const screenshotPng = await broker.surface.screenshot();

    // Subscribed before escalate() so the 'created' notification (synchronous inside the broker,
    // once the intervention record exists) can never race past us.
    const opened = new Promise<void>((resolve) => {
      unsubscribe = broker.interventions.subscribe((intervention, change) => {
        if (change === 'created' && intervention.runId === runId) {
          unsubscribe?.();
          resolve();
        }
      });
    });

    const resolutionPromise = broker.escalate({
      runId,
      runKind: 'replay',
      capabilityId: 'lookup-member-savings-balance',
      stepId: 'open-member',
      reason: {
        code: 'unrecoverable_condition',
        message: 'Member profile did not load: got an access-denied screen instead of member details.',
      },
      screenshotPng,
      currentUrl: stuck.url,
      context: {
        expected: `Member profile page for member ${RESTRICTED_MEMBER_ID} (Profile tab, savings/checking balances).`,
        observed: 'Access Denied: your role does not permit viewing this member.',
      },
    });

    log(`Escalated. Open ${handle.url} and take control to resolve it.`);
    // An escalation that rejects before its record exists would never fire 'created': race the
    // two so that failure surfaces here instead of hanging.
    await Promise.race([opened, resolutionPromise]);

    const resolution = resolutionPromise.then((resolved) => {
      if (resolved.resumeFrom !== 'abort') broker.resumed();
      return resolved;
    });

    return { url: handle.url, runDir: logger.dir, resolution, close };
  } catch (err) {
    unsubscribe?.();
    await close().catch(() => undefined);
    throw err;
  }
}

/** Options for {@link runOperatorDemo}. */
export interface RunOperatorDemoOptions {
  port: number;
}

/** Runs the walkthrough to completion; the Relay console it starts is left running (the CLI
 *  process only exits on Ctrl+C). */
export async function runOperatorDemo(opts: RunOperatorDemoOptions): Promise<void> {
  const { runDir, resolution } = await startOperatorDemo({ port: opts.port, log: (line) => console.log(line) });

  const resolved = await resolution;
  console.log('Resolution:', JSON.stringify(resolved, null, 2));

  if (resolved.resumeFrom === 'abort') {
    console.log(`Run aborted by ${resolved.by}. Evidence is in ${runDir}`);
    return;
  }

  console.log(`Automation resumed from '${resolved.resumeFrom}'. Evidence is in ${runDir}`);
  console.log('Operator server is still up; press Ctrl+C to stop.');
}
