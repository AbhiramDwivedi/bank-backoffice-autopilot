/**
 * apps/cu/src/catalog/index.ts: loading (valid/invalid/duplicate-version, deprecated versions),
 * tool definitions (deprecated excluded, shape), get(), and invoke() (unknown id, deprecated refused,
 * warnings reach `log`, and one happy path against a FakeSurface -- the real mock app is covered by
 * tests/e2e).
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCatalog } from './index.js';
import { loadPolicy, DEFAULT_POLICY_PATH } from '@cu/core/policy';
import type { Policy } from '@cu/core/schema';
import { createCuCoreSurface } from '@cu/core/surface';

const EXAMPLE_PATH = path.resolve('artifacts/examples/lookup-member-savings-balance.example.json');

/** The default policy with allowedOrigins narrowed to one origin (mirrors tests/e2e/harness.ts's
 *  policyFor, reimplemented here to avoid a unit test depending on the e2e harness module). */
function policyFor(baseUrl: string): Policy {
  const base = loadPolicy(DEFAULT_POLICY_PATH);
  return { ...base, allowedOrigins: [new URL(baseUrl).origin] };
}

function loadExampleRaw(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8')) as Record<string, unknown>;
}

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeJson(dir: string, name: string, data: unknown): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

describe('loadCatalog: loading', () => {
  it('keeps the highest semver version when two files declare the same capability id', () => {
    const dir = tempDir();
    const base = loadExampleRaw();

    writeJson(dir, 'cap-a-1.0.0.json', { ...base, id: 'cap-a', version: '1.0.0' });
    writeJson(dir, 'cap-a-1.10.0.json', { ...base, id: 'cap-a', version: '1.10.0' }); // 1.10.0 > 1.2.0 numerically
    writeJson(dir, 'cap-a-1.2.0.json', { ...base, id: 'cap-a', version: '1.2.0' });

    const catalog = loadCatalog(dir);
    const entries = catalog.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe('cap-a');
    expect(entries[0]?.version).toBe('1.10.0');
    expect(catalog.get('cap-a')?.version).toBe('1.10.0');
  });

  it('records malformed JSON and schema-invalid artifacts in skipped(), not entries()', () => {
    const dir = tempDir();
    const base = loadExampleRaw();

    fs.writeFileSync(path.join(dir, 'not-json.json'), '{ this is not json');
    // Schema-invalid: riskLevel does not match the max step risk (all steps are 'read').
    writeJson(dir, 'bad-capability.json', { ...base, id: 'cap-bad', version: '1.0.0', riskLevel: 'irreversible' });
    writeJson(dir, 'cap-good.json', { ...base, id: 'cap-good', version: '1.0.0' });

    const catalog = loadCatalog(dir);
    expect(catalog.entries().map((e) => e.id)).toEqual(['cap-good']);

    const skipped = catalog.skipped();
    expect(skipped).toHaveLength(2);
    const files = skipped.map((s) => path.basename(s.file)).sort();
    expect(files).toEqual(['bad-capability.json', 'not-json.json']);
    for (const s of skipped) expect(s.reason.length).toBeGreaterThan(0);
  });

  it('skips a deprecated higher version in favour of the highest non-deprecated one', () => {
    const dir = tempDir();
    const base = loadExampleRaw();
    writeJson(dir, 'cap-a-1.2.2.json', { ...base, id: 'cap-a', version: '1.2.2', status: 'approved' });
    writeJson(dir, 'cap-a-1.3.0.json', { ...base, id: 'cap-a', version: '1.3.0', status: 'deprecated' });
    writeJson(dir, 'cap-a-1.1.0.json', { ...base, id: 'cap-a', version: '1.1.0', status: 'approved' });

    const catalog = loadCatalog(dir);
    expect(catalog.entries()).toHaveLength(1);
    expect(catalog.get('cap-a')).toMatchObject({ version: '1.2.2', status: 'approved' });
    expect(catalog.toToolDefinitions().map((t) => t.name)).toEqual(['cap-a']);
  });

  it('keeps the highest deprecated version when every version of an id is deprecated (listed, not offered as a tool)', () => {
    const dir = tempDir();
    const base = loadExampleRaw();
    writeJson(dir, 'cap-old-1.0.0.json', { ...base, id: 'cap-old', version: '1.0.0', status: 'deprecated' });
    writeJson(dir, 'cap-old-2.0.0.json', { ...base, id: 'cap-old', version: '2.0.0', status: 'deprecated' });

    const catalog = loadCatalog(dir);
    expect(catalog.get('cap-old')).toMatchObject({ version: '2.0.0', status: 'deprecated' });
    expect(catalog.toToolDefinitions()).toEqual([]);
  });

  it('loads artifacts recursively under nested directories', () => {
    const dir = tempDir();
    const nested = path.join(dir, 'nested', 'deeper');
    fs.mkdirSync(nested, { recursive: true });
    const base = loadExampleRaw();
    writeJson(nested, 'cap-nested.json', { ...base, id: 'cap-nested', version: '1.0.0' });

    const catalog = loadCatalog(dir);
    expect(catalog.entries().map((e) => e.id)).toEqual(['cap-nested']);
  });
});

describe('loadCatalog: ids longer than the 64-character tool-name limit', () => {
  const stem = `reconcile-${'x'.repeat(60)}`; // 70 chars
  const idA = `${stem}-a`;
  const idB = `${stem}-b`;

  it('briefs carry the real id and the truncated tool name; resolve/toToolDefinition accept either', () => {
    const dir = tempDir();
    writeJson(dir, 'a.json', { ...loadExampleRaw(), id: idA, version: '1.0.0' });
    const cat = loadCatalog(dir);
    const [brief] = cat.toBriefs();
    expect(brief).toMatchObject({ id: idA, name: idA.slice(0, 64) });
    expect(cat.resolve(idA)?.id).toBe(idA);
    expect(cat.resolve(brief!.name)?.id).toBe(idA);
    expect(cat.toToolDefinition(brief!.name)?.name).toBe(idA.slice(0, 64));
    expect(cat.toToolDefinition(idA)?.name).toBe(idA.slice(0, 64));
    expect(cat.search('reconcile').map((h) => h.id)).toEqual([idA]);
  });

  it('a tool name shared by two ids resolves to neither, while both ids still resolve', () => {
    const dir = tempDir();
    writeJson(dir, 'a.json', { ...loadExampleRaw(), id: idA, version: '1.0.0' });
    writeJson(dir, 'b.json', { ...loadExampleRaw(), id: idB, version: '1.0.0' });
    const cat = loadCatalog(dir);
    expect(idA.slice(0, 64)).toBe(idB.slice(0, 64));
    expect(cat.resolve(idA.slice(0, 64))).toBeUndefined();
    expect(cat.resolve(idA)?.id).toBe(idA);
    expect(cat.resolve(idB)?.id).toBe(idB);
  });

  it('invoke accepts the tool name and refuses an unknown one', async () => {
    const dir = tempDir();
    writeJson(dir, 'a.json', { ...loadExampleRaw(), id: idA, version: '1.0.0', status: 'deprecated' });
    const cat = loadCatalog(dir);
    await expect(cat.invoke(idA.slice(0, 64), {}, { baseUrl: 'http://localhost:4173' })).rejects.toThrow(/is deprecated/); // resolved, then refused
    await expect(cat.invoke('nope', {}, { baseUrl: 'http://localhost:4173' })).rejects.toThrow(/unknown capability id/);
  });

  it('toBriefs/toToolDefinitions({approvedOnly}) drop drafts', () => {
    const dir = tempDir();
    writeJson(dir, 'a.json', { ...loadExampleRaw(), id: 'cap-a', version: '1.0.0', status: 'approved' });
    writeJson(dir, 'd.json', { ...loadExampleRaw(), id: 'cap-d', version: '1.0.0', status: 'draft' });
    const cat = loadCatalog(dir);
    expect(cat.toBriefs().map((b) => b.id)).toEqual(['cap-a', 'cap-d']);
    expect(cat.toBriefs({ approvedOnly: true }).map((b) => b.id)).toEqual(['cap-a']);
    expect(cat.toToolDefinitions({ approvedOnly: true }).map((t) => t.name)).toEqual(['cap-a']);
  });
});

describe('loadCatalog: toToolDefinitions', () => {
  it('excludes deprecated capabilities and shapes input_schema from inputs', () => {
    const dir = tempDir();
    const base = loadExampleRaw();
    writeJson(dir, 'cap-live.json', { ...base, id: 'cap-live', version: '1.0.0' });
    writeJson(dir, 'cap-old.json', { ...base, id: 'cap-old', version: '1.0.0', status: 'deprecated' });

    const catalog = loadCatalog(dir);
    const tools = catalog.toToolDefinitions();
    expect(tools.map((t) => t.name)).toEqual(['cap-live']);

    const tool = tools[0]!;
    expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(tool.description).toContain('Risk: read');
    expect(tool.description).toContain('Outputs --');
    expect(tool.description).toContain('memberName');
    expect(tool.input_schema.type).toBe('object');
    expect(tool.input_schema.additionalProperties).toBe(false);
    expect(tool.input_schema.required).toEqual(['memberId']);
    expect(tool.input_schema.properties.memberId).toMatchObject({ type: 'string', pattern: '^[0-9]{5}$' });
    expect(tool.input_schema.properties.memberId?.description).toContain('member');
  });

  it('marks a draft capability in its tool description', () => {
    const dir = tempDir();
    const base = loadExampleRaw();
    writeJson(dir, 'cap-draft.json', { ...base, id: 'cap-draft', version: '1.0.0', status: 'draft' });

    const catalog = loadCatalog(dir);
    const tool = catalog.toToolDefinitions()[0]!;
    expect(tool.description).toMatch(/\[draft/);
  });

  it('notes a sensitive input in its description', () => {
    const dir = tempDir();
    const base = loadExampleRaw();
    const withSensitive = structuredClone(base) as Record<string, unknown> & {
      inputs: Record<string, { sensitive: boolean; example?: string }>;
    };
    withSensitive.inputs.memberId!.sensitive = true;
    // A sensitive input must not carry a literal `example` (validateCapability:
    // sensitive_input_has_example).
    delete withSensitive.inputs.memberId!.example;
    writeJson(dir, 'cap-sensitive.json', { ...withSensitive, id: 'cap-sensitive', version: '1.0.0' });

    const catalog = loadCatalog(dir);
    const tool = catalog.toToolDefinitions()[0]!;
    expect(tool.input_schema.properties.memberId?.description).toMatch(/sensitive/i);
  });
});

describe('loadCatalog: invoke', () => {
  it('throws with the list of known ids for an unknown capability id', async () => {
    const dir = tempDir();
    const base = loadExampleRaw();
    writeJson(dir, 'cap-a.json', { ...base, id: 'cap-a', version: '1.0.0' });
    writeJson(dir, 'cap-b.json', { ...base, id: 'cap-b', version: '1.0.0' });

    const catalog = loadCatalog(dir);
    await expect(catalog.invoke('nope', {}, { baseUrl: 'http://localhost:4173' })).rejects.toThrow(/unknown capability id "nope".*cap-a.*cap-b/s);
  });

  it('refuses to invoke a deprecated capability, before any run starts', async () => {
    const dir = tempDir();
    const runsDir = tempDir();
    const base = loadExampleRaw();
    writeJson(dir, 'cap-old.json', { ...base, id: 'cap-old', version: '1.0.0', status: 'deprecated' });

    const catalog = loadCatalog(dir);
    await expect(
      catalog.invoke('cap-old', { memberId: '12345' }, { baseUrl: 'http://localhost:4173', runsDir, surface: createCuCoreSurface() }),
    ).rejects.toThrow(/capability "cap-old" is deprecated .*refusing to invoke it/);
    expect(fs.readdirSync(runsDir)).toEqual([]);
  });

  it('passes opts.log through to the replay, so a busy operator port is reported rather than swallowed', async () => {
    process.env.MOCK_USER ??= 'operator1';
    process.env.MOCK_PASSWORD ??= 'demo-pass-123';

    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(4441, '127.0.0.1', () => resolve());
    });
    try {
      const dir = tempDir();
      const runsDir = tempDir();
      const base = loadExampleRaw();
      writeJson(dir, 'cap-a.json', { ...base, id: 'cap-a', version: '1.0.0' });

      const baseUrl = 'http://localhost:4173';
      const lines: string[] = [];
      const result = await loadCatalog(dir).invoke(
        'cap-a',
        { memberId: '12345' },
        {
          baseUrl,
          policy: policyFor(baseUrl),
          runsDir,
          surface: createCuCoreSurface(),
          autoOperator: 'none',
          operator: { port: 4441 },
          log: (l) => lines.push(l),
        },
      );

      expect(result.kind).toBe('success');
      expect(lines.some((l) => l.includes('4441'))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  }, 30000);

  it('invokes a capability by id against an injected FakeSurface (happy path)', async () => {
    // replayCapability's default secret resolver reads process.env directly (unlike the replay
    // test-helpers' fixed TEST_SECRETS map); mirrors tests/e2e/harness.ts's replayOnce.
    process.env.MOCK_USER ??= 'operator1';
    process.env.MOCK_PASSWORD ??= 'demo-pass-123';

    const dir = tempDir();
    const runsDir = tempDir();
    const base = loadExampleRaw();
    writeJson(dir, 'cap-a.json', { ...base, id: 'cap-a', version: '1.0.0' });

    const baseUrl = 'http://localhost:4173';
    const catalog = loadCatalog(dir);
    const result = await catalog.invoke(
      'cap-a',
      { memberId: '12345' },
      { baseUrl, policy: policyFor(baseUrl), runsDir, surface: createCuCoreSurface(), autoOperator: 'none' },
    );

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.outputs).toEqual({ memberName: 'Jane Q. Sample', savingsBalance: 1234.56 });
    }
  });

  it('passes opts.readOnly through to the replay: with it a failing search is retried, without it it is not', async () => {
    process.env.MOCK_USER ??= 'operator1';
    process.env.MOCK_PASSWORD ??= 'demo-pass-123';

    const dir = tempDir();
    writeJson(dir, 'cap-a.json', { ...loadExampleRaw(), id: 'cap-a', version: '1.0.0' });
    const baseUrl = 'http://localhost:4173';
    const base = policyFor(baseUrl);
    const policy: Policy = { ...base, limits: { ...base.limits, maxAppErrorRetries: 1 } };
    // Every search fails. The surface's own clock is instant, so the failing step does not wait
    // out its timeout in real time, and the retry's backoff is 0.
    const failingSurface = () => {
      let now = 0;
      return createCuCoreSurface({ failSearch: true, clock: { now: () => now, sleep: (ms) => Promise.resolve(void (now += ms)) } });
    };
    const invoke = (readOnly: boolean) =>
      loadCatalog(dir).invoke(
        'cap-a',
        { memberId: '12345' },
        { baseUrl, policy, runsDir: tempDir(), surface: failingSurface(), autoOperator: 'abort', appErrorRetryBackoffMs: 0, ...(readOnly ? { readOnly: true } : {}) },
      );

    const plain = await invoke(false);
    expect(plain.kind === 'hard_failure' ? plain.code : undefined).toBe('app_error');
    expect(plain.recoveries).not.toContain('retry_app_error');

    const asserted = await invoke(true);
    expect(asserted.kind === 'hard_failure' ? asserted.code : undefined).toBe('app_error');
    expect(asserted.recoveries.filter((r) => r === 'retry_app_error')).toHaveLength(1);
  });
});
