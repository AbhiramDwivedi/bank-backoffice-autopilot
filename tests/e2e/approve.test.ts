/**
 * End-to-end: `cu approve` (apps/cu/src/commands/approve.ts) against a real successful replay run,
 * driven through the real CLI child process exactly like tests/e2e/cli.test.ts does.
 *
 * The reference example artifact's version can change over time, so this test reads its
 * version from the file at test time rather than hardcoding it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXAMPLE_ARTIFACT, PASSWORD, runCli, startMock, tempRunsDir, writePolicyFile, type MockServer } from './harness.js';
import type { Capability } from '@cu/core/schema';

/** '1.0.1' -> '1.0.2'; mirrors apps/cu/src/commands/approve.ts's own (unexported) bumpPatch. */
function expectedBumpedVersion(version: string): string {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`not a valid semver version: ${version}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

describe('cli e2e: approve', () => {
  let mock: MockServer;
  let runsDir: string;
  let policyFile: string;
  let artifactFile: string;
  let originalVersion: string;

  beforeAll(async () => {
    mock = await startMock('a');
    runsDir = tempRunsDir();
    policyFile = writePolicyFile(runsDir, mock.baseUrl);

    // Copy the example artifact to a temp file, forced to 'draft' if it wasn't already (approve
    // refuses an already-approved artifact), reading its version fresh rather than hardcoding it.
    const cap = JSON.parse(fs.readFileSync(EXAMPLE_ARTIFACT, 'utf8')) as Capability;
    originalVersion = cap.version;
    cap.status = 'draft';
    artifactFile = path.join(runsDir, 'artifact-under-test.json');
    fs.writeFileSync(artifactFile, JSON.stringify(cap, null, 2), 'utf8');
  });

  afterAll(async () => {
    await mock.close();
  });

  it(
    'replay once (success), then approve: status becomes approved, version bumps, notes record the approval',
    async () => {
      const replayRes = await runCli([
        'replay',
        artifactFile,
        '--input',
        'memberId=12345',
        '--json',
        '--base-url',
        mock.baseUrl,
        '--policy',
        policyFile,
        '--runs-dir',
        runsDir,
        '--operator-port',
        '0',
      ]);
      expect(replayRes.stdout).not.toContain(PASSWORD);
      expect(replayRes.stderr).not.toContain(PASSWORD);
      expect(replayRes.code).toBe(0);
      const replayed = JSON.parse(replayRes.stdout) as { kind: string };
      expect(replayed.kind).toBe('success');

      const approveRes = await runCli(['approve', artifactFile, '--by', 'test-approver', '--notes', 'e2e check', '--runs-dir', runsDir]);
      expect(approveRes.stdout).not.toContain(PASSWORD);
      expect(approveRes.stderr).not.toContain(PASSWORD);
      expect(approveRes.code).toBe(0);
      expect(approveRes.stdout).toContain(`approved`);
      expect(approveRes.stdout).toContain('by test-approver');

      const written = JSON.parse(fs.readFileSync(artifactFile, 'utf8')) as Capability;
      expect(written.status).toBe('approved');
      expect(written.version).toBe(expectedBumpedVersion(originalVersion));
      expect(written.provenance.notes).toContain('Approved by test-approver');
      expect(written.provenance.notes).toContain('e2e check');
    },
    60_000,
  );

  it('refuses to re-approve the now-approved artifact', async () => {
    const res = await runCli(['approve', artifactFile, '--by', 'someone-else', '--runs-dir', runsDir]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('already approved');
  }, 30_000);
});
