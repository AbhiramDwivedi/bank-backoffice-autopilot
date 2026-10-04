/**
 * A canned `LlmClient` for tests: replays a fixed script of tool calls / text turns instead of
 * calling the network. Records every request it was given so tests can assert on prompt shape
 * (see `requestText`).
 */
import type { LlmClient, LlmOutputBlock, LlmRequest, LlmResponse } from './types.js';

/** One scripted turn: a tool call, a plain text reply, or a function that inspects the request
 *  and returns one of those (or another function) dynamically. */
export type ScriptedTurn =
  | { tool: string; input: Record<string, unknown> }
  | { text: string }
  | ((req: LlmRequest, index: number) => ScriptedTurn);

/** Options for {@link createScriptedLlm}. */
export interface ScriptedLlmOptions {
  model?: string;
  /** What to do once the script runs out. Default 'stuck'. */
  onExhausted?: 'stuck' | 'throw';
}

/** A scripted `LlmClient` that also records every request it received. */
export interface ScriptedLlm extends LlmClient {
  readonly requests: readonly LlmRequest[];
  readonly remaining: number;
}

/** Every text block of a request (system + message text), joined with \n — for leak/prompt assertions. */
export function requestText(req: LlmRequest): string {
  const parts: string[] = [req.system];
  for (const m of req.messages) {
    for (const b of m.content) {
      if (b.type === 'text') parts.push(b.text);
    }
  }
  return parts.join('\n');
}

function isDataTurn(t: ScriptedTurn): t is { tool: string; input: Record<string, unknown> } | { text: string } {
  return typeof t !== 'function';
}

/** Creates a scripted `LlmClient` that replays `turns` in order, one per `complete` call. */
export function createScriptedLlm(turns: ScriptedTurn[], opts: ScriptedLlmOptions = {}): ScriptedLlm {
  const model = opts.model ?? 'scripted';
  const onExhausted = opts.onExhausted ?? 'stuck';
  const queue: ScriptedTurn[] = [...turns];
  const requests: LlmRequest[] = [];
  let callCount = 0;

  /** Resolves a queued turn, following function turns until a data turn (or the queue empties). */
  function resolveTurn(req: LlmRequest, index: number): { tool: string; input: Record<string, unknown> } | { text: string } | undefined {
    let next: ScriptedTurn | undefined = queue.shift();
    let guard = 0;
    while (next !== undefined && !isDataTurn(next)) {
      if (guard++ > 10) throw new Error('scripted LLM turn function did not resolve to a value');
      next = next(req, index);
    }
    return next;
  }

  function baseResponse(content: LlmOutputBlock[], stopReason: string): LlmResponse {
    return { content, stopReason, usage: { inputTokens: 0, outputTokens: 0 }, model };
  }

  async function complete(req: LlmRequest): Promise<LlmResponse> {
    requests.push(req);
    const index = callCount++;
    const turn = resolveTurn(req, index);

    if (turn === undefined) {
      if (onExhausted === 'throw') {
        throw new Error('scripted LLM exhausted');
      }
      return baseResponse(
        [{ type: 'tool_use', id: `toolu_scripted_${index}`, name: 'stuck', input: { reason: 'scripted LLM exhausted' } }],
        'tool_use',
      );
    }

    if ('text' in turn) {
      return baseResponse([{ type: 'text', text: turn.text }], 'end_turn');
    }

    return baseResponse(
      [{ type: 'tool_use', id: `toolu_scripted_${index}`, name: turn.tool, input: turn.input }],
      'tool_use',
    );
  }

  return {
    model,
    complete,
    get requests() {
      return requests;
    },
    get remaining() {
      return queue.length;
    },
  };
}
