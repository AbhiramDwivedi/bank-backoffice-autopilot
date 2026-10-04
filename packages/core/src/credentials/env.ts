/**
 * The default credential provider: environment variables, read once at load time.
 *
 * This is the only place in core and in the CLI that reads a credential from `process.env`. It lives
 * in core rather than in an adapter because it wraps nothing external: an environment is already
 * a name -> string map.
 */
import { credentialSet } from './set.js';
import type { CredentialProvider } from './types.js';

/** Reads each requested name from `env` (default `process.env`). Unset and empty both count as absent. */
export function envCredentialProvider(env: Readonly<Record<string, string | undefined>> = process.env): CredentialProvider {
  return {
    id: 'env',
    load(names) {
      const found: Record<string, string | undefined> = {};
      for (const n of names) found[n] = env[n];
      return Promise.resolve({ ok: true, set: credentialSet(found) });
    },
  };
}
