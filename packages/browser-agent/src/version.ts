/**
 * The agent's semantic version. The major number is the compatibility contract: a driver reuses
 * an installed agent with the same major that is not older than its own copy, and re-installs its
 * own copy over an older same-major agent or one of a different major before using it. Keep in
 * sync with package.json (a test checks it).
 */
export const AGENT_VERSION = '1.4.0';
