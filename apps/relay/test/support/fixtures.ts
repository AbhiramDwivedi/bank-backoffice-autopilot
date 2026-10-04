/**
 * Shared fixtures for Relay's server tests, UI tests and the dev harness: a real SessionBroker on
 * a FakeSurface with a controllable fake human-action capture.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createRunLogger,
  createSessionBroker,
  el,
  FAKE_PNG,
  FakeSurface,
  newRunId,
  scenario,
  type EscalationRequest,
  type EscalationResolution,
  type HumanAction,
  type HumanActionCapture,
  type SessionBroker,
} from './core-testing.js';

export { FAKE_PNG };

/** A capture the test drives: `emit` delivers an action while the broker has capture running. */
export interface FakeCapture extends HumanActionCapture {
  /** Delivers an action to the broker (ignored when capture is not running). Accepts malformed input on purpose. */
  emit(action: unknown): void;
  readonly active: boolean;
}

export function makeFakeCapture(): FakeCapture {
  let cb: ((a: HumanAction) => void) | undefined;
  return {
    async start(onAction: (a: HumanAction) => void) {
      cb = onAction;
    },
    async stop() {
      cb = undefined;
    },
    emit(action: unknown) {
      cb?.(action as HumanAction);
    },
    get active() {
      return cb !== undefined;
    },
  };
}

export interface BrokerFixture {
  broker: SessionBroker;
  capture: FakeCapture;
  surface: FakeSurface;
  runDir: string;
  /** Disposes the broker and deletes its run directory. Idempotent. */
  dispose(): void;
}

export interface BrokerFixtureOptions {
  sessionLabel?: string;
  runKind?: 'replay' | 'discovery';
  interventionLeaseMs?: number;
  /** Root directory for run evidence; defaults to a fresh temp dir that dispose() deletes. */
  rootDir?: string;
}

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

export function makeBrokerFixture(opts: BrokerFixtureOptions = {}): BrokerFixture {
  const runKind = opts.runKind ?? 'replay';
  const runId = newRunId();
  const ownDir = opts.rootDir === undefined;
  const rootDir = opts.rootDir ?? mkdtempSync(path.join(tmpdir(), 'relay-test-'));
  const logger = createRunLogger({ runId, runKind, rootDir });
  const surface = new FakeSurface(buildScenario());
  const capture = makeFakeCapture();
  const broker = createSessionBroker({
    surface,
    logger,
    runId,
    runKind,
    capture,
    sessionLabel: opts.sessionLabel ?? `cu-core session ${runId}`,
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
      if (ownDir) rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

/** Resolves with the id of the next intervention the broker creates. */
export function nextInterventionId(broker: SessionBroker): Promise<string> {
  return new Promise((resolve) => {
    const off = broker.interventions.subscribe((i, change) => {
      if (change === 'created') {
        off();
        resolve(i.id);
      }
    });
  });
}

/**
 * Raises an escalation on the broker with realistic cu-core content. Returns the id once the
 * intervention exists, and the promise automation is awaiting (resolves on hand-back or abort).
 */
export async function escalateSample(
  broker: SessionBroker,
  overrides: Partial<EscalationRequest> = {},
): Promise<{ id: string; resolution: Promise<EscalationResolution> }> {
  const idPromise = nextInterventionId(broker);
  const resolution = broker.escalate({
    runId: broker.runId,
    runKind: broker.runKind,
    capabilityId: 'lookup-member-savings-balance',
    stepId: 'open-member',
    reason: { code: 'unrecoverable_condition', message: 'Member profile did not load: got an access-denied screen instead of member details.' },
    screenshotPng: FAKE_PNG,
    currentUrl: 'http://cu-core.local/members/90001',
    context: {
      expected: 'Member profile page for member 90001 (Profile tab, savings and checking balances).',
      observed: 'Access Denied: your role does not permit viewing this member.',
    },
    ...overrides,
  });
  // Surface an escalate() failure instead of hanging on the id, without leaving a dangling rejection.
  let created = false;
  const id = await new Promise<string>((resolve, reject) => {
    void idPromise.then((v) => {
      created = true;
      resolve(v);
    });
    resolution.then(
      () => {
        if (!created) reject(new Error('escalation resolved before it was created'));
      },
      (err: unknown) => {
        if (!created) reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
  return { id, resolution };
}

export function sampleAction(overrides: Partial<HumanAction> = {}): HumanAction {
  return {
    ts: new Date().toISOString(),
    type: 'click',
    frame: [],
    target: { tag: 'button', role: 'button', name: 'Continue' },
    url: 'http://cu-core.local/members/90001',
    ...overrides,
  };
}
