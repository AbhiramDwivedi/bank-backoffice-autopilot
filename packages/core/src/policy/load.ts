/**
 * Loads and validates a Policy from YAML (`policies/default.yaml` and friends).
 *
 * Two levels of validation, both required before a Policy is trusted:
 * 1. Structural — `Policy.safeParse` (zod schema from `packages/core/src/schema/policy.ts`).
 * 2. Regex sanity — every regex *source* string embedded in the policy must actually compile.
 *    Every Policy regex source is compiled by consumers with the 'i' flag and no others, so
 *    that is exactly what is checked here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { Policy } from '../schema/index.js';

/** Resolved relative to this file: repo-root `policies/default.yaml`. */
export const DEFAULT_POLICY_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../policies/default.yaml');

function collectRegexSources(policy: Policy): { label: string; source: string }[] {
  const out: { label: string; source: string }[] = [];
  for (const source of policy.allowedPathPatterns) out.push({ label: 'allowedPathPatterns', source });
  for (const source of policy.deniedPathPatterns) out.push({ label: 'deniedPathPatterns', source });
  for (const source of policy.risk.irreversibleTextPatterns) out.push({ label: 'risk.irreversibleTextPatterns', source });
  for (const source of policy.risk.irreversibleUrlPatterns) out.push({ label: 'risk.irreversibleUrlPatterns', source });
  for (const p of policy.redaction.patterns) out.push({ label: `redaction.patterns[${p.name}]`, source: p.regex });
  for (const source of policy.redaction.screen?.maskLabels ?? []) out.push({ label: 'redaction.screen.maskLabels', source });
  for (const source of policy.redaction.screen?.omitScreenshotUrlPatterns ?? []) out.push({ label: 'redaction.screen.omitScreenshotUrlPatterns', source });
  return out;
}

/** Parses YAML text into a validated {@link Policy}. Throws a single `Error` describing every
 *  problem found (structural or regex) rather than stopping at the first one. */
export function parsePolicy(yamlText: string, source = '<policy>'): Policy {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new Error(`failed to parse YAML in ${source}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  const result = Policy.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new Error(`invalid policy in ${source}: ${issues}`);
  }

  const policy = result.data;
  const badRegexes: string[] = [];
  for (const { label, source: regexSource } of collectRegexSources(policy)) {
    try {
      // Only compiling to check validity; the result itself is discarded.
      new RegExp(regexSource, 'i');
    } catch (err) {
      badRegexes.push(`${label}: /${regexSource}/ (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (badRegexes.length > 0) {
    throw new Error(`invalid regex source(s) in ${source}: ${badRegexes.join('; ')}`);
  }

  return policy;
}

/** Reads a policy YAML file from disk and parses it (see {@link parsePolicy}). */
export function loadPolicy(filePath: string): Policy {
  const text = readFileSync(filePath, 'utf8');
  return parsePolicy(text, filePath);
}
