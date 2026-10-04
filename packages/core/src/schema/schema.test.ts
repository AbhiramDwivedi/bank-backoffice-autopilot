import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  LocatorStrategy,
  Locator,
  FrameHop,
  FramePath,
  TargetDescriptor,
  ValueBinding,
  Condition,
  NavigateAction,
  ClickAction,
  TypeAction,
  SelectAction,
  PressAction,
  ExtractAction,
  WaitAction,
  DismissDialogAction,
  SwitchFrameAction,
  Action,
  Step,
  InputSpec,
  OutputSpec,
  BusinessOutcome,
  RecoveryRule,
  TenantOverride,
  Capability,
  Policy,
  RunEvent,
  FailureCode,
  ReplayResult,
  ControlState,
  HumanAction,
  Intervention,
} from './index.js';
import type {
  LocatorStrategy as LocatorStrategyT,
  Locator as LocatorT,
  TargetDescriptor as TargetDescriptorT,
  Condition as ConditionT,
  Step as StepT,
  BusinessOutcome as BusinessOutcomeT,
  RecoveryRule as RecoveryRuleT,
  TenantOverride as TenantOverrideT,
  Capability as CapabilityT,
} from './index.js';

// --- generic helpers -------------------------------------------------------

/** Round-trips a valid value through the schema and a JSON (de)serialize cycle. */
function roundtrips<T>(schema: z.ZodType<T>, value: unknown): void {
  const parsed = schema.parse(value);
  const json = JSON.parse(JSON.stringify(parsed));
  const reparsed = schema.parse(json);
  expect(reparsed).toEqual(parsed);
}

function rejects(schema: z.ZodType<unknown>, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(false);
}

// --- fixture factories -------------------------------------------------------

const roleStrategy = (): LocatorStrategyT => ({ kind: 'role', role: 'button', name: 'Submit' });
const labelStrategy = (): LocatorStrategyT => ({ kind: 'label', label: 'Member ID' });
const textStrategy = (): LocatorStrategyT => ({ kind: 'text', text: 'Profile' });
const relativeStrategy = (): LocatorStrategyT => ({ kind: 'relative', anchor: { text: 'Balance' }, relation: 'right-of' });
const cssStrategy = (): LocatorStrategyT => ({ kind: 'css', selector: '#foo' });
const bboxStrategy = (): LocatorStrategyT => ({ kind: 'bbox', x: 0.1, y: 0.2, w: 0.1, h: 0.05 });
const automationIdStrategy = (): LocatorStrategyT => ({ kind: 'automation_id', id: 'txtMemberId' });

const ALL_STRATEGIES: [string, () => LocatorStrategyT][] = [
  ['role', roleStrategy],
  ['label', labelStrategy],
  ['text', textStrategy],
  ['relative', relativeStrategy],
  ['css', cssStrategy],
  ['bbox', bboxStrategy],
  ['automation_id', automationIdStrategy],
];

function mkLocator(strategy: LocatorStrategyT = roleStrategy()): LocatorT {
  return { strategy, confidence: 0.9, source: 'recorded' };
}

function mkTarget(locators: LocatorT[] = [mkLocator()]): TargetDescriptorT {
  return { description: 'a target on the page', frame: [], locators };
}

const textVisible = (): ConditionT => ({ kind: 'text_visible', text: 'Hello' });
const textAbsent = (): ConditionT => ({ kind: 'text_absent', text: 'Error' });
const elementVisible = (): ConditionT => ({ kind: 'element_visible', target: mkTarget() });
const elementAbsent = (): ConditionT => ({ kind: 'element_absent', target: mkTarget() });
const urlMatches = (): ConditionT => ({ kind: 'url_matches', pattern: '^/members/' });
const dialogOpen = (): ConditionT => ({ kind: 'dialog_open' });

function mkNested3(): ConditionT {
  return {
    kind: 'all',
    of: [
      { kind: 'any', of: [{ kind: 'not', of: textVisible() }, textAbsent()] },
      elementVisible(),
    ],
  };
}

const inputBinding = (): { kind: 'input'; name: string } => ({ kind: 'input', name: 'memberId' });
const literalBinding = (): { kind: 'literal'; value: string } => ({ kind: 'literal', value: 'hello' });
const secretBinding = (): { kind: 'secret'; env: string } => ({ kind: 'secret', env: 'MOCK_PASSWORD' });

function mkStep(overrides: Partial<StepT> = {}): StepT {
  return {
    id: 's01',
    name: 'A step',
    action: { type: 'click', target: mkTarget() },
    risk: 'read',
    ...overrides,
  };
}

function mkCapability(overrides: Partial<CapabilityT> = {}): CapabilityT {
  return {
    schemaVersion: '1.0',
    id: 'lookup-member-savings-balance',
    version: '1.0.0',
    name: 'Lookup member savings balance',
    description: 'Log in and read a member savings balance.',
    app: {
      vendor: 'Acme Core Systems',
      product: 'CU Core Workstation',
      surface: 'web',
      entryUrl: '{baseUrl}/login',
    },
    status: 'draft',
    riskLevel: 'read',
    inputs: {
      memberId: { type: 'string', description: 'Member ID', required: true, sensitive: false },
    },
    outputs: {
      savingsBalance: { type: 'number', description: 'Savings balance' },
    },
    steps: [
      { id: 's01', name: 'Navigate to login', action: { type: 'navigate', url: '{baseUrl}/login' }, risk: 'read' },
      { id: 's02', name: 'Extract balance', action: { type: 'extract', target: mkTarget(), output: 'savingsBalance' }, risk: 'read' },
    ],
    success: { condition: textVisible(), description: 'Balance shown' },
    businessOutcomes: [],
    recoveryRules: [],
    provenance: {
      discoveredAt: '2024-01-01T00:00:00Z',
      discoveryRunId: 'run-1',
      recordedBy: 'llm',
    },
    ...overrides,
  };
}

// --- LocatorStrategy ---------------------------------------------------------

describe('LocatorStrategy', () => {
  for (const [name, factory] of ALL_STRATEGIES) {
    it(`round-trips kind:${name}`, () => {
      roundtrips(LocatorStrategy, factory());
    });
  }

  it('rejects an unknown discriminator', () => {
    rejects(LocatorStrategy, { kind: 'xpath', selector: '//div' });
  });

  it('rejects out-of-range bbox coordinates', () => {
    rejects(LocatorStrategy, { kind: 'bbox', x: 1.5, y: 0, w: 0.1, h: 0.1 });
  });

  it('rejects an unknown extra key (strict object)', () => {
    rejects(LocatorStrategy, { kind: 'role', role: 'button', name: 'Submit', bogus: true });
  });
});

// --- Locator -----------------------------------------------------------------

describe('Locator', () => {
  it('round-trips', () => {
    roundtrips(Locator, mkLocator());
  });

  it('rejects out-of-range confidence', () => {
    rejects(Locator, { strategy: cssStrategy(), confidence: 1.2, source: 'recorded' });
  });
});

// --- FrameHop / FramePath ------------------------------------------------------

describe('FrameHop / FramePath', () => {
  it('round-trips a frame hop', () => {
    roundtrips(FrameHop, { name: 'main' });
  });

  it('round-trips an empty frame path (top document)', () => {
    roundtrips(FramePath, []);
  });

  it('rejects a frame hop with no fields', () => {
    rejects(FrameHop, {});
  });
});

// --- TargetDescriptor ----------------------------------------------------------

describe('TargetDescriptor', () => {
  it('round-trips', () => {
    roundtrips(TargetDescriptor, mkTarget([mkLocator(roleStrategy()), mkLocator(cssStrategy())]));
  });

  it('rejects an empty locators array', () => {
    rejects(TargetDescriptor, { description: 'x', frame: [], locators: [] });
  });
});

// --- ValueBinding --------------------------------------------------------------

describe('ValueBinding', () => {
  it('round-trips kind:input', () => {
    roundtrips(ValueBinding, inputBinding());
  });
  it('round-trips kind:literal', () => {
    roundtrips(ValueBinding, literalBinding());
  });
  it('round-trips kind:secret', () => {
    roundtrips(ValueBinding, secretBinding());
  });

  it('rejects a lowercase secret env var name', () => {
    rejects(ValueBinding, { kind: 'secret', env: 'mock_password' });
  });

  it('rejects an unknown discriminator', () => {
    rejects(ValueBinding, { kind: 'env', name: 'x' });
  });
});

// --- Condition -----------------------------------------------------------------

describe('Condition', () => {
  const leafCases: [string, () => ConditionT][] = [
    ['text_visible', textVisible],
    ['text_absent', textAbsent],
    ['element_visible', elementVisible],
    ['element_absent', elementAbsent],
    ['url_matches', urlMatches],
    ['dialog_open', dialogOpen],
  ];
  for (const [name, factory] of leafCases) {
    it(`round-trips kind:${name}`, () => {
      roundtrips(Condition, factory());
    });
  }

  it('round-trips a condition nested 3 levels deep (all > any > not)', () => {
    roundtrips(Condition, mkNested3());
  });

  it('rejects an unknown discriminator', () => {
    rejects(Condition, { kind: 'always_true' });
  });

  it('rejects an empty `of` array on all/any', () => {
    rejects(Condition, { kind: 'all', of: [] });
  });
});

// --- Action --------------------------------------------------------------------

describe('Action', () => {
  const cases: [string, z.ZodType<unknown>, unknown][] = [
    ['navigate', NavigateAction, { type: 'navigate', url: '{baseUrl}/members/{input.memberId}' }],
    ['click', ClickAction, { type: 'click', target: mkTarget() }],
    ['type', TypeAction, { type: 'type', target: mkTarget(), value: inputBinding(), clear: true }],
    ['select', SelectAction, { type: 'select', target: mkTarget(), value: literalBinding() }],
    ['press', PressAction, { type: 'press', key: 'Enter' }],
    ['extract', ExtractAction, { type: 'extract', target: mkTarget(), output: 'savingsBalance', parse: 'currency' }],
    ['wait', WaitAction, { type: 'wait', condition: textVisible(), timeoutMs: 5000 }],
    ['dismiss_dialog', DismissDialogAction, { type: 'dismiss_dialog', accept: true }],
    ['switch_frame', SwitchFrameAction, { type: 'switch_frame', frame: [{ name: 'main' }] }],
  ];

  for (const [name, schema, sample] of cases) {
    it(`round-trips type:${name} (variant schema)`, () => {
      roundtrips(schema, sample);
    });
    it(`round-trips type:${name} (Action union)`, () => {
      roundtrips(Action, sample);
    });
  }

  it('rejects an unknown discriminator', () => {
    rejects(Action, { type: 'scroll', target: mkTarget() });
  });

  it('rejects an unknown extra key (strict object)', () => {
    rejects(Action, { type: 'click', target: mkTarget(), extra: 1 });
  });
});

// --- Step ------------------------------------------------------------------

describe('Step', () => {
  it('round-trips', () => {
    roundtrips(Step, mkStep({ precondition: textVisible(), postcondition: elementVisible(), timeoutMs: 3000, onFailure: 'escalate' }));
  });

  it('rejects an empty id', () => {
    rejects(Step, mkStep({ id: '' }));
  });

  it('rejects a missing risk field', () => {
    const step = mkStep() as Record<string, unknown>;
    delete step.risk;
    rejects(Step, step);
  });
});

// --- InputSpec / OutputSpec --------------------------------------------------

describe('InputSpec', () => {
  it('round-trips', () => {
    roundtrips(InputSpec, { type: 'string', description: 'Member ID', required: true, sensitive: false, pattern: '^\\d+$', example: '12345' });
  });

  it('rejects an out-of-enum type', () => {
    rejects(InputSpec, { type: 'object', description: 'x', required: true, sensitive: false });
  });
});

describe('OutputSpec', () => {
  it('round-trips', () => {
    roundtrips(OutputSpec, { type: 'number', description: 'Savings balance' });
  });

  it('rejects an unknown extra key (strict object)', () => {
    rejects(OutputSpec, { type: 'number', description: 'x', bogus: true });
  });
});

// --- BusinessOutcome ----------------------------------------------------------

describe('BusinessOutcome', () => {
  function mk(overrides: Partial<BusinessOutcomeT> = {}): BusinessOutcomeT {
    return {
      name: 'member_not_found',
      description: 'No records found for the given member id',
      detector: textVisible(),
      returns: {},
      ...overrides,
    };
  }

  it('round-trips', () => {
    roundtrips(
      BusinessOutcome,
      mk({
        afterSteps: ['s01'],
        returns: { reason: { type: 'string', description: 'why' } },
        extract: [{ output: 'reason', target: mkTarget(), parse: 'text' }],
      }),
    );
  });

  it('rejects a non-identifier name', () => {
    rejects(BusinessOutcome, mk({ name: 'member-not-found' }));
  });
});

// --- RecoveryRule --------------------------------------------------------------

describe('RecoveryRule', () => {
  function mk(overrides: Partial<RecoveryRuleT> = {}): RecoveryRuleT {
    return {
      name: 'dismiss_maintenance_notice',
      description: 'Dismiss the maintenance interstitial',
      trigger: textVisible(),
      actions: [{ type: 'click', target: mkTarget() }],
      maxAttempts: 3,
      ...overrides,
    };
  }

  it('round-trips', () => {
    roundtrips(RecoveryRule, mk());
  });

  it('rejects maxAttempts below 1', () => {
    rejects(RecoveryRule, mk({ maxAttempts: 0 }));
  });

  it('rejects an empty actions array', () => {
    rejects(RecoveryRule, mk({ actions: [] }));
  });
});

// --- TenantOverride (incl. partial action patch) -------------------------------

describe('TenantOverride', () => {
  function mk(overrides: Partial<TenantOverrideT> = {}): TenantOverrideT {
    return {
      tenant: 'tenant-b',
      stepPatches: [{ stepId: 's01', action: { url: '{baseUrl}/login' } }],
      ...overrides,
    };
  }

  it('round-trips with a partial action patch', () => {
    roundtrips(TenantOverride, mk());
  });

  it('round-trips with a target patch, extraSteps and notes', () => {
    roundtrips(
      TenantOverride,
      mk({
        entryUrl: '{baseUrl}/b/login',
        stepPatches: [{ stepId: 's01', target: mkTarget(), action: { type: 'type', clear: true } }],
        extraSteps: [{ afterStepId: 's01', step: mkStep({ id: 's01b' }) }],
        notes: 'tenant B adds a branch code field',
      }),
    );
  });

  it('rejects an unknown extra key inside a partial action patch (strict)', () => {
    const bad: unknown = { ...mk(), stepPatches: [{ stepId: 's01', action: { url: 'x', bogus: 1 } }] };
    rejects(TenantOverride, bad);
  });
});

// --- Capability -----------------------------------------------------------------

describe('Capability', () => {
  it('round-trips a minimal valid capability', () => {
    roundtrips(Capability, mkCapability());
  });

  it('round-trips with overrides, businessOutcomes and recoveryRules populated', () => {
    roundtrips(
      Capability,
      mkCapability({
        businessOutcomes: [
          {
            name: 'member_not_found',
            description: 'no records found',
            detector: textVisible(),
            afterSteps: ['s01'],
            returns: {},
          },
        ],
        recoveryRules: [
          {
            name: 'dismiss_notice',
            description: 'dismiss the interstitial',
            trigger: dialogOpen(),
            actions: [{ type: 'click', target: mkTarget() }],
            maxAttempts: 2,
          },
        ],
        overrides: [{ tenant: 'tenant-b', stepPatches: [{ stepId: 's01', action: { url: '{baseUrl}/b/login' } }] }],
      }),
    );
  });

  it('rejects a non-semver version', () => {
    rejects(Capability, mkCapability({ version: '1.0' }));
  });

  it('rejects a non-kebab-case id', () => {
    rejects(Capability, mkCapability({ id: 'LookupMember' }));
  });

  it('rejects an unknown extra top-level key (strict object)', () => {
    rejects(Capability, { ...mkCapability(), bogus: true });
  });
});

// --- Policy ----------------------------------------------------------------------

function mkPolicy(): z.infer<typeof Policy> {
  return {
    name: 'default',
    allowedOrigins: ['http://localhost:4173'],
    allowedPathPatterns: [],
    deniedPathPatterns: ['^/__faults'],
    allowedActions: ['navigate', 'click', 'type', 'select', 'press', 'extract', 'wait', 'dismiss_dialog', 'switch_frame'],
    risk: {
      irreversibleTextPatterns: ['^(submit|confirm|transfer|delete|approve|post)\\b'],
      irreversibleUrlPatterns: [],
      discoveryMode: 'escalate',
      replayRequiresApproved: true,
    },
    redaction: { patterns: [{ name: 'ssn', regex: '\\d{3}-\\d{2}-\\d{4}' }] },
    limits: { maxSteps: 50, maxDurationMs: 60_000, maxLlmCalls: 20 },
  };
}

describe('Policy', () => {
  it('round-trips', () => {
    roundtrips(Policy, mkPolicy());
  });

  it('rejects a non-url allowed origin', () => {
    rejects(Policy, { ...mkPolicy(), allowedOrigins: ['not-a-url'] });
  });
});

// --- RunEvent ----------------------------------------------------------------------

describe('RunEvent', () => {
  it('round-trips', () => {
    roundtrips(RunEvent, {
      runId: 'run-1',
      seq: 0,
      ts: '2024-01-01T00:00:00Z',
      kind: 'run_started',
      data: {},
      evidence: { screenshot: 'shots/0.png' },
    });
  });

  it('rejects a negative seq', () => {
    rejects(RunEvent, { runId: 'run-1', seq: -1, ts: '2024-01-01T00:00:00Z', kind: 'run_started', data: {} });
  });

  it('rejects an unknown kind', () => {
    rejects(RunEvent, { runId: 'run-1', seq: 0, ts: '2024-01-01T00:00:00Z', kind: 'bogus', data: {} });
  });
});

// --- FailureCode -----------------------------------------------------------------

describe('FailureCode', () => {
  it('accepts every documented code', () => {
    for (const code of FailureCode.options) {
      expect(FailureCode.safeParse(code).success).toBe(true);
    }
  });

  it('rejects an undocumented code', () => {
    rejects(FailureCode, 'network_error');
  });
});

// --- ReplayResult ------------------------------------------------------------------

describe('ReplayResult', () => {
  const base = {
    runId: 'run-1',
    capabilityId: 'lookup-member-savings-balance',
    capabilityVersion: '1.0.0',
    stepsExecuted: 2,
    durationMs: 1234,
    locatorReport: [{ stepId: 's01', strategyKind: 'role', fallbackDepth: 0 }],
    recoveries: ['dismiss_maintenance_notice'],
  };

  it('round-trips kind:success', () => {
    roundtrips(ReplayResult, { ...base, kind: 'success', outputs: { savingsBalance: 1234.56 } });
  });

  it('round-trips kind:business_outcome', () => {
    roundtrips(ReplayResult, { ...base, kind: 'business_outcome', name: 'member_not_found', data: {} });
  });

  it('round-trips kind:business_outcome with missing', () => {
    roundtrips(ReplayResult, { ...base, kind: 'business_outcome', name: 'access_denied', data: {}, missing: ['message'] });
  });

  it('rejects kind:business_outcome with a non-array missing', () => {
    rejects(ReplayResult, { ...base, kind: 'business_outcome', name: 'access_denied', data: {}, missing: 'message' });
  });

  it('round-trips kind:hard_failure', () => {
    roundtrips(ReplayResult, {
      ...base,
      kind: 'hard_failure',
      stepId: 's02',
      code: 'element_not_found',
      expected: 'element visible',
      observed: 'not found',
      message: 'could not locate target',
      evidence: { screenshot: 'shots/2.png', dom: 'dom/2.html' },
    });
  });

  it('round-trips kind:escalated', () => {
    roundtrips(ReplayResult, {
      ...base,
      kind: 'escalated',
      interventionId: 'iv-1',
      reason: 'stuck after 3 recovery attempts',
      resolution: 'resumed_success',
    });
  });

  it("rejects kind:'success' missing outputs", () => {
    rejects(ReplayResult, { ...base, kind: 'success' });
  });

  it('rejects a hard_failure code not in FailureCode', () => {
    rejects(ReplayResult, {
      ...base,
      kind: 'hard_failure',
      code: 'network_error',
      expected: 'x',
      observed: 'y',
      message: 'm',
      evidence: {},
    });
  });
});

// --- ControlState ------------------------------------------------------------------

describe('ControlState', () => {
  it('accepts every documented state', () => {
    for (const s of ControlState.options) {
      expect(ControlState.safeParse(s).success).toBe(true);
    }
  });

  it('rejects an undocumented state', () => {
    rejects(ControlState, 'idle');
  });
});

// --- HumanAction ---------------------------------------------------------------------

describe('HumanAction', () => {
  it('round-trips', () => {
    roundtrips(HumanAction, {
      ts: '2024-01-01T00:00:00Z',
      type: 'click',
      frame: [],
      target: { role: 'button', name: 'OK' },
      valueRedacted: true,
    });
  });

  it('rejects an unknown type', () => {
    rejects(HumanAction, { ts: '2024-01-01T00:00:00Z', type: 'drag', frame: [], target: {} });
  });
});

// --- Intervention ----------------------------------------------------------------------

describe('Intervention', () => {
  it('round-trips without a resolution', () => {
    roundtrips(Intervention, {
      id: 'iv-1',
      runId: 'run-1',
      runKind: 'replay',
      capabilityId: 'lookup-member-savings-balance',
      stepId: 's02',
      reason: { code: 'stuck', message: 'no progress after 3 attempts' },
      createdAt: '2024-01-01T00:00:00Z',
      status: 'open',
    });
  });

  it('round-trips with a resolution', () => {
    roundtrips(Intervention, {
      id: 'iv-1',
      runId: 'run-1',
      runKind: 'replay',
      reason: { code: 'unexpected_dialog', message: 'native confirm appeared' },
      createdAt: '2024-01-01T00:00:00Z',
      status: 'resolved',
      resolution: {
        by: 'operator1',
        at: '2024-01-01T00:05:00Z',
        humanActions: [{ ts: '2024-01-01T00:04:00Z', type: 'click', frame: [], target: { role: 'button', name: 'OK' } }],
        resumeFrom: 'next_step',
      },
    });
  });

  it('rejects a resolution missing resumeFrom', () => {
    rejects(Intervention, {
      id: 'iv-1',
      runId: 'run-1',
      runKind: 'replay',
      reason: { code: 'stuck', message: 'm' },
      createdAt: '2024-01-01T00:00:00Z',
      status: 'resolved',
      resolution: { by: 'operator1', at: '2024-01-01T00:05:00Z', humanActions: [] },
    });
  });
});
