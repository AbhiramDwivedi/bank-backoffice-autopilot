/**
 * Fail-fast check shared by every command that takes both `--base-url` and a policy (`replay`,
 * `catalog invoke`, `discover`): `--base-url`'s origin must be one of the loaded policy's
 * `allowedOrigins`, checked BEFORE anything launches a browser or a desktop app. `compose()` (apps/cu/src/runtime/compose.ts)
 * enforces the full policy against every action once a run is underway; this is an earlier,
 * cheaper, and more specific check purely for the common "wrong port/host" mistake, so it fails
 * with one clear message instead of a browser launching and then failing on step 1's own navigate.
 *
 * "Origin" is the guard's own notion (`allowlistOrigin`): `URL.origin` for http(s), and
 * `desktop://<process>` for a desktop base URL, whose `URL.origin` would be the useless "null".
 */
import path from 'node:path';
import { allowlistOrigin, loadPolicy } from '@cu/core/policy';
import type { Policy } from '@cu/core/schema';
import { desktopUrlProblem, isDesktopUrl } from '@cu/core/surface';

/**
 * `undefined` when `baseUrl`'s origin is allowed under `policy` (or under the policy loaded from
 * `policyPath`, when `policy` itself is not given -- mirroring `ComposeOptions`'s "an already-loaded
 * policy wins over policyPath"). Otherwise the message body (no "cu:"/"cu <command>:" prefix --
 * callers add their own), covering both a disallowed origin and a policy file that failed to load.
 * Never throws.
 */
export function baseUrlPolicyError(baseUrl: string, policyPath: string, policy?: Policy): string | undefined {
  try {
    new URL(baseUrl);
  } catch {
    return `--base-url "${baseUrl}" is not a valid URL`;
  }
  const origin = allowlistOrigin(baseUrl);
  if (origin === undefined) {
    const desktop = isDesktopUrl(baseUrl) ? desktopUrlProblem(baseUrl) : undefined;
    return `--base-url "${baseUrl}" must be an http(s) URL or a desktop://<process-name> location${desktop !== undefined ? `: ${desktop}` : ''}`;
  }

  let effective: Policy;
  try {
    effective = policy ?? loadPolicy(path.resolve(policyPath));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `could not load policy ${policyPath}: ${message}`;
  }

  if (effective.allowedOrigins.some((o) => allowlistOrigin(o) === origin)) return undefined;
  return `origin ${origin} is not in policy ${policyPath} allowedOrigins; add it or pass --policy`;
}
