#!/usr/bin/env node
/**
 * `cu` -- the CLI entry point. Root program with global options shared by every subcommand (read
 * via `globalsOf(cmd)`, apps/cu/src/globals.ts), wiring everything through `compose()`
 * (apps/cu/src/runtime/compose.ts). Registers:
 *   discover  -- apps/cu/src/commands/discover.ts
 *   replay    -- apps/cu/src/commands/replay.ts
 *   validate  -- apps/cu/src/commands/validate.ts
 *   catalog   -- apps/cu/src/commands/catalog.ts (list / tools / invoke)
 *   operator  -- apps/cu/src/commands/operator.ts
 *   approve   -- apps/cu/src/commands/approve.ts
 *   audit     -- apps/cu/src/commands/audit.ts (risk-judge audit of an existing capability)
 *   optimize  -- apps/cu/src/commands/optimize.ts
 *
 * Never prints a stack trace or an environment value: an uncaught error's *message* only, then
 * exit 1 (CRASH_EXIT_CODE). Command-specific exit codes (replay/catalog invoke) are set by those
 * commands themselves before this catch ever runs.
 */
import { Command, Option } from 'commander';
import { loadEnv } from './env.js';
import { DEFAULT_BASE_URL, DEFAULT_POLICY_FILE, DEFAULT_RUNS_DIR } from './runtime/index.js';
import { CRASH_EXIT_CODE } from './exit-code.js';
import { parsePid } from './globals.js';
import { registerDiscover } from './commands/discover.js';
import { registerReplay } from './commands/replay.js';
import { registerValidate } from './commands/validate.js';
import { registerCatalog } from './commands/catalog.js';
import { registerOperator } from './commands/operator.js';
import { registerApprove } from './commands/approve.js';
import { registerAudit } from './commands/audit.js';
import { registerOptimize } from './commands/optimize.js';

loadEnv();

const program = new Command();

program
  .name('cu')
  .description('Computer-use automation: LLM discovery -> capability artifact -> deterministic, no-LLM replay, with human handoff.')
  .option('--policy <path>', 'policy YAML file', DEFAULT_POLICY_FILE)
  .option('--runs-dir <dir>', 'evidence run directory root', DEFAULT_RUNS_DIR)
  .option('--headless', 'run the browser headless (default)')
  .option('--headed', 'show the browser window (overrides --headless); required for a human to use a live operator handoff in the same window')
  .option('--base-url <url>', `override the mock app base URL (default ${DEFAULT_BASE_URL}, or the --tenant default)`)
  .option('--tenant <a|b|key>', "mock tenant alias 'a'/'b' (selects the default base URL and, for 'b', the capability override key 'riverbend-fcu'), or any other capability override key")
  // A plain string, resolved only by the commands that bind credentials (globals.ts
  // credentialProviderOf): an argParser would make commander quote a rejected spec verbatim.
  .addOption(
    new Option('--credentials <spec>', 'where secret bindings resolve: env (default) | file:<path> | exec:<command> (docs/design/credentials.md)').env(
      'CU_CREDENTIALS',
    ),
  )
  .option('--app-command <command line>', 'with a desktop://<process> --base-url: the command line that starts the Windows app (the run owns and ends it)')
  .option('--attach-pid <pid>', 'with a desktop://<process> --base-url: drive this already running process instead (left running)', parsePid);

registerDiscover(program);
registerReplay(program);
registerValidate(program);
registerCatalog(program);
registerOperator(program);
registerApprove(program);
registerAudit(program);
registerOptimize(program);

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  // Never a stack trace, never an env value: just the message (evidence/redact-style callers
  // scrub their own output; this is the last-resort top-level catch for everything else).
  const message = err instanceof Error ? err.message : String(err);
  console.error(`cu: ${message}`);
  process.exitCode = CRASH_EXIT_CODE;
});
