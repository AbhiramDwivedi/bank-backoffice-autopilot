/**
 * Ensures the video run's policy copy exists (policies/default.yaml with 4173->4183,
 * 4174->4184, the same transformation build.ts would apply), and builds the excerpt/diff content
 * for the term:policy clip.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './script.js';
import { VIDEO_POLICY } from './contracts.js';

const DEFAULT_POLICY_PATH = path.join(REPO_ROOT, 'policies', 'default.yaml');

/** Creates VIDEO_POLICY from policies/default.yaml (ports swapped) if it does not already exist. */
export function ensureVideoPolicy(): void {
  if (existsSync(VIDEO_POLICY)) return;
  const src = readFileSync(DEFAULT_POLICY_PATH, 'utf8');
  const transformed = src.replace(/http:\/\/localhost:4173/g, 'http://localhost:4183').replace(/http:\/\/localhost:4174/g, 'http://localhost:4184');
  mkdirSync(path.dirname(VIDEO_POLICY), { recursive: true });
  writeFileSync(VIDEO_POLICY, transformed);
}

function stripComments(yaml: string): string {
  return yaml
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Extracts a top-level `key:` block (the key's line plus every indented/blank line after it,
 *  until the next top-level key or EOF) from an (already comment-stripped) YAML string. */
function extractSection(yaml: string, key: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (start === -1) return '';
  const out: string[] = [lines[start]!];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (/^\S/.test(l)) break;
    out.push(l);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

export interface PolicyExcerptBlock {
  label: string;
  code: string;
}

/** Real, truthful excerpts of the policy used by this video run: the allowlist/action/risk/
 *  redaction sections (comments stripped) plus a line-level diff of `allowedOrigins` against the
 *  base policy file (ports only). */
export function policyExcerpt(): PolicyExcerptBlock[] {
  ensureVideoPolicy();
  const original = stripComments(readFileSync(DEFAULT_POLICY_PATH, 'utf8'));
  const video = stripComments(readFileSync(VIDEO_POLICY, 'utf8'));

  const allowSection = [extractSection(original, 'allowedOrigins'), extractSection(original, 'deniedPathPatterns'), extractSection(original, 'allowedActions')].join(
    '\n\n',
  );
  const riskSection = extractSection(original, 'risk');
  const redactionSection = extractSection(original, 'redaction');

  const origOrigins = extractSection(original, 'allowedOrigins').split('\n');
  const videoOrigins = extractSection(video, 'allowedOrigins').split('\n');
  const diffLines: string[] = [];
  const max = Math.max(origOrigins.length, videoOrigins.length);
  for (let i = 0; i < max; i += 1) {
    const a = origOrigins[i];
    const b = videoOrigins[i];
    if (a === b) continue;
    if (a !== undefined) diffLines.push(`- ${a}`);
    if (b !== undefined) diffLines.push(`+ ${b}`);
  }
  diffLines.push('', '(same policy otherwise; only the two mock-app ports differ for this video run)');

  return [
    { label: 'policies/default.yaml — allowlist & allowed actions', code: allowSection },
    { label: 'risk — irreversible text/URL patterns', code: riskSection },
    { label: 'redaction patterns', code: redactionSection },
    { label: 'this video run: allowedOrigins diff (ports only)', code: diffLines.join('\n') },
  ];
}
