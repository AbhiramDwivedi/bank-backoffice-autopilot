import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  validateCapability,
  walkCondition,
  targetTexts,
  DEFAULT_IRREVERSIBLE_TEXT_PATTERNS,
} from './validate.js';
import type { CapabilityIssueCode } from './validate.js';
import type { Capability, Condition, TargetDescriptor } from './index.js';
import { buildJsonSchemas } from './export.js';

// --- base fixture: minimal valid capability -----------------------------------
//
// 4 steps (navigate, type an input binding, click, extract), 1 business outcome
// with a matching extract, 1 recovery rule, 1 tenant override.

function memberSearchTarget(): TargetDescriptor {
  return {
    description: 'Member ID text field on the search form',
    frame: [],
    locators: [{ strategy: { kind: 'label', label: 'Member ID' }, confidence: 0.9, source: 'recorded' }],
  };
}

function searchButtonTarget(): TargetDescriptor {
  return {
    description: 'Search button',
    frame: [],
    locators: [{ strategy: { kind: 'role', role: 'button', name: 'Search' }, confidence: 0.9, source: 'recorded' }],
  };
}

function balanceTarget(): TargetDescriptor {
  return {
    description: 'Savings balance value cell',
    frame: [],
    locators: [{ strategy: { kind: 'label', label: 'Savings Balance' }, confidence: 0.8, source: 'recorded' }],
  };
}

function accessDeniedReasonTarget(): TargetDescriptor {
  return {
    description: 'Access denied message text',
    frame: [],
    locators: [{ strategy: { kind: 'text', text: 'Access Denied' }, confidence: 0.7, source: 'recorded' }],
  };
}

function recoveryOkButtonTarget(): TargetDescriptor {
  return {
    description: 'OK button on the maintenance interstitial',
    frame: [],
    locators: [{ strategy: { kind: 'role', role: 'button', name: 'OK' }, confidence: 0.9, source: 'recorded' }],
  };
}

function baseCapability(): Capability {
  return {
    schemaVersion: '1.0',
    id: 'lookup-member-savings-balance',
    version: '1.0.0',
    name: 'Lookup member savings balance',
    description: 'Log in, look up a member and read their current savings balance.',
    app: {
      vendor: 'Acme Core Systems',
      product: 'CU Core Workstation',
      surface: 'web',
      entryUrl: '{baseUrl}/login',
    },
    status: 'draft',
    riskLevel: 'read',
    inputs: {
      memberId: { type: 'string', description: 'Member ID', required: true, sensitive: false, pattern: '^[0-9]{5}$' },
    },
    outputs: {
      savingsBalance: { type: 'number', description: 'Savings balance' },
    },
    steps: [
      { id: 's01', name: 'Navigate to login', action: { type: 'navigate', url: '{baseUrl}/login' }, risk: 'read' },
      {
        id: 's02',
        name: 'Enter member ID',
        action: { type: 'type', target: memberSearchTarget(), value: { kind: 'input', name: 'memberId' }, clear: true },
        risk: 'read',
      },
      { id: 's03', name: 'Submit search', action: { type: 'click', target: searchButtonTarget() }, risk: 'read' },
      {
        id: 's04',
        name: 'Extract savings balance',
        action: { type: 'extract', target: balanceTarget(), output: 'savingsBalance', parse: 'currency' },
        risk: 'read',
      },
    ],
    success: { condition: { kind: 'text_visible', text: 'Savings Balance' }, description: 'Balance is shown on the profile tab' },
    businessOutcomes: [
      {
        name: 'access_denied',
        description: 'The operator role does not permit viewing this member',
        detector: { kind: 'text_visible', text: 'Access Denied' },
        afterSteps: ['s03'],
        returns: { reason: { type: 'string', description: 'denial reason text' } },
        extract: [{ output: 'reason', target: accessDeniedReasonTarget(), parse: 'text' }],
      },
    ],
    recoveryRules: [
      {
        name: 'dismiss_maintenance_notice',
        description: 'Dismiss the "System Maintenance Notice" interstitial if present',
        trigger: { kind: 'text_visible', text: 'System Maintenance Notice' },
        actions: [{ type: 'click', target: recoveryOkButtonTarget() }],
        maxAttempts: 1,
      },
    ],
    provenance: {
      discoveredAt: '2024-01-01T00:00:00Z',
      discoveryRunId: 'discovery-run-1',
      recordedBy: 'llm',
      model: 'claude',
    },
    overrides: [
      {
        tenant: 'tenant-b',
        stepPatches: [{ stepId: 's01', action: { url: '{baseUrl}/b/login' } }],
      },
    ],
  };
}

function clone(cap: Capability): Capability {
  return structuredClone(cap);
}

function issueCodes(result: ReturnType<typeof validateCapability>): CapabilityIssueCode[] {
  if (result.ok) return [];
  return result.issues.map((i) => i.code);
}

// --- baseline -------------------------------------------------------------------

describe('validateCapability: baseline fixture', () => {
  it('validates the minimal valid capability with no issues', () => {
    const result = validateCapability(baseCapability());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issues).toEqual([]);
      expect(result.capability.id).toBe('lookup-member-savings-balance');
    }
  });
});

// --- one test per issue code -----------------------------------------------------

describe('validateCapability: issue codes', () => {
  it('schema: a zod parse error not at path [version]', () => {
    const cap = clone(baseCapability()) as unknown as Record<string, unknown>;
    delete cap.name;
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((i) => i.code === 'schema');
      expect(issue).toBeDefined();
      expect(issue?.path).toEqual(['name']);
    }
  });

  it('invalid_semver: a zod error at path [version] maps to invalid_semver', () => {
    const cap = clone(baseCapability());
    (cap as unknown as { version: string }).version = 'not-a-version';
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(expect.objectContaining({ code: 'invalid_semver', path: ['version'] }));
    }
  });

  it('duplicate_step_id', () => {
    const cap = clone(baseCapability());
    cap.steps[2]!.id = cap.steps[0]!.id;
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(expect.objectContaining({ code: 'duplicate_step_id', path: ['steps', 2, 'id'] }));
    }
  });

  it('unknown_input: a {kind:"input"} binding referencing an undeclared input', () => {
    const cap = clone(baseCapability());
    const step = cap.steps[1]!;
    if (step.action.type === 'type') step.action.value = { kind: 'input', name: 'bogusInput' };
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: 'unknown_input', path: ['steps', 1, 'action', 'value', 'name'] }),
      );
    }
  });

  it('output_not_produced: a declared output with no producing extract step', () => {
    const cap = clone(baseCapability());
    cap.outputs.memberName = { type: 'string', description: 'Member display name' };
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(expect.objectContaining({ code: 'output_not_produced', path: ['outputs', 'memberName'] }));
    }
  });

  it('undeclared_output: an extract step producing an output not in capability.outputs', () => {
    const cap = clone(baseCapability());
    cap.steps.push({
      id: 's05',
      name: 'Extract an undeclared field',
      action: { type: 'extract', target: balanceTarget(), output: 'undeclaredOne' },
      risk: 'read',
    });
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: 'undeclared_output', path: ['steps', 4, 'action', 'output'] }),
      );
    }
  });

  it('outcome_return_mismatch: a returns key with no matching extract', () => {
    const cap = clone(baseCapability());
    cap.businessOutcomes[0]!.returns.extraField = { type: 'string', description: 'unmatched' };
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: 'outcome_return_mismatch', path: ['businessOutcomes', 0, 'returns', 'extraField'] }),
      );
    }
  });

  it('risk_level_mismatch: riskLevel does not equal the max step risk', () => {
    const cap = clone(baseCapability());
    cap.steps[2]!.risk = 'reversible';
    // capability.riskLevel stays 'read'
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(expect.objectContaining({ code: 'risk_level_mismatch', path: ['riskLevel'] }));
    }
  });

  it('unknown_step_ref: businessOutcomes[].afterSteps referencing a non-existent step', () => {
    const cap = clone(baseCapability());
    cap.businessOutcomes[0]!.afterSteps = ['s99'];
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: 'unknown_step_ref', path: ['businessOutcomes', 0, 'afterSteps', 0] }),
      );
    }
  });

  it('irreversible_recovery_action: a recovery action target matches an irreversible text pattern', () => {
    const cap = clone(baseCapability());
    const action = cap.recoveryRules[0]!.actions[0]!;
    if (action.type === 'click') {
      action.target.locators[0]!.strategy = { kind: 'role', role: 'button', name: 'Submit' };
    }
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: 'irreversible_recovery_action', path: ['recoveryRules', 0, 'actions', 0] }),
      );
    }
  });

  it('invalid_regex: an InputSpec.pattern that does not compile', () => {
    const cap = clone(baseCapability());
    cap.inputs.memberId!.pattern = '[unterminated';
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: 'invalid_regex', path: ['inputs', 'memberId', 'pattern'] }),
      );
    }
  });

  it("regex_parse_needs_pattern: extract parse:'regex' with no pattern", () => {
    const cap = clone(baseCapability());
    const step = cap.steps[3]!;
    if (step.action.type === 'extract') {
      step.action.parse = 'regex';
      delete step.action.pattern;
    }
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: 'regex_parse_needs_pattern', path: ['steps', 3, 'action', 'pattern'] }),
      );
    }
  });

  it('plaintext_credential: a literal value typed into a password-like target', () => {
    const cap = clone(baseCapability());
    const step = cap.steps[1]!;
    if (step.action.type === 'type') {
      step.action.target.locators[0]!.strategy = { kind: 'role', role: 'textbox', name: 'Password' };
      step.action.value = { kind: 'literal', value: 'hunter2' };
    }
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: 'plaintext_credential', path: ['steps', 1, 'action', 'value', 'value'] }),
      );
    }
  });

  it('sensitive_input_not_sensitive: an input bound into a password-like target is not marked sensitive', () => {
    const cap = clone(baseCapability());
    const step = cap.steps[1]!;
    if (step.action.type === 'type') {
      step.action.target.locators[0]!.strategy = { kind: 'role', role: 'textbox', name: 'Password' };
      // value binding stays {kind:'input', name:'memberId'}; memberId.sensitive is false
    }
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: 'sensitive_input_not_sensitive', path: ['inputs', 'memberId', 'sensitive'] }),
      );
    }
  });
});

// --- cross-cutting behaviour -----------------------------------------------------

describe('validateCapability: cross-cutting behaviour', () => {
  it('reports multiple issues together', () => {
    const cap = clone(baseCapability());
    cap.steps[2]!.id = cap.steps[0]!.id; // duplicate_step_id
    const step = cap.steps[1]!;
    if (step.action.type === 'type') step.action.value = { kind: 'input', name: 'bogusInput' }; // unknown_input
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    const codes = issueCodes(result);
    expect(codes).toContain('duplicate_step_id');
    expect(codes).toContain('unknown_input');
  });

  it('never throws on garbage input', () => {
    for (const garbage of [null, 42, {}, []]) {
      expect(() => validateCapability(garbage)).not.toThrow();
      const result = validateCapability(garbage);
      expect(result.ok).toBe(false);
    }
  });

  it('respects a custom irreversibleTextPatterns option', () => {
    const cap = baseCapability(); // recovery action target name is "OK"
    const withDefaults = validateCapability(cap);
    expect(withDefaults.ok).toBe(true);

    const withCustom = validateCapability(cap, { irreversibleTextPatterns: ['^ok$'] });
    expect(withCustom.ok).toBe(false);
    if (!withCustom.ok) {
      expect(withCustom.issues).toContainEqual(
        expect.objectContaining({ code: 'irreversible_recovery_action', path: ['recoveryRules', 0, 'actions', 0] }),
      );
    }
  });

  it('DEFAULT_IRREVERSIBLE_TEXT_PATTERNS is used when no option is given', () => {
    expect(DEFAULT_IRREVERSIBLE_TEXT_PATTERNS.length).toBeGreaterThan(0);
  });
});

// --- walkCondition / targetTexts --------------------------------------------------

describe('walkCondition', () => {
  it('visits every node in a nested all/any/not tree, including intermediate nodes', () => {
    const tree: Condition = {
      kind: 'all',
      of: [
        {
          kind: 'any',
          of: [{ kind: 'not', of: { kind: 'text_visible', text: 'x' } }, { kind: 'text_absent', text: 'y' }],
        },
        { kind: 'url_matches', pattern: 'z' },
      ],
    };
    const visited: { kind: string; path: (string | number)[] }[] = [];
    walkCondition(tree, (c, path) => visited.push({ kind: c.kind, path }));

    expect(visited).toEqual([
      { kind: 'all', path: [] },
      { kind: 'any', path: ['of', 0] },
      { kind: 'not', path: ['of', 0, 'of', 0] },
      { kind: 'text_visible', path: ['of', 0, 'of', 0, 'of'] },
      { kind: 'text_absent', path: ['of', 0, 'of', 1] },
      { kind: 'url_matches', path: ['of', 1] },
    ]);
  });
});

describe('targetTexts', () => {
  it('collects role names, labels, texts, relative anchor texts and snapshot name/text', () => {
    const target: TargetDescriptor = {
      description: 'ignored',
      frame: [],
      locators: [
        { strategy: { kind: 'role', role: 'button', name: 'Submit' }, confidence: 0.9, source: 'recorded' },
        { strategy: { kind: 'label', label: 'Password' }, confidence: 0.5, source: 'inferred' },
        { strategy: { kind: 'text', text: 'Sign in' }, confidence: 0.5, source: 'inferred' },
        { strategy: { kind: 'relative', anchor: { text: 'Balance' }, relation: 'right-of' }, confidence: 0.4, source: 'inferred' },
        { strategy: { kind: 'css', selector: '#foo' }, confidence: 0.1, source: 'inferred' },
      ],
      snapshot: { name: 'snap-name', text: 'snap-text' },
    };
    expect(targetTexts(target)).toEqual(['Submit', 'Password', 'Sign in', 'Balance', 'snap-name', 'snap-text']);
  });
});

// --- export ------------------------------------------------------------------------

describe('buildJsonSchemas (export.ts)', () => {
  it('returns the 5 expected schema keys', () => {
    const built = buildJsonSchemas();
    expect(Object.keys(built).sort()).toEqual(['capability', 'intervention', 'policy', 'replay-result', 'run-event'].sort());
  });

  it('the capability schema contains $defs with a self-referencing Condition definition', () => {
    const built = buildJsonSchemas() as { capability: { $defs?: Record<string, unknown> } };
    const defs = built.capability.$defs;
    expect(defs).toBeDefined();
    expect(defs).toHaveProperty('Condition');
    const conditionJson = JSON.stringify(defs!.Condition);
    expect(conditionJson).toContain('#/$defs/Condition');
  });
});

// --- regressions from independent review ---------------------------------------------

describe('validateCapability: review regressions', () => {
  it('plaintext_credential fires for a css-only password target identified only by its description', () => {
    const cap = clone(baseCapability());
    const step = cap.steps[1]!;
    if (step.action.type === 'type') {
      step.action.target = {
        description: 'Password field on the legacy login table',
        frame: [],
        locators: [{ strategy: { kind: 'css', selector: 'input:nth-of-type(2)' }, confidence: 0.4, source: 'recorded' }],
      };
      step.action.value = { kind: 'literal', value: 'hunter2' };
    }
    expect(issueCodes(validateCapability(cap))).toContain('plaintext_credential');
  });

  it('invalid_regex fires for a FrameHop.urlPattern that does not compile', () => {
    const cap = clone(baseCapability());
    const step = cap.steps[1]!;
    if (step.action.type === 'type') step.action.target.frame = [{ name: 'main', urlPattern: '[unterminated' }];
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: 'invalid_regex', path: ['steps', 1, 'action', 'target', 'frame', 0, 'urlPattern'] }),
      );
    }
  });

  it('duplicate_step_id fires for a tenant extra step reusing a base step id', () => {
    const cap = clone(baseCapability());
    cap.overrides![0]!.extraSteps = [{ afterStepId: 's01', step: structuredClone(cap.steps[2]!) }];
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: 'duplicate_step_id', path: ['overrides', 0, 'extraSteps', 0, 'step', 'id'] }),
      );
    }
  });

  it('override_action_type_mismatch fires when a patch changes the action type', () => {
    const cap = clone(baseCapability());
    cap.overrides![0]!.stepPatches = [{ stepId: 's01', action: { type: 'click', target: searchButtonTarget() } }];
    expect(issueCodes(validateCapability(cap))).toContain('override_action_type_mismatch');
  });

  it('irreversible_recovery_action fires for a recovery navigate matching irreversibleUrlPatterns', () => {
    const cap = clone(baseCapability());
    cap.recoveryRules[0]!.actions = [{ type: 'navigate', url: '{baseUrl}/members/1/subaccounts' }];
    expect(validateCapability(cap).ok).toBe(true);
    expect(issueCodes(validateCapability(cap, { irreversibleUrlPatterns: ['/subaccounts$'] }))).toContain(
      'irreversible_recovery_action',
    );
  });
});

// --- output_value_in_artifact ----------------------------------------------------

describe('validateCapability: output_value_in_artifact (opts.knownValues)', () => {
  it('is clean with no knownValues option', () => {
    expect(validateCapability(baseCapability()).ok).toBe(true);
  });

  it('fires when a known value appears in a free-text field, case-insensitively and whitespace-collapsed', () => {
    const cap = clone(baseCapability());
    cap.success.description = 'Balance is shown on the profile tab: $1,234.56';
    const result = validateCapability(cap, { knownValues: ['  $1,234.56  '] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: 'output_value_in_artifact', path: ['success', 'description'] }),
      );
    }
  });

  it('matches case-insensitively across any string field, not just the one it was seeded from', () => {
    const cap = clone(baseCapability());
    cap.steps[3]!.name = "Read Jane Q. Sample's balance";
    const result = validateCapability(cap, { knownValues: ['jane q. sample'] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: 'output_value_in_artifact', path: ['steps', 3, 'name'] }),
      );
    }
  });

  it('is silent when the value does not appear anywhere', () => {
    const result = validateCapability(baseCapability(), { knownValues: ['$9,999.99', 'Nobody Here'] });
    expect(result.ok).toBe(true);
  });

  it('skips values under 3 characters (would match unrelated legitimate text)', () => {
    const cap = clone(baseCapability());
    cap.success.description = 'Balance is shown on the profile tab OK';
    const result = validateCapability(cap, { knownValues: ['OK'] });
    expect(result.ok).toBe(true);
  });

  it('ignores empty-string knownValues entries', () => {
    const result = validateCapability(baseCapability(), { knownValues: ['', '   '] });
    expect(result.ok).toBe(true);
  });

  it("finds a value slugged into a selector or container: 'In transit' in span.state-in-transit", () => {
    const cap = clone(baseCapability());
    const step = cap.steps[2]!;
    if (step.action.type !== 'click') throw new Error('expected the click step');
    step.action.target.locators.push({
      strategy: { kind: 'relative', anchor: { text: 'Search' }, relation: 'below', tag: 'span', within: 'div.order-in-transit' },
      confidence: 0.5,
      source: 'inferred',
    });
    step.action.target.locators.push({ strategy: { kind: 'css', selector: 'span.state_In-Transit' }, confidence: 0.3, source: 'inferred' });
    const result = validateCapability(cap, { knownValues: ['In transit'] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.issues.filter((i) => i.code === 'output_value_in_artifact').map((i) => i.path.at(-1));
      expect(paths).toEqual(expect.arrayContaining(['within', 'selector']));
    }
  });

  it("checks an anchor's column selector too, and binds it like any selector (an optional field: older artifacts still validate)", () => {
    const cap = clone(baseCapability());
    const step = cap.steps[2]!;
    if (step.action.type !== 'click') throw new Error('expected the click step');
    step.action.target.locators.push({
      strategy: { kind: 'relative', anchor: { text: 'Order {input.memberId}', exact: true, selector: 'td.status-in-transit' }, relation: 'right-of', tag: 'td' },
      confidence: 0.5,
      source: 'inferred',
    });
    const result = validateCapability(cap, { knownValues: ['In transit'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.filter((i) => i.code === 'output_value_in_artifact').map((i) => i.path.slice(-2))).toEqual([['anchor', 'selector']]);
    step.action.target.locators.pop();
    step.action.target.locators.push({
      strategy: { kind: 'relative', anchor: { text: 'Order {input.memberId}', exact: true, selector: 'td:nth-child(1)' }, relation: 'right-of', tag: 'td' },
      confidence: 0.5,
      source: 'inferred',
    });
    expect(validateCapability(cap).ok).toBe(true);
    for (const shipped of ['artifacts/lookup-member-savings-balance.json', 'artifacts/examples/lookup-member-savings-balance.example.json']) {
      expect(validateCapability(JSON.parse(readFileSync(shipped, 'utf8'))).ok, shipped).toBe(true);
    }
  });

  it("matches a relative locator's selector as a plain substring, like a css selector", () => {
    const cap = clone(baseCapability());
    const step = cap.steps[2]!;
    if (step.action.type !== 'click') throw new Error('expected the click step');
    step.action.target.locators.push({
      strategy: { kind: 'relative', anchor: { text: 'Search' }, relation: 'below', tag: 'div', selector: 'div.row98765' },
      confidence: 0.5,
      source: 'inferred',
    });
    const result = validateCapability(cap, { knownValues: ['98765'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain('output_value_in_artifact');
  });
});

describe('validateCapability: output_value_in_artifact matches whole tokens outside identity fields', () => {
  it('does not flag a value that only appears in machine-generated identity fields', () => {
    const cap = clone(baseCapability());
    cap.id = 'lookup-member-sample-account-type';
    cap.name = 'Lookup Member Sample Account Type';
    cap.app.tenant = 'sample';
    cap.provenance.discoveryRunId = 'run-sample-1';
    cap.provenance.model = 'sample-model';
    expect(validateCapability(cap, { knownValues: ['Sample'] }).ok).toBe(true);
  });

  it('flags a value in a business-outcome name, a recovery-rule name or the provenance notes', () => {
    const cap = clone(baseCapability());
    cap.businessOutcomes[0]!.name = 'overdrawn_98765';
    cap.recoveryRules[0]!.name = 'dismiss_alert_sample';
    cap.provenance.notes = 'Balance was $1,234.56 at record time.';
    const result = validateCapability(cap, { knownValues: ['98765', 'Sample', '$1,234.56'] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.issues.filter((i) => i.code === 'output_value_in_artifact').map((i) => i.path);
      expect(paths).toEqual(expect.arrayContaining([['businessOutcomes', 0, 'name'], ['recoveryRules', 0, 'name'], ['provenance', 'notes']]));
    }
  });

  it('matches selectors, URLs and URL patterns as substrings, since a value can be glued to other characters there', () => {
    const cap = clone(baseCapability());
    const step = cap.steps[2]!;
    if (step.action.type !== 'click') throw new Error('fixture: s03 is a click');
    step.action.target.locators = [{ strategy: { kind: 'css', selector: 'tr#member12345' }, confidence: 0.3, source: 'inferred' }];
    cap.steps[0]!.action = { type: 'navigate', url: '{baseUrl}/m12345/profile' };
    cap.steps[2]!.postcondition = { kind: 'url_matches', pattern: '/members/id12345(?![0-9])' };
    cap.app.entryUrl = '{baseUrl}/login?ref=x12345';
    const result = validateCapability(cap, { knownValues: ['12345'] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.issues.filter((i) => i.code === 'output_value_in_artifact').map((i) => i.path);
      expect(paths).toEqual(
        expect.arrayContaining([
          ['steps', 2, 'action', 'target', 'locators', 0, 'strategy', 'selector'],
          ['steps', 0, 'action', 'url'],
          ['steps', 2, 'postcondition', 'pattern'],
          ['app', 'entryUrl'],
        ]),
      );
    }
  });

  it('keeps whole-token matching for text fields: a glued value in prose or match text is not flagged', () => {
    const cap = clone(baseCapability());
    cap.success.condition = { kind: 'text_visible', text: 'Member #M12345X' };
    cap.success.description = 'Shows account A12345.';
    expect(validateCapability(cap, { knownValues: ['12345'] }).ok).toBe(true);
  });

  it('does not flag a value found only inside a longer word ("Active" in "Inactive")', () => {
    const cap = clone(baseCapability());
    cap.success.description = 'The member record shows Inactive or Reactivated status.';
    expect(validateCapability(cap, { knownValues: ['Active'] }).ok).toBe(true);
  });

  it('does not flag a number found only inside a longer number', () => {
    const cap = clone(baseCapability());
    cap.success.description = 'Account 1234567 is shown.';
    expect(validateCapability(cap, { knownValues: ['12345'] }).ok).toBe(true);
  });

  it('still flags the same value as a whole token in content fields', () => {
    const cap = clone(baseCapability());
    cap.id = 'lookup-member-sample-account-type';
    cap.steps[3]!.name = 'Read the Sample balance';
    cap.success.description = 'The member record shows Active status.';
    const result = validateCapability(cap, { knownValues: ['Sample', 'active'] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(expect.objectContaining({ code: 'output_value_in_artifact', path: ['steps', 3, 'name'] }));
      expect(result.issues).toContainEqual(expect.objectContaining({ code: 'output_value_in_artifact', path: ['success', 'description'] }));
      expect(result.issues.some((i) => i.path[0] === 'id')).toBe(false);
    }
  });
});

describe('validateCapability: unknown_input for {input.x} placeholders anywhere replay binds', () => {
  function expectUnknownInputAt(cap: Capability, path: (string | number)[]): void {
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContainEqual(expect.objectContaining({ code: 'unknown_input', path }));
  }

  it('accepts placeholders naming declared inputs in conditions, locators, outcomes and recoveries', () => {
    const cap = clone(baseCapability());
    cap.success.condition = { kind: 'text_visible', text: 'Member {input.memberId}' };
    cap.steps[2]!.postcondition = { kind: 'text_visible', text: '{input.memberId}' };
    cap.businessOutcomes[0]!.detector = { kind: 'text_visible', text: 'Access Denied for {input.memberId}' };
    cap.recoveryRules[0]!.trigger = { kind: 'text_visible', text: 'Notice for {input.memberId}' };
    expect(validateCapability(cap).ok).toBe(true);
  });

  it('flags an undeclared placeholder in the success condition', () => {
    const cap = clone(baseCapability());
    cap.success.condition = { kind: 'all', of: [{ kind: 'text_visible', text: 'Member {input.bogus}' }] };
    expectUnknownInputAt(cap, ['success', 'condition', 'of', 0, 'text']);
  });

  it('flags an undeclared placeholder in a step pre/postcondition', () => {
    const cap = clone(baseCapability());
    cap.steps[2]!.precondition = { kind: 'url_matches', pattern: '/members/{input.bogus}$' };
    cap.steps[2]!.postcondition = { kind: 'text_visible', text: '{input.other}' };
    expectUnknownInputAt(cap, ['steps', 2, 'precondition', 'pattern']);
    expectUnknownInputAt(cap, ['steps', 2, 'postcondition', 'text']);
  });

  it('flags an undeclared placeholder in a locator name, label, text or css selector', () => {
    const cap = clone(baseCapability());
    const step = cap.steps[2]!;
    if (step.action.type !== 'click') throw new Error('fixture: s03 is a click');
    step.action.target.locators = [
      { strategy: { kind: 'role', role: 'button', name: '{input.a}' }, confidence: 0.9, source: 'recorded' },
      { strategy: { kind: 'label', label: '{input.b}' }, confidence: 0.8, source: 'recorded' },
      { strategy: { kind: 'text', text: '{input.c}' }, confidence: 0.7, source: 'recorded' },
      { strategy: { kind: 'css', selector: '[data-id="{input.d}"]' }, confidence: 0.6, source: 'recorded' },
    ];
    const result = validateCapability(cap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const unknown = result.issues.filter((i) => i.code === 'unknown_input').map((i) => i.path.join('.'));
      expect(unknown).toEqual([
        'steps.2.action.target.locators.0.strategy.name',
        'steps.2.action.target.locators.1.strategy.label',
        'steps.2.action.target.locators.2.strategy.text',
        'steps.2.action.target.locators.3.strategy.selector',
      ]);
    }
  });

  it('flags an undeclared placeholder in a business-outcome detector or extract target', () => {
    const cap = clone(baseCapability());
    cap.businessOutcomes[0]!.detector = { kind: 'text_visible', text: 'Access Denied for {input.bogus}' };
    cap.businessOutcomes[0]!.extract![0]!.target.description = 'Reason for {input.other}';
    expectUnknownInputAt(cap, ['businessOutcomes', 0, 'detector', 'text']);
    expectUnknownInputAt(cap, ['businessOutcomes', 0, 'extract', 0, 'target', 'description']);
  });

  it('flags an undeclared placeholder in a recovery trigger or recovery action', () => {
    const cap = clone(baseCapability());
    cap.recoveryRules[0]!.trigger = { kind: 'text_visible', text: 'Notice {input.bogus}' };
    cap.recoveryRules[0]!.actions.push({ type: 'wait', condition: { kind: 'text_absent', text: '{input.other}' } });
    expectUnknownInputAt(cap, ['recoveryRules', 0, 'trigger', 'text']);
    expectUnknownInputAt(cap, ['recoveryRules', 0, 'actions', 1, 'condition', 'text']);
  });

  it('flags an undeclared placeholder in a tenant override patch target or extra step', () => {
    const cap = clone(baseCapability());
    cap.overrides![0]!.stepPatches.push({ stepId: 's03', target: { ...searchButtonTarget(), description: 'Search {input.bogus}' } });
    cap.overrides![0]!.extraSteps = [
      {
        afterStepId: 's03',
        step: { id: 'e1', name: 'Wait', risk: 'read', action: { type: 'wait', condition: { kind: 'text_visible', text: '{input.other}' } } },
      },
    ];
    expectUnknownInputAt(cap, ['overrides', 0, 'stepPatches', 1, 'target', 'description']);
    expectUnknownInputAt(cap, ['overrides', 0, 'extraSteps', 0, 'step', 'action', 'condition', 'text']);
  });

  it('does not flag prose that is never bound (capability description, step names)', () => {
    const cap = clone(baseCapability());
    cap.description = 'Look up member {input.someoneElse}.';
    cap.steps[0]!.name = 'Open {input.someoneElse}';
    expect(validateCapability(cap).ok).toBe(true);
  });
});

// --- warnings: unverified_input_binding ------------------------------------------

describe('validateCapability: unverified_input_binding warning', () => {
  // Only this describe's code: the base capability also carries an unbound_outcome_detector
  // warning (its access_denied detector), covered in the describe below.
  function warningsOf(cap: Capability): { code: string; path: (string | number)[] }[] {
    const result = validateCapability(cap);
    if (!result.ok) throw new Error(`expected valid, got: ${JSON.stringify(result.issues)}`);
    return result.warnings.filter((w) => w.code === 'unverified_input_binding').map((w) => ({ code: w.code, path: w.path }));
  }

  it('warns (without failing validation) when an input drives the lookup but only static text is checked', () => {
    // s02 types {memberId}, s03 clicks; neither a later postcondition nor success binds an input.
    expect(warningsOf(baseCapability())).toEqual([{ code: 'unverified_input_binding', path: ['steps', 2] }]);
  });

  it('points at the last input-bound step or click after the first input-bound step', () => {
    const cap = clone(baseCapability());
    cap.steps.splice(3, 0, {
      id: 's05',
      name: 'Open the member row',
      action: {
        type: 'click',
        target: { description: 'result row', frame: [], locators: [{ strategy: { kind: 'text', text: '{input.memberId}' }, confidence: 0.7, source: 'inferred' }] },
      },
      postcondition: { kind: 'text_visible', text: 'Savings' },
      risk: 'read',
    });
    expect(warningsOf(cap)).toEqual([{ code: 'unverified_input_binding', path: ['steps', 3] }]);
  });

  it('is absent when a postcondition at or after the last input-bound step binds an input', () => {
    const cap = clone(baseCapability());
    cap.steps[2]!.postcondition = {
      kind: 'all',
      of: [{ kind: 'text_visible', text: 'Savings' }, { kind: 'url_matches', pattern: '/members/{input.memberId}(?![A-Za-z0-9])', frame: [{ name: 'main' }] }],
    };
    expect(warningsOf(cap)).toEqual([]);
  });

  it('is absent when the success condition binds an input', () => {
    const cap = clone(baseCapability());
    cap.success.condition = { kind: 'all', of: [cap.success.condition, { kind: 'url_matches', pattern: '/members/{input.memberId}' }] };
    expect(warningsOf(cap)).toEqual([]);
  });

  it('a binding checkpoint BEFORE the last input-bound click does not count', () => {
    const cap = clone(baseCapability());
    cap.steps[1]!.postcondition = { kind: 'text_visible', text: '{input.memberId}' };
    expect(warningsOf(cap)).toEqual([{ code: 'unverified_input_binding', path: ['steps', 2] }]);
  });

  it('is absent when only a sensitive input (a credential) drives the steps', () => {
    const cap = clone(baseCapability());
    cap.inputs.memberId!.sensitive = true;
    expect(warningsOf(cap)).toEqual([]);
  });

  it('is absent when no step is driven by an input', () => {
    const cap = clone(baseCapability());
    cap.steps[1] = { ...cap.steps[1]!, action: { type: 'type', target: memberSearchTarget(), value: { kind: 'literal', value: '12345' }, clear: true } };
    cap.inputs = {};
    expect(warningsOf(cap)).toEqual([]);
  });

  describe('a read tied to the input by its locators needs no checkpoint', () => {
    type Strategy = TargetDescriptor['locators'][number]['strategy'];
    const chain = (...strategies: Strategy[]): TargetDescriptor => ({
      description: 'the value',
      frame: [],
      locators: strategies.map((strategy) => ({ strategy, confidence: 0.5, source: 'inferred' as const })),
    });
    /** A price found only below the exact product name, inside that product's container. */
    const ANCHORED: Strategy = { kind: 'relative', anchor: { text: '{input.memberId}', exact: true }, relation: 'below', tag: 'div', selector: 'div.price', within: 'div.card' };
    /** The warning, at the extract: bound to the input, it is the last input-driven step. */
    const AT_THE_EXTRACT = [{ code: 'unverified_input_binding', path: ['steps', 3] }];
    /** The base capability with its extract (steps[3]) reading through `strategies`. */
    function reading(...strategies: Strategy[]): Capability {
      const cap = clone(baseCapability());
      const extract = cap.steps[3]!;
      if (extract.action.type !== 'extract') throw new Error('expected an extract');
      extract.action.target = chain(...strategies);
      return cap;
    }

    it('is absent when every locator of every extract is bound to an input', () => {
      expect(warningsOf(reading(ANCHORED))).toEqual([]);
      expect(warningsOf(reading(ANCHORED, { kind: 'text', text: 'Balance of {input.memberId}', exact: true }))).toEqual([]);
      expect(warningsOf(reading({ kind: 'css', selector: 'tr[data-member="{input.memberId}"] td.balance' }))).toEqual([]);
      expect(warningsOf(reading({ kind: 'relative', anchor: { text: 'Savings Balance' }, relation: 'right-of', within: 'div[data-member="{input.memberId}"]' }))).toEqual([]);
    });

    it.each([
      ['a bbox fallback', { kind: 'bbox', x: 0.1, y: 0.2, w: 0.1, h: 0.05 }],
      ['a static label anchor', { kind: 'relative', anchor: { text: 'Savings Balance' }, relation: 'right-of' }],
      ['a structural selector', { kind: 'css', selector: 'table > tr:nth-of-type(2) > td.balance' }],
      ['a static label', { kind: 'label', label: 'Savings Balance' }],
    ] as [string, Strategy][])('stays when the chain also holds %s', (_what, loose) => {
      expect(warningsOf(reading(ANCHORED, loose))).toEqual(AT_THE_EXTRACT);
      expect(warningsOf(reading(loose, ANCHORED))).toEqual(AT_THE_EXTRACT);
    });

    it('stays for a selector that holds the input and still picks by position', () => {
      // The first result of a search for the input is not the input's record.
      for (const selector of ['div[data-q="{input.memberId}"] li:nth-child(1)', 'div[data-q="{input.memberId}"] > li', 'ul#q-{input.memberId} li.first']) {
        expect(warningsOf(reading({ kind: 'css', selector })), selector).toEqual(AT_THE_EXTRACT);
      }
    });

    it('stays when one of two extracts is not tied to an input', () => {
      const cap = reading(ANCHORED);
      cap.outputs.status = { type: 'string', description: 'Status' };
      cap.steps.push({ id: 's05', name: 'Read the status', action: { type: 'extract', target: chain({ kind: 'label', label: 'Status' }), output: 'status' }, risk: 'read' });
      expect(warningsOf(cap)).toEqual(AT_THE_EXTRACT);
      const second = cap.steps[4]!;
      if (second.action.type !== 'extract') throw new Error('expected an extract');
      second.action.target = chain({ kind: 'relative', anchor: { text: '{input.memberId}', exact: true }, relation: 'right-of', tag: 'td' });
      expect(warningsOf(cap)).toEqual([]);
    });

    it('stays when the capability reads nothing', () => {
      const cap = reading(ANCHORED);
      cap.steps.pop();
      cap.outputs = {};
      expect(warningsOf(cap)).toEqual([{ code: 'unverified_input_binding', path: ['steps', 2] }]);
    });

    it('stays when only a sensitive input is in the locators: it names no record', () => {
      const cap = reading({ kind: 'relative', anchor: { text: '{input.pin}', exact: true }, relation: 'below', within: 'div.card' });
      cap.inputs.pin = { type: 'string', description: 'PIN', required: true, sensitive: true };
      expect(warningsOf(cap)).toEqual([{ code: 'unverified_input_binding', path: ['steps', 2] }]);
    });

    it('stays when a tenant override retargets the extract, or adds one, with a chain that is not tied', () => {
      const retargeted = reading(ANCHORED);
      retargeted.overrides = [{ tenant: 'tenant-b', stepPatches: [{ stepId: 's04', target: chain({ kind: 'css', selector: 'table > tr:nth-of-type(2) > td' }) }] }];
      expect(warningsOf(retargeted)).toEqual(AT_THE_EXTRACT);
      const tied = reading(ANCHORED);
      tied.overrides = [{ tenant: 'tenant-b', stepPatches: [{ stepId: 's04', target: chain(ANCHORED) }] }];
      expect(warningsOf(tied)).toEqual([]);
      const added = reading(ANCHORED);
      added.overrides = [
        {
          tenant: 'tenant-b',
          stepPatches: [],
          extraSteps: [{ afterStepId: 's04', step: { id: 'x01', name: 'Read it again', action: { type: 'extract', target: chain({ kind: 'label', label: 'Savings Balance' }), output: 'savingsBalance' }, risk: 'read' } }],
        },
      ];
      expect(warningsOf(added)).toEqual(AT_THE_EXTRACT);
    });
  });

  it('never appears on an invalid result, and the example artifact validates without it', () => {
    const example: unknown = JSON.parse(
      readFileSync(new URL('../../../../artifacts/examples/lookup-member-savings-balance.example.json', import.meta.url), 'utf8'),
    );
    const result = validateCapability(example);
    expect(result.ok && result.warnings.filter((w) => w.code === 'unverified_input_binding')).toEqual([]);
    const invalid = validateCapability({ ...baseCapability(), riskLevel: 'irreversible' });
    expect(invalid.ok).toBe(false);
    expect('warnings' in invalid).toBe(false);
  });
});

// --- warnings: unbound_outcome_detector ------------------------------------------

describe('validateCapability: unbound_outcome_detector warning', () => {
  function outcomeWarnings(cap: unknown): { path: (string | number)[]; message: string }[] {
    const result = validateCapability(cap);
    if (!result.ok) throw new Error(`expected valid, got: ${JSON.stringify(result.issues)}`);
    return result.warnings.filter((w) => w.code === 'unbound_outcome_detector').map((w) => ({ path: w.path, message: w.message }));
  }
  const paths = (cap: unknown) => outcomeWarnings(cap).map((w) => w.path);
  const readArtifact = (rel: string): unknown => JSON.parse(readFileSync(new URL(`../../../../${rel}`, import.meta.url), 'utf8'));

  it('warns when an unbound detector is checked after a step that submits what an earlier step typed from an input', () => {
    // base: s02 types {memberId}, s03 clicks Search, access_denied ("Access Denied") is checked after s03.
    const [w] = outcomeWarnings(baseCapability());
    expect(w?.path).toEqual(['businessOutcomes', 0, 'detector']);
    expect(w?.message).toContain('"access_denied" is detected after step "s03", which submits what step "s02" filled from input "memberId"');
  });

  it('the shipped and example artifacts: exactly their member_not_found outcome, never the access-denied one (its step clicks the row named by the input)', () => {
    expect(paths(readArtifact('artifacts/lookup-member-savings-balance.json'))).toEqual([['businessOutcomes', 0, 'detector']]);
    expect(outcomeWarnings(readArtifact('artifacts/lookup-member-savings-balance.json'))[0]?.message).toContain('"member_not_found" is detected after step "s07"');
    expect(paths(readArtifact('artifacts/examples/lookup-member-savings-balance.example.json'))).toEqual([['businessOutcomes', 0, 'detector']]);
    expect(paths(readArtifact('tests/fixtures/open-subaccount.draft.json'))).toEqual([]);
  });

  it('is absent when the detector binds the input', () => {
    const cap = clone(baseCapability());
    cap.businessOutcomes[0]!.detector = { kind: 'all', of: [{ kind: 'text_visible', text: 'Access Denied' }, { kind: 'url_matches', pattern: 'memberId={input.memberId}' }] };
    expect(paths(cap)).toEqual([]);
  });

  it('is absent when the step it is checked after carries the input itself', () => {
    const cap = clone(baseCapability());
    cap.steps[2] = {
      ...cap.steps[2]!,
      action: { type: 'click', target: { description: 'row {input.memberId}', frame: [], locators: [{ strategy: { kind: 'text', text: '{input.memberId}' }, confidence: 0.7, source: 'inferred' }] } },
    };
    expect(paths(cap)).toEqual([]);
  });

  it('is absent when an input-bound condition sits between the fill and the submit, but the submit\'s own postcondition does not count', () => {
    const filled = clone(baseCapability());
    filled.steps[1]!.postcondition = { kind: 'text_visible', text: '{input.memberId}' };
    expect(paths(filled)).toEqual([]);

    const pre = clone(baseCapability());
    pre.steps[2]!.precondition = { kind: 'text_visible', text: '{input.memberId}' };
    expect(paths(pre)).toEqual([]);

    // Replay checks outcomes BEFORE the step's own postcondition, so binding it there is too late.
    const own = clone(baseCapability());
    own.steps[2]!.postcondition = { kind: 'url_matches', pattern: 'memberId={input.memberId}' };
    expect(paths(own)).toEqual([['businessOutcomes', 0, 'detector']]);
  });

  it('is absent when no form was filled from an input before the step, or only a credential was', () => {
    const early = clone(baseCapability());
    early.businessOutcomes[0]!.afterSteps = ['s01'];
    expect(paths(early)).toEqual([]);

    const sensitive = clone(baseCapability());
    sensitive.inputs.memberId!.sensitive = true;
    expect(paths(sensitive)).toEqual([]);
  });

  it('with no afterSteps (checked after every step), warns once if any step qualifies', () => {
    const cap = clone(baseCapability());
    delete cap.businessOutcomes[0]!.afterSteps;
    expect(paths(cap)).toEqual([['businessOutcomes', 0, 'detector']]);
  });
});
