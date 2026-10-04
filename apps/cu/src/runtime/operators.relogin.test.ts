/**
 * The generic `relogin` scripted operator against the in-memory CU Core surface: it re-runs the
 * capability's own sign-in, from its explicit `auth` block or the same steps derived at run time,
 * binds the secrets from the run's CredentialSet, waits for the signed-in condition, then hands
 * back asking replay to resume at the first step after the sign-in (decideReloginHandBack), and
 * aborts when replay refuses that resume point. Nothing here names a mock-app field: the steps come from the
 * artifact. The e2e counterpart (real Chromium, real mock app, the shipped recorded artifact) is
 * tests/e2e/replay-handoff-policy.test.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCuCoreSurface, type Clock, type FakeSurface } from '@cu/core/surface';
import { createRunLogger, newRunId } from '@cu/core/evidence';
import { createSessionBroker } from '@cu/core/session';
import { credentialSet, EMPTY_CREDENTIALS, type CredentialSet } from '@cu/core/credentials';
import type { Capability } from '@cu/core/schema';
import { RELOGIN_REFUSED_NOTE, attachAutoOperator } from './operators.js';

const BASE = 'http://localhost:4173';
const PASSWORD = 'demo-pass-123';
const GOOD = credentialSet({ MOCK_USER: 'operator1', MOCK_PASSWORD: PASSWORD });
const EXAMPLE = JSON.parse(fs.readFileSync('artifacts/examples/lookup-member-savings-balance.example.json', 'utf8')) as Capability;

/** Advances time on every sleep with no real delay, so a condition that never holds fails at once. */
function fakeClock(): Clock {
  let now = 0;
  return {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A session-expiry escalation at `stepId` on a surface parked on the session-expired page, handled by the relogin operator. */
async function relogin(o: {
  capability: unknown;
  stepId: string | undefined;
  credentials?: CredentialSet;
  replay?: false;
  reason?: { code: 'unrecoverable_condition' | 'policy_block'; message: string };
}): Promise<{ resumeFrom: string; resumeAtStepId: string | undefined; notes: string; surface: FakeSurface }> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-test-'));
  dirs.push(rootDir);
  const surface = createCuCoreSurface({ interstitial: false, clock: fakeClock() });
  await surface.act({ type: 'navigate', url: `${BASE}/session-expired` }, 1000);
  const runId = newRunId();
  const logger = createRunLogger({ runId, runKind: 'replay', rootDir });
  const broker = createSessionBroker({ surface, logger, runId, runKind: 'replay' });
  const op = attachAutoOperator(broker, 'relogin', {
    baseUrl: BASE,
    ...(o.replay === false ? {} : { replay: { capability: o.capability, inputs: { memberId: '12345' } } }),
    ...(o.credentials !== undefined ? { credentials: o.credentials } : {}),
  });
  try {
    const r = await broker.escalate({
      runId,
      runKind: 'replay',
      ...(o.stepId !== undefined ? { stepId: o.stepId } : {}),
      reason: o.reason ?? { code: 'unrecoverable_condition', message: 'session expired' },
      screenshotPng: Buffer.alloc(0),
      currentUrl: `${BASE}/session-expired`,
    });
    return { resumeFrom: r.resumeFrom, resumeAtStepId: r.resumeAtStepId, notes: r.notes ?? '', surface };
  } finally {
    op?.stop();
    await op?.idle();
    broker.dispose();
  }
}

function withoutAuth(cap: Capability): Capability {
  const copy = structuredClone(cap);
  delete copy.auth;
  return copy;
}

describe('relogin: re-runs the capability\'s own sign-in, then resumes at the first step after it', () => {
  it('explicit auth block (the example), expiry on the sign-on step s04: signs in, and resumes at s05', async () => {
    const { resumeFrom, resumeAtStepId, notes, surface } = await relogin({ capability: EXAMPLE, stepId: 's04', credentials: GOOD });
    expect(resumeFrom).toBe('current_step');
    expect(resumeAtStepId).toBe('s05');
    expect(notes).toContain('explicit sign-in steps (s01, s02, s03, s04)');
    expect(notes).toContain('resuming at s05, the first step after the sign-in');
    expect(await surface.currentUrl()).toBe(`${BASE}/workstation`);
  });

  it('derived (the same artifact without the block): identical steps, identical resume point', async () => {
    const { resumeFrom, resumeAtStepId, notes } = await relogin({ capability: withoutAuth(EXAMPLE), stepId: 's04', credentials: GOOD });
    expect(resumeFrom).toBe('current_step');
    expect(resumeAtStepId).toBe('s05');
    expect(notes).toContain('derived sign-in steps (s01, s02, s03, s04)');
  });

  it('derived with no checkpoint on the sign-on (like the recorded artifact), expiry on typing the member id: the password field being gone proves the sign-in, and the run resumes at that step', async () => {
    const cap = withoutAuth(EXAMPLE);
    delete cap.steps[3]!.postcondition; // s04 sign on
    delete cap.steps[4]!.precondition; // s05 type the member id
    const { resumeFrom, resumeAtStepId, notes, surface } = await relogin({ capability: cap, stepId: 's05', credentials: GOOD });
    expect(resumeFrom).toBe('current_step');
    expect(resumeAtStepId).toBe('s05');
    expect(notes).toContain('derived sign-in steps (s01, s02, s03, s04)');
    expect(await surface.currentUrl()).toBe(`${BASE}/workstation`);
  });

  it('expiry on the search click, after the member id was typed: rewinds to s05, so the id is typed again', async () => {
    const { resumeFrom, resumeAtStepId, notes } = await relogin({ capability: EXAMPLE, stepId: 's06', credentials: GOOD });
    expect(resumeFrom).toBe('current_step');
    expect(resumeAtStepId).toBe('s05');
    expect(notes).toContain('the expiry hit s06');
    expect(notes).not.toMatch(/12345|operator1|demo-pass-123/);
  });

  it('a stepless escalation (the final success check): the same rewind', async () => {
    const { resumeFrom, resumeAtStepId, notes } = await relogin({ capability: EXAMPLE, stepId: undefined, credentials: GOOD });
    expect(resumeFrom).toBe('current_step');
    expect(resumeAtStepId).toBe('s05');
    expect(notes).toContain('final success check');
  });
});

describe('relogin: replay refused the resume point', () => {
  it('aborts with a value-free note saying a human must take over, without signing in again to guess', async () => {
    const { resumeFrom, resumeAtStepId, notes, surface } = await relogin({
      capability: EXAMPLE,
      stepId: 's06',
      credentials: GOOD,
      // What replay raises after refusing: the original session-expiry message is still quoted in it.
      reason: { code: 'policy_block', message: 'replay refused the resume point it was handed (...). The failure being resolved: session expired' },
    });
    expect(resumeFrom).toBe('abort');
    expect(resumeAtStepId).toBeUndefined();
    expect(notes).toBe(RELOGIN_REFUSED_NOTE);
    expect(notes).toMatch(/a human must take over/);
    expect(notes).not.toMatch(/12345|operator1|demo-pass-123/);
    expect(await surface.currentUrl()).toBe(`${BASE}/session-expired`);
  });
});

describe('relogin: aborts with a clear, value-free note', () => {
  it('when no sign-in can be derived (here: no entry navigation to start it from)', async () => {
    const cap = withoutAuth(EXAMPLE);
    cap.steps = cap.steps.slice(1);
    const { resumeFrom, notes } = await relogin({ capability: cap, stepId: 's04', credentials: GOOD });
    expect(resumeFrom).toBe('abort');
    expect(notes).toMatch(/has no auth block, and no sign-in can be derived/);
  });

  it('when there is no replay context at all (discovery)', async () => {
    const { resumeFrom, notes } = await relogin({ capability: EXAMPLE, stepId: 's04', credentials: GOOD, replay: false });
    expect(resumeFrom).toBe('abort');
    expect(notes).toMatch(/no valid capability/);
  });

  it('when a credential the sign-in binds is not in the run\'s set: names it, never a value', async () => {
    const { resumeFrom, notes } = await relogin({ capability: EXAMPLE, stepId: 's04', credentials: credentialSet({ MOCK_USER: 'operator1' }) });
    expect(resumeFrom).toBe('abort');
    expect(notes).toContain('MOCK_PASSWORD');
    expect(notes).not.toContain('operator1');
  });

  it('when no credentials were supplied at all (no fallback to the process environment)', async () => {
    process.env.MOCK_PASSWORD ??= PASSWORD;
    const { resumeFrom, notes } = await relogin({ capability: EXAMPLE, stepId: 's04', credentials: EMPTY_CREDENTIALS });
    expect(resumeFrom).toBe('abort');
    expect(notes).toContain('MOCK_USER');
  });

  it('when the app rejects the credentials: the checkpoint fails, and the wrong password is not in the note', async () => {
    const wrong = credentialSet({ MOCK_USER: 'operator1', MOCK_PASSWORD: 'not-the-password-xyz' });
    const { resumeFrom, notes, surface } = await relogin({ capability: EXAMPLE, stepId: 's04', credentials: wrong });
    expect(resumeFrom).toBe('abort');
    expect(notes).toMatch(/s04/);
    expect(notes).not.toContain('not-the-password-xyz');
    expect(await surface.currentUrl()).toBe(`${BASE}/login`);
  });

  it('derived "form is gone" does not hold after a rejected login, because the form re-renders', async () => {
    const cap = withoutAuth(EXAMPLE);
    delete cap.steps[3]!.postcondition; // derived condition = the password field is gone
    const wrong = credentialSet({ MOCK_USER: 'operator1', MOCK_PASSWORD: 'not-the-password-xyz' });
    const { resumeFrom, notes } = await relogin({ capability: cap, stepId: 's05', credentials: wrong });
    expect(resumeFrom).toBe('abort');
    expect(notes).toMatch(/signed-in condition did not hold/);
    expect(notes).not.toContain('not-the-password-xyz');
  });
});
