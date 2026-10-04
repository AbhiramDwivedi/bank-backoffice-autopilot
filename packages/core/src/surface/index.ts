/**
 * Public entry for the surface module: the `Surface` seam and observation types, condition
 * evaluation helpers, desktop location URLs (`desktop://<process>/<window title>`, shared by the
 * desktop adapter and the policy guard), `FakeSurface` (tests and the operator demo) and the
 * cu-core fake scenario. Real surfaces live in adapter packages (`@cu/adapter-playwright`,
 * `@cu/adapter-desktop`) so their dependencies stay opt-in.
 */
export * from './types.js';
export { collapseWhitespace, textContains, evaluateCondition, type ConditionView, type ElementProbe, type EvaluateConditionOptions } from './conditions.js';
export { holdsWholeWord } from './whole-word.js';
export { recordTextShows } from './record-identity.js';
export { positionalFallbackRefusal, type FoundLocator, type PositionalFallbackRefusal } from './positional-fallback.js';
export {
  DESKTOP_PROTOCOL,
  decodedDesktopLocation,
  desktopOrigin,
  desktopUrlProblem,
  processNameFromImage,
  resolveDesktopRelative,
  formatDesktopUrl,
  isDesktopUrl,
  normalizeProcessName,
  parseDesktopUrl,
  type DesktopLocation,
} from './desktop-location.js';
export { committingKey, normalizeKeyName, urlPreprocess, urlShapeRefusal } from './url-shape.js';
export * from './fake/index.js';
export * from './mask.js';
export { omittedScreenshotPng, isOmittedScreenshot, OMITTED_SCREENSHOT_TEXT } from './omitted.js';
export { createCuCoreScenario, createCuCoreSurface, type CuCoreTenant, type CreateCuCoreScenarioOptions } from './fake-scenarios/cu-core.js';
