/**
 * The record text of a desktop element, for a record identity check on a read
 * (`Surface.readRecordText`). The same shape as the browser's: the record container is the
 * smallest ancestor, within six levels and 60 elements, that groups the element with at least two
 * other text blocks (a panel, a group box, a grid); an element with none gets the text of its whole
 * window, with `scope: 'page'`.
 *
 * What counts as text is what a person reads: the visible text of the controls under the
 * container, never a password and never an editable field's value (a search box holding the very
 * value the run typed would show the input everywhere). A read-only field's value counts: that is
 * where such an app shows a record's data. Pure over a view: no bridge, no I/O.
 */
import { collapseWhitespace, type RecordTextWithin } from '@cu/core/surface';
import type { DesktopNode, DesktopView } from './tree.js';

const MAX_CONTAINER_NODES = 60;
const MAX_DEPTH = 6;
const HAS_WORD = /[\p{L}\p{N}]/u;
/** Roles of controls that hold a value a person edits: Edit, ComboBox, Spinner, Document, Slider. */
const EDITABLE_ROLES: ReadonlySet<string> = new Set(['textbox', 'combobox', 'spinbutton', 'document', 'slider']);

/** What a person reads on the node, or '' (invisible, a password, an editable value). */
function shownText(n: DesktopNode): string {
  if (!n.visible || n.password) return '';
  if (EDITABLE_ROLES.has(n.role) && !n.readOnly) return '';
  return collapseWhitespace(n.text ?? n.name ?? '');
}

/** Record text of `node`; see the file header. */
export function recordTextOf(view: DesktopView, node: DesktopNode, within: RecordTextWithin): { scope: RecordTextWithin; text: string } {
  const nodes = view.nodes;
  const children = new Map<number, number[]>();
  nodes.forEach((n, i) => {
    const list = children.get(n.parent);
    if (list) list.push(i);
    else children.set(n.parent, [i]);
  });
  const subtree = (root: number): number[] => {
    const out: number[] = [];
    const stack = [root];
    while (stack.length > 0 && out.length <= MAX_CONTAINER_NODES) {
      const i = stack.pop()!;
      out.push(i);
      for (const c of children.get(i) ?? []) stack.push(c);
    }
    return out;
  };
  if (within === 'container') {
    const self = nodes.indexOf(node);
    const below = new Set(self >= 0 ? subtree(self) : []);
    const ancestors = new Set<number>();
    for (let a = node.parent; a >= 0; a = nodes[a]!.parent) ancestors.add(a);
    let anc = node.parent;
    for (let depth = 0; anc >= 0 && depth < MAX_DEPTH; depth++, anc = nodes[anc]!.parent) {
      const members = subtree(anc);
      if (members.length > MAX_CONTAINER_NODES) break;
      const blocks = members.filter(
        (i) => i !== self && !below.has(i) && !ancestors.has(i) && (children.get(i) ?? []).length === 0 && HAS_WORD.test(shownText(nodes[i]!)),
      ).length;
      if (blocks >= 2) {
        const text = members.map((i) => shownText(nodes[i]!)).filter((t) => t !== '').join(' ');
        return { scope: 'container', text: collapseWhitespace(text) };
      }
    }
  }
  const text = nodes.filter((n) => n.hwnd === node.hwnd).map(shownText).filter((t) => t !== '').join(' ');
  return { scope: 'page', text: collapseWhitespace(text) };
}
