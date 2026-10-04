/**
 * `cu operator [--demo] [--port <n>]`.
 *
 * A standalone console cannot attach to another process's live browser: the `SessionBroker` (and
 * the browser it guards) live in-process with whatever is driving them (replay/discover), and the
 * Relay console (`@cu/relay`) only ever talks to brokers it was started with.
 *
 * `--demo` runs `runOperatorDemo` (./operator-demo.ts) in this process: a self-contained handoff
 * walkthrough against a `FakeSurface`, no real browser required. Without `--demo`, this command
 * explains why a standalone console cannot attach to a live browser and exits non-zero.
 *
 * For a REAL handoff against the live mock app, use `replay --headed` or `discover --headed`,
 * which start the Relay console in the SAME process as the browser they are driving.
 */
import type { Command } from 'commander';
import { DEFAULT_OPERATOR_PORT } from '../runtime/index.js';
import { runOperatorDemo } from './operator-demo.js';
import { CRASH_EXIT_CODE } from '../exit-code.js';
import { parsePort } from '../globals.js';

const EXPLANATION =
  "cu operator: a standalone console cannot attach to another process's live browser (the SessionBroker runs " +
  'in-process with whatever automation it guards). Use `replay --headed` or `discover --headed` for a real ' +
  'handoff against the live mock app, or `cu operator --demo` for a self-contained FakeSurface walkthrough.';

/** Flags for the `operator` command. */
export interface RunOperatorCommandOptions {
  demo?: boolean;
  port: number;
}

/** Injectable collaborators for `runOperatorCommand`. */
export interface RunOperatorCommandDeps {
  /** Defaults to `runOperatorDemo`. Injectable so a test never starts a real server. */
  demo?: (opts: { port: number }) => Promise<void>;
  printError?: (line: string) => void;
}

/** The command's testable core: commander only parses flags and calls this. */
export async function runOperatorCommand(opts: RunOperatorCommandOptions, deps: RunOperatorCommandDeps = {}): Promise<number> {
  if (opts.demo !== true) {
    (deps.printError ?? ((line: string) => console.error(line)))(EXPLANATION);
    return CRASH_EXIT_CODE;
  }
  await (deps.demo ?? runOperatorDemo)({ port: opts.port });
  return 0;
}

/** Registers the `operator` command on `program`, wiring its flags to `runOperatorCommand`. */
export function registerOperator(program: Command): void {
  program
    .command('operator')
    .description(
      "standalone Relay console. It cannot attach to another process's live browser (the SessionBroker runs " +
        'in-process with whatever automation it guards). With --demo it runs a FakeSurface demo ' +
        'in this process instead: a self-contained handoff walkthrough with no real browser. For a real handoff ' +
        'against the live mock app, use `replay --headed` or `discover --headed`, which start the Relay console in-process.',
    )
    .option('--demo', 'run a self-contained FakeSurface handoff walkthrough in this process')
    .option('--port <n>', 'Relay console port, an integer 0-65535 (used with --demo)', parsePort, DEFAULT_OPERATOR_PORT)
    .action(async (options: { demo?: boolean; port: number }) => {
      process.exitCode = await runOperatorCommand(options);
    });
}
