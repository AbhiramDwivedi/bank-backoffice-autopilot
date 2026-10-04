import { z } from 'zod';

/** Semantic Versioning 2.0.0 (https://semver.org), no leading "v". */
export const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Stable capability id: lowercase kebab-case. */
export const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Input/output names are identifiers so they can appear in `{input.name}` URL templates. */
export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** ISO 8601 datetime string with an explicit offset (e.g. "2024-01-01T00:00:00Z"). */
export const IsoDateTime = z.iso.datetime({ offset: true });
/** A string that must contain at least one character. */
export const NonEmpty = z.string().min(1);
/** A JS-identifier-shaped string, matching {@link IDENT_RE}. */
export const Identifier = z.string().regex(IDENT_RE, 'must be an identifier ([A-Za-z_][A-Za-z0-9_]*)');

/** Scalar value returned to callers in outputs / business-outcome data. */
export const Scalar = z.union([z.string(), z.number(), z.boolean()]);
export type Scalar = z.infer<typeof Scalar>;
