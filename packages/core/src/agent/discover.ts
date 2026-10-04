/**
 * The discovery loop: observe -> prompt -> llm -> parse -> policy -> act -> record, until `done`,
 * `stuck`, an abort, or a limit is hit. Wires together `tools.ts`, `prompt.ts`, `recorder.ts`,
 * `scrub.ts`/`transcript.ts`, `run-context.ts` (shared `RunContext`/`LoopState`), `tool-handlers.ts`
 * (dispatch plus the escalation/give-up control flow), and `finalize.ts` (the capability draft and
 * outputs map once the loop ends).
 *
 * `recorder`'s `onLog` diagnostics are logged as `action_result` events with `data.recorder` set to
 * the message, since no other event kind fits a generic recorder note. "Steps used N/max" and the
 * `maxSteps` limit both count loop turns, not capability steps recorded, so a turn that ends in a
 * policy refusal or a failed action still counts toward the limit.
 *
 * `resolveLimits` (limits.ts) resolves the step/call/duration limits from `opts` and
 * `policy.limits`, clamping an invalid override back to the policy default. `StuckRepeatDetector`
 * (same module) flags an action repeated three turns running without meeting its expectation and
 * routes it through `stuckPath`.
 */
import type { Action, EvidenceRef, RunEventKind } from '../schema/index.js';
import type { SurfaceAction } from '../surface/index.js';
import { createGuardedJudge, resolveRiskJudgeConfig, type GuardedRiskJudge } from '../policy/index.js';
import { createRecorder } from './recorder.js';
import { resolveLimits, StuckRepeatDetector } from './limits.js';
import { createScrubber } from './scrub.js';
import { createTranscript, usageForEvidence } from './transcript.js';
import { systemPrompt, buildTurnContent, type TurnObservation, type TurnState } from './prompt.js';
import { parseToolCall, TOOL_DEFS } from './tools.js';
import type { DiscoverOptions, DiscoveryResult, DiscoveryStatus, LlmInputBlock, LlmRequest, LlmUsage } from './types.js';
import type { LoopState, ResultShape, RunContext } from './run-context.js';
import { dispatch, stuckPath } from './tool-handlers.js';
import { finalizeSuccess, finalizeExtend, buildOutputsForResult, withSensitiveOutputsRedacted } from './finalize.js';

// -------------------------------------------------------------------------------------------
// discover()
// -------------------------------------------------------------------------------------------

/** Runs one discovery (or outcome-discovery "extend") session end to end: navigates to the entry
 *  URL, then loops observe/prompt/llm/parse/policy/act/record until the model calls `done` or
 *  `stuck`, a human aborts an escalation, or a step/call/duration limit is hit. Always returns a
 *  `DiscoveryResult` (never throws); an unexpected internal error is reported as `status: 'stuck'`. */
export async function discover(opts: DiscoverOptions): Promise<DiscoveryResult> {
  const now = opts.now ?? (() => new Date());
  const logger = opts.logger;
  const runId = logger.runId;
  const isExtend = opts.extend !== undefined;

  // --- secrets / scrubbing / evidence sinks -------------------------------------------------

  const secretResolver = opts.secrets ?? ((_name: string): string | undefined => undefined);
  const secretValues: Record<string, string> = {};
  for (const name of opts.secretEnvNames) {
    const v = secretResolver(name);
    if (v !== undefined) secretValues[name] = v;
  }
  const sensitiveInputs: Record<string, string> = {};
  for (const [name, decl] of Object.entries(opts.inputs)) {
    if (decl.sensitive) sensitiveInputs[name] = decl.value;
  }

  const scrubber = createScrubber({ secrets: secretValues, sensitiveInputs, policyPatterns: opts.policy.redaction.patterns });
  const transcript = createTranscript(logger.dir, scrubber);

  function logEvent(kind: RunEventKind, data: Record<string, unknown>, extra?: { stepId?: string; evidence?: EvidenceRef }): void {
    logger.event({ kind, data: scrubber.deep(data), ...(extra?.stepId !== undefined ? { stepId: extra.stepId } : {}), ...(extra?.evidence !== undefined ? { evidence: extra.evidence } : {}) });
  }

  const recorder = createRecorder({
    baseUrl: opts.target.baseUrl,
    inputs: opts.inputs,
    outputsHint: opts.outputs,
    forbiddenValues: Object.values(secretValues),
    // No RunEventKind fits a generic recorder diagnostic, so it's logged as 'action_result' with
    // a `recorder` field instead.
    onLog: (message, data) => logEvent('action_result', { recorder: message, ...(data ?? {}) }),
  });

  // --- limits / config ------------------------------------------------------------------------

  const { maxSteps, maxLlmCalls, maxDurationMs } = resolveLimits(
    { maxSteps: opts.maxSteps, maxLlmCalls: opts.maxLlmCalls, maxDurationMs: opts.maxDurationMs },
    opts.policy.limits,
  );
  const stuckRepeats = new StuckRepeatDetector();
  const expectTimeoutMs = opts.expectTimeoutMs ?? 5000;
  const actionTimeoutMs = opts.actionTimeoutMs ?? 10000;
  const startedAtMs = now().getTime();
  // The model is told truthfully what it is looking at: a web page or a desktop app's accessibility tree.
  const system = systemPrompt({ secretEnvNames: opts.secretEnvNames, extend: isExtend, surface: opts.app.surface });

  // --- mutable loop state / shared run context ------------------------------------------------

  const state: LoopState = {
    turn: 0,
    llmCalls: 0,
    consecutiveDenies: 0,
    consecutiveNoToolUse: 0,
    escalationsUsed: 0,
    history: [],
    lastResult: undefined,
    extractedOutputs: new Map(),
    sensitiveOutputs: new Set(),
  };

  // Risk judge: wrapped once per run, so its cache and counters are this run's.
  const judgeConfig = resolveRiskJudgeConfig(opts.policy);
  const judge: GuardedRiskJudge | undefined =
    opts.judge !== undefined && judgeConfig.mode !== 'off' ? createGuardedJudge(opts.judge, { timeoutMs: judgeConfig.timeoutMs }) : undefined;

  const ctx: RunContext = {
    opts,
    runId,
    isExtend,
    recorder,
    scrubber,
    secretValues,
    sensitiveInputs,
    stuckRepeats,
    expectTimeoutMs,
    actionTimeoutMs,
    now,
    state,
    ...(judge !== undefined ? { judge: { guarded: judge, config: judgeConfig } } : {}),
    logEvent,
  };

  const usageTotal: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  function addUsage(u: LlmUsage): void {
    usageTotal.inputTokens += u.inputTokens;
    usageTotal.outputTokens += u.outputTokens;
    if (u.cacheReadInputTokens !== undefined) usageTotal.cacheReadInputTokens = (usageTotal.cacheReadInputTokens ?? 0) + u.cacheReadInputTokens;
    if (u.cacheCreationInputTokens !== undefined) {
      usageTotal.cacheCreationInputTokens = (usageTotal.cacheCreationInputTokens ?? 0) + u.cacheCreationInputTokens;
    }
  }

  function scrubTurnContent(blocks: LlmInputBlock[]): LlmInputBlock[] {
    return blocks.map((b) => (b.type === 'text' ? { ...b, text: scrubber.text(b.text) } : b));
  }

  let finishAttempted = false;
  function finishResult(partial: ResultShape): DiscoveryResult {
    const result: DiscoveryResult = {
      ...partial,
      runId,
      stepsRecorded: recorder.steps.length,
      llmCalls: state.llmCalls,
      transcriptPath: transcript.path,
      usage: usageTotal,
      ...(judge !== undefined && judgeConfig.mode !== 'off'
        ? {
            riskJudge: {
              id: judge.id,
              mode: judgeConfig.mode,
              calls: judge.calls,
              cacheHits: judge.cacheHits,
              unavailable: judge.unavailable,
              raised: state.judgeRaised ?? 0,
            },
          }
        : {}),
    };
    // Evidence copy: the shared redactor wipes any key containing "token", which would erase the
    // usage counters, so persist them under neutral key names. Scrubbed like every other sink.
    if (finishAttempted) return result; // never a second finish(), even if the first one threw
    finishAttempted = true;
    const evidence: Record<string, unknown> = { kind: 'discovery', ...result, llmUsage: usageForEvidence(usageTotal) };
    delete evidence.usage;
    // A value read from a masked element is returned to the caller but never persisted.
    if (result.outputs !== undefined) evidence.outputs = withSensitiveOutputsRedacted(result.outputs, state.sensitiveOutputs);
    logger.finish(scrubber.deep(evidence));
    return result;
  }

  function terminalResult(status: Exclude<DiscoveryStatus, 'success'>, reason: string): ResultShape {
    return { status, reason, outputs: buildOutputsForResult(ctx) };
  }

  // --- entry navigation ------------------------------------------------------------------------

  async function enterEntry(): Promise<ResultShape | undefined> {
    const urlCheck = opts.guard.checkUrl(opts.target.entryUrl);
    logEvent('policy', { decision: urlCheck.allowed ? 'allow' : 'deny', reason: urlCheck.reason, tool: 'navigate', phase: 'entry_url' });
    if (!urlCheck.allowed) return terminalResult('stuck', `entry_denied: ${urlCheck.reason}`);

    const action: SurfaceAction = { type: 'navigate', url: opts.target.entryUrl };
    const check = opts.guard.checkAction(action, { runKind: 'discovery', currentUrl: opts.target.entryUrl });
    logEvent('policy', { decision: check.decision, reason: check.reason, risk: check.risk, tool: 'navigate', phase: 'entry_action' });
    if (check.decision === 'deny') return terminalResult('stuck', `entry_denied: ${check.reason}`);
    if (check.decision === 'flag_irreversible') return terminalResult('stuck', `entry_flagged_irreversible: ${check.reason}`);

    const actResult = await opts.surface.act(action, actionTimeoutMs);
    logEvent('action', { tool: 'navigate', url: opts.target.entryUrl, why: 'Open the entry page' });
    logEvent('action_result', { ok: actResult.ok, error: actResult.error, navigated: actResult.navigated });
    if (!actResult.ok) return terminalResult('stuck', `entry_navigation_failed: ${actResult.error?.message ?? 'unknown error'}`);

    const recordAction: Action = { type: 'navigate', url: opts.target.entryUrl };
    const step = recorder.recordStep({ action: recordAction, why: 'Open the entry page', risk: check.risk ?? 'read' });
    state.history.push({ stepId: step.id, tool: 'navigate', why: 'Open the entry page' });
    return undefined;
  }

  // --- main loop --------------------------------------------------------------------------------

  try {
    const entryOutcome = await enterEntry();
    if (entryOutcome !== undefined) return finishResult(entryOutcome);

    for (;;) {
      if (state.turn >= maxSteps) return finishResult(terminalResult('max_steps', 'max_steps'));
      if (state.llmCalls >= maxLlmCalls) return finishResult(terminalResult('max_steps', 'max_llm_calls'));
      if (now().getTime() - startedAtMs > maxDurationMs) return finishResult(terminalResult('max_steps', 'max_duration'));

      state.turn += 1;

      const obs = await opts.surface.observe();
      recorder.noteLocation({ url: obs.url, frames: obs.frames });
      // No screenshot = the surface deliberately took none (screen masking): nothing to save, and
      // the prompt says "screenshot omitted".
      const shot = obs.screenshotPng !== undefined ? logger.screenshot(obs.screenshotPng) : undefined;
      logEvent(
        'observation',
        {
          url: obs.url,
          title: obs.title,
          elementCount: obs.elements.length,
          frames: obs.frames.map((f) => f.path),
          dialog: obs.dialog,
          ...(shot === undefined ? { screenshotOmitted: true } : {}),
        },
        shot !== undefined ? { evidence: { screenshot: shot } } : undefined,
      );

      const scrubbedObservation: TurnObservation = {
        url: scrubber.text(obs.url),
        title: scrubber.text(obs.title),
        frames: obs.frames,
        elements: scrubber.deep(obs.elements),
        ...(obs.elementsOmitted !== undefined && obs.elementsOmitted > 0 ? { elementsOmitted: obs.elementsOmitted } : {}),
        textDigest: scrubber.text(obs.textDigest),
        ...(obs.dialog !== undefined ? { dialog: scrubber.deep(obs.dialog) } : {}),
      };

      const turnState: TurnState = {
        goal: opts.goal,
        inputs: opts.inputs,
        secretEnvNames: opts.secretEnvNames,
        extractedOutputs: new Set(state.extractedOutputs.keys()),
        stepsUsed: state.turn,
        maxSteps,
        history: state.history,
        observation: scrubbedObservation,
        ...(obs.screenshotPng !== undefined ? { screenshotPng: obs.screenshotPng } : {}),
        ...(shot !== undefined ? { evidencePath: shot } : {}),
        ...(opts.outputs !== undefined ? { outputs: opts.outputs } : {}),
        ...(state.lastResult !== undefined ? { lastResult: state.lastResult } : {}),
      };

      const request: LlmRequest = {
        system,
        // Choke point: every text block of the outbound request is scrubbed here, so feedback
        // strings built from raw surface errors / extracted text can never carry a secret or a
        // sensitive value to the model (the transcript sink scrubs again independently).
        messages: [{ role: 'user', content: scrubTurnContent(buildTurnContent(turnState)) }],
        tools: TOOL_DEFS,
        maxTokens: 16000,
      };

      transcript.request(state.turn, request);
      state.llmCalls += 1;

      let response;
      try {
        response = await opts.llm.complete(request);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logEvent('error', { phase: 'llm_complete', message });
        return finishResult(terminalResult('stuck', `llm_error: ${message}`));
      }
      transcript.response(state.turn, response);
      addUsage(response.usage);

      if (response.stopReason === 'refusal') {
        const refusalText = response.content.find((b) => b.type === 'text')?.text ?? 'model refused to continue';
        const outcome = await stuckPath(ctx, `refusal: ${refusalText}`, obs);
        if (outcome.kind === 'continue') continue;
        return finishResult(terminalResult(outcome.kind, outcome.reason));
      }

      const toolUseBlock = response.content.find((b) => b.type === 'tool_use');
      if (!toolUseBlock) {
        state.consecutiveNoToolUse += 1;
        if (state.consecutiveNoToolUse >= 3) {
          const outcome = await stuckPath(ctx, 'model did not call a tool for 3 consecutive turns', obs);
          if (outcome.kind === 'continue') {
            state.consecutiveNoToolUse = 0;
            continue;
          }
          return finishResult(terminalResult(outcome.kind, outcome.reason));
        }
        state.lastResult = 'You must call exactly one tool.';
        continue;
      }
      state.consecutiveNoToolUse = 0;

      const parsed = parseToolCall({ name: toolUseBlock.name, input: toolUseBlock.input });
      if (!parsed.ok) {
        state.lastResult = parsed.error;
        continue;
      }

      logEvent('decision', { tool: parsed.call.tool, why: 'why' in parsed.call ? parsed.call.why : undefined, input: parsed.call });

      const outcome = await dispatch(ctx, parsed.call, obs);
      switch (outcome.kind) {
        case 'continue':
          continue;
        case 'done':
          return finishResult(await finalizeSuccess(ctx, outcome.summary));
        case 'declare_outcome_extend':
          return finishResult(await finalizeExtend(ctx));
        case 'stuck':
          return finishResult(terminalResult('stuck', outcome.reason));
        case 'aborted':
          return finishResult(terminalResult('aborted', outcome.reason));
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logEvent('error', { phase: 'internal', message });
    return finishResult(terminalResult('stuck', `internal: ${message}`));
  }
}
