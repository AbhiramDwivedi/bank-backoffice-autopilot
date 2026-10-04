/**
 * `cu replay <artifact.json>` -- the no-LLM production execution path, wired through the shared
 * `runReplay` helper (apps/cu/src/runtime/run-replay.ts) so this command and `catalog invoke` share one
 * path from "capability + inputs" to a `ReplayResult`.
 *
 * `--fault`: the CLI process itself (never the replay surface -- the policy's
 * `deniedPathPatterns` block `/__faults` and `/__reset` for the agent/replay surface, see
 * policies/default.yaml) is the "operator of this demo" and is allowed to hit the mock app's
 * fault-injection endpoint directly over `fetch`, to set up a scenario before the run and restore
 * it afterwards no matter how the run ends -- it wraps the whole `--times` series once, not each
 * run.
 *
 * `--times <n>` (n > 1): launches ONE Chromium browser here and hands it to `runReplay` on every
 * call, so each run gets its own page/context in that same browser (compose()'s PlaywrightSurface
 * only closes the context it opened for an injected `browser`, never the browser itself -- see
 * packages/adapter-playwright/src/surface.ts's `close()`); this command closes the browser once the series
 * finishes. Each run still gets its own run directory. `n === 1` (the default) is one run, printed
 * with `printReplayResult`.
 *
 * A capability whose status is `deprecated` is refused before anything runs, with or without
 * `--approve` (exit 1).
 *
 * `--read-only`: the operator's assertion, for this run, that replaying the capability changes
 * nothing in the target app. It is what lets replay retry a transient app error by restarting its
 * steps (docs/design/replay.md, "Retrying a transient app error"); a capability that carries
 * `readOnly: true` gets the retry without the flag. Replay refuses the assertion on a capability
 * with anything irreversible (a `policy_violation` result, exit 4).
 *
 * `--fault` with `chaos` (the mock app's seeded intermittent faults, apps/mock-app/chaos.ts):
 * the fault body is POSTed once, before the first run, so the app's chaos streams start from the
 * seed once and then run on across the whole series -- they are deliberately NOT reset per run
 * (that would hand every run the identical faults). Session-level state behaves as it always has:
 * each run is a fresh browser context, so a fresh login and a fresh once-per-session interstitial.
 * After the series, and before the faults are restored, the stability summary reads what the app
 * injected (`GET /__faults/chaos`) and echoes the seed and the exact `--fault` value, so the series
 * can be re-run exactly (chaos-report.ts).
 *
 * Ctrl-C (SIGINT/SIGTERM): the run in flight shuts down (runWithShutdown,
 * apps/cu/src/runtime/lifecycle.ts), no result is printed, a `--times` series stops without
 * starting another run, faults are still restored, and the exit code is 130.
 */
import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { chromium } from 'playwright';
import { credentialProviderOf, globalsOf, parseKeyValues, parsePort, collect } from '../globals.js';
import {
  type AutoOperatorMode,
  INTERRUPTED_EXIT_CODE,
  isInterruptedError,
  loadRunCredentials,
  preloadedCredentialProvider,
  runReplay,
  secretEnvNamesOf,
  sensitiveOutputNamesOf,
  type RunReplayOptions,
} from '../runtime/index.js';
import { printReplayResult, printStabilitySummary } from '../print-result.js';
import { collectSeriesChaos, restoreBodyFor, seriesChaosLines } from '../chaos-report.js';
import { exitCodeForResult, CRASH_EXIT_CODE } from '../exit-code.js';
import { baseUrlPolicyError } from '../base-url-policy.js';
import { resolveOperatorPortDefault } from '../operator-port.js';
import { summarizeStability } from '@cu/core/replay';
import type { ReplayResult } from '@cu/core/schema';

const AUTO_OPERATOR_MODES: readonly AutoOperatorMode[] = ['none', 'approve', 'abort', 'relogin'];

/** Each `--fault` set-up/restore request: a dead or hung target fails the command fast instead of hanging it. */
export const FAULT_HTTP_TIMEOUT_MS = 5000;

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FAULT_HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

async function postJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FAULT_HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`POST ${url} -> HTTP ${res.status}`);
  // The mock app answers 200 with a `rejected` list for keys it did not apply (an unknown flag, a
  // bad chaos object). A fault the target refused must stop the run, not run without it.
  const reply: unknown = await res.json().catch(() => undefined);
  const rejected = reply !== null && typeof reply === 'object' ? (reply as { rejected?: unknown }).rejected : undefined;
  if (Array.isArray(rejected) && rejected.length > 0) throw new Error(`the target rejected: ${rejected.map(String).join(', ')}`);
}

/** Printed to stderr whenever a run is asserted read-only from the command line (`replay`, `catalog invoke`). */
export const READ_ONLY_NOTE =
  'note: --read-only asserts, for this run only, that replaying this capability changes nothing in the target app; ' +
  'nothing verifies it, and replay may restart the steps on its own after an app error';

interface ReplayCommandOptions {
  input: string[];
  approve?: boolean;
  readOnly?: boolean;
  fault?: string;
  autoOperator: string;
  /** undefined = not given on the command line; resolveOperatorPortDefault() then picks it. */
  operatorPort?: number;
  json?: boolean;
  times: number;
}

/** Registers the `replay` command on `program`, wiring its flags to `runReplay`. */
export function registerReplay(program: Command): void {
  program
    .command('replay <artifact>')
    .description('replay a validated capability artifact deterministically (no LLM), with typed inputs and human handoff on escalation')
    .option('--input <name=value>', 'a capability input, repeatable (e.g. --input memberId=12345)', collect, [])
    .option('--approve', 'treat the capability as approved for THIS RUN ONLY (in memory; the artifact file on disk is never modified) so its irreversible steps may run')
    .option(
      '--read-only',
      'assert, for THIS RUN ONLY, that replaying the capability changes nothing in the target app (not verified; the artifact is never modified). ' +
        'It lets replay retry a transient app error (HTTP 500, an "Application Error" page) by waiting and restarting its steps, ' +
        'up to the policy\'s limits.maxAppErrorRetries (default 2). Refused on a capability with anything irreversible. ' +
        'A capability that carries readOnly: true needs no flag',
    )
    .option(
      '--fault <json>',
      'JSON object POSTed to <baseUrl>/__faults before the run and reverted after (always, even on failure/crash); ' +
        'the replay surface itself can never reach /__faults or /__reset (denied by policy) -- only the CLI, as the operator of this demo, may set/restore faults',
    )
    .option('--auto-operator <mode>', 'scripted operator for unattended runs: none|approve|abort|relogin (default none: a human uses the Relay console, or --headed)', 'none')
    .option(
      '--operator-port <n>',
      'Relay console port, an integer 0-65535 (0 = ephemeral); if the port is busy, the console starts on an OS-assigned port instead and the new URL is logged. ' +
        'Default: the well-known port with --headed or --auto-operator none (a human may need the console), ' +
        'else 0 (ephemeral -- no console is needed for a headless, scripted run)',
      parsePort,
    )
    .option('--json', 'print only the ReplayResult JSON to stdout; everything else (progress, warnings, run dir) goes to stderr')
    .option(
      '--times <n>',
      'run the replay N times sequentially in one shared browser and print a stability summary instead of a single result (default 1)',
      (v: string) => Number(v),
      1,
    )
    .action(async (artifactPath: string, options: ReplayCommandOptions, cmd: Command) => {
      const g = globalsOf(cmd);
      const log = (line: string): void => console.error(line);

      // Fail fast, before any browser is launched: --base-url's origin must be in the loaded
      // policy's allowedOrigins.
      const originError = baseUrlPolicyError(g.baseUrl, g.policy);
      if (originError !== undefined) {
        console.error(`cu: ${originError}`);
        process.exitCode = CRASH_EXIT_CODE;
        return;
      }

      if (!AUTO_OPERATOR_MODES.includes(options.autoOperator as AutoOperatorMode)) {
        console.error(`cu replay: --auto-operator must be one of ${AUTO_OPERATOR_MODES.join('|')}, got "${options.autoOperator}"`);
        process.exitCode = CRASH_EXIT_CODE;
        return;
      }
      const autoOperator = options.autoOperator as AutoOperatorMode;
      // No console needed for a headless run with a scripted operator attached; --headed or an
      // unscripted (--auto-operator none) run keeps the well-known port so a human can find it.
      const operatorPort = options.operatorPort ?? resolveOperatorPortDefault({ headed: !g.headless, autoOperator });

      if (!Number.isInteger(options.times) || options.times < 1) {
        console.error(`cu replay: --times must be a positive integer, got "${options.times}"`);
        process.exitCode = CRASH_EXIT_CODE;
        return;
      }
      const times = options.times;

      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(artifactPath, 'utf8'));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`cu replay: could not read/parse ${artifactPath}: ${message}`);
        process.exitCode = CRASH_EXIT_CODE;
        return;
      }

      // A deprecated capability is retired: refused here, before --approve could rewrite its
      // status in memory and before any browser is launched.
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>).status === 'deprecated') {
        const rec = raw as Record<string, unknown>;
        console.error(`cu replay: capability "${String(rec.id)}" is deprecated (version ${String(rec.version)}, ${artifactPath}); refusing to replay it`);
        process.exitCode = CRASH_EXIT_CODE;
        return;
      }

      if (options.approve === true) {
        if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
          (raw as Record<string, unknown>).status = 'approved';
        }
        console.error(
          'warning: --approve is treating this capability as approved for this run only (in memory); the artifact file on disk is unchanged',
        );
        console.error('reminder: --approve applies to this run only; `cu approve <file> --by <name>` records an approval on disk');
      }

      if (options.readOnly === true) console.error(READ_ONLY_NOTE);

      let faultBody: unknown;
      if (options.fault !== undefined) {
        try {
          faultBody = JSON.parse(options.fault);
        } catch (err) {
          console.error(`cu replay: --fault is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = CRASH_EXIT_CODE;
          return;
        }
      }

      const inputs = parseKeyValues(options.input, '--input');

      // Credentials load here, before --fault mutates the target app and before --times launches a
      // browser, so "refusing to start (no browser launched)" is true. A failure throws to the
      // top-level catch (`cu: credentials (...): not set: X; ...`, exit 1).
      const credentialProvider = credentialProviderOf(g);
      const credentials = preloadedCredentialProvider(
        await loadRunCredentials(credentialProvider, secretEnvNamesOf(raw, g.overrideKey)),
        credentialProvider.id,
      );

      let faultSnapshot: unknown;
      if (faultBody !== undefined) {
        try {
          faultSnapshot = restoreBodyFor(await getJson(`${g.baseUrl}/__faults`), faultBody);
          await postJson(`${g.baseUrl}/__faults`, faultBody);
          log(`fault injected at ${g.baseUrl}/__faults: ${JSON.stringify(faultBody)}`);
        } catch (err) {
          console.error(`cu replay: --fault setup failed: ${err instanceof Error ? err.message : String(err)}`);
          // The valid keys of a partly rejected body were applied: put the snapshot back.
          if (faultSnapshot !== undefined) await postJson(`${g.baseUrl}/__faults`, faultSnapshot).catch(() => undefined);
          process.exitCode = CRASH_EXIT_CODE;
          return;
        }
      }

      const runOptions: RunReplayOptions = {
        capability: raw,
        inputs,
        policyPath: g.policy,
        runsDir: g.runsDir,
        baseUrl: g.baseUrl,
        headless: g.headless,
        ...(g.overrideKey !== undefined ? { tenant: g.overrideKey } : {}),
        ...(g.desktop !== undefined ? { desktop: g.desktop } : {}),
        autoOperator,
        operator: { port: operatorPort },
        log,
        credentials,
        ...(options.readOnly === true ? { readOnly: true } : {}),
      };
      /** runReplay, or `undefined` once Ctrl-C interrupted the run (exit code 130 is set here). */
      const replayOnce = async (extra: Partial<RunReplayOptions> = {}): Promise<Awaited<ReturnType<typeof runReplay>> | undefined> => {
        try {
          return await runReplay({ ...runOptions, ...extra });
        } catch (err) {
          if (!isInterruptedError(err)) throw err;
          log(`cu replay: ${err.message}; no result reported`);
          process.exitCode = INTERRUPTED_EXIT_CODE;
          return undefined;
        }
      };

      try {
        if (times === 1) {
          const ran = await replayOnce();
          if (ran === undefined) return;
          const { result, runDir, controlState } = ran;

          printReplayResult(result, runDir, { json: options.json === true, sensitiveOutputs: sensitiveOutputNamesOf(raw) });
          const chaos = await collectSeriesChaos(g.baseUrl, faultBody);
          if (chaos !== undefined) for (const line of seriesChaosLines(chaos, 1)) log(line);
          // Confirms hand-back returned control after any escalation.
          log(`control: ${controlState}`);
          process.exitCode = exitCodeForResult(result);
        } else {
          const browser = await chromium.launch({ headless: g.headless });
          const results: ReplayResult[] = [];
          let interrupted = false;
          try {
            for (let i = 0; i < times; i += 1) {
              // runReplay already announces this run's own directory once (runWithShutdown,
              // apps/cu/src/runtime/lifecycle.ts, on every path); this line adds the per-run outcome and
              // control state, not the directory again.
              const ran = await replayOnce({ browser });
              if (ran === undefined) {
                log(`cu replay: stopped after ${results.length} of ${times} runs completed`);
                interrupted = true;
                break;
              }
              results.push(ran.result);
              log(`run ${i + 1}/${times}: ${ran.result.kind} (control: ${ran.controlState})`);
            }
          } finally {
            await browser.close();
          }
          if (interrupted) return;

          const stability = summarizeStability(results);
          // Read before the finally below restores the faults (which turns chaos off).
          const chaos = await collectSeriesChaos(g.baseUrl, faultBody);
          printStabilitySummary(results, stability, { json: options.json === true, ...(chaos !== undefined ? { chaos } : {}) });
          // Worst run wins: the existing kind -> exit code mapping (exit-code.ts) is already
          // ordered by severity (0 < 3 < 4 < 5), so the highest exit code among the series is the
          // worst outcome.
          process.exitCode = results.reduce((worst, r) => Math.max(worst, exitCodeForResult(r)), 0);
        }
      } finally {
        if (faultSnapshot !== undefined) {
          try {
            await postJson(`${g.baseUrl}/__faults`, faultSnapshot);
            log('faults restored to their pre-run snapshot');
          } catch (err) {
            console.error(`warning: failed to restore faults after the run: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    });
}
