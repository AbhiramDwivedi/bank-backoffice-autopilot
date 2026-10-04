/**
 * JSON Schema writer: converts the frozen zod contracts to JSON Schema (draft 2020-12) using
 * zod v4's native `z.toJSONSchema`. `zod-to-json-schema` 3.x targets zod v3 internals and emits
 * empty `{}` schemas for zod v4 types (verified against this repo's node_modules), so it is not
 * used here.
 *
 * Run directly: `npm run schema:export` (= `tsx packages/core/src/schema/export.ts`). Also exposes
 * `buildJsonSchemas()` as a pure function so tests can assert on the generated schemas without
 * touching the filesystem.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Capability, Policy, ReplayResult, RunEvent, Intervention } from './index.js';

const SCHEMAS: Record<string, z.ZodType> = {
  capability: Capability,
  policy: Policy,
  'replay-result': ReplayResult,
  'run-event': RunEvent,
  intervention: Intervention,
};

/**
 * Documents a person writes (a policy file) are validated as INPUT: a field with a zod default is
 * optional there. The others describe what the system emits, so their output shape is exported.
 */
const INPUT_SHAPED: ReadonlySet<string> = new Set(['policy']);

const TITLES: Record<string, string> = {
  capability: 'Capability',
  policy: 'Policy',
  'replay-result': 'Replay Result',
  'run-event': 'Run Event',
  intervention: 'Intervention',
};

/** Builds the JSON Schema documents in memory; does not touch the filesystem. */
export function buildJsonSchemas(): Record<string, object> {
  const out: Record<string, object> = {};
  for (const name of Object.keys(SCHEMAS)) {
    const schema = SCHEMAS[name]!;
    const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: INPUT_SHAPED.has(name) ? 'input' : 'output' }) as Record<string, unknown>;
    json.$id = `https://github.com/AbhiramDwivedi/understudy/schema/${name}.json`;
    json.title = TITLES[name];
    out[name] = json;
  }
  return out;
}

function writeSchemaFiles(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, '..', '..', 'schema');
  mkdirSync(outDir, { recursive: true });
  const built = buildJsonSchemas();
  for (const [name, json] of Object.entries(built)) {
    const filePath = join(outDir, `${name}.json`);
    writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  }
  console.log(`Wrote ${Object.keys(built).length} schema files to ${outDir}`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  writeSchemaFiles();
}
