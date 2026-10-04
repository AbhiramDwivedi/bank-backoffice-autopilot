/**
 * Anthropic-backed `LlmClient`. This is the only file in the repo that imports the SDK (packages/core/src/replay/no-llm.redteam.test.ts).
 * Single-turn calls, adaptive thinking, `tool_choice: auto` with parallel tool use disabled,
 * strict tool schemas, a prompt-cached system prompt, and an opt-in server-side refusal fallback.
 *
 * Retry: 429 / 5xx (incl. 529) / connection errors are retried with exponential backoff + jitter,
 * honouring a `retry-after` header (seconds) when the error carries one, capped at 30s. 400/401/
 * 403/404 are never retried. Request content is never logged.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  LlmClient,
  LlmInputBlock,
  LlmMessage,
  LlmOutputBlock,
  LlmRequest,
  LlmResponse,
  LlmToolDef,
  LlmUsage,
} from '@cu/core/agent';

import { DEFAULT_MODEL } from '@cu/core/agent';

export { DEFAULT_MODEL };

/** Model reasoning effort, passed through to `output_config.effort`. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Beta flag for the scalar `fallbacks: "default"` form. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01' as const;

/**
 * Minimal structural seam the client talks to, instead of the real SDK class directly. The real
 * `messages.create` / `beta.messages.create` overloads are far stricter (streaming vs
 * non-streaming param unions keyed off a `stream` literal) than this interface needs, so it
 * widens params to `Record<string, unknown>` — that lets a hand-written mock in tests satisfy it
 * trivially, and lets `toAnthropicParams`'s deliberately loose return type flow straight through.
 * The real client is adapted to this shape once, in `wrapRealClient` below.
 */
export interface AnthropicLike {
  messages: {
    create(params: Record<string, unknown>): Promise<Anthropic.Message>;
  };
  beta: {
    messages: {
      create(params: Record<string, unknown>): Promise<Anthropic.Beta.BetaMessage>;
    };
  };
}

/** Options for {@link createAnthropicClient}. */
export interface AnthropicClientOptions {
  /** Default process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL. */
  model?: string;
  apiKey?: string;
  /**
   * Workspace to bill and scope the request to. Default process.env.ANTHROPIC_WORKSPACE_ID.
   * Required by the API when the key is not already scoped to a workspace.
   */
  workspaceId?: string;
  /** Total attempts (including the first). Default 3. */
  maxAttempts?: number;
  /** Default 1000ms; exponential backoff with jitter, capped at 30s. */
  baseDelayMs?: number;
  effort?: EffortLevel;
  /** Server-side refusal fallback. Default true. */
  fallbacks?: boolean;
  /** Injection seam for tests. */
  sdk?: AnthropicLike;
  sleep?: (ms: number) => Promise<void>;
}

/** Cumulative token usage across every call a client has made. */
export interface UsageTotals extends LlmUsage {
  calls: number;
}

/** An `LlmClient` that also exposes its running usage totals. */
export interface AnthropicLlmClient extends LlmClient {
  readonly totals: UsageTotals;
}

interface ToAnthropicParamsOptions {
  model: string;
  effort?: EffortLevel;
  fallbacks: boolean;
}

function toAnthropicContentBlock(b: LlmInputBlock): Record<string, unknown> {
  if (b.type === 'image') {
    return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b.pngBase64 } };
  }
  return { type: 'text', text: b.text };
}

function toAnthropicMessage(m: LlmMessage): Record<string, unknown> {
  return { role: m.role, content: m.content.map(toAnthropicContentBlock) };
}

function toAnthropicTool(t: LlmToolDef): Record<string, unknown> {
  return { name: t.name, description: t.description, input_schema: t.input_schema, strict: true };
}

/** Converts an `LlmRequest` into Anthropic SDK request params. Exported for tests. */
export function toAnthropicParams(req: LlmRequest, o: ToAnthropicParamsOptions): Record<string, unknown> {
  const params: Record<string, unknown> = {
    model: o.model,
    max_tokens: req.maxTokens,
    // Cache breakpoint on the system block: tools render before system, so tools+system form a
    // stable, cacheable prefix ahead of the (volatile) per-turn user message.
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    messages: req.messages.map(toAnthropicMessage),
    tools: req.tools.map(toAnthropicTool),
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    thinking: { type: 'adaptive' },
  };

  if (o.effort) {
    params.output_config = { effort: o.effort };
  }

  if (o.fallbacks) {
    params.betas = [FALLBACK_BETA];
    params.fallbacks = 'default';
  }

  return params;
}

function toLlmUsage(u: Anthropic.Usage | Anthropic.Beta.BetaUsage): LlmUsage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadInputTokens: u.cache_read_input_tokens ?? undefined,
    cacheCreationInputTokens: u.cache_creation_input_tokens ?? undefined,
  };
}

type AnyContentBlock = Anthropic.ContentBlock | Anthropic.Beta.BetaContentBlock;

function toLlmOutputBlocks(content: readonly AnyContentBlock[]): LlmOutputBlock[] {
  const out: LlmOutputBlock[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      out.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      out.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
    }
    // Everything else (thinking, fallback, server-tool blocks, ...) is dropped.
  }
  return out;
}

function toLlmResponse(raw: Anthropic.Message | Anthropic.Beta.BetaMessage): LlmResponse {
  return {
    content: toLlmOutputBlocks(raw.content),
    stopReason: raw.stop_reason,
    usage: toLlmUsage(raw.usage),
    model: raw.model,
  };
}

function isConnectionError(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true;
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'APIConnectionError';
}

function statusOf(err: unknown): number | undefined {
  if (err instanceof Anthropic.APIError) return err.status;
  if (typeof err !== 'object' || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/** Retry only 429, >=500 (incl. 529 overloaded), and connection errors. Never 400/401/403/404. */
function isRetryable(err: unknown): boolean {
  if (isConnectionError(err)) return true;
  const status = statusOf(err);
  return status !== undefined && (status === 429 || status >= 500);
}

/** Reads a `retry-after` header (seconds) off either a real Headers object or a plain map. */
function retryAfterMs(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const headers = (err as { headers?: unknown }).headers;
  if (!headers || typeof headers !== 'object') return undefined;

  const getter = (headers as { get?: unknown }).get;
  const raw =
    typeof getter === 'function'
      ? (getter as (name: string) => string | null).call(headers, 'retry-after')
      : (headers as Record<string, string | undefined>)['retry-after'];
  if (!raw) return undefined;

  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function backoffDelayMs(err: unknown, attempt: number, baseDelayMs: number): number {
  const fromHeader = retryAfterMs(err);
  const delay = fromHeader ?? baseDelayMs * 2 ** (attempt - 1) + Math.random() * baseDelayMs;
  return Math.min(delay, 30_000);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Adapts the real SDK client to {@link AnthropicLike}. `toAnthropicParams` deliberately returns a
 * loose `Record<string, unknown>` (so it can also feed a test mock); the real, strictly-typed
 * `create` overloads can't be satisfied from that without a cast. The cast is safe because the
 * params built here always describe a non-streaming request (no `stream: true` is ever set).
 */
function wrapRealClient(client: Anthropic): AnthropicLike {
  return {
    messages: {
      create: (params) => client.messages.create(params as unknown as Anthropic.MessageCreateParamsNonStreaming),
    },
    beta: {
      messages: {
        create: (params) =>
          client.beta.messages.create(params as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming),
      },
    },
  };
}

/** Creates an `LlmClient` backed by the Anthropic SDK, with retry and usage tracking built in. */
export function createAnthropicClient(opts: AnthropicClientOptions = {}): AnthropicLlmClient {
  const model = opts.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const fallbacksEnabled = opts.fallbacks ?? true;
  const sleep = opts.sleep ?? defaultSleep;
  const workspaceId = opts.workspaceId ?? process.env.ANTHROPIC_WORKSPACE_ID;
  const sdk: AnthropicLike =
    opts.sdk ??
    wrapRealClient(
      new Anthropic({
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}),
        maxRetries: 0,
      }),
    );

  const totals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    calls: 0,
  };

  function accumulate(usage: LlmUsage): void {
    totals.calls += 1;
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.cacheReadInputTokens = (totals.cacheReadInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0);
    totals.cacheCreationInputTokens = (totals.cacheCreationInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
  }

  async function complete(req: LlmRequest): Promise<LlmResponse> {
    const params = toAnthropicParams(req, { model, effort: opts.effort, fallbacks: fallbacksEnabled });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const raw = fallbacksEnabled ? await sdk.beta.messages.create(params) : await sdk.messages.create(params);
        const res = toLlmResponse(raw);
        accumulate(res.usage);
        return res;
      } catch (err) {
        if (attempt >= maxAttempts || !isRetryable(err)) throw err;
        await sleep(backoffDelayMs(err, attempt, baseDelayMs));
      }
    }
    /* c8 ignore next -- unreachable: the loop above always returns or throws. */
    throw new Error('unreachable');
  }

  return { model, complete, totals };
}
