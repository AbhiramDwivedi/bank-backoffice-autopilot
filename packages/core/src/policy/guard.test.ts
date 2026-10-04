import { describe, expect, it } from 'vitest';
import type { Action } from '../schema/index.js';
import { DEFAULT_POLICY_PATH, loadPolicy, parsePolicy } from './load.js';
import { createPolicyGuard, type PolicyActionContext, type PolicyGuard } from './guard.js';

const DEFAULT_CTX: PolicyActionContext = { currentUrl: 'http://localhost:4173/workstation' };

function ctx(overrides: Partial<PolicyActionContext> = {}): PolicyActionContext {
  return { ...DEFAULT_CTX, ...overrides };
}

const defaultPolicy = loadPolicy(DEFAULT_POLICY_PATH);
const defaultGuard = createPolicyGuard(defaultPolicy);

function minimalPolicy() {
  return parsePolicy(`
name: test-policy
allowedOrigins: ['http://localhost:4173']
allowedPathPatterns: []
deniedPathPatterns: ['^/__faults', '^/__reset']
allowedActions: [navigate, click, type, select, press, extract, wait, dismiss_dialog, switch_frame]
risk:
  irreversibleTextPatterns:
    - '^(submit|confirm|create|open account|transfer|delete|approve|post)\\b'
  irreversibleUrlPatterns:
    - '/subaccounts$'
  discoveryMode: escalate
  replayRequiresApproved: true
redaction:
  patterns: []
limits:
  maxSteps: 40
  maxDurationMs: 600000
  maxLlmCalls: 60
`);
}

describe('createPolicyGuard: checkUrl', () => {
  const guard = createPolicyGuard(minimalPolicy());

  it('allows an allowed origin with no path restriction', () => {
    const result = guard.checkUrl('http://localhost:4173/members/search');
    expect(result.allowed).toBe(true);
  });

  it('denies a different port', () => {
    expect(guard.checkUrl('http://localhost:4174/members/search').allowed).toBe(false);
  });

  it('denies a different host', () => {
    expect(guard.checkUrl('http://evil.test/members/search').allowed).toBe(false);
  });

  it('denies a different scheme on the same host/port-ish origin', () => {
    expect(guard.checkUrl('https://localhost:4173/members/search').allowed).toBe(false);
  });

  it('denies /__faults and /__reset (denied wins over an otherwise-allowed origin)', () => {
    expect(guard.checkUrl('http://localhost:4173/__faults').allowed).toBe(false);
    expect(guard.checkUrl('http://localhost:4173/__reset').allowed).toBe(false);
    expect(guard.checkUrl('http://localhost:4173/__faults?x=1').allowed).toBe(false);
  });

  it('denied path patterns are case-insensitive', () => {
    expect(guard.checkUrl('http://localhost:4173/__FAULTS').allowed).toBe(false);
  });

  it('denies unparseable URLs', () => {
    expect(guard.checkUrl('not a url').allowed).toBe(false);
  });

  it('denies non-http(s) schemes: javascript:, data:, file:', () => {
    expect(guard.checkUrl('javascript:alert(1)').allowed).toBe(false);
    expect(guard.checkUrl('data:text/html,hi').allowed).toBe(false);
    expect(guard.checkUrl('file:///etc/passwd').allowed).toBe(false);
  });

  it('denies about:blank (not an allowed http(s) origin)', () => {
    expect(guard.checkUrl('about:blank').allowed).toBe(false);
  });

  it('with a non-empty allowedPathPatterns, only matching paths are allowed', () => {
    const restricted = createPolicyGuard(
      parsePolicy(`
name: restricted
allowedOrigins: ['http://localhost:4173']
allowedPathPatterns: ['^/members', '^/workstation$']
deniedPathPatterns: []
allowedActions: [navigate]
risk:
  irreversibleTextPatterns: []
  irreversibleUrlPatterns: []
  discoveryMode: block
  replayRequiresApproved: false
redaction:
  patterns: []
limits: { maxSteps: 10, maxDurationMs: 60000, maxLlmCalls: 5 }
`),
    );
    expect(restricted.checkUrl('http://localhost:4173/members/search').allowed).toBe(true);
    expect(restricted.checkUrl('http://localhost:4173/workstation').allowed).toBe(true);
    expect(restricted.checkUrl('http://localhost:4173/login').allowed).toBe(false);
  });

  it('denied still wins over a matching allowedPathPatterns entry', () => {
    const restricted = createPolicyGuard(
      parsePolicy(`
name: restricted
allowedOrigins: ['http://localhost:4173']
allowedPathPatterns: ['^/']
deniedPathPatterns: ['^/__faults']
allowedActions: [navigate]
risk:
  irreversibleTextPatterns: []
  irreversibleUrlPatterns: []
  discoveryMode: block
  replayRequiresApproved: false
redaction:
  patterns: []
limits: { maxSteps: 10, maxDurationMs: 60000, maxLlmCalls: 5 }
`),
    );
    expect(restricted.checkUrl('http://localhost:4173/__faults').allowed).toBe(false);
  });

  it('using the real default.yaml: both tenant origins allowed, fault routes denied', () => {
    expect(defaultGuard.checkUrl('http://localhost:4173/members/search').allowed).toBe(true);
    expect(defaultGuard.checkUrl('http://localhost:4174/members/search').allowed).toBe(true);
    expect(defaultGuard.checkUrl('http://localhost:4173/__faults').allowed).toBe(false);
    expect(defaultGuard.checkUrl('http://localhost:4173/__reset').allowed).toBe(false);
  });
});

describe('createPolicyGuard: classifyRisk', () => {
  const guard = defaultGuard;

  it('click on a target matching an irreversible text pattern -> irreversible ("Confirm")', () => {
    const action: Action = { type: 'click', target: { description: 'confirm', frame: [], locators: [{ strategy: { kind: 'text', text: 'Confirm' }, confidence: 1, source: 'recorded' }] } };
    expect(guard.classifyRisk(action, ctx({ targetName: 'Confirm', targetText: 'Confirm' }))).toBe('irreversible');
  });

  it('click on a target matching "Submit" -> irreversible', () => {
    const action: Action = { type: 'click', target: { description: 'x', frame: [], locators: [{ strategy: { kind: 'text', text: 'Submit' }, confidence: 1, source: 'recorded' }] } };
    expect(guard.classifyRisk(action, ctx({ targetName: 'Submit' }))).toBe('irreversible');
  });

  it.each(['Continue', 'Cancel', 'OK', 'Search', 'login', 'Open New Sub-Account'])('click on %s is NOT irreversible (reversible)', (name) => {
    const action: Action = { type: 'click', target: { description: name, frame: [], locators: [{ strategy: { kind: 'text', text: name }, confidence: 1, source: 'recorded' }] } };
    expect(guard.classifyRisk(action, ctx({ targetName: name, targetText: name }))).toBe('reversible');
  });

  it('irreversible text matching is case-insensitive', () => {
    const action: Action = { type: 'click', target: { description: 'x', frame: [], locators: [{ strategy: { kind: 'text', text: 'CONFIRM' }, confidence: 1, source: 'recorded' }] } };
    expect(guard.classifyRisk(action, ctx({ targetName: 'CONFIRM' }))).toBe('irreversible');
    const action2: Action = { type: 'click', target: { description: 'x', frame: [], locators: [{ strategy: { kind: 'text', text: 'submit now' }, confidence: 1, source: 'recorded' }] } };
    expect(guard.classifyRisk(action2, ctx({ targetName: 'submit now' }))).toBe('irreversible');
  });

  it('a target on a page whose URL matches irreversibleUrlPatterns is irreversible even if its own text is not', () => {
    const action: Action = { type: 'click', target: { description: 'ok', frame: [], locators: [{ strategy: { kind: 'text', text: 'OK' }, confidence: 1, source: 'recorded' }] } };
    expect(
      guard.classifyRisk(action, ctx({ targetName: 'OK', currentUrl: 'http://localhost:4173/members/12345/subaccounts' })),
    ).toBe('irreversible');
  });

  it('navigate to a URL matching irreversibleUrlPatterns -> irreversible', () => {
    const action: Action = { type: 'navigate', url: 'http://localhost:4173/members/12345/subaccounts' };
    expect(guard.classifyRisk(action, ctx())).toBe('irreversible');
  });

  it('navigate to an ordinary allowed URL -> read (not reversible)', () => {
    const action: Action = { type: 'navigate', url: 'http://localhost:4173/members/search' };
    expect(guard.classifyRisk(action, ctx())).toBe('read');
  });

  it('navigate resolves a relative URL against ctx.currentUrl before matching', () => {
    const action: Action = { type: 'navigate', url: '/members/12345/subaccounts' };
    expect(guard.classifyRisk(action, ctx({ currentUrl: 'http://localhost:4173/workstation' }))).toBe('irreversible');
  });

  it('select on an irreversible-named target -> irreversible; otherwise reversible', () => {
    const action: Action = { type: 'select', target: { description: 'x', frame: [], locators: [{ strategy: { kind: 'text', text: 'x' }, confidence: 1, source: 'recorded' }] }, value: { kind: 'literal', value: 'a' } };
    expect(guard.classifyRisk(action, ctx({ targetName: 'Approve' }))).toBe('irreversible');
    expect(guard.classifyRisk(action, ctx({ targetName: 'Account Type' }))).toBe('reversible');
  });

  it('type without pressEnter is always reversible, even toward an irreversible target name', () => {
    const action: Action = {
      type: 'type',
      target: { description: 'x', frame: [], locators: [{ strategy: { kind: 'text', text: 'x' }, confidence: 1, source: 'recorded' }] },
      value: { kind: 'literal', value: 'hi' },
    };
    expect(guard.classifyRisk(action, ctx({ targetName: 'Confirm' }))).toBe('reversible');
  });

  it('type with pressEnter:true on an irreversible target -> irreversible; otherwise reversible', () => {
    const action: Action = {
      type: 'type',
      target: { description: 'x', frame: [], locators: [{ strategy: { kind: 'text', text: 'x' }, confidence: 1, source: 'recorded' }] },
      value: { kind: 'literal', value: 'hi' },
      pressEnter: true,
    };
    expect(guard.classifyRisk(action, ctx({ targetName: 'Confirm' }))).toBe('irreversible');
    expect(guard.classifyRisk(action, ctx({ targetName: 'Member ID' }))).toBe('reversible');
  });

  it('press Enter on an irreversible target -> irreversible; otherwise reversible', () => {
    const action: Action = { type: 'press', key: 'Enter' };
    expect(guard.classifyRisk(action, ctx({ targetName: 'Confirm' }))).toBe('irreversible');
    expect(guard.classifyRisk(action, ctx({ targetName: 'Member ID' }))).toBe('reversible');
  });

  it('press a non-Enter key -> read, regardless of target', () => {
    const action: Action = { type: 'press', key: 'Tab' };
    expect(guard.classifyRisk(action, ctx({ targetName: 'Confirm' }))).toBe('read');
  });

  it('extract/wait/switch_frame -> read', () => {
    const extract: Action = { type: 'extract', target: { description: 'x', frame: [], locators: [{ strategy: { kind: 'text', text: 'x' }, confidence: 1, source: 'recorded' }] }, output: 'o' };
    const wait: Action = { type: 'wait', condition: { kind: 'text_visible', text: 'x' } };
    const switchFrame: Action = { type: 'switch_frame', frame: [] };
    expect(guard.classifyRisk(extract, ctx({ targetName: 'Confirm' }))).toBe('read');
    expect(guard.classifyRisk(wait, ctx())).toBe('read');
    expect(guard.classifyRisk(switchFrame, ctx())).toBe('read');
  });

  it('dismiss_dialog(accept:false) -> read regardless of message', () => {
    const action: Action = { type: 'dismiss_dialog', accept: false };
    expect(guard.classifyRisk(action, ctx({ targetText: 'Confirm delete?' }))).toBe('read');
  });

  it('dismiss_dialog(accept:true) -> reversible by default', () => {
    const action: Action = { type: 'dismiss_dialog', accept: true };
    expect(guard.classifyRisk(action, ctx())).toBe('reversible');
  });

  it('dismiss_dialog(accept:true) -> irreversible when the dialog message matches irreversible text patterns', () => {
    const action: Action = { type: 'dismiss_dialog', accept: true };
    expect(guard.classifyRisk(action, ctx({ targetText: 'Confirm: this cannot be undone' }))).toBe('irreversible');
  });
});

describe('createPolicyGuard: checkAction', () => {
  const guard = defaultGuard;

  it('denies an action type not in allowedActions', () => {
    const restricted = createPolicyGuard(
      parsePolicy(`
name: no-type
allowedOrigins: ['http://localhost:4173']
allowedPathPatterns: []
deniedPathPatterns: []
allowedActions: [navigate]
risk:
  irreversibleTextPatterns: []
  irreversibleUrlPatterns: []
  discoveryMode: block
  replayRequiresApproved: false
redaction:
  patterns: []
limits: { maxSteps: 10, maxDurationMs: 60000, maxLlmCalls: 5 }
`),
    );
    const action: Action = { type: 'click', target: { description: 'x', frame: [], locators: [{ strategy: { kind: 'text', text: 'x' }, confidence: 1, source: 'recorded' }] } };
    const result = restricted.checkAction(action, ctx());
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/not in policy/);
  });

  it('denies navigate to an off-policy origin', () => {
    const action: Action = { type: 'navigate', url: 'http://evil.test/steal' };
    const result = guard.checkAction(action, ctx());
    expect(result.decision).toBe('deny');
  });

  it('denies navigate to /__faults', () => {
    const action: Action = { type: 'navigate', url: 'http://localhost:4173/__faults' };
    const result = guard.checkAction(action, ctx());
    expect(result.decision).toBe('deny');
  });

  it('resolves a relative navigate URL against ctx.currentUrl before checking it', () => {
    const action: Action = { type: 'navigate', url: '__faults' };
    const result = guard.checkAction(action, ctx({ currentUrl: 'http://localhost:4173/workstation' }));
    expect(result.decision).toBe('deny');
  });

  it('allows a read-risk action within policy', () => {
    const action: Action = { type: 'navigate', url: 'http://localhost:4173/members/search' };
    const result = guard.checkAction(action, ctx());
    expect(result).toEqual({ decision: 'allow', reason: expect.any(String), risk: 'read' });
  });

  it('allows a reversible-risk action within policy', () => {
    const action: Action = { type: 'click', target: { description: 'search', frame: [], locators: [{ strategy: { kind: 'text', text: 'Search' }, confidence: 1, source: 'recorded' }] } };
    const result = guard.checkAction(action, ctx({ targetName: 'Search' }));
    expect(result.decision).toBe('allow');
    expect(result.risk).toBe('reversible');
  });

  it('flags an irreversible-risk action for confirmation', () => {
    const action: Action = { type: 'click', target: { description: 'confirm', frame: [], locators: [{ strategy: { kind: 'text', text: 'Confirm' }, confidence: 1, source: 'recorded' }] } };
    const result = guard.checkAction(action, ctx({ targetName: 'Confirm' }));
    expect(result.decision).toBe('flag_irreversible');
    expect(result.risk).toBe('irreversible');
  });

  it('riskOverride raises a reversible action to irreversible', () => {
    const action: Action = { type: 'click', target: { description: 'x', frame: [], locators: [{ strategy: { kind: 'text', text: 'x' }, confidence: 1, source: 'recorded' }] } };
    const result = guard.checkAction(action, ctx({ targetName: 'Account Type', riskOverride: 'irreversible' }));
    expect(result.decision).toBe('flag_irreversible');
    expect(result.risk).toBe('irreversible');
  });

  it('riskOverride cannot lower risk below classifyRisk: a "Confirm" click stays irreversible even if riskOverride says read', () => {
    const action: Action = { type: 'click', target: { description: 'confirm', frame: [], locators: [{ strategy: { kind: 'text', text: 'Confirm' }, confidence: 1, source: 'recorded' }] } };
    const result = guard.checkAction(action, ctx({ targetName: 'Confirm', riskOverride: 'read' }));
    expect(result.decision).toBe('flag_irreversible');
    expect(result.risk).toBe('irreversible');
  });

  it('riskOverride equal to the base risk is a no-op', () => {
    const action: Action = { type: 'click', target: { description: 'x', frame: [], locators: [{ strategy: { kind: 'text', text: 'x' }, confidence: 1, source: 'recorded' }] } };
    const result = guard.checkAction(action, ctx({ targetName: 'Account Type', riskOverride: 'reversible' }));
    expect(result.decision).toBe('allow');
    expect(result.risk).toBe('reversible');
  });
});

describe('createPolicyGuard: exposed limits/policy', () => {
  it('exposes policy.limits and the policy object verbatim', () => {
    const guard: PolicyGuard = defaultGuard;
    expect(guard.limits).toEqual(defaultPolicy.limits);
    expect(guard.policy).toBe(defaultPolicy);
  });
});
