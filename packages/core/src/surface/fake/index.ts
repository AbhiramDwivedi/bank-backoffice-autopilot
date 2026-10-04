/**
 * Public entry point for `FakeSurface`: scenario authoring (`scenario.ts`), matching helpers
 * (`match.ts`), and the `FakeSurface` class itself (`surface.ts`). Re-exports exactly what
 * `packages/core/src/surface/fake.ts` used to export as a single file, before the split.
 */
export type {
  FakeElementSpec,
  FakeScreenSpec,
  TransitionTarget,
  TransitionContext,
  TransitionMatch,
  TransitionRule,
  FakeScenario,
} from './scenario.js';
export { DEFAULT_VIEWPORT, el, ScenarioBuilder, scenario } from './scenario.js';
export type { InjectedFailure, Clock, FakeSurfaceOptions } from './surface.js';
export { realClock, FAKE_PNG, FakeSurface } from './surface.js';
