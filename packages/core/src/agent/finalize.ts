/**
 * Builds the final `DiscoveryResult` payload once the loop has ended: turning extracted outputs
 * into the operator-facing `outputs` map, and building/validating/writing the `Capability` draft
 * for a successful `done` or a `declare_outcome` extend run.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Capability, CapabilityIssue } from '../schema/index.js';
import { validateCapability } from '../schema/index.js';
import { createValueScrubber } from '../evidence/index.js';
import { findLeaks, kebabFromGoal, type BuildMeta } from './recorder.js';
import { mergeOutcomes } from './extend.js';
import type { ResultShape, RunContext } from './run-context.js';

function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Extracted outputs for the caller: outputs matching a sensitive-declared input are dropped, an
 *  output read from a masked element is returned as read (the caller asked for it; evidence gets
 *  {@link withSensitiveOutputsRedacted}), and every other value is scrubbed again in case its text
 *  happens to contain a secret. */
export function buildOutputsForResult(ctx: RunContext): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [name, value] of ctx.state.extractedOutputs.entries()) {
    if (Object.prototype.hasOwnProperty.call(ctx.sensitiveInputs, name)) continue;
    if (ctx.state.sensitiveOutputs.has(name)) {
      out[name] = value;
      continue;
    }
    // Value-based, whatever the type: a number parsed from a sensitive value must not escape.
    const asText = String(value);
    const scrubbed = ctx.scrubber.text(asText);
    out[name] = scrubbed !== asText ? scrubbed : value;
  }
  return out;
}

/** `outputs` with every name in `sensitive` replaced by `<masked:name>`, for anything persisted. */
export function withSensitiveOutputsRedacted(
  outputs: Record<string, string | number | boolean>,
  sensitive: ReadonlySet<string>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(outputs)) out[name] = sensitive.has(name) ? maskedOutputPlaceholder(name) : value;
  return out;
}

/** What a masked extracted value is replaced with in the transcript, logs and evidence. */
export function maskedOutputPlaceholder(output: string): string {
  return `<masked:${output}>`;
}

/** Builds the capability draft from the recorder's recorded steps/outcomes/success condition,
 *  validates it, and writes `capability.json` on success or `capability.draft.json` with the
 *  validation issues otherwise. */
export async function finalizeSuccess(ctx: RunContext, summary: string): Promise<ResultShape> {
  const id = ctx.opts.capabilityId ?? kebabFromGoal(ctx.opts.goal, Object.values(ctx.opts.inputs).map((d) => d.value));
  const meta: BuildMeta = {
    id,
    goal: ctx.opts.goal,
    app: ctx.opts.app,
    entryUrl: ctx.opts.target.entryUrl,
    runId: ctx.runId,
    model: ctx.opts.llm.model,
    discoveredAt: ctx.now().toISOString(),
    summary,
    validateOptions: {
      irreversibleTextPatterns: ctx.opts.policy.risk.irreversibleTextPatterns,
      irreversibleUrlPatterns: ctx.opts.policy.risk.irreversibleUrlPatterns,
    },
  };
  if (ctx.opts.capabilityName !== undefined) meta.name = ctx.opts.capabilityName;
  // The read-only declaration cannot sit on a capability that performed an irreversible action
  // (validateCapability: read_only_irreversible). The run itself succeeded, so the declaration is
  // what goes, not the capability: it is written without `readOnly`, and the caller is told.
  const irreversible = ctx.recorder.steps.filter((s) => s.risk === 'irreversible').map((s) => s.id);
  const readOnlyDropped = ctx.opts.readOnly === true && irreversible.length > 0 ? irreversible : undefined;
  if (ctx.opts.readOnly === true && readOnlyDropped === undefined) meta.readOnly = true;
  const built = ctx.recorder.build(meta);
  const outputs = buildOutputsForResult(ctx);
  if (built.ok) {
    writeJsonFile(join(ctx.opts.logger.dir, 'capability.json'), built.capability);
    return { status: 'success', capability: built.capability, outputs, ...(readOnlyDropped !== undefined ? { readOnlyDropped } : {}) };
  }
  writeJsonFile(join(ctx.opts.logger.dir, 'capability.draft.json'), built.draft);
  return { status: 'stuck', reason: 'capability_invalid', issues: built.issues, draftPath: 'capability.draft.json', outputs };
}

/** Merges any outcomes recorded during an outcome-discovery ("extend") run into the existing
 *  capability, scrubs this run's extracted values out of its prose, validates the merge (with
 *  those values as `knownValues`), and writes it the same way as `finalizeSuccess`. Fails closed
 *  (writes the redacted draft with issues instead of the capability) if the merge would persist a
 *  secret, a sensitive value, or an extracted value. */
export async function finalizeExtend(ctx: RunContext): Promise<ResultShape> {
  const existing = ctx.opts.extend as Capability;
  const merged = ctx.recorder.scrubExtractedValues(
    mergeOutcomes(existing, {
      steps: ctx.recorder.steps,
      outcomes: ctx.recorder.outcomes,
      runId: ctx.runId,
      discoveredAt: ctx.now().toISOString(),
      model: ctx.opts.llm.model,
    }),
  );
  const outputs = buildOutputsForResult(ctx);
  const knownValues = ctx.recorder.extractedValues.map((v) => v.value);
  // A draft written on either failure path is redacted of every secret, sensitive input and
  // extracted value, exactly like `recorder.build()`'s failure paths.
  const writeDraft = (): void => {
    const redacted = createValueScrubber([...ctx.scrubber.forbidden, ...knownValues]).deep(merged);
    writeJsonFile(join(ctx.opts.logger.dir, 'capability.draft.json'), redacted);
  };
  const validated = validateCapability(merged, {
    irreversibleTextPatterns: ctx.opts.policy.risk.irreversibleTextPatterns,
    irreversibleUrlPatterns: ctx.opts.policy.risk.irreversibleUrlPatterns,
    knownValues,
  });
  if (!validated.ok) {
    writeDraft();
    return { status: 'stuck', reason: 'capability_invalid', issues: validated.issues, draftPath: 'capability.draft.json', outputs };
  }
  const leaks = findLeaks(validated.capability, ctx.scrubber.forbidden);
  if (leaks.length > 0) {
    writeDraft();
    const issues: CapabilityIssue[] = leaks.map((pointer) => ({
      code: 'schema',
      path: pointer.split('/').filter(Boolean),
      message: 'secret or sensitive value would be persisted',
    }));
    return { status: 'stuck', reason: 'capability_invalid', issues, draftPath: 'capability.draft.json', outputs };
  }
  writeJsonFile(join(ctx.opts.logger.dir, 'capability.json'), validated.capability);
  return { status: 'success', capability: validated.capability, outputs };
}
