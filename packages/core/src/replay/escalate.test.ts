import { describe, expect, it } from 'vitest';
import type { Surface } from '../surface/types.js';
import { buildEscalationRequest, interventionReasonFor, shouldEscalate } from './escalate.js';
import { createValueScrubber } from '../evidence/index.js';
import type { Scrubber, StepFailure } from './types.js';
import { DEFAULT_ESCALATE_ON } from './types.js';

function makeScrubber(): Scrubber {
  return createValueScrubber();
}

function makeSurfaceStub(opts: { screenshot?: () => Promise<Buffer>; currentUrl?: () => Promise<string> } = {}): Surface {
  const notUsed = async (): Promise<never> => {
    throw new Error('not exercised by these tests');
  };
  return {
    observe: notUsed,
    resolve: notUsed,
    act: notUsed,
    readText: notUsed,
    check: notUsed,
    waitFor: notUsed,
    screenshot: opts.screenshot ?? (async () => Buffer.from('fake-png-bytes')),
    domSnapshot: notUsed,
    currentUrl: opts.currentUrl ?? (async () => 'http://x/current'),
    close: async () => {},
  };
}

function baseFailure(overrides: Partial<StepFailure> = {}): StepFailure {
  return {
    code: 'checkpoint_failed',
    expected: 'the confirmation screen',
    observed: 'still on the form',
    message: 'postcondition not met within timeout',
    stepId: 's07',
    stepName: 'Open the matching result',
    evidence: { screenshot: 'shots/12.png', dom: 'dom/12.html' },
    ...overrides,
  };
}

describe('shouldEscalate', () => {
  it('is false when there is no handler, regardless of everything else', () => {
    expect(shouldEscalate({ onFailure: 'escalate', code: 'session_expired', escalateOn: ['session_expired'], hasHandler: false })).toBe(false);
  });

  it.each(['policy_violation', 'input_validation', 'internal'] as const)('is false for NON_PAGE_CODE %s even with onFailure escalate', (code) => {
    expect(shouldEscalate({ onFailure: 'escalate', code, escalateOn: DEFAULT_ESCALATE_ON, hasHandler: true })).toBe(false);
  });

  it('is true when the step declares onFailure escalate', () => {
    expect(shouldEscalate({ onFailure: 'escalate', code: 'checkpoint_failed', escalateOn: [], hasHandler: true })).toBe(true);
  });

  it('is true when the code is in escalateOn even with onFailure fail', () => {
    expect(shouldEscalate({ onFailure: 'fail', code: 'unexpected_dialog', escalateOn: DEFAULT_ESCALATE_ON, hasHandler: true })).toBe(true);
  });

  it('is true when the code is in escalateOn and onFailure is omitted', () => {
    expect(shouldEscalate({ code: 'session_expired', escalateOn: DEFAULT_ESCALATE_ON, hasHandler: true })).toBe(true);
  });

  it('is false when onFailure is fail (or omitted) and the code is not in escalateOn', () => {
    expect(shouldEscalate({ onFailure: 'fail', code: 'checkpoint_failed', escalateOn: DEFAULT_ESCALATE_ON, hasHandler: true })).toBe(false);
    expect(shouldEscalate({ code: 'element_not_found', escalateOn: DEFAULT_ESCALATE_ON, hasHandler: true })).toBe(false);
  });
});

describe('interventionReasonFor', () => {
  it("maps 'unexpected_dialog' to itself", () => {
    expect(interventionReasonFor('unexpected_dialog')).toBe('unexpected_dialog');
  });

  it.each(['session_expired', 'app_error', 'checkpoint_failed', 'timeout', 'element_not_found', 'navigation_failed'] as const)(
    "maps %s to 'unrecoverable_condition'",
    (code) => {
      expect(interventionReasonFor(code)).toBe('unrecoverable_condition');
    },
  );
});

describe('buildEscalationRequest', () => {
  it('carries runId, runKind, capabilityId, stepId, reason, screenshot and currentUrl', async () => {
    const surface = makeSurfaceStub();
    const scrubber = makeScrubber();
    const failure = baseFailure();

    const req = await buildEscalationRequest({ runId: 'run-1', capabilityId: 'lookup-member-savings-balance', failure, surface, scrubber });

    expect(req.runId).toBe('run-1');
    expect(req.runKind).toBe('replay');
    expect(req.capabilityId).toBe('lookup-member-savings-balance');
    expect(req.stepId).toBe('s07');
    expect(req.reason).toEqual({ code: 'unrecoverable_condition', message: failure.message });
    expect(req.screenshotPng).toBeInstanceOf(Buffer);
    expect(req.currentUrl).toBe('http://x/current');
  });

  it('reason.code is unexpected_dialog for that failure code', async () => {
    const failure = baseFailure({ code: 'unexpected_dialog', message: 'a native dialog is open' });
    const req = await buildEscalationRequest({
      runId: 'run-1',
      capabilityId: 'cap',
      failure,
      surface: makeSurfaceStub(),
      scrubber: makeScrubber(),
    });
    expect(req.reason.code).toBe('unexpected_dialog');
  });

  it('omits stepId when the failure has none', async () => {
    const failure = baseFailure({ stepId: undefined, stepName: undefined });
    const req = await buildEscalationRequest({
      runId: 'run-1',
      capabilityId: 'cap',
      failure,
      surface: makeSurfaceStub(),
      scrubber: makeScrubber(),
    });
    expect('stepId' in req).toBe(false);
  });

  it('omits screenshotPng when surface.screenshot() throws', async () => {
    const surface = makeSurfaceStub({
      screenshot: async () => {
        throw new Error('a dialog is open, cannot screenshot');
      },
    });
    const req = await buildEscalationRequest({ runId: 'run-1', capabilityId: 'cap', failure: baseFailure(), surface, scrubber: makeScrubber() });
    expect(req.screenshotPng).toBeUndefined();
    expect('screenshotPng' in req).toBe(false);
  });

  it('omits currentUrl when surface.currentUrl() throws', async () => {
    const surface = makeSurfaceStub({
      currentUrl: async () => {
        throw new Error('boom');
      },
    });
    const req = await buildEscalationRequest({ runId: 'run-1', capabilityId: 'cap', failure: baseFailure(), surface, scrubber: makeScrubber() });
    expect(req.currentUrl).toBeUndefined();
    expect('currentUrl' in req).toBe(false);
  });

  it('scrubs a registered secret out of both reason.message and context', async () => {
    const scrubber = makeScrubber();
    const secret = 'sup3r-Secret-Value';
    scrubber.add(secret);
    const failure = baseFailure({
      message: `checkpoint failed while account-number ${secret} was on screen`,
      observed: `page showed account ${secret} in a table cell`,
    });

    const req = await buildEscalationRequest({ runId: 'run-1', capabilityId: 'cap', failure, surface: makeSurfaceStub(), scrubber });

    expect(req.reason.message).not.toContain(secret);
    expect(req.reason.message).toContain('[REDACTED]');
    const contextJson = JSON.stringify(req.context);
    expect(contextJson).not.toContain(secret);
    expect(contextJson).toContain('[REDACTED]');
  });

  it('context includes expected/observed/code/evidence, and originalCode/stepName when present', async () => {
    const failure = baseFailure({ code: 'session_expired', originalCode: 'checkpoint_failed' });
    const req = await buildEscalationRequest({
      runId: 'run-1',
      capabilityId: 'cap',
      failure,
      surface: makeSurfaceStub(),
      scrubber: makeScrubber(),
    });
    expect(req.context).toEqual({
      expected: failure.expected,
      observed: failure.observed,
      code: 'session_expired',
      originalCode: 'checkpoint_failed',
      stepName: failure.stepName,
      evidence: failure.evidence,
    });
  });
});
