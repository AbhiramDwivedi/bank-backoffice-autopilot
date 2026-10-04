/**
 * Test and dev-harness seam: the core pieces Relay's tests and `scripts/dev.ts` need to build a
 * real SessionBroker on a FakeSurface. Like src/server/core.ts, this is the only file here that
 * reaches into the core's test support.
 */
export {
  createSessionBroker,
  type EscalationRequest,
  type EscalationResolution,
  type SessionBroker,
  type SessionBrokerOptions,
} from '@cu/core/session';
export { createRunLogger, createRunRedactor, newRunId } from '@cu/core/evidence';
export { el, FAKE_PNG, FakeSurface, scenario, type HumanActionCapture } from '@cu/core/surface';
export type { HumanAction } from '@cu/core/schema';
