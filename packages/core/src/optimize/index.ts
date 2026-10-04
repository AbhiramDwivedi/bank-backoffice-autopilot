/**
 * Public surface of the capability optimizer: a deterministic, model-free search over an existing
 * capability, verified by replay through an injected trial runner. It never creates a surface or
 * a browser and never touches a model (pinned by replay/no-llm.redteam.test.ts). See
 * docs/design/optimize.md.
 */
export { optimizeCapability, outputsEqual } from './optimize.js';
export { createBeforeStepProbe, type BeforeStepProbe } from './probe.js';
export { provenanceNote, summarizeOptimization } from './report.js';
export { bumpPatch, collapseRedundantRepeats, inputsConsumedBy, lastInputUseStepIds, protectedStepIds, trialCopy } from './rewrite.js';
export {
  DEFAULT_MAX_TRIALS,
  DEFAULT_VERIFY_RUNS,
  type AnalysisReason,
  type KeptReason,
  type OptimizeAnalysis,
  type OptimizeChange,
  type OptimizeOptions,
  type OptimizeReport,
  type OptimizeResult,
  type OptimizeStop,
  type OptimizeTrialRecord,
  type OutputMap,
  type RunTrial,
  type TrialOutcome,
  type TrialPurpose,
  type TrialRequest,
} from './types.js';
