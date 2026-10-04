import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicClient, DEFAULT_MODEL, toAnthropicParams, type AnthropicLike } from './llm.js';
import type { LlmRequest } from '@cu/core/agent';

const BASE_REQUEST: LlmRequest = {
  system: 'you are a helpful discovery agent',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
  tools: [
    {
      name: 'click',
      description: 'click an element',
      input_schema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
    },
  ],
  maxTokens: 16000,
};

function makeAnthropicResponse(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'msg_1',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    model: 'claude-opus-5',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 },
    ...overrides,
  };
}

function makeMockSdk(): AnthropicLike & {
  messagesCreate: ReturnType<typeof vi.fn>;
  betaMessagesCreate: ReturnType<typeof vi.fn>;
} {
  const messagesCreate = vi.fn();
  const betaMessagesCreate = vi.fn();
  return {
    messages: { create: messagesCreate },
    beta: { messages: { create: betaMessagesCreate } },
    messagesCreate,
    betaMessagesCreate,
  };
}

describe('toAnthropicParams (request shaping)', () => {
  it('sets model, max_tokens, system with cache_control, tool_choice auto + disable_parallel_tool_use, adaptive thinking', () => {
    const params = toAnthropicParams(BASE_REQUEST, { model: 'claude-opus-5', fallbacks: false });

    expect(params.model).toBe('claude-opus-5');
    expect(params.max_tokens).toBe(16000);
    expect(params.system).toEqual([
      { type: 'text', text: BASE_REQUEST.system, cache_control: { type: 'ephemeral' } },
    ]);
    expect(params.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(params.thinking).toEqual({ type: 'adaptive' });
  });

  it('renders tools with strict: true and the plain input_schema, no tool_choice forcing', () => {
    const params = toAnthropicParams(BASE_REQUEST, { model: 'claude-opus-5', fallbacks: false });
    expect(params.tools).toEqual([
      {
        name: 'click',
        description: 'click an element',
        input_schema: BASE_REQUEST.tools[0]?.input_schema,
        strict: true,
      },
    ]);
  });

  it('omits output_config when no effort is given, and sets it when one is', () => {
    const withoutEffort = toAnthropicParams(BASE_REQUEST, { model: 'claude-opus-5', fallbacks: false });
    expect(withoutEffort.output_config).toBeUndefined();

    const withEffort = toAnthropicParams(BASE_REQUEST, { model: 'claude-opus-5', fallbacks: false, effort: 'high' });
    expect(withEffort.output_config).toEqual({ effort: 'high' });
  });

  it('adds betas + fallbacks: "default" only when fallbacks is enabled', () => {
    const enabled = toAnthropicParams(BASE_REQUEST, { model: 'claude-opus-5', fallbacks: true });
    expect(enabled.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(enabled.fallbacks).toBe('default');

    const disabled = toAnthropicParams(BASE_REQUEST, { model: 'claude-opus-5', fallbacks: false });
    expect(disabled.betas).toBeUndefined();
    expect(disabled.fallbacks).toBeUndefined();
  });

  it('places a base64 image block (image/png) before a following text block, and drops evidencePath', () => {
    const req: LlmRequest = {
      ...BASE_REQUEST,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', pngBase64: 'ZmFrZQ==', evidencePath: 'shots/0001.png' },
            { type: 'text', text: 'what do you see?' },
          ],
        },
      ],
    };
    const params = toAnthropicParams(req, { model: 'claude-opus-5', fallbacks: false });
    const messages = params.messages as Array<{ role: string; content: unknown[] }>;
    const content = messages[0]?.content as Array<Record<string, unknown>>;

    expect(content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' },
    });
    expect(content[1]).toEqual({ type: 'text', text: 'what do you see?' });
    expect(content[0]).not.toHaveProperty('evidencePath');
  });
});

describe('createAnthropicClient / dispatch', () => {
  it('calls beta.messages.create when fallbacks is enabled (default)', async () => {
    const sdk = makeMockSdk();
    sdk.betaMessagesCreate.mockResolvedValue(makeAnthropicResponse());
    const client = createAnthropicClient({ sdk });

    await client.complete(BASE_REQUEST);

    expect(sdk.betaMessagesCreate).toHaveBeenCalledTimes(1);
    expect(sdk.messagesCreate).not.toHaveBeenCalled();
    const params = sdk.betaMessagesCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
  });

  it('calls plain messages.create with no betas/fallbacks when fallbacks: false', async () => {
    const sdk = makeMockSdk();
    sdk.messagesCreate.mockResolvedValue(makeAnthropicResponse());
    const client = createAnthropicClient({ sdk, fallbacks: false });

    await client.complete(BASE_REQUEST);

    expect(sdk.messagesCreate).toHaveBeenCalledTimes(1);
    expect(sdk.betaMessagesCreate).not.toHaveBeenCalled();
    const params = sdk.messagesCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.betas).toBeUndefined();
    expect(params.fallbacks).toBeUndefined();
  });

  it('uses DEFAULT_MODEL when no model / env override is given', () => {
    const sdk = makeMockSdk();
    const client = createAnthropicClient({ sdk });
    expect(client.model).toBe(DEFAULT_MODEL);
  });

  it('honours an explicit model option over the default', () => {
    const sdk = makeMockSdk();
    const client = createAnthropicClient({ sdk, model: 'claude-sonnet-5' });
    expect(client.model).toBe('claude-sonnet-5');
  });
});

describe('createAnthropicClient / env ANTHROPIC_MODEL override', () => {
  const original = process.env.ANTHROPIC_MODEL;

  afterEach(() => {
    if (original === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = original;
  });

  it('falls back to process.env.ANTHROPIC_MODEL when no model option is given', () => {
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
    const sdk = makeMockSdk();
    const client = createAnthropicClient({ sdk });
    expect(client.model).toBe('claude-sonnet-4-6');
  });

  it('an explicit model option still wins over the env var', () => {
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
    const sdk = makeMockSdk();
    const client = createAnthropicClient({ sdk, model: 'claude-opus-5' });
    expect(client.model).toBe('claude-opus-5');
  });
});

describe('createAnthropicClient / response mapping', () => {
  it('maps text and tool_use blocks, and drops thinking/fallback blocks', async () => {
    const sdk = makeMockSdk();
    sdk.betaMessagesCreate.mockResolvedValue(
      makeAnthropicResponse({
        content: [
          { type: 'thinking', thinking: 'internal reasoning', signature: 'sig' },
          { type: 'text', text: 'here is my answer' },
          { type: 'tool_use', id: 'toolu_abc', name: 'click', input: { ref: 'e1' } },
          { type: 'fallback', from: { model: 'claude-opus-5' }, to: { model: 'claude-opus-4-8' } },
        ],
      }),
    );
    const client = createAnthropicClient({ sdk });

    const res = await client.complete(BASE_REQUEST);

    expect(res.content).toEqual([
      { type: 'text', text: 'here is my answer' },
      { type: 'tool_use', id: 'toolu_abc', name: 'click', input: { ref: 'e1' } },
    ]);
    expect(res.stopReason).toBe('end_turn');
    expect(res.model).toBe('claude-opus-5');
  });

  it('passes through a refusal stop_reason', async () => {
    const sdk = makeMockSdk();
    sdk.betaMessagesCreate.mockResolvedValue(makeAnthropicResponse({ content: [], stop_reason: 'refusal' }));
    const client = createAnthropicClient({ sdk });

    const res = await client.complete(BASE_REQUEST);
    expect(res.stopReason).toBe('refusal');
  });

  it('accumulates usage totals across calls', async () => {
    const sdk = makeMockSdk();
    sdk.betaMessagesCreate
      .mockResolvedValueOnce(
        makeAnthropicResponse({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } }),
      )
      .mockResolvedValueOnce(
        makeAnthropicResponse({ usage: { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
      );
    const client = createAnthropicClient({ sdk });

    await client.complete(BASE_REQUEST);
    await client.complete(BASE_REQUEST);

    expect(client.totals).toEqual({
      calls: 2,
      inputTokens: 13,
      outputTokens: 12,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 1,
    });
  });
});

describe('createAnthropicClient / retries', () => {
  let sleep: (ms: number) => Promise<void>;

  beforeEach(() => {
    sleep = vi.fn((_ms: number) => Promise.resolve());
  });

  it('retries a 429 twice then succeeds: 3 calls total, no real waiting', async () => {
    const sdk = makeMockSdk();
    const rateLimitError = Object.assign(new Error('rate limited'), { status: 429 });
    sdk.betaMessagesCreate
      .mockRejectedValueOnce(rateLimitError)
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce(makeAnthropicResponse());

    const client = createAnthropicClient({ sdk, sleep, maxAttempts: 3, baseDelayMs: 10 });
    const res = await client.complete(BASE_REQUEST);

    expect(sdk.betaMessagesCreate).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(res.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('retries a connection error structurally (name === "APIConnectionError")', async () => {
    const sdk = makeMockSdk();
    const connErr = Object.assign(new Error('ECONNRESET'), { name: 'APIConnectionError' });
    sdk.betaMessagesCreate.mockRejectedValueOnce(connErr).mockResolvedValueOnce(makeAnthropicResponse());

    const client = createAnthropicClient({ sdk, sleep, maxAttempts: 2, baseDelayMs: 10 });
    await client.complete(BASE_REQUEST);

    expect(sdk.betaMessagesCreate).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 400', async () => {
    const sdk = makeMockSdk();
    const badRequest = Object.assign(new Error('bad request'), { status: 400 });
    sdk.betaMessagesCreate.mockRejectedValueOnce(badRequest);

    const client = createAnthropicClient({ sdk, sleep, maxAttempts: 3, baseDelayMs: 10 });

    await expect(client.complete(BASE_REQUEST)).rejects.toBe(badRequest);
    expect(sdk.betaMessagesCreate).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rethrows the last error once attempts are exhausted', async () => {
    const sdk = makeMockSdk();
    const rateLimitError = Object.assign(new Error('still limited'), { status: 429 });
    sdk.betaMessagesCreate.mockRejectedValue(rateLimitError);

    const client = createAnthropicClient({ sdk, sleep, maxAttempts: 3, baseDelayMs: 10 });

    await expect(client.complete(BASE_REQUEST)).rejects.toBe(rateLimitError);
    expect(sdk.betaMessagesCreate).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('honours a retry-after header (seconds), capped at 30s', async () => {
    const sdk = makeMockSdk();
    const err = Object.assign(new Error('rate limited'), {
      status: 429,
      headers: { get: (name: string) => (name === 'retry-after' ? '2' : null) },
    });
    sdk.betaMessagesCreate.mockRejectedValueOnce(err).mockResolvedValueOnce(makeAnthropicResponse());

    const client = createAnthropicClient({ sdk, sleep, maxAttempts: 2, baseDelayMs: 10 });
    await client.complete(BASE_REQUEST);

    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('never logs request content on retry or failure', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sdk = makeMockSdk();
    const rateLimitError = Object.assign(new Error('rate limited'), { status: 429 });
    sdk.betaMessagesCreate.mockRejectedValue(rateLimitError);

    const client = createAnthropicClient({ sdk, sleep, maxAttempts: 2, baseDelayMs: 10 });
    await expect(client.complete(BASE_REQUEST)).rejects.toThrow();

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
