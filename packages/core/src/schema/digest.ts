/**
 * A capability's content digest: what `cu approve` matches a replay against, besides id and version.
 *
 * Id + version alone cannot tell two different contents apart, and the optimizer makes that easy
 * to hit: every `discover --candidates` run is `1.0.0`, and two `cu optimize` runs with different
 * options both produce `x.y.(z+1)`. A replay of one must never be accepted as approval evidence
 * for another. The digest covers everything that changes what replay DOES, and leaves out the
 * three fields an approval itself rewrites -- `status`, `version` and `provenance` -- so the
 * replay of a draft still matches the same content after `cu approve` (or `replay --approve`)
 * changes those.
 *
 * Canonical JSON: object keys sorted by UTF-16 code unit order, members whose value is `undefined`
 * dropped (as JSON.stringify drops them), arrays kept in order, primitives as JSON.stringify writes
 * them. Defined once here; replay and approve both use it.
 */
import { createHash } from 'node:crypto';

/** Deterministic JSON text for a JSON-shaped value (see the module header). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** Fields an approval rewrites; excluded from the digest. */
export const DIGEST_EXCLUDED_FIELDS: readonly string[] = ['status', 'version', 'provenance'];

/** `sha256:<hex>` over the canonical JSON of `capability` without `status`, `version` and `provenance`. */
export function capabilityDigest(capability: unknown): string {
  const content: Record<string, unknown> = {};
  if (capability !== null && typeof capability === 'object' && !Array.isArray(capability)) {
    for (const [k, v] of Object.entries(capability as Record<string, unknown>)) {
      if (!DIGEST_EXCLUDED_FIELDS.includes(k)) content[k] = v;
    }
  }
  return `sha256:${createHash('sha256').update(canonicalJson(content)).digest('hex')}`;
}
