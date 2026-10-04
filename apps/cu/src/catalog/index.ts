/**
 * Agent-facing capability catalog: loads every capability artifact under a directory, exposes
 * Anthropic-style tool definitions for the valid, non-deprecated ones, and can invoke a
 * non-deprecated one by id with typed args -- replaying it through the same wiring the `replay` CLI command uses
 * (`runReplay`, apps/cu/src/runtime/run-replay.ts). That gives one path from "capability + inputs" to a
 * `ReplayResult`, whether it is driven by a human via the CLI or by an agent via this catalog.
 *
 * Finding a capability: `search` (./search.ts, deterministic BM25F keyword ranking) shortlists,
 * `toBriefs` is level 1 of progressive disclosure (id/name + one-liner), `toToolDefinition(id or name)` is
 * level 2 (the full definition). Design: docs/design/capability-selection.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Browser } from 'playwright';
import { SEMVER_RE, validateCapability, type Capability, type Policy, type ReplayResult } from '@cu/core/schema';
import type { Surface } from '@cu/core/surface';
import type { CredentialProvider } from '@cu/core/credentials';
import { DEFAULT_RUNS_DIR, runReplay, type AutoOperatorMode, type DesktopRunOptions, type RelayServerHandle } from '../runtime/index.js';
import { buildSearchIndex, type SearchHit, type SearchIndex, type SearchOptions } from './search.js';
import { oneLineDescription } from './text.js';

export { DEFAULT_TOP_K, type SearchHit, type SearchOptions } from './search.js';
export { oneLineDescription } from './text.js';

/** A capability loaded from an artifact file, with the fields callers need to list, select, and invoke it. */
export interface CatalogEntry {
  id: string;
  version: string;
  name: string;
  description: string;
  status: 'draft' | 'approved' | 'deprecated';
  riskLevel: string;
  /** Absolute path to the artifact file this entry was loaded from. */
  file: string;
  capability: Capability;
}

/** An Anthropic-style tool definition derived from a capability's declared inputs. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: 'string' | 'number' | 'boolean'; description: string; pattern?: string }>;
    required: string[];
    additionalProperties: false;
  };
}

/**
 * Level 1 of progressive disclosure: just enough to choose a capability. `id` is the capability's
 * real id; `name` is its tool name, which equals the id unless the id is longer than 64
 * characters or has characters a tool name cannot (then `name` is a truncated/sanitised form).
 * `toToolDefinition`, `resolve` and `invoke` accept either. `description` is the deterministic
 * one-liner (`oneLineDescription`). Cheap enough to show a model for thousands of capabilities.
 */
export interface CapabilityBrief {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'approved';
  riskLevel: string;
}

/** Options for invoking a catalog capability; mirrors the replay engine's own options. */
export interface InvokeOptions {
  baseUrl: string;
  policyPath?: string;
  policy?: Policy;
  runsDir?: string;
  headless?: boolean;
  /** Capability override key, not the surface's mock tenant id ("a" or "b"). */
  tenant?: string;
  browser?: Browser;
  surface?: Surface;
  /** For a desktop://<process> base URL: how to start or attach to the app. */
  desktop?: DesktopRunOptions;
  autoOperator?: AutoOperatorMode;
  operator?: { port: number } | { server: RelayServerHandle };
  /** One-line progress/warning messages from the replay (e.g. the console URL, a busy port).
   *  Default: swallowed. */
  log?: (line: string) => void;
  /** Where the capability's secret bindings resolve. Default: the environment. */
  credentials?: CredentialProvider;
  /** The caller's assertion, for this run, that replaying the capability changes nothing in the
   *  target app (see `RunReplayOptions.readOnly`): replay may then retry a transient app error. */
  readOnly?: boolean;
  /** The wait before app-error retry n is n times this (see `RunReplayOptions.appErrorRetryBackoffMs`). */
  appErrorRetryBackoffMs?: number;
}

/** A loaded set of capability artifacts, queryable by id and invocable through the replay engine. */
export interface Catalog {
  entries(): CatalogEntry[];
  skipped(): { file: string; reason: string }[];
  get(id: string): CatalogEntry | undefined;
  /** The entry for a capability id, or for its tool name when that is unambiguous (they differ only for ids over 64 characters or with unusual characters). An exact id always wins. */
  resolve(idOrName: string): CatalogEntry | undefined;
  /** Full tool definitions for every non-deprecated capability (all of them; see `toBriefs` for the cheap listing). `approvedOnly` also drops drafts. */
  toToolDefinitions(opts?: { approvedOnly?: boolean }): ToolDefinition[];
  /** Level 2: the full tool definition for one capability (id or tool name); undefined when unknown or deprecated. */
  toToolDefinition(idOrName: string): ToolDefinition | undefined;
  /** Level 1: id + name + one-line description + status + risk for every non-deprecated capability (`approvedOnly` also drops drafts). */
  toBriefs(opts?: { approvedOnly?: boolean }): CapabilityBrief[];
  /** Ranked keyword search (see ./search.ts); the index is built on first use. */
  search(query: string, opts?: SearchOptions): SearchHit[];
  invoke(id: string, args: Record<string, unknown>, opts: InvokeOptions): Promise<ReplayResult>;
}

// -------------------------------------------------------------------------------------------
// Semver precedence (semver.org #11) -- just enough to pick "the highest version" among two
// artifacts that declare the same capability id. No semver package is a project dependency.
// -------------------------------------------------------------------------------------------

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
}

function parseVersion(v: string): ParsedVersion {
  const m = SEMVER_RE.exec(v);
  // Unreachable via loadCatalog (only validateCapability'd versions reach here, and that regex is
  // the same SEMVER_RE), but fail loudly rather than silently miscomparing if it ever is.
  if (!m) throw new Error(`not a semver version: "${v}"`);
  const [, major, minor, patch, pre] = m;
  const prerelease = pre !== undefined && pre.length > 0 ? pre.split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  return { major: Number(major), minor: Number(minor), patch: Number(patch), prerelease };
}

function comparePrereleaseIdentifier(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1; // numeric identifiers always have lower precedence
  if (typeof b === 'number') return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** > 0 when `a` outranks `b`. A version with no prerelease outranks the same version with one. */
function compareSemver(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  const aHasPrerelease = pa.prerelease.length > 0;
  const bHasPrerelease = pb.prerelease.length > 0;
  if (aHasPrerelease !== bHasPrerelease) return aHasPrerelease ? -1 : 1;
  if (!aHasPrerelease) return 0;
  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    if (i >= pa.prerelease.length) return -1;
    if (i >= pb.prerelease.length) return 1;
    const c = comparePrereleaseIdentifier(pa.prerelease[i]!, pb.prerelease[i]!);
    if (c !== 0) return c;
  }
  return 0;
}

// -------------------------------------------------------------------------------------------
// Loading
// -------------------------------------------------------------------------------------------

function walkJsonFiles(dir: string): string[] {
  const out: string[] = [];
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of dirents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJsonFiles(full));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.json')) out.push(full);
  }
  return out;
}

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Capability ids are kebab-case (KEBAB_RE), already a subset of this pattern; the sanitize path
 *  is defense in depth only. */
function toToolName(id: string): string {
  if (TOOL_NAME_RE.test(id)) return id;
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return sanitized.length > 0 ? sanitized : 'capability';
}

function describeOutputs(cap: Capability): string {
  const parts = Object.entries(cap.outputs).map(([name, spec]) => `${name} (${spec.type}): ${spec.description}`);
  return parts.length > 0 ? `Outputs -- ${parts.join('; ')}.` : '';
}

function describeBusinessOutcomes(cap: Capability): string {
  if (cap.businessOutcomes.length === 0) return '';
  const parts = cap.businessOutcomes.map((bo) => `${bo.name} (${bo.description})`);
  return `Business outcomes -- ${parts.join('; ')}.`;
}

/** Tool description: capability description + outputs summary + declared business outcomes +
 *  risk + a `[draft]` marker (a draft with an irreversible step is refused by replay's approval
 *  gate unless the caller passes `--approve` / runs it pre-approved). */
function describeEntry(entry: CatalogEntry): string {
  const cap = entry.capability;
  const parts = [cap.description, describeOutputs(cap), describeBusinessOutcomes(cap), `Risk: ${cap.riskLevel}.`].filter((p) => p.length > 0);
  const draftMarker =
    cap.status === 'draft'
      ? ' [draft: irreversible steps in a draft capability are refused by replay\'s approval gate unless the invocation is pre-approved]'
      : '';
  return `${parts.join(' ')}${draftMarker}`;
}

function entryToTool(entry: CatalogEntry): ToolDefinition {
  const cap = entry.capability;
  const properties: ToolDefinition['input_schema']['properties'] = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(cap.inputs)) {
    const sensitivePart = spec.sensitive ? ' (sensitive: never echoed back in results or evidence)' : '';
    properties[name] = {
      type: spec.type,
      description: `${spec.description}${sensitivePart}`,
      ...(spec.pattern !== undefined ? { pattern: spec.pattern } : {}),
    };
    if (spec.required) required.push(name);
  }
  return {
    name: toToolName(entry.id),
    description: describeEntry(entry),
    input_schema: { type: 'object', properties, required, additionalProperties: false },
  };
}

/** True when `candidate` should replace `current` as the entry for their shared id: any
 *  non-deprecated version outranks every deprecated one, then the highest semver wins. So
 *  deprecating 1.3.0 falls back to an approved 1.2.2 rather than hiding the id. */
function outranks(candidate: CatalogEntry, current: CatalogEntry): boolean {
  const candidateLive = candidate.status !== 'deprecated';
  const currentLive = current.status !== 'deprecated';
  if (candidateLive !== currentLive) return candidateLive;
  return compareSemver(candidate.version, current.version) > 0;
}

/**
 * Loads every capability artifact JSON file under `dir` (recursively), keeping one entry per
 * capability id: the highest semver version among the non-deprecated files, or the highest
 * deprecated one when every file for that id is deprecated (listed, but excluded from tool
 * definitions and refused by `invoke`). Files that fail to parse or fail schema validation are
 * recorded in `skipped()` rather than thrown.
 */
export function loadCatalog(dir: string): Catalog {
  const root = path.resolve(dir);
  const skippedFiles: { file: string; reason: string }[] = [];
  const byId = new Map<string, CatalogEntry>();

  for (const file of walkJsonFiles(root)) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      skippedFiles.push({ file, reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const parsed = validateCapability(raw);
    if (!parsed.ok) {
      const reason = parsed.issues.map((iss) => `${iss.path.length > 0 ? iss.path.join('.') : '(root)'}: [${iss.code}] ${iss.message}`).join('; ');
      skippedFiles.push({ file, reason });
      continue;
    }
    const cap = parsed.capability;
    const entry: CatalogEntry = {
      id: cap.id,
      version: cap.version,
      name: cap.name,
      description: cap.description,
      status: cap.status,
      riskLevel: cap.riskLevel,
      file,
      capability: cap,
    };
    const existing = byId.get(cap.id);
    if (existing === undefined || outranks(entry, existing)) {
      byId.set(cap.id, entry);
    }
  }

  function entries(): CatalogEntry[] {
    return [...byId.values()];
  }

  function skipped(): { file: string; reason: string }[] {
    return [...skippedFiles];
  }

  function get(id: string): CatalogEntry | undefined {
    return byId.get(id);
  }

  /** Tool name -> entry, only for names that map to exactly one id (ambiguous truncations are omitted; their ids still work). */
  let byToolName: Map<string, CatalogEntry> | undefined;
  function resolve(idOrName: string): CatalogEntry | undefined {
    const exact = byId.get(idOrName);
    if (exact !== undefined) return exact;
    if (byToolName === undefined) {
      const seen = new Map<string, CatalogEntry | null>();
      for (const e of byId.values()) {
        const n = toToolName(e.id);
        seen.set(n, seen.has(n) ? null : e);
      }
      byToolName = new Map([...seen].flatMap(([n, e]) => (e === null ? [] : [[n, e] as const])));
    }
    return byToolName.get(idOrName);
  }

  function live(opts?: { approvedOnly?: boolean }): CatalogEntry[] {
    return entries().filter((e) => (opts?.approvedOnly === true ? e.status === 'approved' : e.status !== 'deprecated'));
  }

  function toToolDefinitions(opts?: { approvedOnly?: boolean }): ToolDefinition[] {
    return live(opts).map(entryToTool);
  }

  function toToolDefinition(idOrName: string): ToolDefinition | undefined {
    const entry = resolve(idOrName);
    return entry === undefined || entry.status === 'deprecated' ? undefined : entryToTool(entry);
  }

  function toBriefs(opts?: { approvedOnly?: boolean }): CapabilityBrief[] {
    return live(opts).flatMap((e) =>
      e.status === 'deprecated'
        ? []
        : [{ id: e.id, name: toToolName(e.id), description: oneLineDescription(e.description), status: e.status, riskLevel: e.riskLevel }],
    );
  }

  let searchIndex: SearchIndex | undefined;
  function search(query: string, opts?: SearchOptions): SearchHit[] {
    searchIndex ??= buildSearchIndex(entries());
    return searchIndex.search(query, opts);
  }

  async function invoke(id: string, args: Record<string, unknown>, opts: InvokeOptions): Promise<ReplayResult> {
    const entry = resolve(id);
    if (entry === undefined) {
      const known = [...byId.keys()].sort();
      throw new Error(`unknown capability id "${id}"; known ids: ${known.length > 0 ? known.join(', ') : '(none)'}`);
    }
    if (entry.status === 'deprecated') {
      throw new Error(`capability "${id}" is deprecated (version ${entry.version}, ${entry.file}) and has no non-deprecated version; refusing to invoke it`);
    }
    const { result } = await runReplay({
      capability: entry.capability,
      inputs: args,
      ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
      ...(opts.policyPath !== undefined ? { policyPath: opts.policyPath } : {}),
      runsDir: opts.runsDir ?? DEFAULT_RUNS_DIR,
      baseUrl: opts.baseUrl,
      headless: opts.headless ?? true,
      ...(opts.tenant !== undefined ? { tenant: opts.tenant } : {}),
      autoOperator: opts.autoOperator ?? 'none',
      ...(opts.operator !== undefined ? { operator: opts.operator } : {}),
      ...(opts.browser !== undefined ? { browser: opts.browser } : {}),
      ...(opts.surface !== undefined ? { surface: opts.surface } : {}),
      ...(opts.desktop !== undefined ? { desktop: opts.desktop } : {}),
      ...(opts.log !== undefined ? { log: opts.log } : {}),
      ...(opts.credentials !== undefined ? { credentials: opts.credentials } : {}),
      ...(opts.readOnly === true ? { readOnly: true } : {}),
      ...(opts.appErrorRetryBackoffMs !== undefined ? { appErrorRetryBackoffMs: opts.appErrorRetryBackoffMs } : {}),
    });
    return result;
  }

  return { entries, skipped, get, resolve, toToolDefinitions, toToolDefinition, toBriefs, search, invoke };
}
