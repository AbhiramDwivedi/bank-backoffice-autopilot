/**
 * Parses a credentials spec, the value of the CLI's `--credentials` flag or `CU_CREDENTIALS`:
 * `env` (the default), `file:<path>` or `exec:<command>`. Only the prefix is matched; everything
 * after the first `:` is the path or command, verbatim (a Windows drive letter keeps its colon).
 */
import { envCredentialProvider, type CredentialProvider } from '@cu/core/credentials';
import { fileCredentialProvider } from './file.js';
import { execCredentialProvider, parseCommandLine } from './exec.js';

/** Result of {@link parseCredentialSpec}. */
export type ParseCredentialSpecResult = { ok: true; provider: CredentialProvider } | { ok: false; message: string };

const FORMS = 'env | file:<path> | exec:<command>';

/** Maps a spec string to a provider. Never echoes the spec's argument text in an error. */
export function parseCredentialSpec(spec: string): ParseCredentialSpecResult {
  const s = spec.trim();
  if (s === 'env') return { ok: true, provider: envCredentialProvider() };
  if (s.startsWith('file:')) {
    const p = s.slice('file:'.length).trim();
    if (p === '') return { ok: false, message: `credentials spec "file:" needs a path (${FORMS})` };
    return { ok: true, provider: fileCredentialProvider(p) };
  }
  if (s.startsWith('exec:')) {
    const cmd = s.slice('exec:'.length);
    const parsed = parseCommandLine(cmd);
    if (!parsed.ok) return { ok: false, message: `credentials spec "exec:": ${parsed.message} (${FORMS})` };
    return { ok: true, provider: execCredentialProvider(cmd) };
  }
  // Nothing of the spec is echoed, not even its leading word: a pasted token has no ':' and would be
  // its own "kind".
  return { ok: false, message: `unknown credentials spec; expected one of: ${FORMS}` };
}
