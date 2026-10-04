/**
 * Red-team suite for captured human actions, proven end to end through
 * Relay's real HTTP API (`POST .../take`, the SSE stream, `POST .../handback`) over a real
 * `startRelayServer`, and additionally checks the persisted `<runDir>/interventions/<id>.json` and
 * `<runDir>/events.jsonl` -- see docs/design/security-review.md's "Captured human actions persist
 * a live value..." row and docs/design/relay.md's "Security perimeter".
 *
 * Claim under test: a captured action is rebuilt from a whitelist (no `value` key ever survives;
 * `target.text` is dropped for `input` actions), and every registered secret value
 * (`SessionBrokerOptions.secretValues`) is scrubbed from the surviving `target.name`/`selector`/
 * (non-input) `text` fields -- see packages/core/src/session/broker.ts `recordHumanAction`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { jsonBody, makeSecretBrokerFixture, readJsonlFile, startRealRelayServer, waitForActionCount, type SecretBrokerFixture } from './redteam-helpers.js';
import { escalateSample } from '../support/fixtures.js';
import type { RelayServerHandle } from '../../src/server/index.js';

const TYPED_SECRET = 'hunter2-typedSecretValue';
const REDACTED = '[REDACTED]'; // packages/core/src/schema/constants.ts REDACTED_VALUE

const fixtures: SecretBrokerFixture[] = [];
const servers: RelayServerHandle[] = [];

function fixture(): SecretBrokerFixture {
  const f = makeSecretBrokerFixture([TYPED_SECRET]);
  fixtures.push(f);
  return f;
}

afterEach(async () => {
  for (const h of servers.splice(0)) await h.close();
  for (const f of fixtures.splice(0)) f.dispose();
});

/** Every place the secret must never reach: the two REST reads, the handback response, and the
 *  two on-disk evidence files. Shared across the attacks below to keep each test's intent visible. */
async function assertSecretNeverLeaks(h: RelayServerHandle, f: SecretBrokerFixture, id: string): Promise<void> {
  const list = await (await fetch(`${h.url}/api/interventions`)).json();
  expect(JSON.stringify(list)).not.toContain(TYPED_SECRET);

  const single = await (await fetch(`${h.url}/api/interventions/${id}`)).json();
  expect(JSON.stringify(single)).not.toContain(TYPED_SECRET);

  const hb = await fetch(`${h.url}/api/interventions/${id}/handback`, jsonBody({ by: 'operator', resumeFrom: 'next_step' }));
  expect(hb.status).toBe(200);
  const hbBody = await hb.json();
  expect(JSON.stringify(hbBody)).not.toContain(TYPED_SECRET);

  const onDisk = JSON.parse(readFileSync(path.join(f.runDir, 'interventions', `${id}.json`), 'utf8')) as unknown;
  expect(JSON.stringify(onDisk)).not.toContain(TYPED_SECRET);

  const events = readJsonlFile(path.join(f.runDir, 'events.jsonl'));
  expect(JSON.stringify(events)).not.toContain(TYPED_SECRET);
}

describe('HumanAction capture over the real HTTP API: a typed value must never persist', () => {
  it('an `input` action smuggling `value` and `target.text` is scrubbed: no value, no text, valueRedacted true, and the secret reaches nothing over the API, the SSE stream, handback or disk', async () => {
    const f = fixture();
    const h = await startRealRelayServer([f.broker]);
    servers.push(h);
    const { id, resolution } = await escalateSample(f.broker);

    const take = await fetch(`${h.url}/api/interventions/${id}/take`, jsonBody({ by: 'operator' }));
    expect(take.status).toBe(200);

    // Malformed/untrusted capture (as an operator page's fake or a buggy real capture might send):
    // reports a `value` field (never part of the HumanAction schema) alongside `target.text` equal
    // to the same typed value.
    f.capture.emit({
      ts: new Date().toISOString(),
      type: 'input',
      frame: [],
      target: { tag: 'input', role: 'textbox', name: 'Password', text: TYPED_SECRET },
      value: TYPED_SECRET,
      url: 'http://cu-core.local/members/90001',
    });

    const single = (await waitForActionCount(h.url, id, 1)) as { humanActions: Array<Record<string, unknown>> };
    expect(JSON.stringify(single)).not.toContain(TYPED_SECRET);
    const action = single.humanActions[0]!;
    expect(action.value).toBeUndefined();
    expect((action.target as Record<string, unknown>).text).toBeUndefined();
    expect(action.valueRedacted).toBe(true);
    // Identity fields survive; only text/value are stripped for inputs.
    expect((action.target as Record<string, unknown>).name).toBe('Password');

    await assertSecretNeverLeaks(h, f, id);
    await resolution;
  });

  it("a `click` action smuggling the secret into target.name/selector/text is scrubbed once the broker is given the registered secret value", async () => {
    const f = fixture();
    const h = await startRealRelayServer([f.broker]);
    servers.push(h);
    const { id, resolution } = await escalateSample(f.broker);
    await fetch(`${h.url}/api/interventions/${id}/take`, jsonBody({ by: 'operator' }));

    f.capture.emit({
      ts: new Date().toISOString(),
      type: 'click',
      frame: [],
      target: { tag: 'div', role: 'button', name: TYPED_SECRET, selector: `#x[data-v="${TYPED_SECRET}"]`, text: TYPED_SECRET },
    });

    const single = (await waitForActionCount(h.url, id, 1)) as { humanActions: Array<Record<string, unknown>> };
    expect(JSON.stringify(single)).not.toContain(TYPED_SECRET);
    const target = single.humanActions[0]!.target as Record<string, unknown>;
    expect(target.name).toBe(REDACTED); // exact match: the whole field was the secret
    expect(target.selector).not.toContain(TYPED_SECRET); // embedded in a larger string: substring-scrubbed
    expect(target.selector).toContain(REDACTED);
    expect(target.text).toBe(REDACTED);

    await assertSecretNeverLeaks(h, f, id);
    await resolution;
  });

  it('a `keypress` action carrying the secret as `key` never keeps it as `key`', async () => {
    const f = fixture();
    const h = await startRealRelayServer([f.broker]);
    servers.push(h);
    const { id, resolution } = await escalateSample(f.broker);
    await fetch(`${h.url}/api/interventions/${id}/take`, jsonBody({ by: 'operator' }));

    f.capture.emit({
      ts: new Date().toISOString(),
      type: 'keypress',
      frame: [],
      target: { tag: 'input', role: 'textbox', name: 'Password' },
      key: TYPED_SECRET,
    });

    const single = (await waitForActionCount(h.url, id, 1)) as { humanActions: Array<Record<string, unknown>> };
    expect(JSON.stringify(single)).not.toContain(TYPED_SECRET);
    expect(single.humanActions[0]!.key).not.toBe(TYPED_SECRET);
    expect(single.humanActions[0]!.key).toBeUndefined();

    await assertSecretNeverLeaks(h, f, id);
    await resolution;
  });

  // Named-key-only `key` support (`NAMED_KEY_PATTERN` in broker.ts, gating on `/^[A-Z][A-Za-z0-9]{1,31}$/`)
  // landed in packages/core/src/session/broker.ts while this suite was being written -- a named
  // key like 'Enter' now survives, unlike the secret-shaped `key` in the previous test.
  it('a named key like `Enter` IS kept as `key`', async () => {
    const f = fixture();
    const h = await startRealRelayServer([f.broker]);
    servers.push(h);
    const { id, resolution } = await escalateSample(f.broker);
    await fetch(`${h.url}/api/interventions/${id}/take`, jsonBody({ by: 'operator' }));

    f.capture.emit({
      ts: new Date().toISOString(),
      type: 'keypress',
      frame: [],
      target: { tag: 'input', role: 'textbox', name: 'Password' },
      key: 'Enter',
    });

    const single = (await waitForActionCount(h.url, id, 1)) as { humanActions: Array<Record<string, unknown>> };
    expect(single.humanActions[0]!.key).toBe('Enter');

    await fetch(`${h.url}/api/interventions/${id}/abort`, jsonBody({ by: 'operator' }));
    await resolution;
  });
});
