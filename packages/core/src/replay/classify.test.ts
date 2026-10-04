import { describe, expect, it } from 'vitest';
import type { Condition } from '../schema/index.js';
import { FakeSurface, scenario } from '../surface/index.js';
import type { Surface } from '../surface/types.js';
import { classifyFailure, matchSignal } from './classify.js';
import { DEFAULT_APP_ERROR_SIGNALS, DEFAULT_SESSION_EXPIRED_SIGNALS, type ClassifyContext, type FailureSignal } from './types.js';

function makeContext(surface: Surface, overrides: Partial<ClassifyContext> = {}): ClassifyContext {
  return {
    surface,
    sessionExpiredSignals: DEFAULT_SESSION_EXPIRED_SIGNALS,
    appErrorSignals: DEFAULT_APP_ERROR_SIGNALS,
    ...overrides,
  };
}

function baseSignal(overrides: Partial<FailureSignal> = {}): FailureSignal {
  return {
    code: 'checkpoint_failed',
    expected: 'the results table to show a row',
    observed: '',
    message: 'postcondition not met within timeout',
    ...overrides,
  };
}

/** Hand-written stub Surface: records every method invoked, so tests can assert on call
 * counts/order without a full FakeSurface scenario. Only `check`/`observe` return meaningful
 * data; everything else throws if actually invoked (classify.ts never calls them). */
function counterSurface(calls: string[], opts: { dialogOpen?: boolean; textDigest?: string; throwOn?: 'check' | 'observe' } = {}): Surface {
  const notUsed = async (): Promise<never> => {
    throw new Error('classify.ts should not call this Surface method');
  };
  return {
    async observe() {
      calls.push('observe');
      if (opts.throwOn === 'observe') throw new Error('boom: observe');
      return {
        url: 'http://x/',
        title: 't',
        screenshotPng: Buffer.from(''),
        elements: [],
        frames: [],
        textDigest: opts.textDigest ?? '',
      };
    },
    resolve: notUsed,
    act: notUsed,
    readText: notUsed,
    async check(condition: Condition) {
      calls.push('check');
      if (opts.throwOn === 'check') throw new Error('boom: check');
      if (condition.kind === 'dialog_open') return opts.dialogOpen ?? false;
      return false;
    },
    waitFor: notUsed,
    async screenshot() {
      return Buffer.from('');
    },
    domSnapshot: notUsed,
    async currentUrl() {
      return 'http://x/';
    },
    async close() {},
  };
}

function surfaceWithText(text: string): FakeSurface {
  const built = scenario().screen('s', { url: 'http://x/s', title: 'S', text: [text], elements: [] }).build();
  return new FakeSurface(built);
}

describe('classifyFailure', () => {
  describe('NON_PAGE_CODES', () => {
    it.each(['policy_violation', 'input_validation', 'internal'] as const)('%s is returned unchanged with zero surface calls', async (code) => {
      const calls: string[] = [];
      const signal = baseSignal({ code, message: 'm', observed: 'o' });
      const result = await classifyFailure(makeContext(counterSurface(calls)), signal);
      expect(result).toEqual(signal);
      expect(calls).toEqual([]);
    });
  });

  it('dialog wins over matching page text (ordering): observe() is never called', async () => {
    const calls: string[] = [];
    const surface = counterSurface(calls, { dialogOpen: true, textDigest: 'Your session has expired. Click here to log in.' });
    const signal = baseSignal();
    const result = await classifyFailure(makeContext(surface), signal);
    expect(result.code).toBe('unexpected_dialog');
    expect(result.originalCode).toBe('checkpoint_failed');
    expect(calls).toEqual(['check']);
  });

  it('dialog branch: observed is the fixed phrase, message names the original code, no textExcerpt', async () => {
    const calls: string[] = [];
    const surface = counterSurface(calls, { dialogOpen: true });
    const signal = baseSignal({ code: 'element_not_found', message: 'row not found', observed: 'tried role, label' });
    const result = await classifyFailure(makeContext(surface), signal);
    expect(result.code).toBe('unexpected_dialog');
    expect(result.originalCode).toBe('element_not_found');
    expect(result.observed).toBe('a native dialog is open');
    expect(result.message).toContain('element_not_found');
    expect(result.message).toContain('row not found');
    expect(result.textExcerpt).toBeUndefined();
  });

  it('dialog branch: a signal that is already unexpected_dialog keeps its own message/observed, no originalCode', async () => {
    const calls: string[] = [];
    const surface = counterSurface(calls, { dialogOpen: true });
    const signal = baseSignal({ code: 'unexpected_dialog', message: 'surface reported a dialog', observed: 'surface-native observed' });
    const result = await classifyFailure(makeContext(surface), signal);
    expect(result.code).toBe('unexpected_dialog');
    expect(result.originalCode).toBeUndefined();
    expect(result.message).toBe('surface reported a dialog');
    expect(result.observed).toBe('a native dialog is open');
  });

  it('dialog via a real FakeSurface (inject + act) is detected the same way', async () => {
    const surface = surfaceWithText('a neutral page');
    surface.inject({ kind: 'dialog', dialog: { type: 'alert', message: 'Are you sure?' } });
    const actResult = await surface.act({ type: 'press', key: 'Enter' }, 1000);
    expect(actResult.ok).toBe(true);

    const result = await classifyFailure(makeContext(surface), baseSignal());
    expect(result.code).toBe('unexpected_dialog');
    expect(result.observed).toBe('a native dialog is open');
  });

  it('session_expired: page text matches a session-expired signal (FakeSurface scenario)', async () => {
    const surface = surfaceWithText('Your session has expired. Click here to log in.');
    const signal = baseSignal({ code: 'checkpoint_failed', message: 'postcondition not met' });
    const result = await classifyFailure(makeContext(surface), signal);
    expect(result.code).toBe('session_expired');
    expect(result.originalCode).toBe('checkpoint_failed');
    expect(result.message).toBe('session expired (page shows "Your session has expired") while postcondition not met');
    expect(result.observed).toBe(result.textExcerpt);
    expect(result.textExcerpt).toContain('Your session has expired');
  });

  it('app_error: page text matches an app-error signal (FakeSurface scenario)', async () => {
    const surface = surfaceWithText('Application Error ORA-01017: unable to process request.');
    const signal = baseSignal({ code: 'checkpoint_failed', message: 'postcondition not met' });
    const result = await classifyFailure(makeContext(surface), signal);
    expect(result.code).toBe('app_error');
    expect(result.originalCode).toBe('checkpoint_failed');
    expect(result.message).toBe('app error (page shows "Application Error") while postcondition not met');
    expect(result.observed).toBe(result.textExcerpt);
    expect(result.matchedSignal).toBe('Application Error');
  });

  it('matchedSignal tells an app_error read from the page from one the surface reported for a control it could not operate', async () => {
    const reported = baseSignal({ code: 'app_error', message: "element 'Search' is disabled" });
    // The page shows the error too: same code, no rewrite, but the signal is recorded.
    const onErrorPage = await classifyFailure(makeContext(surfaceWithText('Application Error ORA-01017')), reported);
    expect(onErrorPage.code).toBe('app_error');
    expect(onErrorPage.originalCode).toBeUndefined();
    expect(onErrorPage.message).toBe("element 'Search' is disabled");
    expect(onErrorPage.matchedSignal).toBe('Application Error');
    // An ordinary page: the code is only what the surface said.
    const onOrdinaryPage = await classifyFailure(makeContext(surfaceWithText('Member Search')), reported);
    expect(onOrdinaryPage.code).toBe('app_error');
    expect(onOrdinaryPage.matchedSignal).toBeUndefined();
  });

  it('app_error signal ordering: session-expired signals are checked first, so an app-error page with no session text still classifies as app_error', async () => {
    const surface = surfaceWithText('ORA-01017: division by zero');
    const result = await classifyFailure(makeContext(surface), baseSignal());
    expect(result.code).toBe('app_error');
  });

  it('neutral page + checkpoint_failed with empty observed: observed becomes the page-text excerpt', async () => {
    const surface = surfaceWithText('Welcome back, please continue with your work.');
    const signal = baseSignal({ code: 'checkpoint_failed', observed: '' });
    const result = await classifyFailure(makeContext(surface), signal);
    expect(result.code).toBe('checkpoint_failed');
    expect(result.originalCode).toBeUndefined();
    expect(result.observed).toBe(`page text: "${result.textExcerpt}"`);
  });

  it('neutral page + checkpoint_failed with non-empty observed: excerpt is appended', async () => {
    const surface = surfaceWithText('Welcome back, please continue with your work.');
    const signal = baseSignal({ code: 'checkpoint_failed', observed: 'tried role: no match' });
    const result = await classifyFailure(makeContext(surface), signal);
    expect(result.observed).toBe(`tried role: no match; page text: "${result.textExcerpt}"`);
  });

  it('neutral page + a non-checkpoint_failed code: textExcerpt is set but observed/message are untouched', async () => {
    const surface = surfaceWithText('Welcome back, please continue with your work.');
    const signal = baseSignal({ code: 'element_not_found', observed: 'tried role, label, text', message: 'target not found' });
    const result = await classifyFailure(makeContext(surface), signal);
    expect(result.code).toBe('element_not_found');
    expect(result.observed).toBe('tried role, label, text');
    expect(result.message).toBe('target not found');
    expect(result.textExcerpt).toBeDefined();
  });

  it('excerpt centering: a long neutral page excerpt starts at the beginning and is capped at 300 chars', async () => {
    const long = `${'x'.repeat(50)} PADDING ${'y'.repeat(500)}`;
    const surface = surfaceWithText(long);
    const result = await classifyFailure(makeContext(surface), baseSignal({ code: 'element_not_found' }));
    expect(result.textExcerpt).toHaveLength(300);
    expect(result.textExcerpt?.startsWith('x'.repeat(50))).toBe(true);
  });

  it('excerpt centering: a matched signal is centred in the excerpt window when the page is long', async () => {
    const long = `${'a'.repeat(500)} Your session has expired. Click here to log in. ${'b'.repeat(500)}`;
    const surface = surfaceWithText(long);
    const result = await classifyFailure(makeContext(surface), baseSignal());
    expect(result.code).toBe('session_expired');
    expect(result.textExcerpt).toHaveLength(300);
    expect(result.textExcerpt).toContain('Your session has expired');
    // Not anchored at the very start or the very end: both padding characters appear.
    expect(result.textExcerpt).toContain('a');
    expect(result.textExcerpt).toContain('b');
  });

  it('surface throwing on check() during classification returns the original signal unchanged', async () => {
    const calls: string[] = [];
    const surface = counterSurface(calls, { throwOn: 'check' });
    const signal = baseSignal({ code: 'element_not_found', message: 'm', observed: 'o' });
    const result = await classifyFailure(makeContext(surface), signal);
    expect(result).toEqual(signal);
  });

  it('surface throwing on observe() during classification returns the original signal unchanged', async () => {
    const calls: string[] = [];
    const surface = counterSurface(calls, { throwOn: 'observe' });
    const signal = baseSignal({ code: 'element_not_found', message: 'm', observed: 'o' });
    const result = await classifyFailure(makeContext(surface), signal);
    expect(result).toEqual(signal);
  });
});

describe('matchSignal', () => {
  it('is case-insensitive', () => {
    expect(matchSignal('YOUR SESSION HAS EXPIRED now', ['Your session has expired'])).toBe('Your session has expired');
  });

  it('returns undefined when nothing matches', () => {
    expect(matchSignal('a perfectly normal page', DEFAULT_SESSION_EXPIRED_SIGNALS)).toBeUndefined();
  });

  it('returns the first signal in the list that matches, in list order', () => {
    const signals = ['zzz-not-present', 'ORA-', 'Application Error'];
    expect(matchSignal('Application Error ORA-01017', signals)).toBe('ORA-');
  });
});
