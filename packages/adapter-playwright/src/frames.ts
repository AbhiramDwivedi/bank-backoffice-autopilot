/**
 * FramePath <-> Playwright Frame helpers. A FramePath is the hop list from the top document to
 * the frame holding an element ([] = top). Observation emits `{name}` hops when the frame has a
 * name, else `{index}` (position among the parent's child frames). Resolution honours every
 * field a hop carries (name, index, urlPattern) and requires all of them to match.
 */
import type { Frame, Page } from 'playwright';
import type { FrameHop, FramePath } from '@cu/core/schema';

/** A frame paired with its FramePath and current URL. */
export interface FrameInfo {
  frame: Frame;
  path: FramePath;
  url: string;
}

function hopFor(frame: Frame): FrameHop {
  const parent = frame.parentFrame();
  const name = frame.name();
  if (name) return { name };
  return { index: parent ? parent.childFrames().indexOf(frame) : 0 };
}

/** FramePath of a frame (top document -> []). */
export function framePathOf(frame: Frame): FramePath {
  const hops: FrameHop[] = [];
  let f: Frame | null = frame;
  while (f && f.parentFrame()) {
    hops.unshift(hopFor(f));
    f = f.parentFrame();
  }
  return hops;
}

function hopMatches(frame: Frame, hop: FrameHop, siblings: Frame[]): boolean {
  if (hop.name !== undefined && frame.name() !== hop.name) return false;
  if (hop.index !== undefined && siblings.indexOf(frame) !== hop.index) return false;
  if (hop.urlPattern !== undefined) {
    let re: RegExp;
    try {
      re = new RegExp(hop.urlPattern);
    } catch {
      return false;
    }
    if (!re.test(frame.url())) return false;
  }
  return true;
}

/** Resolves a FramePath to a live Frame; undefined if any hop has no match. First match wins per hop. */
export function resolveFramePath(page: Page, path: FramePath): Frame | undefined {
  let current: Frame = page.mainFrame();
  for (const hop of path) {
    const children = current.childFrames();
    const next = children.find((c) => hopMatches(c, hop, children));
    if (!next) return undefined;
    current = next;
  }
  return current;
}

/** Every frame, depth-first from the top document, with its FramePath and URL. */
export function listFrames(page: Page): FrameInfo[] {
  const out: FrameInfo[] = [];
  const walk = (f: Frame): void => {
    if (f.isDetached()) return;
    out.push({ frame: f, path: framePathOf(f), url: f.url() });
    for (const c of f.childFrames()) walk(c);
  };
  walk(page.mainFrame());
  return out;
}

/** Stable string key for a FramePath (map keys, logging). */
export function framePathKey(path: FramePath): string {
  return path.length === 0 ? 'top' : path.map((h) => h.name ?? `#${h.index ?? '?'}`).join('/');
}

/**
 * Offset (top-document viewport px) of a frame's viewport origin. Top frame -> {0,0}.
 * Uses the frame element's bounding box (already main-viewport-relative in Playwright) plus its
 * border (clientLeft/clientTop). Returns undefined when the frame element is not rendered.
 */
export async function frameOffset(frame: Frame): Promise<{ x: number; y: number } | undefined> {
  if (!frame.parentFrame()) return { x: 0, y: 0 };
  const el = await frame.frameElement();
  try {
    const box = await el.boundingBox();
    if (!box) return undefined;
    const border = await el.evaluate((e) => ({ l: (e as HTMLElement).clientLeft || 0, t: (e as HTMLElement).clientTop || 0 }));
    return { x: box.x + border.l, y: box.y + border.t };
  } finally {
    await el.dispose();
  }
}

/** The frame's own viewport size (innerWidth/innerHeight). */
export async function frameViewport(frame: Frame): Promise<{ width: number; height: number }> {
  return (await frame.evaluate('({ width: window.innerWidth, height: window.innerHeight })')) as { width: number; height: number };
}
