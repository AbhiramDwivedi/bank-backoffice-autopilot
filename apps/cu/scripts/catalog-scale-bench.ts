/**
 * Scale measurement for the catalog. Not part of the library and not run by the test suite: it
 * writes thousands of temp files. Generates N synthetic capability artifacts (the example artifact
 * with a varied id, name, description and field descriptions) in a temp directory, then times,
 * per repeat:
 *   - read + JSON.parse of every file          (the I/O half of `loadCatalog`)
 *   - `validateCapability` on every parsed doc (the schema half)
 *   - `loadCatalog` end to end                 (both, plus the directory walk)
 *   - building the search index, and one warm search (mean over a few queries)
 * and reports the level-1 and full listing sizes. Works from any cwd.
 *
 *   npx tsx apps/cu/scripts/catalog-scale-bench.ts [count=2000] [repeats=5]
 *
 * Prints one JSON object (medians, with min/max of the load time so run-to-run variance is
 * visible). The numbers in docs/design/capability-selection.md come from here. Timings depend on
 * the machine and on what else it is running; expect 2-3x swings between runs on a busy one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { validateCapability } from '@cu/core/schema';
import { loadCatalog } from '../src/catalog/index.js';

const VERBS = ['lookup', 'update', 'close', 'open', 'verify', 'export', 'reverse', 'freeze', 'release', 'review', 'transfer', 'reconcile'];
const NOUNS = ['member', 'account', 'loan', 'card', 'wire', 'check', 'statement', 'address', 'beneficiary', 'dispute', 'escrow', 'certificate'];
const QUALS = ['savings', 'checking', 'mortgage', 'overdraft', 'joint', 'business', 'youth', 'retirement', 'vehicle', 'fee', 'limit', 'hold'];

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const count = Number(process.argv[2] ?? 2000);
const repeats = Number(process.argv[3] ?? 5);
const base = JSON.parse(fs.readFileSync(path.join(repoRoot, 'artifacts/examples/lookup-member-savings-balance.example.json'), 'utf8')) as Record<string, unknown> & {
  inputs: Record<string, { description: string }>;
  outputs: Record<string, { description: string }>;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-scale-'));
try {
  const files: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const verb = VERBS[i % VERBS.length]!;
    const noun = NOUNS[Math.floor(i / VERBS.length) % NOUNS.length]!;
    const qual = QUALS[Math.floor(i / (VERBS.length * NOUNS.length)) % QUALS.length]!;
    const id = `${verb}-${noun}-${qual}-${i}`;
    const cap = structuredClone(base);
    cap.id = id;
    cap.name = `${verb} ${noun} ${qual} (${i})`;
    cap.description = `Signs on, ${verb}s the ${qual} ${noun} identified by memberId, and reports the result. Variant ${i}.`;
    for (const spec of Object.values(cap.inputs)) spec.description = `${spec.description} (${qual} ${noun})`;
    for (const spec of Object.values(cap.outputs)) spec.description = `${spec.description} (${verb})`;
    const file = path.join(dir, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(cap));
    files.push(file);
  }

  const readMs: number[] = [];
  const validateMs: number[] = [];
  const loadMs: number[] = [];
  const indexMs: number[] = [];
  const searchMs: number[] = [];
  const queries = ['lookup member savings balance', 'reverse wire', 'freez', 'beneficiary dispute escrow', 'pineapple'];
  let loaded = 0;
  let catalog = loadCatalog(dir);
  for (let r = 0; r < repeats; r += 1) {
    const t0 = performance.now();
    const docs = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as unknown);
    const t1 = performance.now();
    let valid = 0;
    for (const d of docs) if (validateCapability(d).ok) valid += 1;
    const t2 = performance.now();
    catalog = loadCatalog(dir);
    const t3 = performance.now();
    catalog.search('warmup'); // the first search builds the index
    const t4 = performance.now();
    for (const q of queries) catalog.search(q);
    const t5 = performance.now();
    readMs.push(t1 - t0);
    validateMs.push(t2 - t1);
    loadMs.push(t3 - t2);
    indexMs.push(t4 - t3);
    searchMs.push((t5 - t4) / queries.length);
    loaded = catalog.entries().length;
    if (valid !== count) throw new Error(`only ${valid} of ${count} generated capabilities validated`);
  }

  const briefBytes = JSON.stringify(catalog.toBriefs()).length;
  const fullBytes = JSON.stringify(catalog.toToolDefinitions()).length;
  const perFile = (ms: number): number => Number((ms / count).toFixed(2));

  console.log(
    JSON.stringify(
      {
        capabilities: loaded,
        repeats,
        readAndParseMsMedian: Math.round(median(readMs)),
        validateMsMedian: Math.round(median(validateMs)),
        readAndParseMsPerFile: perFile(median(readMs)),
        validateMsPerFile: perFile(median(validateMs)),
        loadCatalogMsMedian: Math.round(median(loadMs)),
        loadCatalogMsMin: Math.round(Math.min(...loadMs)),
        loadCatalogMsMax: Math.round(Math.max(...loadMs)),
        buildIndexMsMedian: Math.round(median(indexMs)),
        searchMsPerQueryMedian: Number(median(searchMs).toFixed(2)),
        briefJsonBytes: briefBytes,
        fullToolsJsonBytes: fullBytes,
        approxBriefTokens: Math.round(briefBytes / 4),
        approxFullTokens: Math.round(fullBytes / 4),
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
