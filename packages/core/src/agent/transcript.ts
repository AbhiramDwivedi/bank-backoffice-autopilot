/**
 * Append-only JSONL transcript of every model request/response, for audit and replay debugging.
 * Every entry is scrubbed (`scrub.deep`) before it is written: secrets, sensitive input values,
 * and anything the policy's redaction patterns catch never reach disk. Images are never written
 * as bytes — only the evidence path (or `null`) and the base64 length, so the transcript stays
 * small and diff-able.
 *
 * Usage counters are written as `llmUsage: {input, output, cacheRead?, cacheWrite?}` because the
 * shared redactor redacts any key containing "token" (see usageForEvidence).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LlmInputBlock, LlmMessage, LlmOutputBlock, LlmRequest, LlmResponse } from './types.js';
import type { Scrubber } from './scrub.js';
import type { LlmUsage } from './types.js';

/**
 * Usage counters under key names the shared redactor leaves alone (it redacts any key containing
 * "token", which would erase `inputTokens` etc.). Used by every evidence sink in packages/core/src/agent.
 */
export function usageForEvidence(u: LlmUsage): { input: number; output: number; cacheRead?: number; cacheWrite?: number } {
  return {
    input: u.inputTokens,
    output: u.outputTokens,
    ...(u.cacheReadInputTokens !== undefined ? { cacheRead: u.cacheReadInputTokens } : {}),
    ...(u.cacheCreationInputTokens !== undefined ? { cacheWrite: u.cacheCreationInputTokens } : {}),
  };
}

/** Handle for a run's transcript.jsonl: records model requests, responses, and free-form notes
 *  in turn order. */
export interface Transcript {
  /** Run-dir relative: 'transcript.jsonl'. */
  readonly path: string;
  request(turn: number, req: LlmRequest): void;
  response(turn: number, res: LlmResponse): void;
  note(turn: number, text: string, data?: Record<string, unknown>): void;
}

const RELATIVE_PATH = 'transcript.jsonl';

function inputBlockToLine(b: LlmInputBlock): Record<string, unknown> {
  if (b.type === 'image') {
    return { type: 'image', path: b.evidencePath ?? null, bytes: b.pngBase64.length };
  }
  return { type: 'text', text: b.text };
}

function messageToLine(m: LlmMessage): Record<string, unknown> {
  return { role: m.role, content: m.content.map(inputBlockToLine) };
}

function outputBlockToLine(b: LlmOutputBlock): Record<string, unknown> {
  if (b.type === 'tool_use') {
    return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
  }
  return { type: 'text', text: b.text };
}

/** Creates a {@link Transcript} that appends scrubbed JSONL records to `transcript.jsonl` under
 *  `runDir`, creating the directory if it doesn't exist. */
export function createTranscript(runDir: string, scrub: Scrubber): Transcript {
  const absPath = join(runDir, RELATIVE_PATH);
  mkdirSync(dirname(absPath), { recursive: true });

  /** The full system prompt is written once; later identical requests reference that turn. */
  let lastSystem: { turn: number; text: string } | undefined;

  function writeLine(entry: Record<string, unknown>): void {
    const scrubbed = scrub.deep(entry);
    appendFileSync(absPath, `${JSON.stringify(scrubbed)}\n`, 'utf8');
  }

  return {
    path: RELATIVE_PATH,

    request(turn, req) {
      const systemField: Record<string, unknown> =
        lastSystem !== undefined && lastSystem.text === req.system
          ? { systemRef: `same-as-turn-${lastSystem.turn}` }
          : { system: req.system };
      if (lastSystem === undefined || lastSystem.text !== req.system) {
        lastSystem = { turn, text: req.system };
      }

      writeLine({
        ts: new Date().toISOString(),
        turn,
        kind: 'request',
        ...systemField,
        // Names only, never full JSON schemas.
        tools: req.tools.map((t) => t.name),
        messages: req.messages.map(messageToLine),
        maxTokens: req.maxTokens,
      });
    },

    response(turn, res) {
      writeLine({
        ts: new Date().toISOString(),
        turn,
        kind: 'response',
        content: res.content.map(outputBlockToLine),
        stopReason: res.stopReason,
        llmUsage: usageForEvidence(res.usage),
        model: res.model,
      });
    },

    note(turn, text, data) {
      writeLine({
        ts: new Date().toISOString(),
        turn,
        kind: 'note',
        text,
        ...(data !== undefined ? { data } : {}),
      });
    },
  };
}
