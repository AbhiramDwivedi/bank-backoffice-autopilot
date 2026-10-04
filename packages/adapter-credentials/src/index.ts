/**
 * `@cu/adapter-credentials`: credential providers beyond the environment, implementing the
 * `CredentialProvider` port from `@cu/core/credentials`.
 *
 * - `file:<path>`: a JSON object or dotenv-style file kept outside the repository.
 * - `exec:<command>`: a credential-helper process speaking JSON on stdin/stdout.
 * - `parseCredentialSpec`: the CLI's `--credentials` / `CU_CREDENTIALS` value -> provider.
 */
export {
  fileCredentialProvider,
  isInsideGitWorkTree,
  parseDotenv,
  realGitProbe,
  type FileCredentialProviderOptions,
  type GitIgnoreAnswer,
  type GitProbe,
} from './file.js';
export { execCredentialProvider, parseCommandLine, type ExecCredentialProviderOptions, type ParseCommandLineResult } from './exec.js';
export { parseCredentialSpec, type ParseCredentialSpecResult } from './spec.js';
