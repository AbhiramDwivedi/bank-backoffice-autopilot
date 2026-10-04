/**
 * The credential-provider port: where the values behind a capability's `{kind:'secret', env}`
 * bindings come from.
 *
 * Two phases, on purpose:
 * - `CredentialProvider.load(names)` is async and runs once, before a run starts and before any
 *   browser launches. That is where a vault call, a credential-helper process or a token endpoint
 *   fits, and where a missing credential fails fast.
 * - `CredentialSet` is the synchronous result the run uses: `get` backs `BindContext.secret` at the
 *   moment a step binds, and `values` is the list the run's redactor scrubs by value.
 *
 * A binding's `env` field is simply the credential's NAME. The artifact never stores a value and
 * never says which provider resolved the name; that is a property of the run, not the capability.
 *
 * Expected failures are typed results (`CredentialLoadResult`), not exceptions. A failure's
 * `message` names credentials and the provider, and never carries a credential value, a file's
 * contents or a helper's stdout.
 */

/** A credential name: the same shape the schema allows in a `{kind:'secret', env}` binding. */
export const CREDENTIAL_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/** The credentials one run resolved, held in memory for that run only. */
export interface CredentialSet {
  /** The value for `name`, or undefined when the set has none (never an empty string). */
  get(name: string): string | undefined;
  /** Every non-empty value in the set: what the run's redactor scrubs from evidence and payloads. */
  values(): string[];
  /** The names the set holds a value for, sorted. Names are not secret; values are. */
  names(): string[];
}

/** Why a provider could not supply the requested credentials. */
export type CredentialFailureCode =
  /** One or more requested names have no value. `names` lists them. */
  | 'missing'
  /** A requested name is not a valid credential name. */
  | 'invalid_name'
  /** The source is not reachable: file not found, command not found, permission denied. */
  | 'unavailable'
  /** The source answered with something that is not a name -> string map. */
  | 'malformed'
  /** The provider refused on purpose (e.g. a credentials file a commit could pick up). */
  | 'refused'
  /** A helper process did not answer in time. */
  | 'timeout'
  /** A helper process exited non-zero. */
  | 'failed'
  /** The provider threw instead of returning a result (a bug in that provider). */
  | 'provider_error';

/** A typed credential failure. `message` never contains a credential value. */
export interface CredentialFailure {
  code: CredentialFailureCode;
  /** The provider's `id`, e.g. `env`, `file:/home/me/creds.json`, `exec:op-helper`. */
  providerId: string;
  /** Credential names the failure concerns (for `missing`: exactly the absent ones). */
  names: string[];
  message: string;
}

/** Result of {@link CredentialProvider.load}. */
export type CredentialLoadResult = { ok: true; set: CredentialSet } | { ok: false; error: CredentialFailure };

/**
 * A source of credentials. Implementations: `envCredentialProvider` (this module, the default),
 * and the `file:` / `exec:` providers in `@cu/adapter-credentials`.
 *
 * `load` may return a set that lacks some of the requested names; `loadCredentials` turns that into
 * a `missing` failure, so providers need not repeat the check. A provider should return only the
 * requested names, so no more secret material than the run needs is held in memory.
 */
export interface CredentialProvider {
  /** Stable, value-free identifier used in messages: `env`, `file:<path>`, `exec:<program>`. */
  readonly id: string;
  load(names: readonly string[]): Promise<CredentialLoadResult>;
}
