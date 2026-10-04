/**
 * Credentials in the composition root: turning a `--credentials` spec into a `CredentialProvider`,
 * and loading a run's credentials before anything starts.
 *
 * A run loads its credentials exactly once, before a Relay console, a browser or a model client
 * exists, so a missing credential costs nothing to discover. The loaded `CredentialSet` then flows
 * to every place a credential is touched: `compose()` (the redactor's value list), replay and
 * discovery (binding `{kind:'secret'}` values), discover's leak scan, and the relogin operator.
 *
 * A load failure here is a configuration error of the invocation, like an unreadable policy file,
 * so it is thrown as `CredentialsUnavailableError` (typed, carrying the `CredentialFailure`) rather
 * than folded into a `ReplayResult`, which describes what happened in the app. Its message names
 * credentials and the provider, never a value.
 */
import { loadCredentials, describeCredentialFailure, type CredentialFailure, type CredentialProvider, type CredentialSet } from '@cu/core/credentials';
import { parseCredentialSpec } from '@cu/adapter-credentials';

/** Thrown by {@link loadRunCredentials} when the provider cannot supply every requested name. */
export class CredentialsUnavailableError extends Error {
  constructor(public readonly failure: CredentialFailure) {
    super(`${describeCredentialFailure(failure)}; refusing to start (no browser launched)`);
    this.name = 'CredentialsUnavailableError';
  }
}

/** True for a {@link CredentialsUnavailableError}. */
export function isCredentialsUnavailableError(err: unknown): err is CredentialsUnavailableError {
  return err instanceof CredentialsUnavailableError;
}

/**
 * The provider for a `--credentials` / `CU_CREDENTIALS` spec: `env`, `file:<path>` or
 * `exec:<command>`. Throws an `Error` naming the accepted forms (never the spec's argument text)
 * for anything else.
 */
export function credentialProviderFromSpec(spec: string): CredentialProvider {
  const parsed = parseCredentialSpec(spec);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.provider;
}

/** Loads `names` from `provider`; throws {@link CredentialsUnavailableError} unless every one resolved. */
export async function loadRunCredentials(provider: CredentialProvider, names: readonly string[]): Promise<CredentialSet> {
  const result = await loadCredentials(provider, names);
  if (!result.ok) throw new CredentialsUnavailableError(result.error);
  return result.set;
}

/**
 * A provider that answers from a set already loaded: for a command that must load credentials
 * itself, before it launches a browser or mutates the target app (`replay --times`, `--fault`), and
 * then hands the run a provider. Keeps the original provider's id for messages.
 */
export function preloadedCredentialProvider(set: CredentialSet, id: string): CredentialProvider {
  return { id, load: () => Promise.resolve({ ok: true, set }) };
}
