/**
 * Builds the `evidence/` folder from real runs.
 *
 * Usage (mock app running on :4173, and on :4174 when --tenant-b is given):
 *   npx tsx tools/evidence/make-evidence.ts --artifact artifacts/lookup-member-savings-balance.json \
 *     --discovery-run run_20260926_xxxxxxxx [--tenant-b]
 *
 * It replays the artifact through the CLI for each scenario, copies every run directory into
 * `evidence/`, copies the artifact, and writes `evidence/README.md`. Run directories already
 * contain only redacted content; nothing here re-redacts.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// Reused so the tenant B base URL comes from the same config the CLI itself uses for `--tenant b`
// (apps/cu/src/runtime/compose.ts), instead of a second hardcoded '4174' living here.
import { TENANTS } from '@cu/cli/runtime';

interface LocatorReportEntry {
  stepId: string;
  strategyKind: string;
  fallbackDepth: number;
}

/** 0 when `report` is empty: no fallback ever happened. */
function maxFallbackDepth(report: readonly LocatorReportEntry[]): number {
  return report.reduce((max, e) => Math.max(max, e.fallbackDepth), 0);
}

interface Scenario {
  name: string;
  title: string;
  args: string[];
  expectKind: string;
  /**
   * Extra pass/fail check against the run's locatorReport, beyond expectKind. Returns an error
   * message when the check fails, undefined when it passes.
   */
  checkLocatorReport?: (report: readonly LocatorReportEntry[]) => string | undefined;
}

// The "Enter the member ID" step. Its base (tenant A) target's primary locator names the label
// "Member ID"; tenant B's real label is "Member #" (apps/mock-app/tenant.ts), so this step only
// resolves at fallback depth 0 on tenant B when the capability's riverbend-fcu override is applied.
/** The step the tenant override patches (the member id field), read from the artifact; s05 if it has no override. */
function tenantBLabelStepId(): string {
  try {
    const cap = JSON.parse(readFileSync(artifact, 'utf8')) as { overrides?: { stepPatches?: { stepId?: string }[] }[] };
    return cap.overrides?.[0]?.stepPatches?.[0]?.stepId ?? 's05';
  } catch {
    return 's05';
  }
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const artifact = flag('--artifact') ?? 'artifacts/lookup-member-savings-balance.json';
const TENANT_B_LABEL_STEP_ID = tenantBLabelStepId();
const discoveryRun = flag('--discovery-run');
/** Extend-mode runs that declared business outcomes (repeatable: --extend-run <runId>). */
const extendRuns = args.flatMap((a, i) => {
  const next = args[i + 1];
  return a === '--extend-run' && next ? [next] : [];
});
const withTenantB = args.includes('--tenant-b');
const runsDir = 'runs';
const evidenceDir = 'evidence';

if (!existsSync(artifact)) {
  console.error(`artifact not found: ${artifact}`);
  process.exit(1);
}

const scenarios: Scenario[] = [
  { name: 'replay-success', title: 'Replay, success with outputs', args: ['--input', 'memberId=12345'], expectKind: 'success' },
  { name: 'replay-not-found', title: 'Replay, business outcome (member not found)', args: ['--input', 'memberId=99999'], expectKind: 'business_outcome' },
  { name: 'replay-access-denied', title: 'Replay, business outcome (access denied)', args: ['--input', 'memberId=90001'], expectKind: 'business_outcome' },
  { name: 'replay-app-error', title: 'Replay, hard failure (injected application error)', args: ['--input', 'memberId=12345', '--fault', '{"failSearch":true}'], expectKind: 'hard_failure' },
  { name: 'replay-handoff', title: 'Replay, escalation to a human and resume (injected session expiry)', args: ['--input', 'memberId=12345', '--fault', '{"expireSession":true}', '--auto-operator', 'relogin'], expectKind: 'escalated' },
];
if (withTenantB) {
  const tenantBBaseUrl = TENANTS.b?.baseUrl;
  if (!tenantBBaseUrl) {
    console.error("--tenant-b given but TENANTS.b has no baseUrl configured (apps/cu/src/runtime/compose.ts)");
    process.exit(1);
  }
  scenarios.push(
    {
      name: 'replay-tenant-b',
      title: 'Replay on tenant B through the override',
      args: ['--input', 'memberId=12345', '--tenant', 'b'],
      expectKind: 'success',
      checkLocatorReport: (report) => {
        const depth = maxFallbackDepth(report);
        return depth === 0 ? undefined : `expected fallback depth 0 across the run with the tenant override applied, got ${depth}`;
      },
    },
    {
      name: 'replay-tenant-b-no-override',
      title: "Replay against tenant B's base URL directly, without `--tenant`",
      // Same base URL as the scenario above, reached without the capability's tenant override:
      // this is meant to show locator drift, not to fail the run.
      args: ['--input', 'memberId=12345', '--base-url', tenantBBaseUrl],
      expectKind: 'success',
      checkLocatorReport: (report) => {
        const depth = maxFallbackDepth(report.filter((e) => e.stepId === TENANT_B_LABEL_STEP_ID));
        return depth > 0
          ? undefined
          : `expected the member id label step (${TENANT_B_LABEL_STEP_ID}) to show fallback depth > 0 without the tenant override, got ${depth}`;
      },
    },
  );
}

// Remove only what this script produces. Other evidence, such as the explainer video and the
// hand-curated `followups/` folder, stays.
if (existsSync(evidenceDir)) {
  for (const entry of readdirSync(evidenceDir)) {
    const managed =
      entry === 'README.md' ||
      entry === 'capability.json' ||
      entry === 'discovery-run' ||
      entry.startsWith('discovery-extend-') ||
      entry.startsWith('replay-');
    if (managed) rmSync(path.join(evidenceDir, entry), { recursive: true, force: true });
  }
}
mkdirSync(evidenceDir, { recursive: true });

const hasFollowups = existsSync(path.join(evidenceDir, 'followups'));
const lines: string[] = [
  '# Evidence',
  '',
  'Each directory ' +
    (hasFollowups ? 'at the top level here' : 'here') +
    ' is a real run directory, copied unchanged from `runs/`.' +
    (hasFollowups ? ' The live runs behind the later features are under `followups/`, described at the end.' : '') +
    ' Every run directory holds `events.jsonl` (the structured log) and `result.json`. The rest appear only when a run produces them: `shots/` (screenshots: one per model turn in discovery runs, and the failure or escalation screenshots in replay runs), `dom/` (DOM snapshots on failure), and `interventions/` (handoff records). Discovery runs also hold `transcript.jsonl` and the `capability.json` they produced.',
  '',
  discoveryRun
    ? 'The capability under test is [capability.json](capability.json), recorded by the discovery run below and replayed for every scenario.'
    : 'The capability under test is [capability.json](capability.json), replayed for every scenario.',
  '',
];

cpSync(artifact, path.join(evidenceDir, 'capability.json'));

if (discoveryRun) {
  const src = path.join(runsDir, discoveryRun);
  if (!existsSync(src)) {
    console.error(`discovery run not found: ${src}`);
    process.exit(1);
  }
  cpSync(src, path.join(evidenceDir, 'discovery-run'), { recursive: true });
  const result = JSON.parse(readFileSync(path.join(src, 'result.json'), 'utf8')) as Record<string, unknown>;
  lines.push(
    '## discovery-run',
    '',
    `This LLM-driven run produced the capability. It finished with status \`${String(result.status)}\`, recorded ${String(result.stepsRecorded)} steps, and made ${String(result.llmCalls)} model calls. \`transcript.jsonl\` is the redacted model transcript, and the \`decision\` events in \`events.jsonl\` carry the model's reasoning for each step.`,
    '',
  );
}

for (const [i, runId] of extendRuns.entries()) {
  const src = path.join(runsDir, runId);
  if (!existsSync(src)) {
    console.error(`extend run not found: ${src}`);
    process.exit(1);
  }
  const name = `discovery-extend-${i + 1}`;
  cpSync(src, path.join(evidenceDir, name), { recursive: true });
  const result = JSON.parse(readFileSync(path.join(src, 'result.json'), 'utf8')) as Record<string, unknown>;
  lines.push(
    `## ${name}`,
    '',
    `This extend-mode discovery run tried a different input to find an exceptional outcome. It finished with status \`${String(result.status)}\` after ${String(result.llmCalls)} model calls. The run merged the outcome the model declared into the capability as a business outcome.`,
    '',
  );
}

for (const s of scenarios) {
  process.stdout.write(`${s.name} ... `);
  // Spawn node directly (no shell) so JSON arguments survive Windows quoting.
  const proc = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'apps/cu/src/index.ts', 'replay', artifact, '--runs-dir', runsDir, '--operator-port', '0', '--json', ...s.args],
    { encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 },
  );
  let result: Record<string, unknown> | undefined;
  try {
    result = JSON.parse(proc.stdout) as Record<string, unknown>;
  } catch {
    console.error(`\n${s.name}: could not parse result JSON\n${proc.stdout}\n${proc.stderr}`);
    process.exit(1);
  }
  const runId = String(result.runId);
  cpSync(path.join(runsDir, runId), path.join(evidenceDir, s.name), { recursive: true });
  const kind = String(result.kind);
  const locatorReport = Array.isArray(result.locatorReport) ? (result.locatorReport as LocatorReportEntry[]) : [];
  const overallMaxDepth = maxFallbackDepth(locatorReport);
  console.log(`locator fallback depth (max across the run): ${overallMaxDepth}`);

  let ok = kind === s.expectKind;
  let checkError: string | undefined;
  if (ok && s.checkLocatorReport) {
    checkError = s.checkLocatorReport(locatorReport);
    if (checkError !== undefined) ok = false;
  }
  console.log(`${kind}${ok ? '' : ` (expected ${s.expectKind}${checkError ? `; ${checkError}` : ''})`} -> ${s.name}/`);

  const detail =
    kind === 'success'
      ? `outputs: \`${JSON.stringify(result.outputs)}\``
      : kind === 'business_outcome'
        ? `outcome \`${String(result.name)}\`, data: \`${JSON.stringify(result.data)}\``
        : kind === 'hard_failure'
          ? `code \`${String(result.code)}\` at step \`${String(result.stepId)}\`; evidence \`${JSON.stringify(result.evidence)}\``
          : `resolution \`${String(result.resolution)}\`; outcome after hand-back: \`${JSON.stringify(result.outcome)}\``;
  // A --fault value is a JSON object; without quotes around it, the printed command isn't
  // something you could actually paste into a shell.
  const renderArg = (a: string): string => (a.includes('{') ? `'${a}'` : a);
  const command = s.args.map(renderArg).join(' ');
  let readmeLine = `${s.title}. Command: \`replay ${command}\`. Result kind \`${kind}\`, ${detail}. Locator fallback depth (max across the run): \`${overallMaxDepth}\`.`;
  if (s.name === 'replay-tenant-b-no-override') {
    const labelStepDepth = maxFallbackDepth(locatorReport.filter((e) => e.stepId === TENANT_B_LABEL_STEP_ID));
    readmeLine += ` Drift signal: step \`${TENANT_B_LABEL_STEP_ID}\` (the member id field label) resolved at fallback depth \`${labelStepDepth}\` instead of \`0\`, because this run has no tenant override and the base capability's "Member ID" label locator does not match tenant B's real "Member #" label.`;
  }
  lines.push(`## ${s.name}`, '', readmeLine, '');
  if (!ok) process.exitCode = 2;
}

if (hasFollowups) {
  lines.push(
    '## followups',
    '',
    'Live runs of the risk judge, `cu audit`, the optimizer, seeded chaos, discovery with a real model on the mock app and on the Windows mock desktop app, and the public-target run. Each has its own folder with the commands, their captured output, and the run directories the commands produced; [followups/README.md](followups/README.md) lists them with their results. `npm run evidence` does not rebuild this folder.',
    '',
  );
}

if (existsSync(path.join(evidenceDir, 'explainer.mp4'))) {
  lines.push(
    '## explainer.mp4',
    '',
    'This narrated walkthrough covers the problem, the design, and a live run. `npm run video:build` rebuilds it from real runs, as described in [how the explainer video is built](../docs/video/README.md).',
    '',
  );
}

writeFileSync(path.join(evidenceDir, 'README.md'), lines.join('\n'));
console.log(`wrote ${evidenceDir}/README.md`);
