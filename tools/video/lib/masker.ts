/**
 * Secret masking for terminal-style segments. Every captured string (CLI stdout/stderr, file
 * excerpts, printed results) MUST be run through `maskSecrets` before it is embedded in a
 * rendered page, and checked with `assertNoSecret` afterwards. The demo password must never be
 * visible in any term:* segment, even though typing it into the real login field (a
 * type="password" input, live:* segments) is fine.
 */

const HARDCODED_DEFAULT_PASSWORD = 'demo-pass-123';
const MASK = '••••••'; // ••••••

/** The password value(s) that must never appear in rendered terminal text: whatever
 *  MOCK_PASSWORD is currently set to, plus the mock app's hardcoded documented default (in case
 *  a caller typed it literally in a command even though the env var differs). */
export function secretValues(): string[] {
  const values = new Set<string>([HARDCODED_DEFAULT_PASSWORD]);
  if (process.env.MOCK_PASSWORD) values.add(process.env.MOCK_PASSWORD);
  return [...values].filter((v) => v.length > 0);
}

/** Replaces every occurrence of a known secret value, and the `MOCK_PASSWORD=...` env-assignment
 *  form specifically (in case the value itself was already redacted upstream but the form still
 *  reads like a leak), with a fixed-width bullet mask. Never mutates; returns the masked copy. */
export function maskSecrets(text: string, secrets: readonly string[] = secretValues()): string {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join(MASK);
  }
  out = out.replace(/MOCK_PASSWORD=\S+/g, `MOCK_PASSWORD=${MASK}`);
  return out;
}

/** Throws if any known secret value still appears in `text` (a masking bug, not user error). */
export function assertNoSecret(text: string, secrets: readonly string[] = secretValues()): void {
  for (const s of secrets) {
    if (s && text.includes(s)) {
      throw new Error(`masker bug: a secret value leaked into rendered terminal text (length ${s.length})`);
    }
  }
}

/** mask then assert in one call — the shape every term:* content-gatherer should use. */
export function maskAndVerify(text: string): string {
  const masked = maskSecrets(text);
  assertNoSecret(masked);
  return masked;
}
