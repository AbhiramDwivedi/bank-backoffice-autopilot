/** Bundle entry for dist/cu-agent.js: installs `window.__cuAgent` (idempotent). Never throws into the page. */
import { installAgent } from './agent.js';

try {
  installAgent();
} catch {
  /* a hostile page broke a built-in the agent relies on; the page itself must keep working */
}
