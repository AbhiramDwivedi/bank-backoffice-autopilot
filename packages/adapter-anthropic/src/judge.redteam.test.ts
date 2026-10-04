/**
 * Redteam: the Anthropic API key never leaves the request header. The judge runs over the real SDK
 * client with an injected `fetch`, so the SDK's own error objects (which carry the response body)
 * are exercised: a 401 whose body echoes the key, a 422 echoing the request, a network error
 * echoing the key, and a malformed 200. The key must appear in no error message, stack or JSON,
 * in no judgment, and only in the `x-api-key` header of the outbound request.
 */
import { describe, expect, it } from 'vitest';
import type { RiskJudgeRequest } from '@cu/core/policy';
import { createAnthropicJudge } from './judge.js';

// Built at runtime so no tracked file contains a key-shaped literal (the repo-hygiene scan in
// apps/mock-app/repo-hygiene.redteam.test.ts greps tracked content for the key prefix).
const KEY = ['sk', 'ant', 'test-SECRET-0123456789abcdef'].join('-');

const REQ: RiskJudgeRequest = {
  phase: 'record',
  action: { type: 'click' },
  target: { name: 'Continue' },
  page: { url: 'http://localhost:4173/x' },
  goal: 'g',
  lexicalRisk: 'reversible',
};

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const respond =
  (status: number, body: unknown): FetchFn =>
  async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('redteam: the Anthropic judge never leaks its API key', () => {
  const failures: [string, FetchFn][] = [
    ['401 whose body echoes the key', respond(401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` } })],
    ['422 whose body echoes a header', respond(422, { type: 'error', error: { type: 'invalid_request_error', message: `x-api-key: ${KEY}` } })],
    [
      'network error whose message echoes the key',
      async () => {
        throw new TypeError(`connect failed with x-api-key ${KEY}`);
      },
    ],
    ['malformed 200 echoing the key', respond(200, { id: 'm', type: 'message', role: 'assistant', model: KEY, content: [{ type: 'text', text: KEY }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })],
  ];

  for (const [name, fetch] of failures) {
    it(`not in the error: ${name}`, async () => {
      const judge = createAnthropicJudge({ apiKey: KEY, fetch });
      const err = await caught(judge.judge(REQ));
      expect(err).toBeInstanceOf(Error);
      const e = err as Error;
      expect(e.message).not.toContain(KEY);
      expect(String(e.stack)).not.toContain(KEY);
      expect(JSON.stringify(e)).not.toContain(KEY);
      expect(JSON.stringify(Object.getOwnPropertyNames(e).map((k) => (e as unknown as Record<string, unknown>)[k]))).not.toContain(KEY);
    }, 20000);
  }

  it('only in the x-api-key header of the outbound request; not in the body, a judgment, or the judge object', async () => {
    let seenKeyHeader = '';
    let seenBody = '';
    const judge = createAnthropicJudge({
      apiKey: KEY,
      fetch: async (input, init) => {
        seenKeyHeader = new Headers(init?.headers).get('x-api-key') ?? '';
        seenBody = String(init?.body ?? '');
        return respond(200, {
          id: 'm',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [{ type: 'tool_use', id: 't', name: 'report_risk', input: { risk: 'read', p_irreversible: 0.1, rationale: 'fine' } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1 },
        })(input, init);
      },
    });
    const judgment = await judge.judge(REQ);
    expect(seenKeyHeader).toBe(KEY);
    expect(seenBody).not.toContain(KEY);
    expect(JSON.stringify(judgment)).not.toContain(KEY);
    expect(JSON.stringify(judge)).not.toContain(KEY);
  });
});
