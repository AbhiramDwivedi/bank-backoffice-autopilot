/**
 * Validates and coerces raw invocation inputs against a capability's declared InputSpecs.
 * Pure and synchronous.
 */
import type { InputSpec } from '../schema/index.js';
import type { InputValidationResult, InputValue } from './types.js';

/** Builds a `problem` string, honoring `sensitive` (never includes the raw value when true). */
function problem(spec: InputSpec | undefined, name: string, tail: string, rawValue?: unknown): string {
  const sensitive = spec?.sensitive ?? false;
  if (sensitive || rawValue === undefined) {
    return `input "${name}" ${tail}`;
  }
  return `input "${name}" value ${JSON.stringify(rawValue)} ${tail}`;
}

/**
 * Checks in deterministic order: `Object.keys(specs)` first (required/type/pattern per input),
 * then undeclared keys present in `raw`. Returns the first failure found.
 */
export function validateInputs(specs: Record<string, InputSpec>, raw: Record<string, unknown>): InputValidationResult {
  // A null-prototype object, not `{}`: `values` is populated by assigning through a *declared
  // input name*, which -- per the schema's Identifier regex (`[A-Za-z_][A-Za-z0-9_]*`) -- legally
  // includes names like "__proto__". `{}`'s inherited `Object.prototype.__proto__` accessor would
  // silently swallow `values['__proto__'] = <primitive>` as a no-op (the setter only accepts an
  // object/null), so that input's coerced value would vanish from `values` without any error,
  // even though validation otherwise reported success. A null-prototype object has no such
  // accessor, so the assignment always creates a normal own data property. See
  // `validate-inputs.redteam.test.ts` ("__proto__" as a declared input name).
  const values: Record<string, InputValue> = Object.create(null) as Record<string, InputValue>;

  for (const name of Object.keys(specs)) {
    const spec = specs[name]!;
    const present = Object.prototype.hasOwnProperty.call(raw, name);
    const rawValue = raw[name];
    const isEmpty = !present || rawValue === undefined || rawValue === null || rawValue === '';

    if (isEmpty) {
      if (spec.required) {
        return { ok: false, input: name, problem: `input "${name}" is required` };
      }
      continue; // optional and missing: omitted from values
    }

    let coerced: InputValue;
    if (spec.type === 'string') {
      if (typeof rawValue === 'string') {
        coerced = rawValue;
      } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
        coerced = String(rawValue);
      } else {
        return { ok: false, input: name, problem: problem(spec, name, 'expected string', rawValue) };
      }
    } else if (spec.type === 'number') {
      if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
        coerced = rawValue;
      } else if (typeof rawValue === 'string' && rawValue.trim() !== '' && Number.isFinite(Number(rawValue.trim()))) {
        coerced = Number(rawValue.trim());
      } else {
        return { ok: false, input: name, problem: problem(spec, name, 'expected number', rawValue) };
      }
    } else if (spec.type === 'boolean') {
      if (typeof rawValue === 'boolean') {
        coerced = rawValue;
      } else if (rawValue === 'true') {
        coerced = true;
      } else if (rawValue === 'false') {
        coerced = false;
      } else {
        return { ok: false, input: name, problem: problem(spec, name, 'expected boolean', rawValue) };
      }
    } else {
      return { ok: false, input: name, problem: `input "${name}" has an unrecognized type` };
    }

    if (spec.pattern !== undefined) {
      // Defense in depth: `validateCapability` already rejects a non-compiling `InputSpec.pattern`
      // at artifact-load time, so this should be unreachable via `replayCapability`'s normal path
      // (which always validates first) -- but `validateInputs` is itself exported and callable
      // directly (as this file's own tests do), so it must not let a bad pattern become an
      // uncaught SyntaxError; it becomes the same kind of structured `input_validation` failure
      // as any other bad input.
      let re: RegExp;
      try {
        re = new RegExp(spec.pattern);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false, input: name, problem: `input "${name}" has an invalid pattern (author error, not caller error): ${reason}` };
      }
      if (!re.test(String(coerced))) {
        return { ok: false, input: name, problem: problem(spec, name, `does not match pattern ${spec.pattern}`, coerced) };
      }
    }

    values[name] = coerced;
  }

  for (const key of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(specs, key)) {
      return { ok: false, input: key, problem: `input "${key}" is not declared by this capability` };
    }
  }

  return { ok: true, values };
}
