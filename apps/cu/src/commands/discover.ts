/**
 * `discover` CLI command.
 *
 * Wires the composition root (`compose.ts`) to the discovery agent (`packages/core/src/agent`): builds typed
 * inputs/outputs from repeatable `--input`/`--sensitive`/`--output` flags, resolves an Anthropic
 * LLM client (or fails fast, before any browser is launched, if `ANTHROPIC_API_KEY` is unset),
 * runs `discover()`, then validates + scans the resulting capability for a secret/sensitive leak
 * before writing it to disk.
 *
 * Two guards keep an unattended run from doing damage:
 * - `--auto-operator approve` answers escalations without a human, so on its own it never
 *   confirms an irreversible action: the run uses the policy's `discoveryMode: 'block'`
 *   behaviour (the agent is told the action was refused and carries on). Only
 *   `--allow-unattended-irreversible` lets the scripted operator confirm them.
 * - The default output path `artifacts/<id>.json` is never overwritten: if it already exists
 *   the run refuses to start (and, if it appears during the run, the capability is written into
 *   the run directory instead). An explicit `--out` is written as given.
 *
 * After a successful run, and before the capability is written, it is optimized: a model-free,
 * replay-verified pass (discover-optimize.ts, runtime/run-optimize.ts) that collapses exact repeats,
 * drops checkpoints that already held before their step, and removes steps the replay does not need.
 * `--no-optimize` skips it; a failure in it never loses the discovered capability. `--candidates <n>`
 * runs the whole discovery n times and keeps the best verified candidate (discover-candidates.ts).
 *
 * Ctrl-C shuts the session down and ends the run with exit code 130, reporting the capability
 * path when the file was already written, else that none was written.
 *
 * `runDiscover` is the testable core (commander-free); `registerDiscover` only parses flags and
 * calls it. Tests inject a scripted LLM / policy / surface / browser via `deps` so nothing here
 * ever needs a real Anthropic API key or a real Chromium download to be exercised.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';
import type { Browser } from 'playwright';
import {
  compose,
  DEFAULT_OPERATOR_PORT,
  INTERRUPTED_EXIT_CODE,
  isInterruptedError,
  runWithShutdown,
  attachAutoOperator,
  startRelayConsole,
  loadRunCredentials,
  preloadedCredentialProvider,
  isCredentialsUnavailableError,
  type AutoOperatorMode,
  type DesktopRunOptions,
  type RelayServerHandle,
  type TrialReplayPassThrough,
} from '../runtime/index.js';
import { envCredentialProvider, type CredentialProvider, type CredentialSet } from '@cu/core/credentials';
import { isDesktopUrl } from '@cu/core/surface';
import { credentialProviderOf, globalsOf, parseKeyValues, parsePort, collect } from '../globals.js';
import { CRASH_EXIT_CODE } from '../exit-code.js';
import { baseUrlPolicyError } from '../base-url-policy.js';
import { discover, type DiscoverOptions, type DiscoveryResult, type InputDecl, type LlmClient, type OutputDecl } from '@cu/core/agent';
import { createAnthropicClient } from '@cu/adapter-anthropic';
import { IDENT_RE, KEBAB_RE, validateCapability, type Capability, type JsonType, type Policy } from '@cu/core/schema';
import type { Surface } from '@cu/core/surface';
import type { RiskJudge } from '@cu/core/policy';
import { RISK_JUDGE_CHOICES, resolveRiskJudge, riskJudgeBanner, riskJudgeUnavailableLine, type RiskJudgeChoice } from './risk-judge.js';
import { optimizeDiscovered, referenceOutputsFor, type DiscoverOptimizeOutcome } from './discover-optimize.js';
import { runCandidates } from './discover-candidates.js';

/** The credential names the agent may bind when no `--secret` is given: the mock app's demo login,
 *  so the documented demo commands work unchanged. Credentials are never CLI inputs: the agent
 *  references them by name, and the values come from the run's CredentialProvider. */
export const DEFAULT_SECRET_NAMES: readonly string[] = ['MOCK_USER', 'MOCK_PASSWORD'];

const OUTPUT_TYPES: ReadonlySet<string> = new Set<JsonType>(['string', 'number', 'boolean']);

/** discover-specific exit code: the run ended without success (stuck/max_steps/aborted), not a
 *  crash. */
const STUCK_EXIT_CODE = 2;

// -------------------------------------------------------------------------------------------
// Flag parsing (pure, exported so apps/cu/src/commands/discover.test.ts can exercise it directly).
// -------------------------------------------------------------------------------------------

/**
 * `--input name=value` (repeatable) + `--sensitive name` (repeatable) -> typed `InputDecl`s.
 * Every declared input is recorded as `type: 'string'` regardless of whether the value looks
 * numeric: the CLI has no way to know the author's intent (a member id that is all digits is
 * still conceptually a string, and the recorder itself derives a `^\d+$` pattern for all-digit
 * values). Keeping the CLI's own type fixed at 'string' avoids a guess here duplicating (and
 * potentially disagreeing with) that later step.
 */
export function parseInputDecls(pairs: readonly string[], sensitiveNames: readonly string[]): Record<string, InputDecl> {
  const raw = parseKeyValues([...pairs], '--input');
  for (const name of Object.keys(raw)) {
    if (!IDENT_RE.test(name)) throw new Error(`--input "${name}" is not a valid identifier (letters, digits, underscore; not starting with a digit)`);
  }
  const sensitiveSet = new Set(sensitiveNames);
  for (const name of sensitiveSet) {
    if (!(name in raw)) throw new Error(`--sensitive ${name} does not match any --input ${name}=...`);
  }
  const out: Record<string, InputDecl> = {};
  for (const [name, value] of Object.entries(raw)) {
    out[name] = {
      value,
      sensitive: sensitiveSet.has(name),
      description: `"${name}" (supplied on the command line)`,
      type: 'string',
    };
  }
  return out;
}

/** `--output name:type` (repeatable) -> typed `OutputDecl`s. */
export function parseOutputDecls(pairs: readonly string[]): Record<string, OutputDecl> {
  const out: Record<string, OutputDecl> = {};
  for (const p of pairs) {
    const i = p.indexOf(':');
    if (i <= 0) throw new Error(`--output expects name:type, got "${p}"`);
    const name = p.slice(0, i);
    const type = p.slice(i + 1);
    if (!IDENT_RE.test(name)) throw new Error(`--output "${name}" is not a valid identifier (letters, digits, underscore; not starting with a digit)`);
    if (!OUTPUT_TYPES.has(type)) throw new Error(`--output ${name}: type must be one of string|number|boolean, got "${type}"`);
    out[name] = { type: type as JsonType, description: `"${name}" (declared on the command line)` };
  }
  return out;
}

function joinEntry(baseUrl: string, entry: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = entry.startsWith('/') ? entry : `/${entry}`;
  return `${base}${suffix}`;
}

/** The values a discovered capability must never contain in plaintext: every loaded credential's
 *  value that is long enough to be a meaningful fragment rather than noise (>= 3 chars, the same
 *  floor the session broker scrubs at), plus every `--sensitive` input's concrete run value. */
export function forbiddenValues(inputs: Record<string, InputDecl>, credentials: CredentialSet): string[] {
  return forbiddenEntries(inputs, credentials).map((e) => e.value);
}

/** {@link forbiddenValues}, each with a value-free label saying where it came from. */
function forbiddenEntries(inputs: Record<string, InputDecl>, credentials: CredentialSet): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  for (const name of credentials.names()) {
    const v = credentials.get(name);
    if (v !== undefined && v.length >= 3) out.push({ label: `credential ${name}`, value: v });
  }
  for (const [name, decl] of Object.entries(inputs)) {
    if (decl.sensitive && decl.value.length > 0) out.push({ label: `sensitive input ${name}`, value: decl.value });
  }
  return out;
}

/** Which forbidden values `serialized` contains, by label (a credential or input NAME), never the value. */
export function leakedLabels(serialized: string, inputs: Record<string, InputDecl>, credentials: CredentialSet): string[] {
  return forbiddenEntries(inputs, credentials)
    .filter((e) => serialized.includes(e.value))
    .map((e) => e.label);
}

function nextReplayCommand(artifactPath: string, inputs: Record<string, InputDecl>): string {
  const flags = Object.entries(inputs)
    .filter(([, decl]) => !decl.sensitive)
    .map(([name, decl]) => `--input ${name}=${decl.value}`)
    .join(' ');
  return `npm run replay -- ${artifactPath}${flags ? ` ${flags}` : ''}`;
}

function isEaddrinuse(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
}

// -------------------------------------------------------------------------------------------
// runDiscover: the testable core.
// -------------------------------------------------------------------------------------------

/** Inputs to `runDiscover`, gathered from CLI flags and globals. */
export interface RunDiscoverOptions {
  goal: string;
  /** Raw `name=value` pairs from repeated `--input`. */
  input: string[];
  /** Input names from repeated `--sensitive`. */
  sensitive: string[];
  /** Raw `name:type` pairs from repeated `--output`. */
  output: string[];
  id: string;
  /** Path to an existing capability JSON file (outcome-discovery / extend mode). */
  extend?: string;
  /** Where to write the capability. Given: written there, replacing any existing file. Omitted:
   *  `artifacts/<id>.json`, which is never overwritten. */
  out?: string;
  /** Path under the base URL the run starts at. Default '/login' for a web app; a desktop app
   *  (desktop://<process> base URL) starts at the app itself, so its default is none. */
  entry?: string;
  /** For a desktop://<process> base URL: how to start or attach to the app (--app-command / --attach-pid). */
  desktop?: DesktopRunOptions;
  vendor: string;
  product: string;
  operatorPort: number;
  autoOperator: AutoOperatorMode;
  /** With `autoOperator: 'approve'`, let the scripted operator confirm irreversible actions
   *  (risky_action_confirmation). Without it they are refused, as in `discoveryMode: 'block'`. */
  allowUnattendedIrreversible?: boolean;
  /** `--risk-judge`: which judgment-based risk check to layer over the lexical patterns. Default
   *  `auto` (Claude, on the ANTHROPIC_API_KEY discovery already needs). See docs/design/risk-judge.md. */
  riskJudge?: RiskJudgeChoice;
  /** Credential names the agent may bind (repeatable `--secret`). Omitted or empty:
   *  {@link DEFAULT_SECRET_NAMES}. Given: replaces that list. */
  secret?: string[];
  // --- globals (globalsOf(cmd) in the real CLI) ---
  /** Where the credentials come from (`--credentials`). Default: the environment. */
  credentials?: CredentialProvider;
  policy: string;
  runsDir: string;
  headless: boolean;
  baseUrl: string;
  tenant?: string;
  overrideKey?: string;
  // --- the optimization stage ---
  /** `--no-optimize` sets this false. Default true. */
  optimize?: boolean;
  optimizeMaxTrials?: number;
  optimizeVerifyRuns?: number;
  /** `--read-only`: the operator's assertion that replaying the recorded capability, whole or with
   *  steps removed, changes nothing in the app. Recorded as `readOnly: true`; the optimization
   *  stage replays only under it. */
  readOnly?: boolean;
  /** Internal (`--candidates`): write the capability to `<run dir>/candidate.json` instead of the destination. */
  candidateInRunDir?: boolean;
  /** `--candidates <n>`: run the discovery n times and keep the best verified one (runDiscoverCandidates). Default 1. */
  candidates?: number;
}

/** Injectable collaborators for `runDiscover`, so tests can run without a real LLM or browser. */
export interface RunDiscoverDeps {
  llm?: LlmClient;
  /** Injected risk judge. With `llm` injected and no `judge`, the run has no judge (tests). */
  judge?: RiskJudge;
  surface?: Surface;
  browser?: Browser;
  policy?: Policy;
  /** Progress messages (never a run's final report, which always goes to real stdout). Default
   *  `console.error`. */
  print?: (line: string) => void;
  /** Fresh surface per optimization trial, for tests that inject `surface`. Without it, an injected
   *  `surface` skips the optimization stage (there is no way to open fresh sessions on it). */
  trialSurface?: () => Surface | Promise<Surface>;
  /** Allowlisted runReplay options for every optimization trial (e.g. a credentials provider). */
  trialReplay?: TrialReplayPassThrough;
}

/** The outcome of `runDiscover`: exit code, the discovery result if the agent ran, and where any
 *  artifact or run evidence landed. */
export interface RunDiscoverResult {
  exitCode: number;
  result?: DiscoveryResult;
  artifactPath?: string;
  runDir: string;
  /** The optimization stage's outcome, when the run got that far. */
  optimize?: DiscoverOptimizeOutcome;
}

/** Parsed & validated CLI input, before any composition happens. */
interface ParsedArgs {
  inputs: Record<string, InputDecl>;
  outputs: Record<string, OutputDecl>;
  extendCapability?: Capability;
}

/** The default artifact path for a capability id, relative to the working directory. */
export function defaultArtifactPath(id: string): string {
  return path.join('artifacts', `${id}.json`);
}

/**
 * Why `--entry` is not a URL path under `--base-url`, or undefined when it is one ('' means the
 * base URL itself). Git Bash (MSYS) rewrites an argument that starts with "/" into a Windows path
 * before any program sees it, so `--entry /` arrives as "C:/Program Files/Git/" and would be
 * navigated to as `<base>/C:/Program Files/Git/`. A drive letter or a backslash is a filesystem
 * path, never a URL path, so it is refused before anything starts, with the fix. Exported for tests.
 */
export function entryPathError(entry: string): string | undefined {
  if (entry === '') return undefined;
  if (/^[A-Za-z]:([\\/]|$)/.test(entry) || entry.includes('\\')) {
    return (
      `--entry ${JSON.stringify(entry)} is a filesystem path, not a URL path under --base-url. ` +
      'Git Bash rewrites an argument that starts with "/" into a Windows path before the program sees it ' +
      '(--entry / arrives as "C:/Program Files/Git/"). Run the command with MSYS_NO_PATHCONV=1 in front ' +
      '(MSYS_NO_PATHCONV=1 npm run discover -- ... --entry /login), or give the path without its leading slash ' +
      '(--entry login), or --entry "" for the base URL itself.'
    );
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(entry)) {
    return `--entry ${JSON.stringify(entry)} is a full URL; --entry is a path under --base-url (put the origin in --base-url and the path in --entry).`;
  }
  return undefined;
}

function parseArgsOrThrow(opts: RunDiscoverOptions): ParsedArgs {
  if (!KEBAB_RE.test(opts.id)) throw new Error(`--id "${opts.id}" must be lowercase kebab-case (e.g. "lookup-member-savings-balance")`);
  const entryError = opts.entry !== undefined ? entryPathError(opts.entry) : undefined;
  if (entryError !== undefined) throw new Error(entryError);
  if (opts.input.length === 0) throw new Error('at least one --input name=value is required');
  if (opts.output.length === 0) throw new Error('at least one --output name:type is required');
  if (opts.allowUnattendedIrreversible === true && opts.autoOperator !== 'approve') {
    throw new Error('--allow-unattended-irreversible only applies with --auto-operator approve');
  }
  if (opts.out === undefined) {
    const target = defaultArtifactPath(opts.id);
    if (fs.existsSync(target)) {
      throw new Error(
        `${target} already exists; refusing to overwrite it. Pass --out <path> to write the new capability elsewhere ` +
          `(or --out ${target} to replace it deliberately).`,
      );
    }
  }

  const inputs = parseInputDecls(opts.input, opts.sensitive);
  const outputs = parseOutputDecls(opts.output);

  let extendCapability: Capability | undefined;
  if (opts.extend !== undefined) {
    const raw = fs.readFileSync(opts.extend, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const validated = validateCapability(parsed);
    if (!validated.ok) {
      throw new Error(`--extend ${opts.extend} is not a valid capability: ${JSON.stringify(validated.issues)}`);
    }
    extendCapability = validated.capability;
  }

  return { inputs, outputs, ...(extendCapability ? { extendCapability } : {}) };
}

/**
 * Runs one discovery session end to end: validates flags, resolves an LLM client, starts the
 * Relay console, composes the runtime, and runs the discovery agent against the target
 * application. Writes the resulting capability to disk unless it fails validation or would leak
 * a secret or sensitive input value, in which case it refuses to write and returns a non-zero
 * exit code.
 */
export async function runDiscover(opts: RunDiscoverOptions, deps: RunDiscoverDeps = {}): Promise<RunDiscoverResult> {
  const progress = deps.print ?? ((line: string): void => {
    console.error(line);
  });
  const report = (line: string): void => {
    console.log(line);
  };

  // --- 1. Flag validation + --extend read, all before touching any resource. -----------------
  let parsed: ParsedArgs;
  try {
    parsed = parseArgsOrThrow(opts);
  } catch (err) {
    progress(`discover: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: CRASH_EXIT_CODE, runDir: '' };
  }
  const { inputs, outputs, extendCapability } = parsed;

  // --- 2. LLM client: fail fast, before any browser is launched, if no key is available. -----
  // Secrets the agent may bind must exist before anything starts: an unset one would make a
  // `type source:"secret"` action silently type nothing and leave the model to flail at the login.
  const secretNames = opts.secret !== undefined && opts.secret.length > 0 ? [...new Set(opts.secret)] : [...DEFAULT_SECRET_NAMES];
  let credentials: CredentialSet;
  try {
    credentials = await loadRunCredentials(opts.credentials ?? envCredentialProvider(), secretNames);
  } catch (err) {
    if (!isCredentialsUnavailableError(err)) throw err;
    progress(`discover: ${err.message}`);
    return { exitCode: CRASH_EXIT_CODE, runDir: '' };
  }

  let llm: LlmClient;
  if (deps.llm) {
    llm = deps.llm;
  } else if (!process.env.ANTHROPIC_API_KEY) {
    progress('discover: ANTHROPIC_API_KEY is not set; refusing to start (no browser launched). Set it in the environment or in .env.');
    return { exitCode: CRASH_EXIT_CODE, runDir: '' };
  } else {
    llm = createAnthropicClient();
  }

  // --- 2.1. Risk judge (docs/design/risk-judge.md): resolved before any browser is launched. An
  //          injected LLM without an injected judge means a test, which runs lexical-only. -------
  let riskJudge: { judge?: RiskJudge; label: string };
  if (deps.judge !== undefined) {
    riskJudge = { judge: deps.judge, label: deps.judge.id };
  } else if (deps.llm !== undefined) {
    riskJudge = { label: 'off (no judge injected)' };
  } else {
    const resolved = resolveRiskJudge(opts.riskJudge ?? 'auto');
    if (!resolved.ok) {
      progress(`discover: ${resolved.error}; refusing to start (no browser launched).`);
      return { exitCode: CRASH_EXIT_CODE, runDir: '' };
    }
    riskJudge = resolved;
  }
  let judgeDownReported = false;

  // --- 2.5. --base-url's origin must be in the loaded policy's allowedOrigins, fail fast before
  //          any browser is launched. `deps.policy` (an already-loaded Policy, used by tests and
  //          by compose() itself when given) wins over loading opts.policy from disk, exactly
  //          like compose()'s own "already-loaded policy wins over policyPath". ------------------
  const originError = baseUrlPolicyError(opts.baseUrl, opts.policy, deps.policy);
  if (originError !== undefined) {
    progress(`cu: ${originError}`);
    return { exitCode: CRASH_EXIT_CODE, runDir: '' };
  }

  // --- 3. Relay console: started BEFORE compose() (which launches the browser), so a port
  //        conflict here never leaves a browser behind. -----------------------------------------
  let operatorHandle: RelayServerHandle | undefined;
  try {
    operatorHandle = await startRelayConsole({ port: opts.operatorPort, log: progress });
  } catch (err) {
    if (!isEaddrinuse(err)) throw err;
    progress(`discover: operator port ${opts.operatorPort} is already in use; continuing without the Relay console.`);
  }
  if (operatorHandle) {
    const headedHint = opts.headless ? '' : ' -- with --headed, a human can also take control directly in the browser window';
    progress(`discover: Relay console at ${operatorHandle.url}${headedHint}`);
  }

  try {
    const c = await compose({
      runKind: 'discovery',
      credentials,
      sensitiveValues: Object.values(inputs).filter((decl) => decl.sensitive).map((decl) => decl.value),
      ...(deps.policy ? { policy: deps.policy } : { policyPath: opts.policy }),
      runsDir: opts.runsDir,
      baseUrl: opts.baseUrl,
      headless: opts.headless,
      ...(deps.browser ? { browser: deps.browser } : {}),
      ...(deps.surface ? { surface: deps.surface } : {}),
      ...(opts.desktop ? { desktop: opts.desktop } : {}),
      ...(operatorHandle ? { operator: { server: operatorHandle } } : {}),
    });

    // An unattended approver must not confirm irreversible actions on its own: refuse them before
    // they escalate, exactly as `discoveryMode: 'block'` does, unless explicitly allowed.
    const blockIrreversible = opts.autoOperator === 'approve' && opts.allowUnattendedIrreversible !== true;
    const agentPolicy: Policy = blockIrreversible ? { ...c.policy, risk: { ...c.policy.risk, discoveryMode: 'block' } } : c.policy;
    if (blockIrreversible) {
      progress('discover: --auto-operator approve refuses irreversible actions in this run (pass --allow-unattended-irreversible to let it confirm them).');
    } else if (opts.autoOperator === 'approve') {
      progress('discover: warning: --allow-unattended-irreversible lets the scripted operator confirm irreversible actions with no human review.');
    }

    progress(`discover: ${riskJudgeBanner(riskJudge, c.policy)}`);

    const scriptedOp = attachAutoOperator(c.broker, opts.autoOperator, { baseUrl: opts.baseUrl, log: progress, approveRiskyActions: !blockIrreversible });
    // Set the moment the capability file is written, so a Ctrl-C that lands after the write (while
    // the run is still shutting down) reports the file that exists instead of "none written".
    let writtenPath: string | undefined;
    try {
      return await runWithShutdown(
        c,
        async () => {
          // The base URL's scheme says what kind of app this is; a desktop app has no entry path.
          const desktopApp = isDesktopUrl(opts.baseUrl);
          const entry = opts.entry ?? (desktopApp ? '' : '/login');
          const entryUrl = entry === '' ? opts.baseUrl : joinEntry(opts.baseUrl, entry);
          const discoverOpts: DiscoverOptions = {
            goal: opts.goal,
            target: { baseUrl: opts.baseUrl, entryUrl },
            app: {
              vendor: opts.vendor,
              product: opts.product,
              surface: desktopApp ? 'desktop' : 'web',
              ...(opts.overrideKey !== undefined ? { tenant: opts.overrideKey } : {}),
            },
            inputs,
            outputs,
            surface: c.surface,
            policy: agentPolicy,
            guard: c.guard,
            logger: c.logger,
            llm,
            escalate: c.escalate,
            secretEnvNames: secretNames,
            secrets: (name) => credentials.get(name),
            capabilityId: opts.id,
            ...(opts.readOnly === true ? { readOnly: true } : {}),
            ...(extendCapability ? { extend: extendCapability } : {}),
            ...(riskJudge.judge !== undefined
              ? {
                  judge: riskJudge.judge,
                  onRiskJudgeUnavailable: (info: Parameters<typeof riskJudgeUnavailableLine>[0]) => {
                    if (judgeDownReported) return;
                    judgeDownReported = true;
                    progress(`discover: ${riskJudgeUnavailableLine(info)}`);
                  },
                }
              : {}),
          };

          const result = await discover(discoverOpts);
          return finalize(result, opts, inputs, credentials, c.logger.dir, c.policy, report, progress, (p) => {
            writtenPath = p;
          }, deps);
        },
        progress,
      );
    } catch (err) {
      if (!isInterruptedError(err)) throw err;
      progress(`discover: ${err.message}; ${writtenPath !== undefined ? `capability written to ${writtenPath}` : 'no capability written'}`);
      return { exitCode: INTERRUPTED_EXIT_CODE, runDir: c.logger.dir, ...(writtenPath !== undefined ? { artifactPath: writtenPath } : {}) };
    } finally {
      scriptedOp?.stop();
      await scriptedOp?.idle();
    }
  } finally {
    await operatorHandle?.close().catch(() => undefined);
  }
}

/** Reports the run, writes the capability (with a leak scan), and picks the exit code. Runs
 *  inside `runWithShutdown`'s body, so `c.close()` still happens after this returns.
 *  `onWritten` is called with the artifact path right after the file is written. */
async function finalize(
  result: DiscoveryResult,
  opts: RunDiscoverOptions,
  inputs: Record<string, InputDecl>,
  credentials: CredentialSet,
  runDir: string,
  policy: Policy,
  report: (line: string) => void,
  progress: (line: string) => void,
  onWritten: (artifactPath: string) => void,
  deps: RunDiscoverDeps = {},
): Promise<RunDiscoverResult> {
  // The run directory itself is not reported here: runWithShutdown (apps/cu/src/runtime/lifecycle.ts)
  // already announces it exactly once, on stderr, on every path -- printing it again on stdout
  // would duplicate that same path.
  report(`run id: ${result.runId}`);
  report(`status: ${result.status}`);
  if (result.readOnlyDropped !== undefined) {
    progress(
      `discover: warning: the goal was declared --read-only, but the run performed an irreversible action (step ${result.readOnlyDropped.join(', ')}); ` +
        'the read-only declaration was removed from the capability and no optimization trials will run',
    );
  }
  report(`steps recorded: ${result.stepsRecorded}`);
  report(`llm calls: ${result.llmCalls}`);
  if (result.riskJudge !== undefined) {
    const j = result.riskJudge;
    report(`risk judge calls: ${j.calls} (${j.id}, ${j.mode}; cache hits ${j.cacheHits}, unavailable ${j.unavailable}, raised ${j.raised})`);
  }
  report(
    `usage: input=${result.usage.inputTokens} output=${result.usage.outputTokens}` +
      (result.usage.cacheReadInputTokens !== undefined ? ` cacheRead=${result.usage.cacheReadInputTokens}` : '') +
      (result.usage.cacheCreationInputTokens !== undefined ? ` cacheCreation=${result.usage.cacheCreationInputTokens}` : ''),
  );

  if (result.status !== 'success' || result.capability === undefined) {
    report(`reason: ${result.reason ?? '(none)'}`);
    if (result.issues) report(`validation issues: ${JSON.stringify(result.issues)}`);
    if (result.draftPath) report(`draft written: ${path.join(runDir, result.draftPath)}`);
    if (result.outputs && Object.keys(result.outputs).length > 0) report(`outputs extracted so far: ${JSON.stringify(result.outputs)}`);
    return { exitCode: STUCK_EXIT_CODE, result, runDir };
  }

  // Defense in depth: discover() already validates internally, but the CLI is the last gate
  // before anything touches disk, so it re-validates and re-scans for a leak on its own.
  const revalidated = validateCapability(result.capability, {
    irreversibleTextPatterns: policy.risk.irreversibleTextPatterns,
    irreversibleUrlPatterns: policy.risk.irreversibleUrlPatterns,
  });
  if (!revalidated.ok) {
    progress(`discover: refusing to write -- the final capability failed validation: ${JSON.stringify(revalidated.issues)}`);
    report(`validation issues: ${JSON.stringify(revalidated.issues)}`);
    return { exitCode: CRASH_EXIT_CODE, result, runDir };
  }

  const serialized = `${JSON.stringify(revalidated.capability, null, 2)}\n`;
  const leaked = leakedLabels(serialized, inputs, credentials);
  if (leaked.length > 0) {
    // Names only. A short or common value (a username like "admin") can appear in the app's own
    // text and cause a false refusal; the name tells the author which one to look at.
    progress(`discover: refusing to write the capability -- it contains the value of ${leaked.join(', ')}.`);
    return { exitCode: CRASH_EXIT_CODE, result, runDir };
  }

  // Optimization stage: never throws, and hands back the discovered capability on any failure. The
  // first Ctrl-C stops it between trials (the signal), so the write below still happens.
  const stageAbort = new AbortController();
  const onStageSignal = (): void => stageAbort.abort();
  process.on('SIGINT', onStageSignal);
  process.on('SIGTERM', onStageSignal);
  const referenceOutputs = referenceOutputsFor(revalidated.capability, result.outputs);
  const optimized = await optimizeDiscovered({
    capability: revalidated.capability,
    inputs: Object.fromEntries(Object.entries(inputs).map(([name, decl]) => [name, decl.value])),
    ...(referenceOutputs !== undefined ? { referenceOutputs } : {}),
    runId: result.runId,
    runDir,
    runsDir: opts.runsDir,
    baseUrl: opts.baseUrl,
    headless: opts.headless,
    ...(opts.overrideKey !== undefined ? { tenant: opts.overrideKey } : {}),
    policy,
    isExtend: opts.extend !== undefined,
    ...(deps.browser !== undefined ? { browser: deps.browser } : {}),
    surfaceInjected: deps.surface !== undefined,
    ...(deps.trialSurface !== undefined ? { trialSurface: deps.trialSurface } : {}),
    ...(opts.desktop !== undefined ? { desktop: opts.desktop } : {}),
    forbidden: forbiddenValues(inputs, credentials),
    signal: stageAbort.signal,
    ...(result.readOnlyDropped !== undefined ? { readOnlyDropped: result.readOnlyDropped } : {}),
    // Trials bind the same credentials the discovery run loaded, from the same source.
    replayPassThrough: deps.trialReplay ?? { credentials: preloadedCredentialProvider(credentials, (opts.credentials ?? envCredentialProvider()).id) },
    settings: {
      enabled: opts.optimize !== false,
      ...(opts.optimizeMaxTrials !== undefined ? { maxTrials: opts.optimizeMaxTrials } : {}),
      ...(opts.optimizeVerifyRuns !== undefined ? { verifyRuns: opts.optimizeVerifyRuns } : {}),
    },
    report,
    progress,
  }).finally(() => {
    process.off('SIGINT', onStageSignal);
    process.off('SIGTERM', onStageSignal);
  });
  const toWrite = optimized.optimized ? `${JSON.stringify(optimized.capability, null, 2)}\n` : serialized;

  const out = opts.candidateInRunDir === true ? path.join(runDir, 'candidate.json') : opts.out;
  const artifactPath = writeArtifact(toWrite, revalidated.capability.id, out, runDir, progress);
  onWritten(artifactPath);

  if (result.outputs && Object.keys(result.outputs).length > 0) report(`outputs: ${JSON.stringify(result.outputs)}`);
  report(`artifact: ${artifactPath}`);
  report(`next: ${nextReplayCommand(artifactPath, inputs)}`);

  return { exitCode: 0, result, artifactPath, runDir, optimize: optimized };
}

/** Writes the capability and returns its absolute path. An explicit `out` is written as given.
 *  The default `artifacts/<id>.json` is created exclusively (checked before the run started, and
 *  again here): if it appeared during the run, the capability goes into the run directory instead. */
export function writeArtifact(serialized: string, id: string, out: string | undefined, runDir: string, progress: (line: string) => void): string {
  if (out !== undefined) {
    const target = path.resolve(out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, serialized, 'utf8');
    return target;
  }
  const target = path.resolve(defaultArtifactPath(id));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(target, serialized, { encoding: 'utf8', flag: 'wx' });
    return target;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const fallback = path.resolve(runDir, `${id}.json`);
  fs.writeFileSync(fallback, serialized, 'utf8');
  progress(`discover: ${target} already exists; not overwriting it. Wrote the capability to ${fallback} instead.`);
  return fallback;
}

/**
 * `discover --candidates <n>`: runs {@link runDiscover} n times (each its own session, run
 * directory and optimization stage) and writes the best verified candidate to the destination
 * (`--out`, or the never-overwritten default). n = 1 is exactly `runDiscover`.
 */
export function runDiscoverCandidates(opts: RunDiscoverOptions, deps: RunDiscoverDeps = {}): Promise<RunDiscoverResult> {
  return runCandidates(opts, deps, { runOnce: runDiscover, writeArtifact, defaultArtifactPath });
}

// -------------------------------------------------------------------------------------------
// Commander wiring.
// -------------------------------------------------------------------------------------------

interface RawDiscoverCliOptions {
  goal: string;
  input: string[];
  sensitive: string[];
  output: string[];
  id: string;
  extend?: string;
  out?: string;
  entry?: string;
  vendor: string;
  product: string;
  operatorPort: number;
  autoOperator: AutoOperatorMode;
  allowUnattendedIrreversible?: boolean;
  riskJudge: RiskJudgeChoice;
  secret: string[];
  optimize: boolean;
  optimizeMaxTrials?: number;
  optimizeVerifyRuns?: number;
  readOnly?: boolean;
  candidates: number;
}

/** Registers the `discover` command on `program`, wiring its flags to `runDiscover`. */
export function registerDiscover(program: Command): void {
  program
    .command('discover')
    .description('Discover how to carry out a goal in the target application and record it as a capability.')
    .requiredOption('--goal <text>', 'the goal to accomplish, in plain language')
    .option('--input <name=value>', 'declare a run input (repeatable)', collect, [])
    .option('--sensitive <name>', 'mark a declared input as sensitive (repeatable)', collect, [])
    .option('--output <name:type>', 'declare an expected output; type is string|number|boolean (repeatable)', collect, [])
    .option(
      '--secret <NAME>',
      `a credential name the agent may bind, resolved by --credentials (repeatable; replaces the default ${DEFAULT_SECRET_NAMES.join(', ')})`,
      collect,
      [],
    )
    .requiredOption('--id <kebab>', 'kebab-case capability id')
    .option(
      '--extend <artifact.json>',
      'probe an existing capability (path to its JSON) for exceptional outcomes; the result is written like any other run ' +
        '(the default artifacts/<id>.json is never overwritten, so extending that file in place needs --out)',
    )
    .option(
      '--out <path>',
      'where to write the capability JSON, replacing any existing file there. Default artifacts/<id>.json, which is never ' +
        'overwritten: if it already exists the run refuses to start',
    )
    .option(
      '--entry <path>',
      'entry path under --base-url (default /login; "" for the base URL itself; a desktop://<process> app starts at the app itself). ' +
        'In Git Bash, set MSYS_NO_PATHCONV=1 or drop the leading slash: the shell turns "/login" into a Windows path',
    )
    .option('--vendor <name>', 'app.vendor for the recorded capability', 'Acme Core Systems')
    .option('--product <name>', 'app.product for the recorded capability', 'CU Core Workstation')
    .option('--operator-port <port>', 'Relay console port, an integer 0-65535 (0 = ephemeral)', parsePort, DEFAULT_OPERATOR_PORT)
    .addOption(
      new Option(
        '--auto-operator <mode>',
        'scripted operator for unattended runs: none (a human answers escalations on the Relay console), ' +
          'approve (refuses irreversible actions unless --allow-unattended-irreversible; aborts any other escalation), ' +
          'abort (aborts every escalation)',
      )
        .choices(['none', 'approve', 'abort'])
        .default('none'),
    )
    .option(
      '--allow-unattended-irreversible',
      'with --auto-operator approve only: let the scripted operator confirm irreversible actions (submit, transfer, open account...) ' +
        'with no human review. Without it those actions are refused in the run',
    )
    .addOption(
      new Option(
        '--risk-judge <judge>',
        'judgment-based check of committing actions, on top of the policy patterns: auto (anthropic, on the ANTHROPIC_API_KEY ' +
          'discover already needs), jev (needs TYPESAFE_API_KEY), anthropic, or off (lexical patterns only). How it is applied is set by the policy\'s risk.judge',
      )
        .choices([...RISK_JUDGE_CHOICES])
        .default('auto'),
    )
    .option(
      '--read-only',
      'declare the goal read-only: replaying the recorded capability, whole or with steps removed, changes nothing in the app. Recorded as ' +
        'readOnly: true; the built-in optimization replays (and so rewrites) only under it. A wrong declaration means optimization trials write to the live app',
    )
    .option('--no-optimize', 'skip the built-in optimization stage (by default the recorded capability is optimized, model-free and replay-verified, before it is written)')
    .option('--optimize-max-trials <n>', 'optimization: cap on removal trials, each one replay (default 25)', (v: string) => Number(v))
    .option('--optimize-verify-runs <n>', 'optimization: consecutive successful replays the result must pass (default 3)', (v: string) => Number(v))
    .option(
      '--candidates <n>',
      'run the whole discovery n times (n times the model cost), optimize each, and keep the verified candidate with the fewest steps if all verified ' +
        'candidates agree on the outputs; every candidate stays in its run directory. Requires --read-only',
      (v: string) => Number(v),
      1,
    )
    .action(async (_opts: unknown, cmd: Command) => {
      const cli = cmd.opts<RawDiscoverCliOptions>();
      const g = globalsOf(cmd);
      const result = await runDiscoverCandidates({
        goal: cli.goal,
        input: cli.input,
        sensitive: cli.sensitive,
        output: cli.output,
        id: cli.id,
        ...(cli.extend !== undefined ? { extend: cli.extend } : {}),
        ...(cli.out !== undefined ? { out: cli.out } : {}),
        ...(cli.entry !== undefined ? { entry: cli.entry } : {}),
        ...(g.desktop !== undefined ? { desktop: g.desktop } : {}),
        vendor: cli.vendor,
        product: cli.product,
        operatorPort: cli.operatorPort,
        autoOperator: cli.autoOperator,
        ...(cli.allowUnattendedIrreversible === true ? { allowUnattendedIrreversible: true } : {}),
        riskJudge: cli.riskJudge,
        secret: cli.secret,
        credentials: credentialProviderOf(g),
        policy: g.policy,
        runsDir: g.runsDir,
        headless: g.headless,
        baseUrl: g.baseUrl,
        ...(g.tenant !== undefined ? { tenant: g.tenant } : {}),
        ...(g.overrideKey !== undefined ? { overrideKey: g.overrideKey } : {}),
        optimize: cli.optimize,
        ...(cli.readOnly === true ? { readOnly: true } : {}),
        ...(cli.optimizeMaxTrials !== undefined ? { optimizeMaxTrials: cli.optimizeMaxTrials } : {}),
        ...(cli.optimizeVerifyRuns !== undefined ? { optimizeVerifyRuns: cli.optimizeVerifyRuns } : {}),
        candidates: cli.candidates,
      });
      process.exitCode = result.exitCode;
    });
}
