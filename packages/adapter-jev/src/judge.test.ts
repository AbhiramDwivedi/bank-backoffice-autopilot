/**
 * `createJevJudge` against an injected `fetch`: request shape (endpoint, auth header, model,
 * named state fields, two Noul questions with criteria), response validation and mapping, and the
 * retry policy (429/529 retried with backoff and `retry-after`, 401/422 not, abort honoured).
 */
import { describe, expect, it } from 'vitest';
import type { RiskJudgeRequest } from '@cu/core/policy';
import { JEV_ENDPOINT, createJevJudge, toJudgment, type FetchLike } from './judge.js';

const REQ: RiskJudgeRequest = {
  phase: 'record',
  action: { type: 'click' },
  target: { name: 'Continue', role: 'button', tag: 'button' },
  page: { url: 'http://localhost:4173/transfers/review', title: 'Review transfer', textDigest: 'Review your transfer of $500.00' },
  goal: 'Send the transfer',
  why: 'Proceed',
  lexicalRisk: 'reversible',
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function okBody(commits: number, changes: number) {
  return {
    model: 'jev-1.13.0',
    answers: { commits_irreversibly: { type: 'noul', noul: commits }, changes_state: { type: 'noul', noul: changes } },
    usage: { input_tokens: 400, output_tokens: 20 },
  };
}

/** A fetch that answers from a queue of `[status, body, headers?]` and records each call. */
function queuedFetch(responses: [number, unknown, Record<string, string>?][]): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
    const next = responses.shift();
    if (next === undefined) throw new Error('no more queued responses');
    const [status, body, headers = {}] = next;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: async () => body,
    };
  }) as FetchLike & { calls: Call[] };
  f.calls = calls;
  return f;
}

const noSleep = async (): Promise<void> => undefined;

describe('createJevJudge: request', () => {
  it('POSTs one request with the bearer key, the model, named state fields and two Noul questions', async () => {
    const fetch = queuedFetch([[200, okBody(0.9, 0.95)]]);
    const judge = createJevJudge({ apiKey: 'test-key-1', fetch });
    await judge.judge(REQ);

    expect(fetch.calls).toHaveLength(1);
    const call = fetch.calls[0]!;
    expect(call.url).toBe(JEV_ENDPOINT);
    expect(call.headers.authorization).toBe('Bearer test-key-1');
    expect(call.body.model).toBe('jev-latest');
    expect(call.body.state).toMatchObject({
      action: { type: 'click' },
      control: { name: 'Continue', role: 'button' },
      page: { url: REQ.page.url, title: 'Review transfer' },
      operator_goal: 'Send the transfer',
      agent_stated_reason: 'Proceed',
      pattern_based_risk: 'reversible',
    });
    const questions = call.body.questions as Record<string, { type: string; instructions: string; criteria: { true: string; false: string } }>;
    expect(Object.keys(questions).sort()).toEqual(['changes_state', 'commits_irreversibly']);
    for (const q of Object.values(questions)) {
      expect(q.type).toBe('noul');
      expect(q.instructions).toContain('untrusted');
      expect(q.criteria.true.length).toBeGreaterThan(0);
      expect(q.criteria.false.length).toBeGreaterThan(0);
    }
    expect(judge.id).toBe('jev:jev-latest');
  });

  it('honours a model override', async () => {
    const fetch = queuedFetch([[200, okBody(0.1, 0.1)]]);
    const judge = createJevJudge({ apiKey: 'k', model: 'jev-1.13.0', fetch });
    await judge.judge(REQ);
    expect(fetch.calls[0]!.body.model).toBe('jev-1.13.0');
    expect(judge.id).toBe('jev:jev-1.13.0');
  });

  it('refuses an empty key up front', () => {
    expect(() => createJevJudge({ apiKey: '  ' })).toThrow(/API key is required/);
  });
});

describe('createJevJudge: response mapping', () => {
  it('maps the two probabilities to risk and pIrreversible', () => {
    expect(toJudgment(okBody(0.92, 0.97))).toMatchObject({ risk: 'irreversible', pIrreversible: 0.92 });
    expect(toJudgment(okBody(0.1, 0.8))).toMatchObject({ risk: 'reversible', pIrreversible: 0.1 });
    expect(toJudgment(okBody(0.05, 0.1))).toMatchObject({ risk: 'read', pIrreversible: 0.05 });
    expect(toJudgment(okBody(0.92, 0.97)).rationale).toContain('P(commits irreversibly)=0.92');
  });

  it('rejects a response missing an answer, with the wrong type, or out of range', async () => {
    const missing = { model: 'm', answers: { commits_irreversibly: { type: 'noul', noul: 0.5 } } };
    const wrongType = { model: 'm', answers: { commits_irreversibly: { type: 'choice', choice: 'yes' }, changes_state: { type: 'noul', noul: 0.1 } } };
    const outOfRange = okBody(1.4, 0.2);
    for (const body of [missing, wrongType, outOfRange, 'nope']) {
      const judge = createJevJudge({ apiKey: 'k', fetch: queuedFetch([[200, body]]) });
      await expect(judge.judge(REQ)).rejects.toThrow(/unexpected response shape/);
    }
  });
});

describe('createJevJudge: errors and retries', () => {
  it('retries 429 and 529 with backoff, honouring retry-after', async () => {
    const fetch = queuedFetch([
      [429, { error: 'rate' }, { 'retry-after': '2' }],
      [529, { error: 'overloaded' }],
      [200, okBody(0.2, 0.3)],
    ]);
    const sleeps: number[] = [];
    const judge = createJevJudge({ apiKey: 'k', fetch, baseDelayMs: 100, sleep: async (ms) => void sleeps.push(ms) });
    const j = await judge.judge(REQ);
    expect(j.pIrreversible).toBe(0.2);
    expect(fetch.calls).toHaveLength(3);
    expect(sleeps).toEqual([2000, 200]);
  });

  it('gives up after maxAttempts with the last status', async () => {
    const fetch = queuedFetch([
      [529, {}],
      [529, {}],
    ]);
    const judge = createJevJudge({ apiKey: 'k', fetch, maxAttempts: 2, sleep: noSleep });
    await expect(judge.judge(REQ)).rejects.toMatchObject({ name: 'JevJudgeError', status: 529, message: 'jev: HTTP 529 overloaded' });
    expect(fetch.calls).toHaveLength(2);
  });

  it('does not retry 401 or 422', async () => {
    for (const status of [401, 422]) {
      const fetch = queuedFetch([[status, { detail: 'nope' }]]);
      const judge = createJevJudge({ apiKey: 'k', fetch, sleep: noSleep });
      await expect(judge.judge(REQ)).rejects.toMatchObject({ status });
      expect(fetch.calls).toHaveLength(1);
    }
  });

  it('retries a network error', async () => {
    let n = 0;
    const flaky: FetchLike = async (url, init) => {
      n += 1;
      if (n === 1) throw new TypeError('fetch failed');
      return queuedFetch([[200, okBody(0.6, 0.9)]])(url, init);
    };
    const judge = createJevJudge({ apiKey: 'k', fetch: flaky, sleep: noSleep });
    expect((await judge.judge(REQ)).risk).toBe('irreversible');
  });

  it('stops retrying once the caller aborts (the guarded judge timeout)', async () => {
    const controller = new AbortController();
    const fetch = queuedFetch([
      [529, {}],
      [200, okBody(0.1, 0.1)],
    ]);
    const judge = createJevJudge({
      apiKey: 'k',
      fetch,
      sleep: async (_ms, signal) => {
        controller.abort(new Error('timed out'));
        if (signal?.aborted) throw signal.reason;
      },
    });
    await expect(judge.judge(REQ, controller.signal)).rejects.toThrow(/aborted while backing off/);
    expect(fetch.calls).toHaveLength(1);
  });
});
