/**
 * Public surface of the replay engine. Everything else under `packages/core/src/replay/**` is an
 * implementation detail of `replayCapability`.
 */
export { replayCapability } from './replay.js';
export { validateInputs } from './validate-inputs.js';
/** The effective, tenant-specific capability a run executes; the relogin operator re-runs its sign-in steps. */
export { applyTenantOverride } from './overrides.js';
export {
  describeResult,
  summarizeLocatorDrift,
  summarizeStability,
  type EscalationBreakdown,
  type LocatorDriftSummary,
  type RecoveryCount,
  type StabilitySummary,
} from './describe.js';

export type {
  ActOptions,
  BeforeStepHook,
  BeforeStepInfo,
  InputValidationResult,
  InputValue,
  PolicyActionContext,
  PolicyCheck,
  PolicyDecision,
  PolicyGuardLike,
  ReplayClock,
  ReplayOptions,
} from './types.js';
