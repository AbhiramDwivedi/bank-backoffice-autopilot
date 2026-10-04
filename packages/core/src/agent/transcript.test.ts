import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTranscript } from './transcript.js';
import { createScrubber } from './scrub.js';
import type { LlmRequest, LlmResponse } from './types.js';

function readLines(runDir: string): Record<string, unknown>[] {
  const raw = readFileSync(join(runDir, 'transcript.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('createTranscript', () => {
  let runDir: string;

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), 'agent-transcript-test-'));
  });

  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });

  it('exposes the run-dir relative path', () => {
    const scrub = createScrubber({ secrets: {}, sensitiveInputs: {} });
    const transcript = createTranscript(runDir, scrub);
    expect(transcript.path).toBe('transcript.jsonl');
  });

  it('writes one JSON line per call, creating the run dir if needed', () => {
    const nestedDir = join(runDir, 'nested', 'run-1');
    const scrub = createScrubber({ secrets: {}, sensitiveInputs: {} });
    const transcript = createTranscript(nestedDir, scrub);

    const req: LlmRequest = { system: 'be helpful', messages: [], tools: [], maxTokens: 100 };
    transcript.request(1, req);
    transcript.note(1, 'hello', { foo: 'bar' });

    const lines = readLines(nestedDir);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.kind).toBe('request');
    expect(lines[1]?.kind).toBe('note');
  });

  it('writes the system prompt in full only the first time it is seen', () => {
    const scrub = createScrubber({ secrets: {}, sensitiveInputs: {} });
    const transcript = createTranscript(runDir, scrub);

    const req: LlmRequest = { system: 'the system prompt', messages: [], tools: [], maxTokens: 100 };
    transcript.request(1, req);
    transcript.request(2, req);

    const lines = readLines(runDir);
    expect(lines[0]?.system).toBe('the system prompt');
    expect(lines[0]?.systemRef).toBeUndefined();
    expect(lines[1]?.system).toBeUndefined();
    expect(lines[1]?.systemRef).toBe('same-as-turn-1');
  });

  it('writes a fresh system prompt again once it changes, then refs that new turn', () => {
    const scrub = createScrubber({ secrets: {}, sensitiveInputs: {} });
    const transcript = createTranscript(runDir, scrub);

    transcript.request(1, { system: 'v1', messages: [], tools: [], maxTokens: 100 });
    transcript.request(2, { system: 'v2', messages: [], tools: [], maxTokens: 100 });
    transcript.request(3, { system: 'v2', messages: [], tools: [], maxTokens: 100 });

    const lines = readLines(runDir);
    expect(lines[0]?.system).toBe('v1');
    expect(lines[1]?.system).toBe('v2');
    expect(lines[2]?.systemRef).toBe('same-as-turn-2');
  });

  it('records tool names only, never schemas', () => {
    const scrub = createScrubber({ secrets: {}, sensitiveInputs: {} });
    const transcript = createTranscript(runDir, scrub);

    const req: LlmRequest = {
      system: 'sys',
      messages: [],
      tools: [{ name: 'click', description: 'click a thing', input_schema: { type: 'object', properties: { ref: {} } } }],
      maxTokens: 100,
    };
    transcript.request(1, req);

    const lines = readLines(runDir);
    expect(lines[0]?.tools).toEqual(['click']);
    expect(JSON.stringify(lines[0])).not.toContain('input_schema');
  });

  it('records an image block as a path + base64 length, never the bytes', () => {
    const scrub = createScrubber({ secrets: {}, sensitiveInputs: {} });
    const transcript = createTranscript(runDir, scrub);

    const base64 = Buffer.from('not-really-a-png').toString('base64');
    const req: LlmRequest = {
      system: 'sys',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', pngBase64: base64, evidencePath: 'shots/0001.png' },
            { type: 'text', text: 'what do you see?' },
          ],
        },
      ],
      tools: [],
      maxTokens: 100,
    };
    transcript.request(1, req);

    const lines = readLines(runDir);
    const messages = lines[0]?.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const imageBlock = messages[0]?.content[0];
    expect(imageBlock).toEqual({ type: 'image', path: 'shots/0001.png', bytes: base64.length });

    const raw = readFileSync(join(runDir, 'transcript.jsonl'), 'utf8');
    expect(raw).not.toContain(base64);
  });

  it('records null path when an image has no evidencePath', () => {
    const scrub = createScrubber({ secrets: {}, sensitiveInputs: {} });
    const transcript = createTranscript(runDir, scrub);

    const req: LlmRequest = {
      system: 'sys',
      messages: [{ role: 'user', content: [{ type: 'image', pngBase64: 'abc' }] }],
      tools: [],
      maxTokens: 100,
    };
    transcript.request(1, req);

    const lines = readLines(runDir);
    const messages = lines[0]?.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[0]?.content[0]).toEqual({ type: 'image', path: null, bytes: 3 });
  });

  it('scrubs a secret value out of request text and response tool input', () => {
    const scrub = createScrubber({ secrets: { MOCK_PASSWORD: 'hunter2' }, sensitiveInputs: {} });
    const transcript = createTranscript(runDir, scrub);

    const req: LlmRequest = {
      system: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'password is hunter2' }] }],
      tools: [],
      maxTokens: 100,
    };
    transcript.request(1, req);

    const res: LlmResponse = {
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'type', input: { value: 'hunter2' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'claude-opus-5',
    };
    transcript.response(1, res);

    const raw = readFileSync(join(runDir, 'transcript.jsonl'), 'utf8');
    expect(raw).not.toContain('hunter2');
    expect(raw).toContain('<secret:MOCK_PASSWORD>');
  });

  it('writes response content, stopReason, usage and model', () => {
    const scrub = createScrubber({ secrets: {}, sensitiveInputs: {} });
    const transcript = createTranscript(runDir, scrub);

    const res: LlmResponse = {
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 2 },
      model: 'claude-opus-5',
    };
    transcript.response(1, res);

    const lines = readLines(runDir);
    // Usage is persisted under neutral key names (see usageForEvidence) so the shared
    // redactor's "token" key rule does not erase the counters.
    expect(lines[0]).toMatchObject({
      kind: 'response',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      llmUsage: { input: 5, output: 7, cacheRead: 2 },
      model: 'claude-opus-5',
    });
  });

  it('writes a note with optional data', () => {
    const scrub = createScrubber({ secrets: {}, sensitiveInputs: {} });
    const transcript = createTranscript(runDir, scrub);

    transcript.note(3, 'expectation not met', { expect: 'welcome banner' });
    const lines = readLines(runDir);
    expect(lines[0]).toMatchObject({ kind: 'note', turn: 3, text: 'expectation not met', data: { expect: 'welcome banner' } });
  });
});
