/**
 * `cu catalog` -- the agent-facing capability interface (apps/cu/src/catalog/index.ts). Four
 * subcommands, sharing a `--dir` option on the parent `catalog` command (read via
 * `optsWithGlobals()`, same pattern as the root program's globals):
 *   list    -- table of every valid capability, plus skipped files and why
 *   search  -- ranked keyword search with the reason each result matched
 *   tools   -- Anthropic ToolDefinition[] JSON; plain = every valid, non-deprecated capability,
 *              --brief = level 1 (name + one-liner), --id = level 2 (one full definition),
 *              --query = full definitions for the search shortlist (docs/design/capability-selection.md)
 *   invoke  -- replay one by id with typed --input args; same output/exit-code contract as `replay`
 *              (130 when interrupted by Ctrl-C); a deprecated capability is refused (exit 1)
 */
import path from 'node:path';
import type { Command } from 'commander';
import { DEFAULT_TOP_K, loadCatalog, oneLineDescription, type CapabilityBrief } from '../catalog/index.js';
import { credentialProviderOf, globalsOf, parseKeyValues, parsePort, collect } from '../globals.js';
import { type AutoOperatorMode, INTERRUPTED_EXIT_CODE, isInterruptedError, sensitiveOutputNamesOf } from '../runtime/index.js';
import { printReplayResult } from '../print-result.js';
import { exitCodeForResult, CRASH_EXIT_CODE } from '../exit-code.js';
import { baseUrlPolicyError } from '../base-url-policy.js';
import { resolveOperatorPortDefault } from '../operator-port.js';
import { READ_ONLY_NOTE } from './replay.js';

const AUTO_OPERATOR_MODES: readonly AutoOperatorMode[] = ['none', 'approve', 'abort', 'relogin'];
const DEFAULT_CATALOG_DIR = 'artifacts';

interface CatalogDirOption {
  dir?: string;
}

function catalogDirOf(cmd: Command): string {
  return cmd.optsWithGlobals<CatalogDirOption>().dir ?? DEFAULT_CATALOG_DIR;
}

interface SearchCommandOptions {
  topK?: string;
  json?: boolean;
  includeDeprecated?: boolean;
  approvedOnly?: boolean;
}

interface ToolsCommandOptions {
  brief?: boolean;
  approvedOnly?: boolean;
  id?: string;
  query?: string;
  topK?: string;
}

/** Reports a usage error the way every `cu` command does: message on stderr, exit code 1. */
function fail(message: string): void {
  console.error(message);
  process.exitCode = CRASH_EXIT_CODE;
}

/** `--top-k` must be a positive integer. Returns the number, the default when absent, or 'invalid' after reporting. */
function parseTopK(raw: string | undefined, who: string): number | 'invalid' {
  if (raw === undefined) return DEFAULT_TOP_K;
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    fail(`${who}: --top-k must be a positive integer, got "${raw}"`);
    return 'invalid';
  }
  return Number(raw);
}

/** Level-1 listing: a JSON array with one compact object per line (cheap to hand to a model). */
function printBriefs(briefs: CapabilityBrief[]): void {
  if (briefs.length === 0) {
    console.log('[]');
    return;
  }
  console.log(`[\n${briefs.map((b) => `  ${JSON.stringify(b)}`).join(',\n')}\n]`);
}

/** Registers the `catalog` command and its `list`/`search`/`tools`/`invoke` subcommands on `program`. */
export function registerCatalog(program: Command): void {
  const catalog = program
    .command('catalog')
    .description('the agent-facing capability catalog: list and search capability artifacts, print tool definitions, or invoke one by id')
    .option('--dir <path>', 'artifacts directory to scan recursively for capability JSON files', DEFAULT_CATALOG_DIR);

  catalog
    .command('list')
    .description(
      'print a table of every valid capability under --dir (per id, the highest non-deprecated version; deprecated only when no other version exists), ' +
        'plus any skipped files with the reason they were skipped',
    )
    .action((_options: unknown, cmd: Command) => {
      const dir = catalogDirOf(cmd);
      const cat = loadCatalog(dir);
      const entries = cat.entries();

      if (entries.length === 0) {
        console.log(`(no valid capabilities under ${dir})`);
      } else {
        console.log(['id', 'version', 'status', 'risk', 'inputs -> outputs', 'file'].join('\t'));
        for (const e of entries) {
          const inputsList = Object.keys(e.capability.inputs).join(',') || '(none)';
          const outputsList = Object.keys(e.capability.outputs).join(',') || '(none)';
          console.log([e.id, e.version, e.status, e.riskLevel, `${inputsList} -> ${outputsList}`, e.file].join('\t'));
        }
      }

      const skipped = cat.skipped();
      if (skipped.length > 0) {
        console.log('');
        console.log('skipped:');
        for (const s of skipped) console.log(`  ${s.file}: ${s.reason}`);
      }
    });

  catalog
    .command('search <query...>')
    .description(
      'rank capabilities against free text (deterministic keyword search over id, name, description, inputs, outputs, business outcomes and app metadata); ' +
        'prints rank, id, version, status, score, which fields matched, and a one-line description. Deprecated capabilities are excluded by default',
    )
    .option('--top-k <n>', `maximum number of results, a positive integer (default ${DEFAULT_TOP_K})`)
    .option('--json', 'print the results as JSON ({ query, topK, results: [...] }) instead of a table')
    .option('--include-deprecated', 'also rank capabilities whose only version is deprecated')
    .option('--approved-only', 'only rank approved capabilities (drops drafts; wins over --include-deprecated)')
    .action((queryWords: string[], options: SearchCommandOptions, cmd: Command) => {
      const query = queryWords.join(' ').trim();
      const topK = parseTopK(options.topK, 'cu catalog search');
      if (topK === 'invalid') return;
      if (query.length === 0) {
        fail('cu catalog search: the query is empty');
        return;
      }
      const cat = loadCatalog(catalogDirOf(cmd));
      const hits = cat.search(query, { topK, includeDeprecated: options.includeDeprecated === true, approvedOnly: options.approvedOnly === true });
      const rows = hits.map((h) => ({ ...h, description: oneLineDescription(cat.get(h.id)?.description ?? '') }));

      if (options.json === true) {
        console.log(JSON.stringify({ query, topK, results: rows }, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log(`(no capability matches "${query}")`);
        return;
      }
      console.log(['rank', 'id', 'version', 'status', 'score', 'matched on', 'description'].join('\t'));
      for (const r of rows) {
        const matchedOn = r.matched.map((m) => `${m.field}(${m.terms.join(',')})`).join(' ');
        console.log([r.rank, r.id, r.version, r.status, r.score.toFixed(3), matchedOn, r.description].join('\t'));
      }
    });

  catalog
    .command('tools')
    .description(
      'print Anthropic tool definitions for valid, non-deprecated capabilities under --dir. Plain `tools` prints all of them. ' +
        'Progressive disclosure: --brief (level 1) prints only name + one-line description + status + risk; ' +
        '--id <id> (level 2) prints the one full definition; --query <text> [--top-k n] prints full definitions for the search shortlist only',
    )
    .option('--brief', 'level 1: only name, one-line description, status and risk level per capability (combine with --query to brief the shortlist)')
    .option('--id <id>', 'level 2: the full tool definition for one capability (its id, or the tool name shown by --brief)')
    .option('--approved-only', 'only approved capabilities (drops drafts); with --id, refuses a draft')
    .option('--query <text>', 'only the top-k capabilities matching this free text, ranked (default k 10)')
    .option('--top-k <n>', `with --query, the shortlist size: a positive integer (default ${DEFAULT_TOP_K})`)
    .action((options: ToolsCommandOptions, cmd: Command) => {
      const name = 'cu catalog tools';
      if (options.brief === true && options.id !== undefined) return fail(`${name}: --brief and --id are mutually exclusive (--brief is level 1, --id is level 2)`);
      if (options.id !== undefined && options.query !== undefined) return fail(`${name}: --id and --query are mutually exclusive`);
      if (options.topK !== undefined && options.query === undefined) return fail(`${name}: --top-k only applies together with --query`);
      if (options.query !== undefined && options.query.trim().length === 0) return fail(`${name}: --query is empty`);
      const topK = parseTopK(options.topK, name);
      if (topK === 'invalid') return;

      const cat = loadCatalog(catalogDirOf(cmd));

      const approvedOnly = options.approvedOnly === true;

      if (options.id !== undefined) {
        const entry = cat.resolve(options.id);
        if (entry !== undefined && entry.status === 'deprecated') return fail(`${name}: capability "${options.id}" is deprecated and has no non-deprecated version`);
        if (entry !== undefined && approvedOnly && entry.status !== 'approved') return fail(`${name}: capability "${entry.id}" is a ${entry.status}, and --approved-only was given`);
        const tool = cat.toToolDefinition(options.id);
        if (tool !== undefined) {
          console.log(JSON.stringify(tool, null, 2));
          return;
        }
        const near = cat.search(options.id, { topK: 3 }).map((h) => h.id);
        return fail(`${name}: unknown capability id "${options.id}"${near.length > 0 ? `; did you mean: ${near.join(', ')}` : ''}`);
      }

      if (options.query !== undefined) {
        const ids = cat.search(options.query, { topK, approvedOnly }).map((h) => h.id);
        if (options.brief === true) {
          const briefs = new Map(cat.toBriefs().map((b) => [b.id, b]));
          printBriefs(ids.flatMap((id) => briefs.get(id) ?? []));
        } else {
          console.log(JSON.stringify(ids.flatMap((id) => cat.toToolDefinition(id) ?? []), null, 2));
        }
        return;
      }

      if (options.brief === true) printBriefs(cat.toBriefs({ approvedOnly }));
      else console.log(JSON.stringify(cat.toToolDefinitions({ approvedOnly }), null, 2));
    });

  interface InvokeCommandOptions {
    input: string[];
    autoOperator: string;
    /** undefined = not given on the command line; resolveOperatorPortDefault() then picks it. */
    operatorPort?: number;
    json?: boolean;
    readOnly?: boolean;
  }

  catalog
    .command('invoke <id>')
    .description('replay a capability from the catalog by id, with typed --input args (same output/exit-code contract as `replay`); a deprecated capability is refused')
    .option('--input <name=value>', 'a capability input, repeatable (e.g. --input memberId=12345)', collect, [])
    .option('--auto-operator <mode>', 'scripted operator for unattended runs: none|approve|abort|relogin (default none)', 'none')
    .option(
      '--operator-port <n>',
      'Relay console port, an integer 0-65535 (0 = ephemeral); a busy port is retried on an OS-assigned port and the new console URL is logged. ' +
        'Default: the well-known port with --headed or --auto-operator none ' +
        '(a human may need the console), else 0 (ephemeral -- no console is needed for a headless, scripted run)',
      parsePort,
    )
    .option('--json', 'print only the ReplayResult JSON to stdout; everything else goes to stderr')
    .option(
      '--read-only',
      'assert, for this run only, that replaying the capability changes nothing in the target app (not verified), ' +
        'so replay may retry a transient app error by restarting its steps; refused on a capability with anything irreversible (same as `replay --read-only`)',
    )
    .action(async (id: string, options: InvokeCommandOptions, cmd: Command) => {
      const g = globalsOf(cmd);
      const dir = catalogDirOf(cmd);

      // Fail fast, before any browser is launched: --base-url's origin must be in the loaded
      // policy's allowedOrigins. Kept out of the try/catch below so it reports as "cu: ..." like
      // every other command's version of this check, not "cu catalog invoke: ...".
      const originError = baseUrlPolicyError(g.baseUrl, g.policy);
      if (originError !== undefined) {
        console.error(`cu: ${originError}`);
        process.exitCode = CRASH_EXIT_CODE;
        return;
      }

      if (!AUTO_OPERATOR_MODES.includes(options.autoOperator as AutoOperatorMode)) {
        console.error(`cu catalog invoke: --auto-operator must be one of ${AUTO_OPERATOR_MODES.join('|')}, got "${options.autoOperator}"`);
        process.exitCode = CRASH_EXIT_CODE;
        return;
      }
      const autoOperator = options.autoOperator as AutoOperatorMode;
      // No console needed for a headless run with a scripted operator attached; --headed or an
      // unscripted (--auto-operator none) run keeps the well-known port so a human can find it.
      const operatorPort = options.operatorPort ?? resolveOperatorPortDefault({ headed: !g.headless, autoOperator });
      const log = (line: string): void => console.error(line);
      const inputs = parseKeyValues(options.input, '--input');
      const cat = loadCatalog(dir);
      if (options.readOnly === true) console.error(READ_ONLY_NOTE);

      try {
        const result = await cat.invoke(id, inputs, {
          baseUrl: g.baseUrl,
          policyPath: g.policy,
          runsDir: g.runsDir,
          headless: g.headless,
          ...(g.overrideKey !== undefined ? { tenant: g.overrideKey } : {}),
          ...(g.desktop !== undefined ? { desktop: g.desktop } : {}),
          autoOperator,
          operator: { port: operatorPort },
          log,
          credentials: credentialProviderOf(g),
          ...(options.readOnly === true ? { readOnly: true } : {}),
        });
        // Catalog.invoke returns only the ReplayResult; the run directory is reconstructed the
        // same way createRunLogger lays it out: <rootDir>/<runId>.
        const runDir = path.resolve(g.runsDir, result.runId);
        printReplayResult(result, runDir, { json: options.json === true, sensitiveOutputs: sensitiveOutputNamesOf(cat.get(id)?.capability) });
        process.exitCode = exitCodeForResult(result);
      } catch (err) {
        if (isInterruptedError(err)) {
          console.error(`cu catalog invoke: ${err.message}; no result reported`);
          process.exitCode = INTERRUPTED_EXIT_CODE;
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error(`cu catalog invoke: ${message}`);
        process.exitCode = CRASH_EXIT_CODE;
      }
    });
}
