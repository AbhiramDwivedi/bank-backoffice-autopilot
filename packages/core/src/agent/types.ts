/**
 * Discovery agent: shared types.
 *
 * The agent never imports Playwright or the Anthropic SDK directly from the loop: it talks to a
 * `Surface` (packages/core/src/surface/types.ts) and an `LlmClient` (below). Only packages/adapter-anthropic/src/llm.ts imports the SDK.
 */
import type {
  Capability,
  CapabilityIssue,
  JsonType,
  Policy,
  RiskClass,
} from '../schema/index.js';
import type { Surface, SurfaceAction } from '../surface/index.js';
import type { RunLogger } from '../evidence/index.js';
import type { EscalationHandler } from '../session/index.js';
import type { PolicyUrlCheck, RiskJudge } from '../policy/index.js';

// ---------------------------------------------------------------------------------------------
// Policy seam. `packages/core/src/policy/guard.ts` exports `createPolicyGuard(policy)`; the agent codes against
// this structural subset of it, so tests can supply a stub guard.
// ---------------------------------------------------------------------------------------------

/** A policy guard's verdict on one action or URL. */
export type PolicyDecision = 'allow' | 'deny' | 'flag_irreversible';

/** Context passed alongside an action to {@link PolicyGuardLike.checkAction}. */
export interface PolicyActionContext {
  runKind?: 'discovery';
  /** Accessible name of the target element, if the action has one. */
  targetName?: string;
  /** Visible text of the target element, if the action has one. */
  targetText?: string;
  /** Top-document URL at the moment of the check. */
  currentUrl: string;
}

/** Result of a policy check: what to do, why, and (for an action check) the risk to record. */
export interface PolicyCheck {
  decision: PolicyDecision;
  reason: string;
  /** Absent => the agent derives it: 'irreversible' when flagged, else 'read'. */
  risk?: RiskClass;
}


/** Structural seam onto the production policy guard: decides whether an action or URL is allowed. */
export interface PolicyGuardLike {
  /**
   * The action is the concrete SurfaceAction with `{ref}` target and any typed `value` masked as
   * '[REDACTED]': the guard decides on type, target and URL, never on the value.
   */
  checkAction(action: SurfaceAction, ctx: PolicyActionContext): PolicyCheck;
  checkUrl(url: string): PolicyUrlCheck;
}

// ---------------------------------------------------------------------------------------------
// LLM seam. Provider-neutral and single-turn: every model call is ONE user message built fresh
// from the current observation + a short history (no growing transcript, no thinking-block
// replay, bounded cost). The Anthropic client maps these to SDK types; the scripted client
// replays canned tool calls in tests.
// ---------------------------------------------------------------------------------------------

/** One block of a user turn's content: plain text, or a screenshot image. */
export type LlmInputBlock =
  | { type: 'text'; text: string }
  /** PNG screenshot. `evidencePath` (run-dir relative) is what the transcript records instead of the bytes. */
  | { type: 'image'; pngBase64: string; evidencePath?: string };

/** A single, self-contained user turn: the agent never sends assistant history back to the model. */
export interface LlmMessage {
  role: 'user';
  content: LlmInputBlock[];
}

/** A tool the model may call, in provider-neutral form. */
export interface LlmToolDef {
  name: string;
  description: string;
  /** JSON Schema object; strict-compatible: additionalProperties:false and every property required. */
  input_schema: Record<string, unknown>;
}

/** One `LlmClient.complete` call: a fresh, single-turn request built from the current state. */
export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: LlmToolDef[];
  maxTokens: number;
}

/** One block of a model response: plain text, or a tool call. */
export type LlmOutputBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

/** Token counts for one model call. */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/** Result of one model call, mapped out of the provider's own response shape. */
export interface LlmResponse {
  content: LlmOutputBlock[];
  /** 'tool_use' | 'end_turn' | 'max_tokens' | 'refusal' | ... (provider stop reason, passed through). */
  stopReason: string | null;
  usage: LlmUsage;
  /** Model that actually served the call (may differ from requested after a server-side fallback). */
  model: string;
}

/** Provider-neutral model client the discovery loop calls once per turn. */
export interface LlmClient {
  /** Model id, recorded in capability.provenance.model. */
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

// ---------------------------------------------------------------------------------------------
// discover()
// ---------------------------------------------------------------------------------------------

/** Declaration of one input value for a discovery run. */
export interface InputDecl {
  /** The concrete value used during THIS run. Never shown to the model when sensitive. */
  value: string;
  sensitive: boolean;
  description: string;
  type: JsonType;
}

/** Declaration of one expected output, as a hint to the model. */
export interface OutputDecl {
  type: JsonType;
  description: string;
}

/** Options for {@link discover}: the goal, target app, wiring for the surface/policy/LLM seams,
 *  and the run's inputs, declared outputs, and limits. */
export interface DiscoverOptions {
  goal: string;
  target: { baseUrl: string; entryUrl: string };
  app: { vendor: string; product: string; productVersion?: string; surface: 'web' | 'desktop'; tenant?: string };
  inputs: Record<string, InputDecl>;
  /** Declared expected outputs (hint to the model; `done` is refused until each is extracted). */
  outputs?: Record<string, OutputDecl>;
  surface: Surface;
  /** Loaded policy: discoveryMode, limits, redaction patterns. */
  policy: Policy;
  guard: PolicyGuardLike;
  logger: RunLogger;
  llm: LlmClient;
  escalate?: EscalationHandler;
  /**
   * Judgment-based risk check (docs/design/risk-judge.md), consulted after the lexical guard
   * allows a committing action, as `policy.risk.judge.mode` says. Absent = lexical only.
   */
  judge?: RiskJudge;
  /** Called each time the judge could not answer (error, timeout, malformed), so the CLI can tell
   *  the operator. `onError` is the policy's `risk.judge.onError`. */
  onRiskJudgeUnavailable?: (info: { judge: string; reason: string; onError: 'fail_closed' | 'fail_open' }) => void;
  /**
   * Env var names the model may reference with a secret binding (e.g. MOCK_USER, MOCK_PASSWORD).
   * Their values are resolved only at act() time and are scrubbed from everything persisted and
   * from everything shown to the model.
   */
  secretEnvNames: string[];
  /** Credential resolver for `secretEnvNames` (typically `CredentialSet.get`). Omitted: none of
   *  them resolves, and the agent is told so when it tries to bind one. */
  secrets?: (env: string) => string | undefined;
  /** Defaults: policy.limits.* */
  maxSteps?: number;
  maxLlmCalls?: number;
  maxDurationMs?: number;
  /** kebab-case; default derived from the goal. */
  capabilityId?: string;
  capabilityName?: string;
  /**
   * The operator's assertion that replaying the recorded capability -- whole, or with steps
   * removed -- changes nothing in the target app (`discover --read-only`). Recorded as
   * `readOnly: true`; it is what lets the optimizer replay variants of it. Not verified.
   */
  readOnly?: boolean;
  /** Outcome-discovery mode: probe for exceptional outcomes and merge them into this capability. */
  extend?: Capability;
  /** Injectable for tests. */
  now?: () => Date;
  /** Wait for an `expect` text after acting. Default 5000. */
  expectTimeoutMs?: number;
  /** Per-action timeout passed to surface.act/readText. Default 10000. */
  actionTimeoutMs?: number;
}

/** How a discovery run ended. */
export type DiscoveryStatus = 'success' | 'stuck' | 'max_steps' | 'aborted';

/** Outcome of one {@link discover} call. */
export interface DiscoveryResult {
  status: DiscoveryStatus;
  /** Present on success and validated by validateCapability. */
  capability?: Capability;
  /** Validation issues when the draft could not be made valid (draft written to draftPath). */
  issues?: CapabilityIssue[];
  /** Why the run ended when not 'success' (stuck reason, limit hit, abort). */
  reason?: string;
  runId: string;
  stepsRecorded: number;
  llmCalls: number;
  /** Run-dir relative: 'transcript.jsonl'. */
  transcriptPath: string;
  /** Run-dir relative: 'capability.draft.json' when written. */
  draftPath?: string;
  /** Non-sensitive values extracted during the run, for the operator's eyes. */
  outputs?: Record<string, string | number | boolean>;
  /**
   * Set when the run was declared read-only (`DiscoverOptions.readOnly`) but recorded an
   * irreversible step: the ids of those steps. The declaration was dropped -- the capability is
   * written without `readOnly` -- rather than letting the contradiction fail the whole discovery.
   */
  readOnlyDropped?: string[];
  usage: LlmUsage;
  /** Present when a risk judge was wired in and its mode is not 'off'. */
  riskJudge?: RiskJudgeSummary;
}

/** Risk-judge activity over one discovery run. */
export interface RiskJudgeSummary {
  id: string;
  mode: 'advise' | 'enforce';
  /** Calls that reached the judge (cache hits excluded). */
  calls: number;
  cacheHits: number;
  unavailable: number;
  /** Actions the judge raised above the lexical risk (enforce mode). */
  raised: number;
}
