/**
 * Reads real evidence back out of a run directory (events.jsonl, interventions/*.json) for the
 * term:handoff-result, term:redaction and term:agent-tag clips, plus (readEvidenceReadmeSection)
 * evidence/README.md's own scenario write-ups for term:tenant-drift. Pure file reads — no
 * mock-app dependency.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './script.js';

/** Trimmed-down view of one captured human action, for display only. */
export interface InterventionActionExcerpt {
  type: unknown;
  target: unknown;
  valueRedacted: unknown;
}

/** Trimmed-down view of an `interventions/<id>.json` record, for display only. */
export interface InterventionExcerpt {
  id: unknown;
  status: unknown;
  reason: unknown;
  resolution?: {
    by: unknown;
    resumeFrom: unknown;
    notes: unknown;
    humanActions: InterventionActionExcerpt[];
  };
}

/** The first (only, in our runs) intervention record in `runDir/interventions/`. */
export function readInterventionExcerpt(runDir: string): InterventionExcerpt | undefined {
  const dir = path.join(runDir, 'interventions');
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return undefined;
  const full = JSON.parse(readFileSync(path.join(dir, files[0]!), 'utf8')) as Record<string, unknown>;
  const resolution = full.resolution as Record<string, unknown> | undefined;
  return {
    id: full.id,
    status: full.status,
    reason: full.reason,
    resolution: resolution
      ? {
          by: resolution.by,
          resumeFrom: resolution.resumeFrom,
          notes: resolution.notes,
          humanActions: Array.isArray(resolution.humanActions)
            ? (resolution.humanActions as unknown[]).map((a) => {
                const action = a as Record<string, unknown>;
                return { type: action.type, target: action.target, valueRedacted: action.valueRedacted };
              })
            : [],
        }
      : undefined,
  };
}

export interface EventGrepResult {
  redactedLines: string[];
  humanActionLines: string[];
}

/** At most `max` characters of `line`, centred on the first `marker` so it stays on screen however
 *  long the line is; an elided start or end is shown as an ellipsis. */
function windowAround(line: string, marker: string, max: number): string {
  if (line.length <= max) return line;
  const at = Math.max(0, line.indexOf(marker));
  const start = Math.max(0, Math.min(at - Math.floor(max / 2), line.length - max));
  const body = line.slice(start, start + max);
  return `${start > 0 ? '…' : ''}${body}${start + max < line.length ? '…' : ''}`;
}

/** Greps `runDir/events.jsonl` for lines containing `[REDACTED` and `human_action` lines whose
 *  data carries `valueRedacted:true` (typed inputs first), each windowed around its marker. */
export function grepEvents(runDir: string, opts: { maxRedacted?: number; maxHumanAction?: number; maxLineChars?: number } = {}): EventGrepResult {
  const file = path.join(runDir, 'events.jsonl');
  const maxRedacted = opts.maxRedacted ?? 2;
  const maxHumanAction = opts.maxHumanAction ?? 2;
  const maxLineChars = opts.maxLineChars ?? 240;
  if (!existsSync(file)) return { redactedLines: [], humanActionLines: [] };
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const redactedLines = lines
    .filter((l) => l.includes('[REDACTED'))
    .slice(0, maxRedacted)
    .map((l) => windowAround(l, '[REDACTED', maxLineChars));
  // Typed inputs first (the point of the clip), each windowed so `"valueRedacted":true` is on screen.
  const valueFree = lines.filter((l) => l.includes('"kind":"human_action"') && l.includes('"valueRedacted":true'));
  const humanActionLines = [...valueFree.filter((l) => l.includes('"type":"input"')), ...valueFree.filter((l) => !l.includes('"type":"input"'))]
    .slice(0, maxHumanAction)
    .map((l) => windowAround(l, '"valueRedacted":true', maxLineChars));
  return { redactedLines, humanActionLines };
}

/** One `{kind:'observation', data:{browserAgent:{...}}}` line found in `runDir/events.jsonl`,
 *  trimmed to the fields term:agent-tag actually shows (dropping runId/seq/ts, and the per-frame
 *  detail down to a count) so the real, unmodified values still fit the static block's height with
 *  `"source":"app"` visible near the top rather than scrolled/clipped off. */
export interface BrowserAgentEvent {
  kind: unknown;
  source: unknown;
  present: unknown;
  version: unknown;
  frameCount: number | undefined;
  /** The event's events.jsonl line, unmodified. */
  line: string;
}

/**
 * Finds the first browser-agent detection event in `runDir/events.jsonl` (term:agent-tag, second
 * block). `compose()` (apps/cu/src/runtime/compose.ts) only logs this when it builds the surface
 * itself — a caller-supplied surface (like this pipeline's in-process handoff recording) is never
 * wired to log it — so this only ever finds a hit in a plain `cu replay` CLI run's evidence, never
 * the handoff run's. Returns undefined if the file is missing or no such event is present.
 */
export function findBrowserAgentEvent(runDir: string): BrowserAgentEvent | undefined {
  const file = path.join(runDir, 'events.jsonl');
  if (!existsSync(file)) return undefined;
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const data = record.data as Record<string, unknown> | undefined;
    const browserAgent = data?.browserAgent as Record<string, unknown> | undefined;
    if (browserAgent !== undefined) {
      return {
        kind: record.kind,
        source: browserAgent.source,
        present: browserAgent.present,
        version: browserAgent.version,
        frameCount: Array.isArray(browserAgent.frames) ? (browserAgent.frames as unknown[]).length : undefined,
        line,
      };
    }
  }
  return undefined;
}

const EVIDENCE_README_PATH = path.join(REPO_ROOT, 'evidence', 'README.md');

/**
 * The paragraph under a `## <heading>` section of evidence/README.md (term:tenant-drift), read at
 * record time so the video always shows the real, current write-up rather than a copy that can
 * drift from the file. Throws if the heading is not found — a missing section means the doc and
 * this clip have gone out of sync, which should stop the build rather than show stale text.
 */
export function readEvidenceReadmeSection(heading: string): string {
  const text = readFileSync(EVIDENCE_README_PATH, 'utf8').replace(/\r/g, '');
  const lines = text.split('\n');
  const headingLine = `## ${heading}`;
  const start = lines.findIndex((l) => l.trim() === headingLine);
  if (start === -1) throw new Error(`evidence/README.md has no "${headingLine}" section`);
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (/^##\s/.test(l)) break;
    if (l.trim().length > 0) out.push(l.trim());
  }
  return out.join(' ').trim();
}
