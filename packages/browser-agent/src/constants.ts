/**
 * Constants shared by the in-page bundle and the Node-side entry. No DOM or Node APIs here, so
 * both sides can import it.
 */

/** Text that replaces a secret value. A copy of the repo's marker in src/schema/constants.ts:
 * this package cannot depend on core, and the two must stay equal. */
export const REDACTED_VALUE = '[REDACTED]';

/** Hard cap on every string the agent emits, except `bodyText` (see DEFAULT_MAX_BODY_TEXT). */
export const MAX_STRING = 300;

/** The fallback sink keeps at most this many records; the oldest are dropped first. */
export const EVENT_BUFFER_MAX = 500;

/** Default cap on `enumerate().bodyText`. Equal to the driver's text-digest cap, so the digest it
 * builds from per-frame body text is unchanged. */
export const DEFAULT_MAX_BODY_TEXT = 8000;

/** Global the agent installs itself under. */
export const AGENT_GLOBAL = '__cuAgent';

/** Function a driver installs (Playwright `exposeBinding`) to receive captured actions directly. */
export const ACTION_BINDING = '__cuHumanAction';

/** `type` of the `window.postMessage` envelope the fallback sink posts: `{ type, action }`. */
export const ACTION_MESSAGE_TYPE = 'cu-agent:action';

/** Attribute set on `<html>` (value: the agent version) so presence is detectable without JS. */
export const DETECT_ATTRIBUTE = 'data-cu-agent';

/** Attribute naming the screen-mask rule that hid an element (a short `[a-z0-9_]` slug); see mask.ts. */
export const MASK_KIND_ATTR = 'data-cu-mask-kind';

/**
 * Attribute on the paint host of a hidden text range: the element the redaction stylesheet hides
 * for it (value: the plan's nonce). Pixels only: the text channel never reads it as a masked element.
 */
export const MASK_PAINT_ATTR = 'data-cu-mask-paint';
