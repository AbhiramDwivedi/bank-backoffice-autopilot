/**
 * `ensureRelayBuilt`: builds Relay's UI into a fresh outdir, is a no-op once it is fresh, and
 * rebuilds when `index.html` looks stale. Never touches `apps/relay/src/**` -- only ever writes to
 * a temp outdir this file owns and cleans up.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureRelayBuilt } from './relay-ui.js';

const tempDirs: string[] = [];

function tempOutdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ui-test-'));
  tempDirs.push(dir);
  return path.join(dir, 'dist');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('ensureRelayBuilt', () => {
  it('builds into a temp outdir when the UI is missing', async () => {
    const outdir = tempOutdir();
    const result = await ensureRelayBuilt({ outdir });

    expect(result.built).toBe(true);
    expect(result.outdir).toBe(outdir);
    expect(fs.existsSync(path.join(outdir, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(outdir, 'assets', 'app.js'))).toBe(true);
  }, 30000);

  it('is a no-op the second time (already fresh)', async () => {
    const outdir = tempOutdir();
    await ensureRelayBuilt({ outdir });

    const second = await ensureRelayBuilt({ outdir });
    expect(second.built).toBe(false);
    expect(second.outdir).toBe(outdir);
  }, 30000);

  it('rebuilds when the built output is older than the UI/shared source (mtime moved to the past)', async () => {
    const outdir = tempOutdir();
    await ensureRelayBuilt({ outdir });

    // ensureRelayBuilt judges staleness by assets/app.js's mtime (see relay-ui.ts's needsBuild for
    // why: Windows' CopyFile preserves index.html's *source* mtime on copy, so index.html's own
    // mtime in outdir does not reflect build time the way assets/app.js's freshly-written mtime does).
    // A fixed date older than any source file, not "a day ago": a relative offset only predates
    // the sources on a checkout younger than the offset, so the test would start failing a day
    // after the last UI edit.
    const appJs = path.join(outdir, 'assets', 'app.js');
    const past = new Date('2000-01-01T00:00:00Z');
    await fs.promises.utimes(appJs, past, past);

    const third = await ensureRelayBuilt({ outdir });
    expect(third.built).toBe(true);
  }, 30000);
});
