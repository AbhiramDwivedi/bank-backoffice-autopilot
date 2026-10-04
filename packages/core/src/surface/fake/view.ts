/**
 * Read-model helpers for `FakeSurface`: turning a `FakeElementSpec` into the `TargetDescriptor`
 * a real discovery agent would have recorded for it, turning a resolved element into the
 * `ObservedElement` shape `observe()` reports, and collapsing a screen's elements into the
 * text digest `observe()` and `text_visible`/`text_absent` both read. Pure functions of their
 * arguments; no `FakeSurface` instance state.
 */
import { REDACTED_VALUE, type FramePath, type Locator, type TargetDescriptor } from '../../schema/index.js';
import { collapseWhitespace } from '../conditions.js';
import type { ObservedElement } from '../types.js';
import { createMaskMatcher, maskObservedElement, maskPlaceholder, type MaskMatcher, type MaskedText } from '../mask.js';
import { DEFAULT_VIEWPORT, type FakeElementSpec, type FakeScreenSpec } from './scenario.js';
import { clamp01, framePathEquals, type RuntimeElement } from './match.js';

/** ARIA roles real enough to anchor a `role` locator. Synthetic roles like 'clickable' or
 * 'generic' (used for legacy divs/tds standing in for real controls) are deliberately excluded
 * -- a synthesized descriptor falls through to `label`/`text`/... for those. */
const REAL_ARIA_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'tab',
  'tabpanel',
  'heading',
  'cell',
  'row',
  'rowheader',
  'columnheader',
  'table',
  'grid',
  'img',
  'menuitem',
  'switch',
  'slider',
  'progressbar',
  'alert',
  'dialog',
  'list',
  'listitem',
]);

/** A `<td>`/`<th>`'s role is never "real" enough to anchor a `role` locator, matching production
 * (packages/browser-agent/src/naming.ts's `inferRole()`: `tag==='td'||'th' -> {role:'cell', real:false}`)
 * -- regardless of what synthetic/ARIA role string the scenario gives it (usually `'cell'`,
 * which is otherwise in `REAL_ARIA_ROLES` for genuinely real ARIA grid cells). */
function isRoleLocatorEligible(spec: FakeElementSpec): boolean {
  if (spec.tag === 'td' || spec.tag === 'th') return false;
  return REAL_ARIA_ROLES.has(spec.role);
}

/** Ordered: role+name (if the role is a real ARIA role and the name is non-empty), label,
 * text, relative same-row-right-of-its-anchor (if `row` is known and `rowAnchorText`/`label`
 * gives an anchor text), css (if any), and always finally a normalized bbox. Confidences
 * decrease down this list; every entry is `source: 'inferred'` (this is a live introspection,
 * not a recording). */
function synthesizeDescriptor(spec: FakeElementSpec, viewport = DEFAULT_VIEWPORT): TargetDescriptor {
  const locators: Locator[] = [];
  if (isRoleLocatorEligible(spec) && spec.name.trim() !== '') {
    locators.push({ strategy: { kind: 'role', role: spec.role, name: spec.name, exact: false }, confidence: 0.9, source: 'inferred' });
  }
  if (spec.label !== undefined) {
    locators.push({ strategy: { kind: 'label', label: spec.label, exact: false }, confidence: 0.78, source: 'inferred' });
  }
  if (spec.text !== undefined) {
    locators.push({ strategy: { kind: 'text', text: spec.text, exact: false, tag: spec.tag }, confidence: 0.65, source: 'inferred' });
  }
  const rowAnchor = spec.rowAnchorText ?? spec.label;
  if (spec.row !== undefined && rowAnchor !== undefined) {
    locators.push({
      strategy: { kind: 'relative', anchor: { text: rowAnchor }, relation: 'right-of' },
      confidence: 0.5,
      source: 'inferred',
    });
  }
  if (spec.css !== undefined && spec.css.length > 0) {
    locators.push({ strategy: { kind: 'css', selector: spec.css[0]! }, confidence: 0.32, source: 'inferred' });
  }
  locators.push({
    strategy: {
      kind: 'bbox',
      x: clamp01(spec.bbox.x / viewport.width),
      y: clamp01(spec.bbox.y / viewport.height),
      w: clamp01(spec.bbox.w / viewport.width),
      h: clamp01(spec.bbox.h / viewport.height),
    },
    confidence: 0.12,
    source: 'inferred',
  });
  return {
    description: `${spec.role} "${spec.name || spec.text || spec.label || spec.id}" (<${spec.tag}>)`,
    frame: spec.frame ?? [],
    locators,
    snapshot: { tag: spec.tag, role: spec.role, name: spec.name, text: spec.text },
  };
}

/** `observe()`'s per-element view: role/name/text/value (redacted for password fields) plus a
 * freshly synthesized descriptor, for a resolved `RuntimeElement`. `values` is the surface's
 * live values store (by element id), read here in preference to the spec's static `value`. */
export function toObservedElement(entry: RuntimeElement, values: Readonly<Record<string, string>>, viewport = DEFAULT_VIEWPORT): ObservedElement {
  const { ref, spec } = entry;
  const raw = values[spec.id] ?? spec.value;
  const value = raw === undefined ? undefined : spec.inputType === 'password' ? REDACTED_VALUE : raw;
  return {
    ref,
    role: spec.role,
    name: spec.name,
    text: spec.text,
    tag: spec.tag,
    value,
    bbox: spec.bbox,
    frame: spec.frame ?? [],
    enabled: spec.enabled ?? true,
    descriptor: synthesizeDescriptor(spec, viewport),
  };
}

/** `textDigest` = whitespace-collapsed `screen.text` (top document only) plus every visible
 * element's `text` (falling back to `name` when there's no separate visible text), in
 * document order, restricted to `scope` when it isn't `'all'`. Shared by `observe()` and by
 * the `ConditionView` used for `text_visible`/`text_absent`. */
export function computeTextDigest(screen: FakeScreenSpec, elements: RuntimeElement[], scope: 'all' | FramePath): string | undefined {
  if (scope !== 'all') {
    const known = scope.length === 0 || (screen.frames ?? []).some((f) => framePathEquals(f.path, scope));
    if (!known) return undefined;
  }
  const parts: string[] = [];
  if (scope === 'all' || scope.length === 0) parts.push(...(screen.text ?? []));
  for (const { spec } of elements) {
    if (spec.hidden === true) continue;
    const elFrame = spec.frame ?? [];
    if (scope !== 'all' && !framePathEquals(elFrame, scope)) continue;
    const t = spec.text ?? spec.name;
    if (t) parts.push(t);
  }
  return collapseWhitespace(parts.join(' '));
}

/** The kind a masked spec is reported under (`masked: true` -> 'masked'), or undefined when it is not masked. */
export function maskKindOf(spec: FakeElementSpec): string | undefined {
  if (spec.masked === undefined) return undefined;
  return spec.masked === true ? 'masked' : spec.masked;
}

const FIELD_TAGS: ReadonlySet<string> = new Set(['input', 'textarea', 'select']);

/** A matcher over the text of every masked, non-field element of `elements` (field values are masked per element, never elsewhere). */
export function screenMaskMatcher(elements: readonly RuntimeElement[]): MaskMatcher {
  const texts: MaskedText[] = [];
  for (const { spec } of elements) {
    const kind = maskKindOf(spec);
    if (kind === undefined || FIELD_TAGS.has(spec.tag)) continue;
    if (spec.text !== undefined) texts.push({ text: spec.text, kind });
    else if (spec.name !== '') texts.push({ text: spec.name, kind });
  }
  return createMaskMatcher(texts);
}

/** `toObservedElement`, then the screen-mask text view of it (see surface/mask.ts). */
export function toMaskedObservedElement(entry: RuntimeElement, values: Readonly<Record<string, string>>, matcher: MaskMatcher, viewport = DEFAULT_VIEWPORT): ObservedElement {
  return maskObservedElement(toObservedElement(entry, values, viewport), matcher, maskKindOf(entry.spec));
}

/** A masked spec's placeholder, for `describeRef`/`domSnapshot`. */
export function maskedPlaceholderFor(spec: FakeElementSpec): string | undefined {
  const kind = maskKindOf(spec);
  return kind === undefined ? undefined : maskPlaceholder(kind);
}
