/**
 * Catalog invoke, end to end (apps/cu/src/catalog/index.ts). `loadCatalog('artifacts')` walks the real
 * artifacts/ directory; `toToolDefinitions()` is the Anthropic tool-definition surface an agent
 * would see; `invoke(id, args, opts)` replays a capability by id through the exact same wiring
 * as `cu replay` (apps/cu/src/runtime/run-replay.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { loadCatalog } from '@cu/cli/catalog';
import { PASSWORD, USER, launchBrowser, policyFor, startMock, tempRunsDir, type MockServer } from './harness.js';

describe('catalog: load, tool definitions, invoke end to end', () => {
  let browser: Browser;
  let mock: MockServer;

  beforeAll(async () => {
    // catalog.invoke() is a library call, not the CLI (which loads these via apps/cu/src/env.ts's
    // loadEnv()): the secret-env values it needs for the artifact's `{kind:'secret'}` inputs must
    // already be in the environment, same as harness.ts's replayOnce() defaults them.
    process.env.MOCK_USER ??= USER;
    process.env.MOCK_PASSWORD ??= PASSWORD;
    browser = await launchBrowser();
    mock = await startMock('a');
  });

  afterAll(async () => {
    await mock.close();
    await browser.close();
  });

  it('loads artifacts/ and picks the highest version of a capability id', () => {
    const catalog = loadCatalog('artifacts');
    const entry = catalog.get('lookup-member-savings-balance');
    expect(entry).toBeDefined();
    // artifacts/ holds the model-recorded 1.2.x and the hand-written 1.0.x example under one id.
    expect(entry?.capability.version.startsWith('1.2.')).toBe(true);
    expect(entry?.status).toBe('approved');
  });

  it('exposes the reference example as a strict Anthropic tool definition', () => {
    const catalog = loadCatalog('artifacts/examples');
    const entry = catalog.get('lookup-member-savings-balance');
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('approved');

    const tools = catalog.toToolDefinitions();
    const tool = tools.find((t) => t.name === 'lookup-member-savings-balance');
    expect(tool).toBeDefined();
    expect(tool?.input_schema.type).toBe('object');
    expect(tool?.input_schema.additionalProperties).toBe(false);
    expect(tool?.input_schema.required).toEqual(['memberId']);
    expect(tool?.input_schema.properties.memberId?.pattern).toBe('^[0-9]{5}$');
  });

  it(
    'invoke: memberId 12345 against the real mock app succeeds with the reference savings balance',
    async () => {
      const catalog = loadCatalog('artifacts');
      const result = await catalog.invoke(
        'lookup-member-savings-balance',
        { memberId: '12345' },
        { baseUrl: mock.baseUrl, policy: policyFor(mock.baseUrl), runsDir: tempRunsDir(), browser, autoOperator: 'none' },
      );
      expect(result.kind).toBe('success');
      if (result.kind === 'success') {
        expect(result.outputs.savingsBalance).toBe(1234.56);
      }
    },
    60_000,
  );

  it(
    'invoke: memberId "abc" fails input validation before the browser ever navigates',
    async () => {
      const catalog = loadCatalog('artifacts');
      const result = await catalog.invoke(
        'lookup-member-savings-balance',
        { memberId: 'abc' },
        { baseUrl: mock.baseUrl, policy: policyFor(mock.baseUrl), runsDir: tempRunsDir(), browser, autoOperator: 'none' },
      );
      expect(result.kind).toBe('hard_failure');
      if (result.kind === 'hard_failure') {
        expect(result.code).toBe('input_validation');
      }
    },
    60_000,
  );

  it('invoke: an unknown capability id throws', async () => {
    const catalog = loadCatalog('artifacts');
    await expect(
      catalog.invoke('does-not-exist', {}, { baseUrl: mock.baseUrl, policy: policyFor(mock.baseUrl), runsDir: tempRunsDir(), browser }),
    ).rejects.toThrow(/unknown capability id/);
  });
});
