/** Public entry for the Playwright surface. Other modules should depend on `Surface` only. */
export { createPlaywrightSurface, PlaywrightSurface, type AgentModeDetail, type PlaywrightSurfaceOptions } from './surface.js';
export { detectAgent, type AgentDetection, type AgentSource } from './inpage.js';
