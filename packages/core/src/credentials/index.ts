/**
 * Public surface of the credentials module: the `CredentialProvider` port, `CredentialSet`, the
 * env provider (the default) and `loadCredentials`. Depends on no other core module.
 * See docs/design/credentials.md.
 */
export * from './types.js';
export { credentialSet, credentialFailure, describeCredentialFailure, loadCredentials, EMPTY_CREDENTIALS } from './set.js';
export { envCredentialProvider } from './env.js';
