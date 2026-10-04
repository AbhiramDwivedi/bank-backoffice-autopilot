/**
 * The hand-back copy helpers (src/ui/labels.ts), tested as plain functions: no browser, so these
 * run wherever the relay project runs, unlike relay.browser.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { RetryResumeHint } from '../../src/shared/api.js';
import { continuedWithLabel, nextStepHelp, repeatsCopy, retryOptionCopy, retryResumeOf } from '../../src/ui/labels.js';

const AFTER_SIGN_IN = { stepId: 's05', stepName: 'Enter the member ID' };
const WHY = 'resuming at "s05" would run irreversible step "s06" again: its action has already been carried out in this run';
const BLOCKED = { stepId: 's06', stepName: 'Post the transfer' };

describe('retryResumeOf', () => {
  it('reads the hint and drops what is not well formed', () => {
    expect(retryResumeOf({})).toBeUndefined();
    expect(retryResumeOf({ context: { retryResume: 'nope' } })).toBeUndefined();
    expect(retryResumeOf({ context: { retryResume: { stepName: 'no id' } } })).toBeUndefined();
    expect(
      retryResumeOf({
        context: { retryResume: { ...AFTER_SIGN_IN, repeats: [BLOCKED, { stepName: 'no id' }, 7], refused: WHY, blockedBy: BLOCKED, retryRuns: 'failing_step', extra: 1 } },
      }),
    ).toEqual({ ...AFTER_SIGN_IN, repeats: [BLOCKED], refused: WHY, blockedBy: BLOCKED, retryRuns: 'failing_step' });
    expect(retryResumeOf({ context: { retryResume: { stepId: 's05', retryRuns: 'everything' } } })).toEqual({ stepId: 's05' });
  });

  it('shortens long ids and names', () => {
    const hint = retryResumeOf({ context: { retryResume: { stepId: 'x'.repeat(500) } } });
    expect(hint?.stepId.length).toBe(121);
  });
});

describe('retryOptionCopy', () => {
  it('no hint: a plain retry, or for the success check, a check again', () => {
    expect(retryOptionCopy(undefined)).toEqual({ label: 'Retry this step' });
    expect(retryOptionCopy(undefined, { hasStep: false })).toEqual({ label: 'Check the result again' });
  });

  it('a lost session: start again after sign-in, and leave the app on the screen shown right after it', () => {
    const copy = retryOptionCopy(AFTER_SIGN_IN);
    expect(copy.label).toBe('Start again after sign-in');
    expect(copy.help).toContain('step s05 (“Enter the member ID”), the first step after sign-in');
    expect(copy.help).toContain('leave the app on the screen shown right after sign-in');
    expect(retryOptionCopy(AFTER_SIGN_IN, { hasStep: false }).help).not.toContain('this step');
  });

  it('a refused restart with the failing step left to run: says up front that only this step runs, and why', () => {
    const copy = retryOptionCopy({ ...AFTER_SIGN_IN, refused: WHY, blockedBy: BLOCKED, retryRuns: 'failing_step' });
    expect(copy.label).toBe('Retry only this step');
    expect(copy.help).toContain('Automation will re-run only this step');
    expect(copy.help).toContain('step s06 (“Post the transfer”) already ran and must not run again');
    expect(copy.help).toContain('bring the app back to the screen this step expects');
    expect(copy.help).not.toContain('I completed this step');
  });

  it('a refused restart at the success check: never says "this step"', () => {
    const copy = retryOptionCopy({ ...AFTER_SIGN_IN, refused: WHY, blockedBy: BLOCKED, retryRuns: 'success_check' }, { hasStep: false });
    expect(copy.label).toBe('Check the result again');
    expect(copy.help).toContain('only check the result again');
    expect(copy.help).not.toContain('this step');
    expect(copy.help).not.toContain('I completed this step');
  });

  it('refused outright (the failing step itself already ran): says so, and abort is the other way out', () => {
    const copy = retryOptionCopy({ ...AFTER_SIGN_IN, refused: WHY, blockedBy: BLOCKED });
    expect(copy.label).toBe('Retry this step');
    expect(copy.help).toContain(`Automation will refuse this: ${WHY}`);
    expect(copy.help).toContain('abort the run');
  });
});

describe('repeatsCopy, nextStepHelp, continuedWithLabel', () => {
  const repeating: RetryResumeHint = { ...AFTER_SIGN_IN, repeats: [AFTER_SIGN_IN, BLOCKED] };

  it('lists the steps that run again, only for an accepted restart', () => {
    expect(repeatsCopy(repeating)).toEqual({
      intro: 'These steps already ran and will run again:',
      steps: ['step s05 (“Enter the member ID”)', 'step s06 (“Post the transfer”)'],
    });
    expect(repeatsCopy(AFTER_SIGN_IN)).toBeUndefined();
    expect(repeatsCopy({ ...repeating, refused: WHY, retryRuns: 'failing_step' })).toBeUndefined();
  });

  it('cautions "I completed this step" after a lost session, naming the retry option as it reads', () => {
    expect(nextStepHelp(undefined)).toBeUndefined();
    expect(nextStepHelp(AFTER_SIGN_IN)).toContain('choose “Start again after sign-in”');
    expect(nextStepHelp({ ...AFTER_SIGN_IN, refused: WHY, retryRuns: 'failing_step' })).toContain('choose “Retry only this step”');
    expect(nextStepHelp({ ...AFTER_SIGN_IN, refused: WHY })).toBeUndefined();
    expect(nextStepHelp(AFTER_SIGN_IN, { hasStep: false })).toBeUndefined();
  });

  it('says what the round continued with', () => {
    expect(continuedWithLabel({ resumeFrom: 'abort' }, AFTER_SIGN_IN)).toBe('Nothing: run aborted');
    expect(continuedWithLabel({ resumeFrom: 'next_step' }, AFTER_SIGN_IN)).toBe('The next step');
    expect(continuedWithLabel({ resumeFrom: 'current_step' }, undefined)).toBe('Retry this step');
    expect(continuedWithLabel({ resumeFrom: 'current_step' }, AFTER_SIGN_IN)).toBe('Start again after sign-in, at step s05');
    expect(continuedWithLabel({ resumeFrom: 'current_step' }, { ...AFTER_SIGN_IN, refused: WHY, retryRuns: 'failing_step' })).toBe('Retry only this step');
    expect(continuedWithLabel({ resumeFrom: 'current_step' }, { ...AFTER_SIGN_IN, refused: WHY })).toBe('Retry this step (automation refused it)');
  });
});
