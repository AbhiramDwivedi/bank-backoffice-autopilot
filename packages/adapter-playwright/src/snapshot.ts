/**
 * domSnapshot(): outerHTML of every frame, with `<!-- frame: path url -->` markers, password
 * values and every `value` attribute blanked, scripts and event handlers stripped, truncated at
 * 500KB.
 *
 * A snapshot is written to evidence as HTML, so opening it from disk must not run the target
 * page's JavaScript or send the viewer anywhere. Three layers ensure that: the in-page serializer
 * drops `<script>` elements, `on*` handler attributes and `javascript:` URLs; the output starts
 * with a Content-Security-Policy `<meta>` that forbids every script, frame, remote fetch, `<base>`
 * URL and form submission (only inline styles and `data:` images render); and a Node-side pass
 * (`stripActiveTags`) removes every `<base>` tag and every `<meta http-equiv>` tag, since a CSP
 * cannot stop a meta refresh. The in-page serializer runs in the page's own world, where a hostile
 * page can patch the DOM APIs it uses, so the last two layers are applied outside the page.
 *
 * Screen masking (docs/design/screen-masking.md): with a mask plan, the snapshot gets the same
 * masks as the screenshot. In the clone, every element the plan marked has its content replaced by
 * `[MASKED:<kind>]` (a masked select also loses its `selected` option), the marks and any overlay
 * are removed; then, Node-side, every text the plan masked is replaced wherever else it appears in
 * text, comments or attribute values (`scrubMarkup`). A frame the plan could not cover is written
 * as an "unavailable" marker with none of its DOM (fail closed).
 */
import type { Frame, Page } from 'playwright';
import { scrubMarkup, type ValueScrubber } from '@cu/core/evidence';
import type { MaskMatcher } from '@cu/core/surface';
import { framePathKey, listFrames } from './frames.js';

export const MAX_SNAPSHOT_BYTES = 500 * 1024;

const TRUNCATED_MARKER = '<!-- truncated -->';

/** First line of every snapshot. As the first element of the document it lands in <head>, where a CSP meta applies. */
export const SNAPSHOT_CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`;

/** Start of a `<meta>` or `<base>` start tag: the name followed by what ends a tag name in the HTML tokenizer (or the end of input). */
const ACTIVE_TAG_START = /<(meta|base)(?=[\t\n\f\r />]|$)/gi;

/** Passes of tag removal before falling back to escaping every remaining tag start (see stripActiveTags). */
const MAX_STRIP_PASSES = 8;

const isTagSpace = (c: string): boolean => c === '\t' || c === '\n' || c === '\f' || c === '\r' || c === ' ';

/**
 * Scans one start tag from just after its tag name, following the HTML tokenizer's attribute
 * states (quoted and unquoted values, `/`, a `>` inside quotes), and returns the index just past
 * its closing `>` (the input length when it never closes) plus its attribute names, ASCII
 * lowercased as the parser stores them.
 */
function scanStartTag(html: string, from: number): { end: number; attrNames: string[] } {
  type State = 'before' | 'name' | 'after' | 'beforeValue' | 'dq' | 'sq' | 'unquoted' | 'afterQuoted' | 'selfClosing';
  const attrNames: string[] = [];
  let name = '';
  let state: State = 'before';
  const endName = (): void => {
    attrNames.push(name.replace(/[A-Z]+/g, (s) => s.toLowerCase()));
    name = '';
  };
  let i = from;
  while (i < html.length) {
    const c = html[i]!;
    switch (state) {
      case 'before':
        if (isTagSpace(c)) break;
        if (c === '/') state = 'selfClosing';
        else if (c === '>') return { end: i + 1, attrNames };
        else {
          state = 'name';
          name = c;
        }
        break;
      case 'name':
        if (isTagSpace(c)) {
          endName();
          state = 'after';
        } else if (c === '/') {
          endName();
          state = 'selfClosing';
        } else if (c === '>') {
          endName();
          return { end: i + 1, attrNames };
        } else if (c === '=') {
          endName();
          state = 'beforeValue';
        } else name += c;
        break;
      case 'after':
        if (isTagSpace(c)) break;
        if (c === '/') state = 'selfClosing';
        else if (c === '=') state = 'beforeValue';
        else if (c === '>') return { end: i + 1, attrNames };
        else {
          state = 'name';
          name = c;
        }
        break;
      case 'beforeValue':
        if (isTagSpace(c)) break;
        if (c === '"') state = 'dq';
        else if (c === "'") state = 'sq';
        else if (c === '>') return { end: i + 1, attrNames };
        else state = 'unquoted';
        break;
      case 'dq':
        if (c === '"') state = 'afterQuoted';
        break;
      case 'sq':
        if (c === "'") state = 'afterQuoted';
        break;
      case 'unquoted':
        if (isTagSpace(c)) state = 'before';
        else if (c === '>') return { end: i + 1, attrNames };
        break;
      case 'afterQuoted':
      case 'selfClosing':
        if (c === '>') return { end: i + 1, attrNames };
        if (isTagSpace(c) || (c === '/' && state === 'afterQuoted')) {
          state = c === '/' ? 'selfClosing' : 'before';
          break;
        }
        state = 'before';
        continue; // reconsume in the before-attribute-name state
    }
    i++;
  }
  if (state === 'name') endName();
  return { end: html.length, attrNames };
}

/**
 * Removes every `<base>` tag and every `<meta>` tag with an `http-equiv` attribute (a refresh, a
 * competing CSP, ...) from serialized HTML. A CSP cannot forbid a meta refresh, and the in-page
 * serializer runs where the page can tamper with it, so this runs Node-side on the final text.
 * Tags are found by case-insensitive name and scanned as the HTML tokenizer would, so quoting,
 * case and a `>` inside a quoted value cannot hide one. Every occurrence is examined, including
 * ones inside comments or attribute values (removing those is harmless). Removal repeats until
 * nothing changes, so deleting one tag cannot splice a new one together from the text around it;
 * past MAX_STRIP_PASSES every remaining `<meta`/`<base` start is escaped to `&lt;` instead, which
 * deletes nothing and so cannot splice anything.
 */
export function stripActiveTags(html: string): string {
  let out = html;
  for (let pass = 0; pass < MAX_STRIP_PASSES; pass++) {
    let kept = '';
    let last = 0;
    let changed = false;
    ACTIVE_TAG_START.lastIndex = 0;
    for (let m = ACTIVE_TAG_START.exec(out); m; m = ACTIVE_TAG_START.exec(out)) {
      const tag = scanStartTag(out, m.index + m[0].length);
      if (m[1]!.toLowerCase() === 'base' || tag.attrNames.includes('http-equiv')) {
        kept += out.slice(last, m.index);
        last = tag.end;
        changed = true;
        ACTIVE_TAG_START.lastIndex = tag.end;
      }
    }
    if (!changed) return out;
    out = kept + out.slice(last);
  }
  return out.replace(ACTIVE_TAG_START, (s) => `&lt;${s.slice(1)}`);
}

/**
 * Runs in-page. Clones `document.documentElement` (the live DOM is never touched), blanks every
 * `value` attribute on `input`/`option` elements (covers password fields and anything else a
 * server may have re-rendered with a stale value), clears every `textarea`'s contents (a
 * textarea's value lives in its child text, not an attribute), and blanks every `srcdoc`
 * attribute on an `iframe` (see below). It then removes every `<script>` element, every
 * `<meta http-equiv="refresh">`, every `on*` event-handler attribute, and every URL attribute
 * (`href`, `src`, `action`, `formaction`, `xlink:href`) holding a `javascript:` URL, and returns
 * the clone's outerHTML.
 *
 * A `srcdoc` iframe's entire nested document markup is itself an HTML content attribute on the
 * `<iframe>` element, including any server-rendered `value="..."` a password field in that nested
 * document was given. `listFrames()` (frames.ts) walks into a srcdoc frame and captures and blanks
 * its own document correctly, but that's a separate capture: the parent frame's own outerHTML
 * still embeds the raw, unblanked nested markup verbatim inside the `srcdoc="..."` attribute
 * string, which would defeat the input-blanking above for anything nested under a srcdoc iframe.
 * Blanking `srcdoc` here closes that gap; the nested frame's own section of the snapshot still
 * shows its blanked content.
 *
 * This is a plain JS string, not a TS function passed to `evaluate`: esbuild can inject helpers
 * (e.g. `__name`) into a serialized function's source that don't exist in the page.
 */
const SERIALIZE_JS = `
(function (m) {
  // With a mask plan, the agent's masked copy (marked elements and hidden text ranges replaced by
  // placeholders, marks removed); without it, a plain copy. A plan that is gone fails the frame.
  var root;
  if (m) {
    var lib = window.__cuAgent && window.__cuAgent.lib;
    root = lib && lib.maskClone ? lib.maskClone(m.nonce) : null;
    if (!root) throw new Error('mask plan unavailable');
  } else {
    root = document.documentElement.cloneNode(true);
  }
  var valued = root.querySelectorAll('input, option');
  for (var i = 0; i < valued.length; i++) {
    if (valued[i].hasAttribute('value')) valued[i].removeAttribute('value');
  }
  var textareas = root.querySelectorAll('textarea');
  for (var j = 0; j < textareas.length; j++) {
    textareas[j].textContent = '';
  }
  var srcdocFrames = root.querySelectorAll('iframe[srcdoc]');
  for (var k = 0; k < srcdocFrames.length; k++) {
    srcdocFrames[k].setAttribute('srcdoc', '[omitted by domSnapshot: see this frame\\'s own captured section]');
  }
  var removable = root.querySelectorAll('script, meta[http-equiv]');
  for (var r = 0; r < removable.length; r++) {
    var node = removable[r];
    if (node.tagName.toLowerCase() === 'meta' && String(node.getAttribute('http-equiv')).toLowerCase() !== 'refresh') continue;
    if (node.parentNode) node.parentNode.removeChild(node);
  }
  var urlAttrs = { href: true, src: true, action: true, formaction: true, 'xlink:href': true };
  var all = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));
  for (var e = 0; e < all.length; e++) {
    var attrs = all[e].attributes;
    for (var a = attrs.length - 1; a >= 0; a--) {
      var name = attrs[a].name.toLowerCase();
      var drop = name.slice(0, 2) === 'on';
      if (!drop && urlAttrs[name] === true) {
        drop = /^javascript:/i.test(String(attrs[a].value).replace(/[\\u0000-\\u0020]/g, ''));
      }
      if (drop) all[e].removeAttribute(attrs[a].name);
    }
  }
  return root.outerHTML;
})
`;

/** Truncates `s` to at most `maxBytes` UTF-8 bytes (best-effort at a multi-byte boundary). */
function truncateToBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf-8');
  if (buf.byteLength <= maxBytes) return s;
  return buf.subarray(0, Math.max(0, maxBytes)).toString('utf-8');
}

/** The screen-mask plan a snapshot applies (see the module header). */
export interface SnapshotMask {
  nonce: string;
  /** Frames the plan did not cover (could not plan, or attached since): written as an unavailable marker. */
  skipFrame: (frame: Frame) => boolean;
  /**
   * The plan's matcher, applied Node-side to text, comments and attribute values only: catches
   * what the in-page copy cannot (an SSN shape in an `alt` or `data-*` attribute, a run value).
   */
  patterns: MaskMatcher;
}

/** Captures every frame's DOM as inert HTML text (see the module header), blanking sensitive values and truncating oversized output. */
export async function snapshotDom(page: Page, mask?: SnapshotMask): Promise<string> {
  const frames = listFrames(page);
  const parts: string[] = [];
  const arg = mask ? JSON.stringify({ nonce: mask.nonce }) : 'null';
  const scrubber: Pick<ValueScrubber, 'text'> | undefined = mask ? { text: (t: string) => mask.patterns.replace(t) } : undefined;
  for (const f of frames) {
    const key = framePathKey(f.path);
    if (mask?.skipFrame(f.frame)) {
      parts.push(`<!-- frame: ${key} ${f.url} unavailable: the screen mask could not be computed -->`);
      continue;
    }
    try {
      const html = String(await f.frame.evaluate(`${SERIALIZE_JS}(${arg})`));
      parts.push(`<!-- frame: ${key} ${f.url} -->\n${scrubber ? scrubMarkup(html, scrubber as ValueScrubber) : html}`);
    } catch {
      parts.push(`<!-- frame: ${key} ${f.url} unavailable -->`);
    }
  }
  const head = `${SNAPSHOT_CSP_META}\n`;
  const body = parts.join('\n');
  const budget = Math.max(0, MAX_SNAPSHOT_BYTES - Buffer.byteLength(head, 'utf-8'));
  if (Buffer.byteLength(body, 'utf-8') <= budget) return head + stripActiveTags(body);
  // Stripped after truncating, so a tag cut open by the cut and closed by the marker is caught
  // too. Stripping only shortens the text; the marker is re-added if a stripped tag took it.
  const marker = `\n${TRUNCATED_MARKER}`;
  let content = stripActiveTags(truncateToBytes(body, Math.max(0, budget - Buffer.byteLength(marker, 'utf-8'))) + marker);
  if (!content.endsWith(TRUNCATED_MARKER)) content += marker;
  return head + content;
}
