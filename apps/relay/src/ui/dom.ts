/**
 * Minimal DOM building and patching. The only way UI code creates elements.
 *
 * Safety rule: data never reaches an HTML parser. Strings become text nodes or attribute values
 * (`setAttribute`), never `innerHTML`. URL-bearing attributes (`href`, `src`, `action`,
 * `formaction`) accept only same-origin paths, `http(s):`, `blob:` and `data:image/`; anything
 * else (for example `javascript:`) is dropped.
 */

export type Child = Node | string | number | null | undefined | false;
export type AttrValue = string | number | boolean | null | undefined;
export type Attrs = Record<string, AttrValue | EventListener>;

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href']);
const SAFE_URL = /^(?:\/(?!\/)|#|https?:|blob:|data:image\/(?:png|jpeg|webp|gif);)/i;

/** True when `value` is safe to put in a URL-bearing attribute. */
export function isSafeUrl(value: string): boolean {
  return SAFE_URL.test(value.trim());
}

/** Sets or removes one attribute. `true` sets an empty boolean attribute; `false`/null/undefined removes it. */
export function setAttr(el: Element, name: string, value: AttrValue): void {
  if (value === false || value === null || value === undefined) {
    el.removeAttribute(name);
    return;
  }
  const str = value === true ? '' : String(value);
  if (URL_ATTRS.has(name.toLowerCase()) && !isSafeUrl(str)) {
    el.removeAttribute(name);
    return;
  }
  if (el.getAttribute(name) !== str) el.setAttribute(name, str);
}

function appendChildren(el: Element, children: readonly (Child | readonly Child[])[]): void {
  for (const c of children) {
    if (Array.isArray(c)) {
      appendChildren(el, c);
    } else if (c instanceof Node) {
      el.appendChild(c);
    } else if (c !== null && c !== undefined && c !== false) {
      el.appendChild(document.createTextNode(String(c)));
    }
  }
}

/**
 * Creates an element. Attribute keys starting with `on` and holding a function become event
 * listeners (`onclick`, `onkeydown`, ...). `class` and `className` both set the class attribute.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: (Child | readonly Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else {
        setAttr(el, key === 'className' ? 'class' : key, value);
      }
    }
  }
  appendChildren(el, children);
  return el;
}

/** Sets text content only when it changed (avoids needless layout and screen-reader chatter). */
export function setText(el: Node, value: string | number | null | undefined): void {
  const next = value === null || value === undefined ? '' : String(value);
  if (el.textContent !== next) el.textContent = next;
}

/** Replaces all children. Strings become text nodes. */
export function setChildren(el: Element, ...children: (Child | readonly Child[])[]): void {
  el.replaceChildren();
  appendChildren(el, children);
}

/** Looks up a required element by id; throws at startup if the HTML shell is missing it. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`relay: missing #${id} in the HTML shell`);
  return el as T;
}

/**
 * Keyed list reconciliation. Reuses the existing node for each key (so focus, scroll and
 * in-progress input survive a re-render), creates nodes for new keys, removes nodes for gone keys,
 * and reorders with the minimum of moves. Each managed child carries `data-key`.
 */
export function patchList<T>(
  parent: Element,
  items: readonly T[],
  key: (item: T) => string,
  create: (item: T) => HTMLElement,
  update: (el: HTMLElement, item: T) => void,
): void {
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(parent.children)) {
    const k = (child as HTMLElement).dataset.key;
    if (k !== undefined) existing.set(k, child as HTMLElement);
  }
  let cursor: Element | null = parent.firstElementChild;
  const seen = new Set<string>();
  for (const item of items) {
    const k = key(item);
    seen.add(k);
    let el = existing.get(k);
    if (!el) {
      el = create(item);
      el.dataset.key = k;
    }
    update(el, item);
    if (el !== cursor) parent.insertBefore(el, cursor);
    else cursor = cursor.nextElementSibling;
  }
  for (const [k, el] of existing) {
    if (!seen.has(k)) el.remove();
  }
}
