/**
 * Public API of the runtime module: the composition root. Wires a raw Surface, policy
 * enforcement, the session broker and (optionally) a Relay console (`@cu/relay`) into one
 * `Composition`, runs a replay through that wiring end to end (`runReplay`), attaches a scripted
 * operator for unattended runs, and handles graceful shutdown. Used by every CLI command and by
 * `apps/cu/src/catalog` (a library) so neither depends on the CLI.
 */
export {
  compose,
  resumingEscalation,
  resolveTenant,
  TENANTS,
  DEFAULT_BASE_URL,
  DEFAULT_POLICY_FILE,
  DEFAULT_RUNS_DIR,
  DEFAULT_OPERATOR_PORT,
  type ComposeOptions,
  type Composition,
} from './compose.js';

export { createDesktopRunSurface, type DesktopRunOptions } from './desktop.js';

export { runReplay, secretEnvNamesOf, sensitiveOutputNamesOf, controlStateLabel, type RunReplayOptions, type RunReplayResult } from './run-replay.js';

export {
  runOptimize,
  trialOutcomeOf,
  policyIrreversibility,
  DEFAULT_REMOVAL_STEP_TIMEOUT_MS,
  type RunOptimizeOptions,
  type TrialReplayPassThrough,
} from './run-optimize.js';

export { attachAutoOperator, type AutoOperatorMode, type AutoOperatorOptions } from './operators.js';

export {
  CredentialsUnavailableError,
  credentialProviderFromSpec,
  isCredentialsUnavailableError,
  loadRunCredentials,
  preloadedCredentialProvider,
} from './credentials.js';

export { runWithShutdown, InterruptedError, isInterruptedError, INTERRUPTED_EXIT_CODE } from './lifecycle.js';

export { ensureRelayBuilt, startRelayConsole, type RelayServerHandle } from './relay-ui.js';
