import { z } from 'zod';
import { NonEmpty } from './common.js';

const unit = z.number().min(0).max(1);

/** One way to find a control. Ordered from most to least stable in a TargetDescriptor. */
export const LocatorStrategy = z.discriminatedUnion('kind', [
  /** ARIA role + accessible name. */
  z.strictObject({ kind: z.literal('role'), role: NonEmpty, name: z.string(), exact: z.boolean().optional() }),
  /** Control associated with label text; includes adjacent-cell heuristic for legacy tables. */
  z.strictObject({ kind: z.literal('label'), label: NonEmpty, exact: z.boolean().optional() }),
  /** Visible text anchor (clickable rows, span tabs, div buttons). `wholeWord` (with a contains
   *  match): the text must appear as a whole token, case-sensitively, so "Lee" never matches
   *  "Leeson" nor "lee"; the recorder sets it on a run input narrowed out of a longer text. */
  z.strictObject({ kind: z.literal('text'), text: NonEmpty, exact: z.boolean().optional(), tag: z.string().optional(), wholeWord: z.boolean().optional() }),
  /**
   * The element nearest to an anchor text along a relation, among candidates matching `tag`,
   * `role` and, when given, the CSS `selector` (e.g. `div.price`: tells a card's price apart from
   * its description) and lying inside the anchor's nearest ancestor matching `within` (the record's
   * container, e.g. `div.card`). `anchor.exact` accepts only an element whose whole text equals the
   * anchor text (case-sensitive, whitespace-collapsed), never a containing one; the recorder sets
   * it on every anchor bound to a run input. A surface without CSS treats `selector`/`within` as a
   * miss. `anchor.wholeWord`: a contains match on the anchor text must find it as a whole token,
   * case-sensitively ("Lee" never anchors on "Bo Leeson" nor "lee"; it does on "Lee Wong").
   * `anchor.selector`: the anchor element, or an ancestor of it, must match this CSS selector
   * (`td:nth-child(1)`: the anchor is looked up in one column only); a surface without CSS treats
   * it as a miss. All are optional; without them the strategy behaves as it always has.
   */
  z.strictObject({
    kind: z.literal('relative'),
    anchor: z.strictObject({ text: NonEmpty, exact: z.boolean().optional(), wholeWord: z.boolean().optional(), selector: NonEmpty.optional() }),
    relation: z.enum(['right-of', 'below', 'left-of', 'above', 'same-row']),
    role: z.string().optional(),
    tag: z.string().optional(),
    selector: NonEmpty.optional(),
    within: NonEmpty.optional(),
  }),
  /** Permitted, low confidence; for legacy quirks. */
  z.strictObject({ kind: z.literal('css'), selector: NonEmpty }),
  /** Normalized 0..1 within the frame viewport; last resort. */
  z.strictObject({ kind: z.literal('bbox'), x: unit, y: unit, w: unit, h: unit }),
  /**
   * A developer-assigned automation identifier: UI Automation's AutomationId on Windows (macOS
   * would map it to AXIdentifier). Exact, case-sensitive. Native toolkits only: a web surface has
   * no equivalent and treats it as a miss, so the chain falls through to the next locator.
   */
  z.strictObject({ kind: z.literal('automation_id'), id: NonEmpty }),
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategy>;
/** The `kind` discriminator values of {@link LocatorStrategy}. */
export type LocatorStrategyKind = LocatorStrategy['kind'];
export const LocatorStrategyKind = z.enum(['role', 'label', 'text', 'relative', 'css', 'bbox', 'automation_id']);
/** `LocatorStrategyKind`'s options, in declaration order. */
export const LOCATOR_STRATEGY_KINDS: readonly LocatorStrategyKind[] = LocatorStrategyKind.options;

/** One locator strategy paired with the recorder's confidence and how it was produced. */
export const Locator = z.strictObject({
  strategy: LocatorStrategy,
  /** 0..1, recorder's estimate of stability. */
  confidence: unit,
  source: z.enum(['recorded', 'inferred', 'human']),
});
export type Locator = z.infer<typeof Locator>;

/** One hop from the top document towards the frame holding the element. */
export const FrameHop = z
  .strictObject({ name: z.string().optional(), urlPattern: z.string().optional(), index: z.number().int().min(0).optional() })
  .refine((h) => h.name !== undefined || h.urlPattern !== undefined || h.index !== undefined, {
    message: 'a frame hop needs at least one of name, urlPattern, index',
  });
export type FrameHop = z.infer<typeof FrameHop>;

/** [] = top document. */
export const FramePath = z.array(FrameHop);
export type FramePath = z.infer<typeof FramePath>;

/** Everything needed to find one element at replay time: a human-readable description, a frame
 * path, an ordered fallback chain of locators, and an optional record-time snapshot for drift
 * diagnostics. */
export const TargetDescriptor = z
  .strictObject({
    /** Human readable: "Member ID text field on the search form". */
    description: NonEmpty,
    frame: FramePath,
    /** Ordered; replay tries in order. */
    locators: z.array(Locator).min(1),
    /** What it looked like at record time; for drift diagnostics only. */
    snapshot: z
      .strictObject({ tag: z.string().optional(), role: z.string().optional(), name: z.string().optional(), text: z.string().optional() })
      .optional(),
  })
  .meta({ id: 'TargetDescriptor' });
export type TargetDescriptor = z.infer<typeof TargetDescriptor>;
