/**
 * Minimal `.env` loader (no dotenv dependency). Reads KEY=VALUE lines from `<cwd>/.env` if the
 * file exists; never prints values.
 *
 * It also fills in the mock app's demo login when unset, so `npm run mock-app` plus the CLI work
 * with no configuration at all. Those two names are the mock app's, nothing more: they feed the
 * default (`env`) credential provider only because the shipped capabilities bind them. A run that
 * uses `--credentials file:...` or `exec:...` never reads them, and an app with its own login names
 * its own credentials (`discover --secret NAME`).
 */
import fs from 'node:fs';
import path from 'node:path';

/** The mock app's documented demo account (apps/mock-app/README.md). Not real credentials. */
export const MOCK_APP_DEMO_CREDENTIALS: Readonly<Record<string, string>> = Object.freeze({
  MOCK_USER: 'operator1',
  MOCK_PASSWORD: 'demo-pass-123',
});

/**
 * Loads `<cwd>/.env` into `env` (default `process.env`) without overwriting a variable already
 * set, then applies {@link MOCK_APP_DEMO_CREDENTIALS} to whichever of those names is still unset
 * (an explicitly empty value is left empty, so it fails the credential check rather than silently
 * becoming the demo password). Returns the names it read from `.env`, so callers can report
 * "loaded 3 variables from .env" without leaking values.
 */
export function loadEnv(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string[] {
  const file = path.join(cwd, '.env');
  const set: string[] = [];
  if (fs.existsSync(file)) {
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
      if (!m || raw.trimStart().startsWith('#')) continue;
      const value = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
      if (env[m[1]!] === undefined) {
        env[m[1]!] = value;
        set.push(m[1]!);
      }
    }
  }
  for (const [name, value] of Object.entries(MOCK_APP_DEMO_CREDENTIALS)) {
    if (env[name] === undefined) env[name] = value;
  }
  return set;
}
