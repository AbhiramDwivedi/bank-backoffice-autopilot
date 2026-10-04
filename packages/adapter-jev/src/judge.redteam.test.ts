/**
 * Redteam: the TypeSafe API key never leaves the Authorization header. Not in a thrown error's
 * message or stack (for every failure class: HTTP errors, a network error whose message echoes the
 * key, a malformed body), not in a judgment, and not in the judge object itself.
 */
import { describe, expect, it } from 'vitest';
import type { RiskJudgeRequest } from '@cu/core/policy';
import { createJevJudge, type FetchLike } from './judge.js';

const KEY = 'ts-live-SECRET-KEY-0123456789abcdef';

const REQ: RiskJudgeRequest = {
  phase: 'record',
  action: { type: 'click' },
  target: { name: 'Continue' },
  page: { url: 'http://localhost:4173/x' },
  goal: 'g',
  lexicalRisk: 'reversible',
};

function respond(status: number, body: unknown): FetchLike {
  return async () => ({ status, ok: status < 300, headers: { get: () => null }, json: async () => body });
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('redteam: the Jev API key never leaks', () => {
  const failures: [string, FetchLike][] = [
    ['401 whose body echoes the key', respond(401, { detail: `invalid key ${KEY}` })],
    ['422 whose body echoes the request', respond(422, { detail: `Authorization: Bearer ${KEY}` })],
    ['529 overloaded', respond(529, {})],
    ['malformed 200 body echoing the key', respond(200, { model: KEY, answers: {} })],
    [
      'network error whose message echoes the key',
      async () => {
        throw new TypeError(`connect failed for Bearer ${KEY}`);
      },
    ],
  ];

  for (const [name, fetch] of failures) {
    it(`not in the error: ${name}`, async () => {
      const judge = createJevJudge({ apiKey: KEY, fetch, maxAttempts: 2, sleep: async () => undefined });
      const err = await caught(judge.judge(REQ));
      expect(err).toBeInstanceOf(Error);
      const e = err as Error;
      expect(e.message).not.toContain(KEY);
      expect(String(e.stack)).not.toContain(KEY);
      expect(JSON.stringify(e)).not.toContain(KEY);
    });
  }

  it('not in a judgment, nor in the judge object', async () => {
    const judge = createJevJudge({
      apiKey: KEY,
      fetch: respond(200, { model: 'jev-1', answers: { commits_irreversibly: { type: 'noul', noul: 0.4 }, changes_state: { type: 'noul', noul: 0.9 } } }),
    });
    const judgment = await judge.judge(REQ);
    expect(JSON.stringify(judgment)).not.toContain(KEY);
    expect(JSON.stringify(judge)).not.toContain(KEY);
    expect(judge.id).not.toContain(KEY);
  });

  it('only in the Authorization header of the outbound request, never the body', async () => {
    let seenBody = '';
    let seenAuth = '';
    const judge = createJevJudge({
      apiKey: KEY,
      fetch: async (url, init) => {
        seenBody = init.body;
        seenAuth = init.headers.authorization ?? '';
        return respond(200, { model: 'm', answers: { commits_irreversibly: { type: 'noul', noul: 0 }, changes_state: { type: 'noul', noul: 0 } } })(url, init);
      },
    });
    await judge.judge(REQ);
    expect(seenAuth).toBe(`Bearer ${KEY}`);
    expect(seenBody).not.toContain(KEY);
  });
});
