/**
 * Covers three parts of the broker's public surface that Relay's adapter relies on (see
 * docs/design/relay.md, "The port Relay depends on"), plus the `key` field on a captured keypress
 * action:
 *  - `recordHumanAction` copying (and sanitizing) `key` for `keypress` actions.
 *  - `SessionBroker.leaseMs` (read-only mirror of `interventionLeaseMs`).
 *  - `SessionBroker.onHumanAction` (fires once per action accepted into a live round).
 *
 * Shares the same FakeSurface/broker setup pattern as broker.test.ts, but self-contained since
 * that file does not export its helpers.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HumanAction } from '../schema/index.js';
import { createRunLogger, newRunId } from '../evidence/index.js';
import { el, FakeSurface, scenario, type FakeScenario } from '../surface/index.js';
import { createSessionBroker } from './broker.js';
import type { HumanActionEvent, SessionBroker } from './broker-api.js';
import type { EscalationRequest } from './types.js';

function buildScenario(): FakeScenario {
  return scenario()
    .screen('blocked', {
      url: 'http://x.test/blocked',
      title: 'Blocked',
      elements: [el({ id: 'ack', role: 'button', name: 'Acknowledge', tag: 'button', bbox: { x: 0, y: 0, w: 100, h: 24 } })],
    })
    .on('click', { targetId: 'ack' })
    .goto('done')
    .screen('done', {
      url: 'http://x.test/done',
      title: 'Done',
      elements: [el({ id: 'doneMsg', role: 'generic', name: 'Done!', text: 'Done!', tag: 'div', bbox: { x: 0, y: 0, w: 60, h: 20 } })],
    })
    .build();
}

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'session-broker-events-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function setup(opts: { secretValues?: () => string[]; interventionLeaseMs?: number } = {}): {
  runId: string;
  broker: SessionBroker;
} {
  const dir = makeTmpDir();
  const runId = newRunId();
  const surface = new FakeSurface(buildScenario());
  const logger = createRunLogger({ runId, runKind: 'replay', rootDir: dir });
  const broker = createSessionBroker({
    surface,
    logger,
    runId,
    runKind: 'replay',
    ...(opts.secretValues !== undefined ? { secretValues: opts.secretValues } : {}),
    ...(opts.interventionLeaseMs !== undefined ? { interventionLeaseMs: opts.interventionLeaseMs } : {}),
  });
  return { runId, broker };
}

function escalationRequest(runId: string): EscalationRequest {
  return { runId, runKind: 'replay', capabilityId: 'test-cap', stepId: 's1', reason: { code: 'unrecoverable_condition', message: 'blocked' } };
}

/** Escalates and takes control as 'alice', returning the intervention id. */
async function escalateToHuman(broker: SessionBroker, runId: string): Promise<string> {
  let resolveId!: (id: string) => void;
  const idPromise = new Promise<string>((res) => {
    resolveId = res;
  });
  const unsubscribe = broker.interventions.subscribe((i, change) => {
    if (change === 'created') {
      unsubscribe();
      resolveId(i.id);
    }
  });
  void broker.escalate(escalationRequest(runId));
  const id = await idPromise;
  // The subscribe notification fires from inside escalate()'s own async continuation, before its
  // transition lock is released (see broker.ts escalate()'s `finally { lockHeld = false }`); a
  // macrotask tick lets that continuation finish before takeControl is attempted.
  await new Promise((r) => setTimeout(r, 0));
  await broker.takeControl(id, 'alice');
  return id;
}

function clickAction(name: string): HumanAction {
  return { ts: new Date().toISOString(), type: 'click', frame: [], target: { role: 'button', name } };
}

function keypressAction(key: string): HumanAction {
  return { ts: new Date().toISOString(), type: 'keypress', frame: [], target: { role: 'textbox', name: 'Note' }, key } as HumanAction;
}

function inputAction(): HumanAction {
  return { ts: new Date().toISOString(), type: 'input', frame: [], target: { role: 'textbox', name: 'Note' } };
}

// ---------------------------------------------------------------------------------------------
// `key` on keypress actions
// ---------------------------------------------------------------------------------------------

describe('recordHumanAction: key on keypress actions', () => {
  it('keeps a named key (Enter)', async () => {
    const { runId, broker } = setup();
    const id = await escalateToHuman(broker, runId);
    broker.recordHumanAction(id, keypressAction('Enter'), 'capture');
    expect(broker.view(id).humanActions[0]?.key).toBe('Enter');
  });

  it('keeps other named keys (Tab, Escape, ArrowDown, F5, Backspace)', async () => {
    const { runId, broker } = setup();
    const id = await escalateToHuman(broker, runId);
    for (const key of ['Tab', 'Escape', 'ArrowDown', 'F5', 'Backspace']) {
      broker.recordHumanAction(id, keypressAction(key), 'capture');
    }
    expect(broker.view(id).humanActions.map((a) => a.key)).toEqual(['Tab', 'Escape', 'ArrowDown', 'F5', 'Backspace']);
  });

  it('drops a single printable character (the rest of the action is still recorded)', async () => {
    const { runId, broker } = setup();
    const id = await escalateToHuman(broker, runId);
    broker.recordHumanAction(id, keypressAction('a'), 'capture');
    const view = broker.view(id);
    expect(view.humanActions).toHaveLength(1);
    expect(view.humanActions[0]?.key).toBeUndefined();
    expect(view.humanActions[0]?.type).toBe('keypress');
  });

  it('drops an invalid/oversized key (lowercase-first, digit-first, or over the 32-char cap)', async () => {
    const { runId, broker } = setup();
    const id = await escalateToHuman(broker, runId);
    broker.recordHumanAction(id, keypressAction('enter'), 'capture'); // lowercase-first
    broker.recordHumanAction(id, keypressAction('1Enter'), 'capture'); // digit-first
    broker.recordHumanAction(id, keypressAction('A'.repeat(40)), 'capture'); // over the cap
    const view = broker.view(id);
    expect(view.humanActions).toHaveLength(3);
    for (const a of view.humanActions) expect(a.key).toBeUndefined();
  });

  it('drops key for every non-keypress type, even a syntactically valid named key', async () => {
    const { runId, broker } = setup();
    const id = await escalateToHuman(broker, runId);
    const raw = { ...clickAction('Acknowledge'), key: 'Enter' } as HumanAction;
    broker.recordHumanAction(id, raw, 'capture');
    expect(broker.view(id).humanActions[0]?.key).toBeUndefined();
  });

  it('drops the key when it equals a registered secret value (scrubbing changed it), keeping the rest of the action', async () => {
    const { runId, broker } = setup({ secretValues: () => ['Ctrlq'] });
    const id = await escalateToHuman(broker, runId);
    // 'Ctrlq' passes the named-key shape (letter, then alnum) but is a registered secret.
    broker.recordHumanAction(id, keypressAction('Ctrlq'), 'capture');
    const view = broker.view(id);
    expect(view.humanActions).toHaveLength(1);
    expect(view.humanActions[0]?.key).toBeUndefined();
    expect(JSON.stringify(view.humanActions)).not.toContain('Ctrlq');
  });

  it('keeps a named key unaffected by scrubbing when it does not match any registered secret', async () => {
    const { runId, broker } = setup({ secretValues: () => ['hunter2'] });
    const id = await escalateToHuman(broker, runId);
    broker.recordHumanAction(id, keypressAction('Enter'), 'capture');
    expect(broker.view(id).humanActions[0]?.key).toBe('Enter');
  });
});

// ---------------------------------------------------------------------------------------------
// leaseMs
// ---------------------------------------------------------------------------------------------

describe('SessionBroker.leaseMs', () => {
  it('defaults to 900000', () => {
    const { broker } = setup();
    expect(broker.leaseMs).toBe(900_000);
  });

  it('reflects interventionLeaseMs', () => {
    const { broker } = setup({ interventionLeaseMs: 12_345 });
    expect(broker.leaseMs).toBe(12_345);
  });
});

// ---------------------------------------------------------------------------------------------
// onHumanAction
// ---------------------------------------------------------------------------------------------

describe('SessionBroker.onHumanAction', () => {
  it('fires once per accepted action from a capture source, with the sanitized action', async () => {
    const { runId, broker } = setup();
    const id = await escalateToHuman(broker, runId);
    const events: HumanActionEvent[] = [];
    broker.onHumanAction((e) => events.push(e));

    broker.recordHumanAction(id, clickAction('Acknowledge'), 'capture');
    broker.recordHumanAction(id, inputAction(), 'capture');

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ interventionId: id, runId, source: 'capture' });
    expect(events[0]?.action.type).toBe('click');

    // The input action's sanitized shape: no `value`, no `target.text`, `valueRedacted: true`.
    const inputEvent = events[1]!;
    expect(inputEvent.action.type).toBe('input');
    expect(inputEvent.action.valueRedacted).toBe(true);
    expect(inputEvent.action.target.text).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(inputEvent.action, 'value')).toBe(false);
  });

  it('fires for a scripted-operator source too', async () => {
    const { runId, broker } = setup();
    const id = await escalateToHuman(broker, runId);
    const events: HumanActionEvent[] = [];
    broker.onHumanAction((e) => events.push(e));

    broker.recordHumanAction(id, clickAction('Acknowledge'), 'scripted-operator');

    expect(events).toHaveLength(1);
    expect(events[0]?.source).toBe('scripted-operator');
  });

  it('does not fire for a dropped (malformed) action', async () => {
    const { runId, broker } = setup();
    const id = await escalateToHuman(broker, runId);
    const events: HumanActionEvent[] = [];
    broker.onHumanAction((e) => events.push(e));

    const malformed = { ts: 'not-a-date', type: 'click', frame: [], target: {} } as unknown as HumanAction;
    broker.recordHumanAction(id, malformed, 'capture');

    expect(events).toHaveLength(0);
    expect(broker.view(id).humanActions).toHaveLength(0);
  });

  it('unsubscribe stops delivery', async () => {
    const { runId, broker } = setup();
    const id = await escalateToHuman(broker, runId);
    const events: HumanActionEvent[] = [];
    const unsubscribe = broker.onHumanAction((e) => events.push(e));

    broker.recordHumanAction(id, clickAction('Acknowledge'), 'capture');
    unsubscribe();
    broker.recordHumanAction(id, clickAction('Acknowledge'), 'capture');

    expect(events).toHaveLength(1);
    expect(broker.view(id).humanActions).toHaveLength(2); // recording itself is unaffected
  });

  it('a throwing listener does not prevent storage, the human_action event, or other listeners', async () => {
    const { runId, broker } = setup();
    const id = await escalateToHuman(broker, runId);
    const events: HumanActionEvent[] = [];
    broker.onHumanAction(() => {
      throw new Error('boom');
    });
    broker.onHumanAction((e) => events.push(e));

    expect(() => broker.recordHumanAction(id, clickAction('Acknowledge'), 'capture')).not.toThrow();

    expect(events).toHaveLength(1);
    expect(broker.view(id).humanActions).toHaveLength(1);
  });

  it('mutating the event\'s action does not change broker.view(id).humanActions', async () => {
    const { runId, broker } = setup();
    const id = await escalateToHuman(broker, runId);
    let captured: HumanActionEvent | undefined;
    broker.onHumanAction((e) => {
      captured = e;
    });

    broker.recordHumanAction(id, clickAction('Acknowledge'), 'capture');
    expect(captured).toBeDefined();
    captured!.action.target.name = 'tampered';
    (captured!.action as { type: string }).type = 'input';

    const stored = broker.view(id).humanActions[0]!;
    expect(stored.target.name).toBe('Acknowledge');
    expect(stored.type).toBe('click');
  });
});
