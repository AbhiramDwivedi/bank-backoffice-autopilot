/**
 * `cu validate <artifact.json>` -- validates a capability artifact with `validateCapability`
 * (packages/core/src/schema/validate.ts) with no surface, no policy, no run directory: this is a static check.
 */
import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { validateCapability } from '@cu/core/schema';

/** Registers the `validate` command on `program`. */
export function registerValidate(program: Command): void {
  program
    .command('validate <artifact>')
    .description('validate a capability artifact JSON file against the schema and cross-field rules')
    .action((artifactPath: string) => {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(artifactPath, 'utf8'));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`cu validate: could not read/parse ${artifactPath}: ${message}`);
        process.exitCode = 1;
        return;
      }

      const result = validateCapability(raw);
      if (result.ok) {
        const c = result.capability;
        console.log(`valid: ${c.id}@${c.version} (${c.status}, ${c.steps.length} steps, risk ${c.riskLevel})`);
        // Warnings never fail validation (exit code stays 0); they go to stderr.
        for (const warning of result.warnings) {
          const path = warning.path.length > 0 ? warning.path.join('.') : '(root)';
          console.warn(`  warning ${path}: [${warning.code}] ${warning.message}`);
        }
        return;
      }

      console.error(`invalid: ${artifactPath}`);
      for (const issue of result.issues) {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        console.error(`  ${path}: [${issue.code}] ${issue.message}`);
      }
      process.exitCode = 1;
    });
}
