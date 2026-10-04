/**
 * Global CLI options (set on the root `program`, read by every command via `globalsOf(cmd)`),
 * and the shared flag parsers. Contract between apps/cu/src/index.ts and apps/cu/src/commands/*.ts.
 */
import { InvalidArgumentError, type Command } from 'commander';
import { envCredentialProvider, type CredentialProvider } from '@cu/core/credentials';
import { DEFAULT_BASE_URL, DEFAULT_POLICY_FILE, DEFAULT_RUNS_DIR, credentialProviderFromSpec, resolveTenant } from './runtime/index.js';

/** Resolved global CLI options, after merging root flags with tenant defaults. */
export interface GlobalOptions {
  policy: string;
  runsDir: string;
  headless: boolean;
  /** Explicit --base-url, else the tenant's default, else http://localhost:4173. */
  baseUrl: string;
  tenant?: string;
  /** Capability override key derived from --tenant (b -> riverbend-fcu). */
  overrideKey?: string;
  /**
   * The raw --credentials / CU_CREDENTIALS spec (`env` | `file:<path>` | `exec:<command>`), unparsed.
   * Only the commands that bind credentials resolve it, through {@link credentialProviderOf}, so a
   * malformed value never breaks `validate` or `catalog list`. Never print it: an `exec:` command's
   * arguments can carry tokens.
   */
  credentialsSpec?: string;
  /** For a desktop://<process> --base-url: --app-command or --attach-pid. */
  desktop?: { launch?: string; attachPid?: number };
}

/**
 * Root options as commander stores them: --policy, --runs-dir, --headless/--headed, --base-url,
 * --tenant, --credentials. `headless` and `headed` are two independent boolean flags (both registered on the
 * root program in apps/cu/src/index.ts) rather than a single `--headless`/`--no-headless` pair, so
 * either spelling works; `headed` (when passed) always wins over `headless`.
 */
interface RawGlobals {
  policy?: string;
  runsDir?: string;
  headless?: boolean;
  headed?: boolean;
  baseUrl?: string;
  tenant?: string;
  /** The raw spec string, deliberately with no commander argParser: commander quotes a rejected
   *  argument verbatim in its error ("argument '<value>' is invalid"). */
  credentials?: string;
  appCommand?: string;
  attachPid?: number;
}

/** `cmd.optsWithGlobals()` merges command options over root options; a command-level --tenant wins. */
export function globalsOf(cmd: Command): GlobalOptions {
  const raw = cmd.optsWithGlobals<RawGlobals>();
  const t = resolveTenant(raw.tenant);
  const headless = raw.headed === true ? false : (raw.headless ?? true);
  return {
    policy: raw.policy ?? DEFAULT_POLICY_FILE,
    runsDir: raw.runsDir ?? DEFAULT_RUNS_DIR,
    headless,
    baseUrl: raw.baseUrl ?? t.baseUrl ?? DEFAULT_BASE_URL,
    ...(raw.tenant !== undefined ? { tenant: raw.tenant } : {}),
    ...(t.overrideKey !== undefined ? { overrideKey: t.overrideKey } : {}),
    ...(raw.credentials !== undefined ? { credentialsSpec: raw.credentials } : {}),
    ...(raw.appCommand !== undefined || raw.attachPid !== undefined
      ? { desktop: { ...(raw.appCommand !== undefined ? { launch: raw.appCommand } : {}), ...(raw.attachPid !== undefined ? { attachPid: raw.attachPid } : {}) } }
      : {}),
  };
}

/** A malformed --credentials / CU_CREDENTIALS spec. The message names what is wrong and the accepted
 *  forms, never any part of the spec itself. */
export class CredentialSpecError extends Error {
  constructor(detail: string) {
    super(`--credentials / CU_CREDENTIALS: ${detail}`);
    this.name = 'CredentialSpecError';
  }
}

/**
 * The run's credential provider: the env provider when no spec was given, else the spec's. Called
 * only by commands that bind credentials (discover, replay, catalog invoke), at the start of their
 * action. Throws {@link CredentialSpecError}; the CLI's top-level catch prints `cu: <message>` and
 * exits 1. `parseCredentialSpec`'s messages never quote the spec, which is what makes this safe.
 */
export function credentialProviderOf(g: Pick<GlobalOptions, 'credentialsSpec'>): CredentialProvider {
  if (g.credentialsSpec === undefined) return envCredentialProvider();
  try {
    return credentialProviderFromSpec(g.credentialsSpec);
  } catch (err) {
    throw new CredentialSpecError(err instanceof Error ? err.message : 'invalid spec');
  }
}

/** Commander parser for `--attach-pid`: a positive whole number. */
export function parsePid(value: string): number {
  const n = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError('must be a process id (a positive integer)');
  return n;
}

/** Commander collector for repeatable/variadic `name=value` flags. Values split on the FIRST '='. */
export function parseKeyValues(pairs: readonly string[] | undefined, flag = '--input'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs ?? []) {
    const i = p.indexOf('=');
    if (i <= 0) throw new Error(`${flag} expects name=value, got "${p}"`);
    out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}

/** Collector for commander: `.option('--input <kv...>', '...', collect, [])`. */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Commander parser for a TCP port flag (`--operator-port`, `--port`): a whole number 0-65535,
 *  0 meaning ephemeral. Anything else (`abc`, `12abc`, `-1`, `70000`) is rejected by commander
 *  with "option '<flag>' argument '<value>' is invalid. must be an integer port number (0-65535)". */
export function parsePort(value: string): number {
  const n = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new InvalidArgumentError('must be an integer port number (0-65535)');
  return n;
}
