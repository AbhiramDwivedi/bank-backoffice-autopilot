/**
 * `cu catalog search` and the progressive-disclosure flags of `cu catalog tools` (--brief, --id,
 * --query, --top-k), run through the real commander wiring against a real catalog directory built
 * from the example artifact. (catalog.test.ts mocks the catalog and covers `invoke`.)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCatalog } from './catalog.js';

const EXAMPLE = JSON.parse(fs.readFileSync(path.resolve('artifacts/examples/lookup-member-savings-balance.example.json'), 'utf8')) as Record<string, unknown>;

let dir: string;
let stdout: string[];
let stderr: string[];

function writeCap(file: string, patch: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, file), JSON.stringify({ ...EXAMPLE, version: '1.0.0', ...patch }, null, 2));
}

async function run(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerCatalog(program);
  await program.parseAsync(['node', 'cu', 'catalog', '--dir', dir, ...args]);
}

/** An id longer than the 64-character tool-name limit (the schema puts no cap on ids). */
const LONG_ID = `reconcile-quarterly-escrow-disbursement-${'x'.repeat(30)}-for-joint-members-v2`;

const out = (): string => stdout.join('\n');
const err = (): string => stderr.join('\n');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-search-'));
  writeCap('balance.json', {
    id: 'lookup-member-savings-balance',
    name: 'Look Up Member Savings Balance',
    description: 'Searches for a member by memberId and returns their savings balance. Signs on first.',
  });
  writeCap('wire.json', { id: 'send-wire-transfer', name: 'Send Wire Transfer', description: 'Sends an outgoing wire. Needs approval.' });
  writeCap('old.json', { id: 'retired-wire-lookup', name: 'Retired Wire Lookup', description: 'Old wire lookup.', status: 'deprecated' });
  writeCap('long.json', { id: LONG_ID, name: 'Reconcile Escrow', description: 'Reconciles the zebrafish ledger.' });
  writeCap('draft.json', { id: 'draft-wire-fee', name: 'Draft Wire Fee', description: 'Reads the wire fee schedule.', status: 'draft' });
  stdout = [];
  stderr = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void stdout.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void stderr.push(a.join(' ')));
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('cu catalog search', () => {
  it('prints a table with rank, id, version, status, score, matched fields and a one-line description', async () => {
    await run(['search', 'savings', 'balance']);
    const lines = out().split('\n');
    expect(lines[0]).toBe(['rank', 'id', 'version', 'status', 'score', 'matched on', 'description'].join('\t'));
    const cols = lines[1]!.split('\t');
    expect(cols.slice(0, 3)).toEqual(['1', 'lookup-member-savings-balance', '1.0.0']);
    expect(cols[3]).toBe('approved');
    expect(cols[4]).toMatch(/^\d+\.\d{3}$/);
    expect(cols[5]).toMatch(/^id\(.*\) name\(.*\)/);
    expect(cols[6]).toBe('Searches for a member by memberId and returns their savings balance.');
    expect(process.exitCode).toBeUndefined();
  });

  it('accepts the query as one quoted argument and excludes deprecated by default, keeping drafts', async () => {
    await run(['search', 'wire']);
    const ids = out().split('\n').slice(1).map((l) => l.split('\t')[1]);
    expect(ids.sort()).toEqual(['draft-wire-fee', 'send-wire-transfer']);
    expect(out()).toContain('draft\t');
  });

  it('--include-deprecated also ranks deprecated capabilities', async () => {
    await run(['search', 'wire', '--include-deprecated']);
    expect(out()).toContain('retired-wire-lookup');
  });

  it('--top-k limits the results', async () => {
    await run(['search', 'wire', '--top-k', '1']);
    expect(out().split('\n')).toHaveLength(2); // header + one row
  });

  it('--json prints { query, topK, results } with the documented fields', async () => {
    await run(['search', 'wire fee', '--json', '--top-k', '2']);
    const parsed = JSON.parse(out()) as { query: string; topK: number; results: Record<string, unknown>[] };
    expect(parsed.query).toBe('wire fee');
    expect(parsed.topK).toBe(2);
    expect(parsed.results.length).toBeLessThanOrEqual(2);
    expect(parsed.results[0]).toMatchObject({
      rank: 1,
      id: 'draft-wire-fee',
      version: '1.0.0',
      name: 'Draft Wire Fee',
      status: 'draft',
      riskLevel: 'read',
      description: 'Reads the wire fee schedule.',
    });
    expect(typeof parsed.results[0]?.score).toBe('number');
    expect(parsed.results[0]?.matched).toEqual(expect.arrayContaining([{ field: 'id', terms: ['fee', 'wire'] }]));
  });

  it('prints a plain message (exit 0) when nothing matches, and an empty results array in JSON', async () => {
    await run(['search', 'pineapple']);
    expect(out()).toBe('(no capability matches "pineapple")');
    expect(process.exitCode).toBeUndefined();
    stdout.length = 0;
    await run(['search', 'pineapple', '--json']);
    expect((JSON.parse(out()) as { results: unknown[] }).results).toEqual([]);
  });

  it('is deterministic: the same query twice prints identical output', async () => {
    await run(['search', 'wire', '--json']);
    const first = out();
    stdout.length = 0;
    await run(['search', 'wire', '--json']);
    expect(out()).toBe(first);
  });

  it.each(['0', '-1', '1.5', 'abc', ''])('rejects --top-k %j (exit 1, nothing printed to stdout)', async (bad) => {
    await run(['search', 'wire', '--top-k', bad]);
    expect(process.exitCode).toBe(1);
    expect(err()).toContain('--top-k must be a positive integer');
    expect(out()).toBe('');
  });

  it('rejects a blank query', async () => {
    await run(['search', '   ']);
    expect(process.exitCode).toBe(1);
    expect(err()).toContain('the query is empty');
  });
});

describe('cu catalog tools', () => {
  it('plain: prints every non-deprecated full definition (unchanged behaviour)', async () => {
    await run(['tools']);
    const tools = JSON.parse(out()) as { name: string; input_schema: unknown }[];
    expect(tools.map((t) => t.name).sort()).toEqual([LONG_ID.slice(0, 64), 'draft-wire-fee', 'lookup-member-savings-balance', 'send-wire-transfer'].sort());
    expect(tools[0]?.input_schema).toBeDefined();
  });

  it('--brief: only name, one-line description, status and risk, no deprecated', async () => {
    await run(['tools', '--brief']);
    const briefs = JSON.parse(out()) as Record<string, unknown>[];
    expect(briefs.map((b) => b.id).sort()).toEqual([LONG_ID, 'draft-wire-fee', 'lookup-member-savings-balance', 'send-wire-transfer'].sort());
    for (const b of briefs) expect(Object.keys(b).sort()).toEqual(['description', 'id', 'name', 'riskLevel', 'status']);
    const balance = briefs.find((b) => b.name === 'lookup-member-savings-balance');
    expect(balance).toEqual({
      id: 'lookup-member-savings-balance',
      name: 'lookup-member-savings-balance',
      description: 'Searches for a member by memberId and returns their savings balance.',
      status: 'approved',
      riskLevel: 'read',
    });
    expect(out().length).toBeLessThan(JSON.stringify(JSON.parse(out()), null, 2).length); // compact, one object per line
  });

  it('--id: prints the one full definition (level 2)', async () => {
    await run(['tools', '--id', 'send-wire-transfer']);
    const tool = JSON.parse(out()) as { name: string; description: string; input_schema: { required: string[] } };
    expect(tool.name).toBe('send-wire-transfer');
    expect(tool.description).toContain('Risk: read');
    expect(tool.input_schema.required).toEqual(['memberId']);
  });

  it('--id: an unknown id fails (exit 1) and suggests close matches', async () => {
    await run(['tools', '--id', 'wire-transfer']);
    expect(process.exitCode).toBe(1);
    expect(err()).toContain('unknown capability id "wire-transfer"');
    expect(err()).toContain('did you mean: send-wire-transfer');
    expect(out()).toBe('');
  });

  it('--id: a deprecated-only capability is refused, not described', async () => {
    await run(['tools', '--id', 'retired-wire-lookup']);
    expect(process.exitCode).toBe(1);
    expect(err()).toContain('is deprecated');
    expect(out()).toBe('');
  });

  it('--brief with --id is an error', async () => {
    await run(['tools', '--brief', '--id', 'send-wire-transfer']);
    expect(process.exitCode).toBe(1);
    expect(err()).toContain('--brief and --id are mutually exclusive');
    expect(out()).toBe('');
  });

  it('--id with --query is an error', async () => {
    await run(['tools', '--id', 'send-wire-transfer', '--query', 'wire']);
    expect(process.exitCode).toBe(1);
    expect(err()).toContain('--id and --query are mutually exclusive');
  });

  it('--query: full definitions for the ranked shortlist only, best first, honouring --top-k', async () => {
    await run(['tools', '--query', 'outgoing']);
    expect((JSON.parse(out()) as { name: string }[]).map((t) => t.name)).toEqual(['send-wire-transfer']);
    stdout.length = 0;
    await run(['tools', '--query', 'wire', '--top-k', '1']);
    const tools = JSON.parse(out()) as { name: string }[];
    expect(tools.map((t) => t.name)).toEqual(['draft-wire-fee']); // pinned: ties on the term, wins on shorter id/name fields (BM25F length normalisation)
  });

  describe('an id longer than 64 characters', () => {
    it('--brief advertises both the real id and the truncated tool name, and --id accepts either', async () => {
      await run(['tools', '--brief']);
      const brief = (JSON.parse(out()) as { id: string; name: string }[]).find((b) => b.id === LONG_ID);
      expect(brief).toBeDefined();
      expect(brief?.name).toBe(LONG_ID.slice(0, 64));
      for (const key of [LONG_ID, LONG_ID.slice(0, 64)]) {
        stdout.length = 0;
        await run(['tools', '--id', key]);
        expect(process.exitCode).toBeUndefined();
        expect((JSON.parse(out()) as { name: string }).name).toBe(LONG_ID.slice(0, 64));
      }
    });

    it('--query keeps it in both full and --brief shortlists', async () => {
      await run(['tools', '--query', 'zebrafish', '--brief']);
      expect((JSON.parse(out()) as { id: string }[]).map((b) => b.id)).toEqual([LONG_ID]);
      stdout.length = 0;
      await run(['tools', '--query', 'zebrafish']);
      expect((JSON.parse(out()) as { name: string }[]).map((t) => t.name)).toEqual([LONG_ID.slice(0, 64)]);
    });
  });

  describe('--approved-only', () => {
    it('drops drafts from plain, --brief and --query output', async () => {
      await run(['tools', '--approved-only']);
      expect((JSON.parse(out()) as { name: string }[]).map((t) => t.name)).not.toContain('draft-wire-fee');
      stdout.length = 0;
      await run(['tools', '--brief', '--approved-only']);
      expect((JSON.parse(out()) as { id: string; status: string }[]).every((b) => b.status === 'approved')).toBe(true);
      stdout.length = 0;
      await run(['tools', '--query', 'wire fee', '--approved-only', '--brief']);
      expect((JSON.parse(out()) as { id: string }[]).map((b) => b.id)).toEqual(['send-wire-transfer']);
    });

    it('--id refuses a draft but still describes an approved capability', async () => {
      await run(['tools', '--id', 'draft-wire-fee', '--approved-only']);
      expect(process.exitCode).toBe(1);
      expect(err()).toContain('is a draft');
      expect(out()).toBe('');
      process.exitCode = undefined;
      await run(['tools', '--id', 'send-wire-transfer', '--approved-only']);
      expect(process.exitCode).toBeUndefined();
    });

    it('search --approved-only excludes drafts (and wins over --include-deprecated)', async () => {
      await run(['search', 'wire', '--approved-only', '--include-deprecated', '--json']);
      expect((JSON.parse(out()) as { results: { id: string }[] }).results.map((r) => r.id)).toEqual(['send-wire-transfer']);
    });
  });

  it('--query with no match prints an empty array', async () => {
    await run(['tools', '--query', 'pineapple']);
    expect(JSON.parse(out())).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it('--query --brief: level-1 entries for the shortlist', async () => {
    await run(['tools', '--query', 'outgoing', '--brief']);
    expect((JSON.parse(out()) as { name: string; input_schema?: unknown }[]).map((b) => [b.name, b.input_schema])).toEqual([['send-wire-transfer', undefined]]);
  });

  it('--top-k without --query is an error; a non-positive-integer --top-k is an error', async () => {
    await run(['tools', '--top-k', '3']);
    expect(process.exitCode).toBe(1);
    expect(err()).toContain('--top-k only applies together with --query');
    process.exitCode = undefined;
    stderr.length = 0;
    for (const bad of ['0', '-2', '2.5', 'x']) {
      process.exitCode = undefined;
      await run(['tools', '--query', 'wire', '--top-k', bad]);
      expect(process.exitCode).toBe(1);
      expect(err()).toContain('--top-k must be a positive integer');
    }
    expect(out()).toBe('');
  });

  it('a blank --query is an error', async () => {
    await run(['tools', '--query', '  ']);
    expect(process.exitCode).toBe(1);
    expect(err()).toContain('--query is empty');
  });
});

describe('cu catalog invoke --operator-port help', () => {
  it('describes the retry-on-an-OS-assigned-port behaviour, not "no console"', () => {
    const program = new Command();
    registerCatalog(program);
    const invoke = program.commands.find((c) => c.name() === 'catalog')?.commands.find((c) => c.name() === 'invoke');
    const help = invoke?.options.find((o) => o.long === '--operator-port')?.description ?? '';
    expect(help).toContain('retried on an OS-assigned port');
    expect(help).not.toContain('falls back to no console');
  });
});
