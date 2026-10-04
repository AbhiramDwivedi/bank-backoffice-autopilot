/**
 * Relay's dev harness (`npm --prefix apps/relay run dev`): builds the UI in watch mode and starts
 * the server against three realistic cu-core fixtures, so the console has something to show
 * without a real browser automation running.
 *
 *   - a replay run stuck on 'lookup-member-savings-balance' / 'open-member' with an
 *     unrecoverable_condition (an access-denied screen where a member profile was expected).
 *   - a replay run stuck on 'post-share-draft-reversal' / 'confirm-reversal' with a
 *     risky_action_confirmation (an irreversible reversal needing approval).
 *   - a discovery run (no capability, just a goal) blocked by an unexpected_dialog (a session
 *     expiry warning).
 *
 * While a fixture's broker is held by a human, this script emits a plausible captured action
 * (click / input / keypress / navigate, rotating) through that fixture's capture every 3s, so the
 * timeline fills in like a real operator working the session.
 *
 * Uses `startRelayServer` (../src/server/index.ts):
 *   startRelayServer({ port?, host?, brokers?: SessionBroker[], leaseMs?, staticDir?, redact? })
 *     => Promise<{ url, port, register(broker, { leaseMs?, redact? }?), unregister(runId), close() }>
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUi } from './build.js';
import { escalateSample, makeBrokerFixture, sampleAction, type BrokerFixture } from '../test/support/fixtures.js';
import type { HumanAction } from '../test/support/core-testing.js';
import { startRelayServer } from '../src/server/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.RELAY_PORT ?? 4330);
const ACTION_INTERVAL_MS = 3000;
const LEASE_MS = 5 * 60_000;

type ActionFactory = () => HumanAction;

/** Rotates through a plausible sequence of captured actions: search, type a member id, submit, then move on. */
const ACTIONS: readonly ActionFactory[] = [
  () => sampleAction({ type: 'click', target: { tag: 'button', role: 'button', name: 'Search' } }),
  () =>
    sampleAction({
      type: 'input',
      target: { tag: 'input', role: 'textbox', name: 'Member ID' },
      valueRedacted: true,
    }),
  () => sampleAction({ type: 'keypress', target: { tag: 'input', role: 'textbox', name: 'Member ID' }, key: 'Enter' }),
  () => sampleAction({ type: 'navigate', target: {}, url: 'http://cu-core.local/members/90001' }),
];

async function main(): Promise<void> {
  const ui = await buildUi({ watch: true, outdir: path.join(HERE, '..', 'dist') });

  const savingsLookup = makeBrokerFixture({ sessionLabel: 'cu-core — savings balance lookup', runKind: 'replay' });
  const shareDraftReversal = makeBrokerFixture({ sessionLabel: 'cu-core — share draft reversal', runKind: 'replay' });
  const loanPayoffLookup = makeBrokerFixture({ sessionLabel: 'cu-core — loan payoff lookup', runKind: 'discovery' });
  const fixtures: BrokerFixture[] = [savingsLookup, shareDraftReversal, loanPayoffLookup];

  const created = await Promise.all([
    escalateSample(savingsLookup.broker),
    escalateSample(shareDraftReversal.broker, {
      capabilityId: 'post-share-draft-reversal',
      stepId: 'confirm-reversal',
      reason: {
        code: 'risky_action_confirmation',
        message: "Reversing a posted share draft is irreversible and needs an operator's approval.",
      },
      currentUrl: 'http://cu-core.local/members/90001/share-drafts/SD-58231/reverse',
      context: {
        action: 'Reverse posted share draft SD-58231 ($412.00) for member 90001.',
        policy: "Reversal actions require an operator's approval before automation proceeds.",
      },
    }),
    escalateSample(loanPayoffLookup.broker, {
      capabilityId: undefined,
      goal: 'Find the payoff amount for loan 4471-02',
      stepId: undefined,
      reason: { code: 'unexpected_dialog', message: "A 'Session will expire in 60 seconds' dialog blocked the page." },
      currentUrl: 'http://cu-core.local/loans/4471-02',
      context: {
        expected: 'The payoff amount for loan 4471-02, shown on the loan details page.',
        observed: 'A "Session will expire in 60 seconds" dialog blocked the page before the payoff amount loaded.',
      },
    }),
  ]);
  // Nothing resolves these until a human takes and hands back/aborts through the running console;
  // swallow the eventual settlement so it never surfaces as an unhandled rejection.
  for (const c of created) c.resolution.catch(() => undefined);

  const server = await startRelayServer({
    port: PORT,
    brokers: fixtures.map((f) => f.broker),
    leaseMs: LEASE_MS,
  });
  console.log(`relay dev: ${server.url}`);

  const actionCursor = new WeakMap<BrokerFixture, number>();
  const tick = setInterval(() => {
    for (const fixture of fixtures) {
      if (fixture.broker.token.state !== 'human' || !fixture.capture.active) continue;
      const i = actionCursor.get(fixture) ?? 0;
      const next = ACTIONS[i % ACTIONS.length];
      if (next) fixture.capture.emit(next());
      actionCursor.set(fixture, i + 1);
    }
  }, ACTION_INTERVAL_MS);
  tick.unref();

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    clearInterval(tick);
    void (async () => {
      try {
        await server.close();
      } catch (err) {
        console.error('relay dev: error closing server', err);
      } finally {
        for (const fixture of fixtures) fixture.dispose();
        await ui.stop();
        process.exit(0);
      }
    })();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error('relay dev failed to start', err);
  process.exitCode = 1;
});
