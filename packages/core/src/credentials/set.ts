/**
 * `CredentialSet` construction and `loadCredentials`, the one place the "every requested name must
 * resolve" rule lives, so each provider only has to fetch.
 */
import { CREDENTIAL_NAME_RE, type CredentialFailure, type CredentialLoadResult, type CredentialProvider, type CredentialSet } from './types.js';

/**
 * A frozen `CredentialSet` over `entries`. Empty values are dropped, so `get` never returns `''`
 * and `values()` never contains one. The entries are copied: mutating the input later changes
 * nothing.
 */
export function credentialSet(entries: Readonly<Record<string, string | undefined>> | ReadonlyMap<string, string | undefined> = {}): CredentialSet {
  const map = new Map<string, string>();
  const pairs = entries instanceof Map ? [...entries.entries()] : Object.entries(entries);
  for (const [name, value] of pairs) {
    if (typeof value === 'string' && value !== '') map.set(name, value);
  }
  const set: CredentialSet = {
    get: (name) => map.get(name),
    values: () => [...map.values()],
    names: () => [...map.keys()].sort(),
  };
  return Object.freeze(set);
}

/** The set with no credentials, for runs whose capability binds none. */
export const EMPTY_CREDENTIALS: CredentialSet = credentialSet();

/** A value-free failure. */
export function credentialFailure(code: CredentialFailure['code'], providerId: string, names: readonly string[], message: string): CredentialLoadResult {
  return { ok: false, error: { code, providerId, names: [...names], message } };
}

/** One line for a CLI or log: the code, the provider, the message. Never a value. */
export function describeCredentialFailure(f: CredentialFailure): string {
  return `credentials (${f.providerId}): ${f.message}`;
}

/**
 * Loads `names` from `provider` and checks every one resolved.
 *
 * - Names are de-duplicated and validated first (`invalid_name`); an empty list never calls the
 *   provider and yields {@link EMPTY_CREDENTIALS}.
 * - A provider that throws is reported as `provider_error` naming only the error's class, since a
 *   third-party provider's message could quote what it read.
 * - The returned set holds only the requested names, even if the provider returned more.
 * - Any requested name without a non-empty value is a `missing` failure listing exactly those names.
 */
export async function loadCredentials(provider: CredentialProvider, names: readonly string[]): Promise<CredentialLoadResult> {
  const wanted = [...new Set(names)];
  const invalid = wanted.filter((n) => !CREDENTIAL_NAME_RE.test(n));
  if (invalid.length > 0) {
    return credentialFailure('invalid_name', provider.id, invalid, `not a valid credential name (A-Z, 0-9, _; not starting with a digit): ${invalid.join(', ')}`);
  }
  if (wanted.length === 0) return { ok: true, set: EMPTY_CREDENTIALS };

  let result: CredentialLoadResult;
  try {
    result = await provider.load(wanted);
  } catch (err) {
    const kind = err instanceof Error ? err.name : typeof err;
    return credentialFailure('provider_error', provider.id, wanted, `the provider threw (${kind}) instead of returning a result`);
  }
  if (!result.ok) return result;

  const missing = wanted.filter((n) => result.set.get(n) === undefined);
  if (missing.length > 0) {
    return credentialFailure('missing', provider.id, missing, `not set: ${missing.join(', ')}`);
  }
  const only: Record<string, string> = {};
  for (const n of wanted) only[n] = result.set.get(n)!;
  return { ok: true, set: credentialSet(only) };
}
