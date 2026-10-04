/**
 * The element cap, shared by the in-page `enumerate({ maxElements })` and the driver's cross-frame
 * cap, so the two always agree on what is kept. Pure: no DOM, no Node.
 *
 * Without a reserve, a page with more controls than the cap lists no text at all: on a 200-card
 * product list the 400 links and buttons fill 150 slots and not one price is listed. So:
 *  1. a third of the cap (or every text leaf, when there are fewer) is held for text leaves;
 *  2. the rest goes to interactive entries, then informative ones;
 *  3. whatever the first two leave unused goes to more text leaves.
 * Within a tier, entries inside the viewport (what the model's screenshot shows) come first, then
 * text leaves by priority, then document order. The kept entries are returned in input order.
 *
 * Applying it per frame and then across frames keeps exactly what one global pass would keep for
 * the interactive and informative tiers, and never drops a text leaf the global pass would keep:
 * an entry dropped in its own frame has at least as many better entries ahead of it there as the
 * global pass would leave room for.
 */

/** Share of the cap held for text leaves. */
export const TEXT_SHARE = 1 / 3;

/** What the cap needs to know about one entry. */
export interface CapEntry {
  group: 'interactive' | 'informative' | 'text';
  /** Text leaves only; 0 is kept first. */
  priority: number;
  inViewport: boolean;
}

/** Indices (ascending, i.e. input order) of the entries `max` keeps. */
export function selectForCap(entries: readonly CapEntry[], max: number): number[] {
  const cap = Math.max(0, Math.floor(max));
  const idx = entries.map((_, i) => i);
  if (entries.length <= cap) return idx;
  const textIdx = idx.filter((i) => entries[i]!.group === 'text');
  const otherIdx = idx.filter((i) => entries[i]!.group !== 'text');
  const reserve = Math.min(textIdx.length, Math.ceil(cap * TEXT_SHARE));
  const vp = (i: number): number => (entries[i]!.inViewport ? 0 : 1);
  const groupRank = (i: number): number => (entries[i]!.group === 'interactive' ? 0 : 1);
  otherIdx.sort((a, b) => groupRank(a) - groupRank(b) || vp(a) - vp(b) || a - b);
  textIdx.sort((a, b) => vp(a) - vp(b) || entries[a]!.priority - entries[b]!.priority || a - b);
  const others = otherIdx.slice(0, Math.max(0, cap - reserve));
  const texts = textIdx.slice(0, cap - others.length);
  return [...others, ...texts].sort((a, b) => a - b);
}
