/**
 * Descriptor synthesis for desktop elements: the fallback chain recorded for every element
 * `observe()` reports, most stable first.
 *
 *   automation_id  0.95  a developer-assigned AutomationId (never a window handle the toolkit made up)
 *   role           0.9   role + UIA Name, only when the name is the control's own (see tree.ts)
 *   label          0.8   LabeledBy, else the static text to the left / above
 *   text           0.7   visible text of a non-value control (button caption, static text)
 *   relative       0.5   right of (or below) the label static
 *   bbox           0.1   position in the window, last resort
 *
 * Every candidate locator is checked against the view it was synthesized from and kept only if it
 * resolves to exactly this element, so a freshly recorded artifact replays at fallback depth 0 on
 * the screen it was recorded on (the web adapter's self-consistency guarantee, enforced here by
 * construction). The bbox locator is kept even when it does not pass that check, because the
 * schema needs at least one locator; it is last, so it only fires when nothing else does.
 */
import type { Locator, LocatorStrategy, TargetDescriptor } from '@cu/core/schema';
import { CT } from './protocol.js';
import { maskFrame, MaskedStrings } from './mask.js';
import { candidatesFor, poolFor } from './resolve.js';
import type { DesktopNode, DesktopView } from './tree.js';

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Roles whose UIA name is a meaningful role-locator name when it is the control's own. */
const ROLE_LOCATOR_TYPES: ReadonlySet<number> = new Set([
  CT.Button, CT.CheckBox, CT.RadioButton, CT.MenuItem, CT.TabItem, CT.Hyperlink, CT.ListItem, CT.TreeItem,
  CT.SplitButton, CT.Edit, CT.ComboBox, CT.Spinner, CT.Slider, CT.Document, CT.DataItem,
]);
/** Value controls: never get a text locator (their visible text is the value, which drifts and may be sensitive). */
const VALUE_TYPES: ReadonlySet<number> = new Set([CT.Edit, CT.ComboBox, CT.Spinner, CT.Document, CT.Slider]);

/** Every string field of a strategy (names, labels, texts, anchors, ids, selectors). */
function strategyStrings(s: LocatorStrategy): string[] {
  return Object.values(s).flatMap((v) => (typeof v === 'string' ? [v] : v !== null && typeof v === 'object' ? Object.values(v).filter((x): x is string => typeof x === 'string') : []));
}

/**
 * Builds the fallback chain for `node` as of `view`. `masked` holds the strings the surface's mask
 * hides: a locator mentioning one is never built (it would record the value into the artifact), so
 * a masked element is found by its AutomationId, label, relative position or bbox instead, and the
 * description and snapshot carry the placeholder.
 */
export function synthesizeDescriptor(view: DesktopView, node: DesktopNode, masked: MaskedStrings = new MaskedStrings([])): TargetDescriptor {
  // A frame hop named by a masked title is recorded without the name; the pool it matches (every
  // frame at that depth) is what each locator must be unique in.
  const frame = maskFrame(node.frame, masked);
  const pool = poolFor(view, frame);
  const unique = (s: LocatorStrategy): boolean => {
    const c = candidatesFor(view, pool, s);
    return Array.isArray(c) && c.length === 1 && c[0] === node;
  };
  const locators: Locator[] = [];
  const add = (strategy: LocatorStrategy, confidence: number): void => {
    if (strategyStrings(strategy).some((s) => masked.mentions(s))) return;
    if (unique(strategy)) locators.push({ strategy, confidence, source: 'inferred' });
  };

  if (node.automationId !== undefined) add({ kind: 'automation_id', id: node.automationId }, 0.95);
  if (ROLE_LOCATOR_TYPES.has(node.ct) && node.genuineName && !node.password) {
    add({ kind: 'role', role: node.role, name: node.uiaName.trim(), exact: true }, 0.9);
  }
  if (node.label !== undefined && node.ct !== CT.Text) add({ kind: 'label', label: node.label, exact: true }, 0.8);
  if (!VALUE_TYPES.has(node.ct) && node.text !== undefined && node.text.length <= 80) {
    add({ kind: 'text', text: node.text, exact: true, tag: node.tag }, 0.7);
  }
  if (node.label !== undefined && node.labelRid !== undefined) {
    const anchor = view.nodes.find((n) => n.rid === node.labelRid);
    if (anchor) {
      const relation = anchor.bbox.x + anchor.bbox.w <= node.bbox.x + 2 ? 'right-of' : 'below';
      add({ kind: 'relative', anchor: { text: anchor.name }, relation, role: node.role }, 0.5);
    }
  }
  const bbox: LocatorStrategy = {
    kind: 'bbox',
    x: clamp01(node.bbox.x / view.viewport.width),
    y: clamp01(node.bbox.y / view.viewport.height),
    w: clamp01(node.bbox.w / view.viewport.width),
    h: clamp01(node.bbox.h / view.viewport.height),
  };
  locators.push({ strategy: bbox, confidence: 0.1, source: 'inferred' });

  const shown = node.name || node.text || node.label || node.tag;
  return masked.scrubDeep({
    description: `${node.role} "${shown}" (${node.tag})`,
    frame,
    locators,
    snapshot: {
      tag: node.tag,
      role: node.role,
      name: node.name,
      ...(node.text !== undefined && !VALUE_TYPES.has(node.ct) ? { text: node.text } : {}),
    },
  });
}
