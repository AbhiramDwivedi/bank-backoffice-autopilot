/**
 * observe() enumeration: elements across all frames, accessible names, synthesized descriptors,
 * text digest.
 *
 * One in-page round trip per frame does the heavy lifting (`window.__cuAgent.enumerate()`, from
 * `@cu/browser-agent`, installed/ensured via inpage.ts): it walks the frame's visible elements,
 * splits them into "interactive" and "informative" groups (document order), and precomputes
 * everything descriptor synthesis needs. A second round trip per frame turns the `els` array of
 * that same result into real ElementHandles via `getProperty('els').getProperties()` +
 * `asElement()`.
 *
 * Selection across all frames: every frame's interactive elements (top frame first, then depth
 * first), then every frame's informative elements, each group in document order, then text
 * leaves (`group: 'text'`, see @cu/browser-agent's leaves.ts). The combined list is capped at
 * `maxElements`: interactive first, then informative, then text leaves chosen by their
 * `priority` (lowest first, frame and document order within a priority) and listed in frame and
 * document order. The text group comes last so that adding it changed neither which legacy
 * elements are listed nor their refs. `omitted` counts what the cap dropped. Element handles
 * beyond the cap are disposed so they don't leak.
 *
 * A frame that fails mid-enumeration (navigating, detached) is skipped without failing the whole
 * observation; `frames` still lists it from `listFrames`, independent of enumeration success. A
 * frame that still holds no usable agent after `ensureAgent` installs one (e.g. the page pinned an
 * agent of another major) is different: `AgentVersionError` propagates and the observation fails.
 *
 * Screen masking: with `opts.mask`, enumeration is not run here. The plan already ran
 * `lib.maskObserve` in each frame, which planned, enumerated and read every enumerated element's
 * mask kind (it, or an ancestor, carries the plan's mark; a password field always) in ONE
 * synchronous call, so the text read here is exactly the text the plan saw. This module reads that
 * result (`opts.mask.observed(frame)`). A frame without one (the plan could not cover it, or it
 * appeared after the plan) is skipped entirely (after `ensureAgent`, so an unusable agent still
 * fails the observation): none of its text leaves the surface (fail closed). The surface turns the
 * kinds into the masked text view (`maskObservedElement`).
 */
import type { ElementHandle, Frame, JSHandle, Page } from 'playwright';
import { selectForCap, type ElementData, type Viewport } from '@cu/browser-agent';
import type { FramePath, Locator, TargetDescriptor } from '@cu/core/schema';
import type { ObservedElement, RecordContext } from '@cu/core/surface';
import { frameOffset, listFrames } from './frames.js';
import { AgentVersionError, ensureAgent } from './inpage.js';

/** One enumerated element before ref assignment. */
export interface EnumeratedElement {
  element: Omit<ObservedElement, 'ref'>;
  frame: Frame;
  handle: ElementHandle<Element>;
  /** The kind of mask painted over this element (see `EnumerateOptions.mask`); undefined when none. */
  maskKind?: string;
  /**
   * The recorder-only context (real text). Kept OFF `element`, which becomes the reported
   * `ObservedElement`: the surface holds it per ref and returns it only from `recordContextOf`.
   */
  recordContext?: RecordContext;
}

/** Output of one observe() enumeration pass. */
export interface EnumerationResult {
  elements: EnumeratedElement[];
  /** All frames' innerText, whitespace-collapsed, top first, capped (~8000 chars). */
  textDigest: string;
  frames: { path: FramePath; url: string }[];
  /** Elements enumerated but dropped by the `maxElements` cap. */
  omitted: number;
}

/** Caps applied while enumerating a page. */
export interface EnumerateOptions {
  maxElements: number;
  maxDigestChars: number;
  /**
   * The screen-mask plan in effect: per frame, the handle to its `lib.maskObserve` result
   * (`{ plan, enumeration, kinds }`); a frame without one is skipped.
   */
  mask?: { observed: (frame: Frame) => JSHandle | undefined };
}

interface Candidate {
  data: ElementData;
  handle: ElementHandle<Element>;
  frame: Frame;
  framePath: FramePath;
  offset: { x: number; y: number };
  viewport: Viewport;
  maskKind?: string;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** ARIA roles whose own-text can also stand as a "genuine" accessible-name source for a role
 * locator (mirrors what Playwright's getByRole computes the name from for these). */
const TEXT_NAME_ROLES: ReadonlySet<string> = new Set(['button', 'link', 'heading', 'tab', 'option']);
/** Name sources that are always a legitimate basis for a role locator's name. */
const ALWAYS_GENUINE_SOURCES: ReadonlySet<string> = new Set(['aria-label', 'aria-labelledby', 'label', 'alt', 'title', 'placeholder']);

function isGenuineRoleName(d: ElementData): boolean {
  if (!d.name) return false;
  if (ALWAYS_GENUINE_SOURCES.has(d.nameSource)) return true;
  if (d.nameSource === 'text' && TEXT_NAME_ROLES.has(d.role)) return true;
  return false;
}

function synthesizeDescriptor(d: ElementData, framePath: FramePath, viewport: Viewport): TargetDescriptor {
  const locators: Locator[] = [];
  const isPassword = d.tag === 'input' && d.inputType === 'password';

  // 1. role -- only a genuine ARIA role with a genuine accessible-name source; never for passwords.
  if (d.roleReal && !isPassword && isGenuineRoleName(d)) {
    locators.push({
      strategy: { kind: 'role', role: d.role, name: d.name, exact: d.name.length < 80 && !d.nameTruncated },
      confidence: 0.9,
      source: 'inferred',
    });
  }

  // 2. label -- a real <label>/aria label association, or the legacy adjacent-cell heuristic. A
  // truncated label cannot match exactly, so it is matched as a case-insensitive substring.
  if ((d.labelKind === 'label' || d.labelKind === 'adjacent-cell') && d.labelText) {
    locators.push({ strategy: { kind: 'label', label: d.labelText, exact: !d.labelTruncated }, confidence: 0.8, source: 'inferred' });
  }

  // 3. text -- unique own visible text (or, for a clickable <tr>, its first cell's unique text).
  if (d.textLocatorCandidate && d.textUnique) {
    locators.push({
      strategy: {
        kind: 'text',
        text: d.textLocatorCandidate,
        exact: true,
        ...(d.textLocatorTagOmit ? {} : { tag: d.tag }),
      },
      confidence: 0.7,
      source: 'inferred',
    });
  }

  // 4. relative -- anchored on the row/left label, else the nearest text directly above; plus one
  // per verified container anchor (the record's own title, e.g. a product card's name). For a
  // text leaf the container anchors come first: the text right above a value in a card is usually
  // a sibling field of the same record (its description), which identifies the record only by
  // accident. For every other element they come after, so a legacy element's chain keeps its
  // order. Older agents report no `containerAnchors`.
  // A row anchor is the element's label only when the cell reads as one; in a row of three or more
  // data cells it is the previous column's value -- another record's data, which would also find
  // the recorded row for any input. An agent before 1.4.0 does not say: treated as a label.
  const rowAnchorText = d.rowAnchorText && d.rowAnchorIsLabel !== false ? d.rowAnchorText : '';
  const anchorText = d.rowAnchorText ? rowAnchorText : d.aboveAnchorText;
  const rowOrAbove: Locator | undefined = anchorText
    ? {
        strategy: {
          kind: 'relative',
          anchor: { text: anchorText },
          relation: rowAnchorText ? 'right-of' : 'below',
          tag: d.tag,
          ...(d.roleReal ? { role: d.role } : {}),
        },
        confidence: 0.5,
        source: 'inferred',
      }
    : undefined;
  // Only a container-bounded anchor is emitted: without `within`, a record lacking the element
  // would yield its neighbour's (an agent before 1.4.0 reports none).
  const containerLocators: Locator[] = (d.containerAnchors ?? [])
    .filter((a) => !!a.within)
    .map(
      (a): Locator => ({
        strategy: {
          kind: 'relative',
          anchor: { text: a.text },
          relation: a.relation,
          tag: d.tag,
          ...(d.roleReal ? { role: d.role } : {}),
          ...(a.selector ? { selector: a.selector } : {}),
          ...(a.within ? { within: a.within } : {}),
        },
        confidence: d.group === 'text' ? 0.55 : 0.45,
        source: 'inferred',
      }),
    )
    .filter((l) => rowOrAbove === undefined || JSON.stringify(l.strategy) !== JSON.stringify(rowOrAbove.strategy));
  if (d.group === 'text') locators.push(...containerLocators);
  if (rowOrAbove) locators.push(rowOrAbove);
  if (d.group !== 'text') locators.push(...containerLocators);

  // 5. css -- structural selector, unique in the document, never a generated id.
  if (d.cssSelector) {
    locators.push({ strategy: { kind: 'css', selector: d.cssSelector }, confidence: 0.3, source: 'inferred' });
  }

  // 6. bbox -- always present; normalized to the frame's own viewport, last resort.
  locators.push({
    strategy: {
      kind: 'bbox',
      x: clamp01(d.rect.x / viewport.width),
      y: clamp01(d.rect.y / viewport.height),
      w: clamp01(d.rect.w / viewport.width),
      h: clamp01(d.rect.h / viewport.height),
    },
    confidence: 0.1,
    source: 'inferred',
  });

  const label = d.name || d.text || d.labelText || d.tag;
  return {
    description: `${d.role} "${label}" (<${d.tag}>)`,
    frame: framePath,
    locators,
    snapshot: { tag: d.tag, role: d.role, name: d.name, text: d.text },
  };
}

function toEnumeratedElement(c: Candidate): EnumeratedElement {
  const d = c.data;
  const bbox = { x: d.rect.x + c.offset.x, y: d.rect.y + c.offset.y, w: d.rect.w, h: d.rect.h };
  return {
    element: {
      role: d.role,
      name: d.name,
      text: d.text ? d.text : undefined,
      tag: d.tag,
      value: d.value,
      bbox,
      frame: c.framePath,
      enabled: d.enabled,
      descriptor: synthesizeDescriptor(d, c.framePath, c.viewport),
    },
    frame: c.frame,
    handle: c.handle,
    ...(c.maskKind !== undefined ? { maskKind: c.maskKind } : {}),
    ...(d.recordContext ? { recordContext: { ...d.recordContext, tag: d.tag, ...(d.roleReal ? { role: d.role } : {}) } } : {}),
  };
}

/** Reads `els` (a parallel array of DOM elements) off the in-page result as real ElementHandles,
 * sorted back into their original index order (Map iteration order for array-like properties is
 * not a contract worth relying on). Non-element properties (e.g. `length`) are disposed. */
async function readElementHandles(elsHandle: JSHandle): Promise<ElementHandle<Element>[]> {
  const props = await elsHandle.getProperties();
  const indexed: { idx: number; handle: ElementHandle<Element> }[] = [];
  for (const [key, h] of props) {
    if (!/^\d+$/.test(key)) {
      await h.dispose();
      continue;
    }
    const el = h.asElement();
    if (el) indexed.push({ idx: Number(key), handle: el as ElementHandle<Element> });
    else await h.dispose();
  }
  indexed.sort((a, b) => a.idx - b.idx);
  return indexed.map((x) => x.handle);
}

/** Enumerates every frame of `page` into candidate elements, descriptors, and a text digest. */
export async function enumeratePage(page: Page, opts: EnumerateOptions): Promise<EnumerationResult> {
  const frameInfos = listFrames(page);
  const framesOut = frameInfos.map((f) => ({ path: f.path, url: f.url }));

  const interactive: Candidate[] = [];
  const informative: Candidate[] = [];
  const text: Candidate[] = [];
  let omittedInPage = 0;
  const digestParts: string[] = [];

  for (const info of frameInfos) {
    if (info.frame.isDetached()) continue;
    try {
      await ensureAgent(info.frame);
      // After ensureAgent, so a frame that cannot hold a usable agent still fails loudly (below).
      const observed = opts.mask ? opts.mask.observed(info.frame) : undefined;
      if (opts.mask && !observed) continue;
      const offset = await frameOffset(info.frame);
      if (!offset) continue; // frame element not rendered

      // The in-page cap uses the same order as the cross-frame cap below, so an entry it drops (at
      // least maxElements ahead of it in its own frame) could never be kept here either; it spares
      // the page the descriptor work for those entries. With a mask plan, the plan's `maskObserve`
      // call already enumerated under the same cap (the surface passes `maxElements` to the plan).
      const rootHandle = observed
        ? await observed.getProperty('enumeration')
        : await info.frame.evaluateHandle((max) => window.__cuAgent!.enumerate({ maxElements: max }), opts.maxElements);      try {
        const dataHandle = await rootHandle.getProperty('data');
        const rawData = (await dataHandle.jsonValue()) as ElementData[];
        await dataHandle.dispose();

        const viewportHandle = await rootHandle.getProperty('viewport');
        const viewport = (await viewportHandle.jsonValue()) as Viewport;
        await viewportHandle.dispose();

        const bodyTextHandle = await rootHandle.getProperty('bodyText');
        const bodyText = (await bodyTextHandle.jsonValue()) as string;
        await bodyTextHandle.dispose();

        const omittedHandle = await rootHandle.getProperty('omitted');
        const frameOmitted: unknown = await omittedHandle.jsonValue();
        await omittedHandle.dispose();
        if (typeof frameOmitted === 'number' && frameOmitted > 0) omittedInPage += frameOmitted;

        const elsHandle = await rootHandle.getProperty('els');
        const handles = await readElementHandles(elsHandle);
        await elsHandle.dispose();

        let kinds: (string | null)[] = [];
        if (observed) {
          const kindsHandle = await observed.getProperty('kinds');
          const raw: unknown = await kindsHandle.jsonValue();
          await kindsHandle.dispose();
          kinds = Array.isArray(raw) ? raw.map((k) => (typeof k === 'string' ? k.slice(0, 40) : null)) : [];
          // Kinds parallel `els`: a mismatch means the result is not what the agent produced. Withhold the frame.
          if (kinds.length !== handles.length) {
            await Promise.all(handles.map((h) => h.dispose().catch(() => undefined)));
            continue;
          }
        }
        if (bodyText) digestParts.push(bodyText);

        const count = Math.min(handles.length, rawData.length);
        for (let i = 0; i < count; i++) {
          const d = rawData[i];
          const h = handles[i];
          if (!d || !h) continue;
          const maskKind = kinds[i] ?? undefined;
          const cand: Candidate = { data: d, handle: h, frame: info.frame, framePath: info.path, offset, viewport, ...(maskKind !== undefined ? { maskKind } : {}) };
          if (d.group === 'interactive') interactive.push(cand);
          else if (d.group === 'text') text.push(cand);
          else informative.push(cand);
        }
        // Any leftover handles (shouldn't normally happen; data/els are pushed 1:1 in-page) are disposed.
        for (let i = count; i < handles.length; i++) await handles[i]?.dispose();
      } finally {
        await rootHandle.dispose();
      }
    } catch (err) {
      // A frame that cannot hold a usable agent fails the observation loudly rather than
      // silently dropping its elements.
      if (err instanceof AgentVersionError) {
        await Promise.all([...interactive, ...informative, ...text].map((c) => c.handle.dispose().catch(() => undefined)));
        throw err;
      }
      // Frame navigated away or detached mid-enumeration: skip it, keep the rest of the observation.
      continue;
    }
  }

  // The same cap the page applied per frame (@cu/browser-agent cap.ts), now across frames: a
  // reserve for text leaves, then controls, then informative entries, viewport first.
  const all = [...interactive, ...informative, ...text];
  const keep = new Set(
    selectForCap(
      all.map((c) => ({ group: c.data.group, priority: c.data.priority ?? 0, inViewport: c.data.inViewport ?? true })),
      opts.maxElements,
    ),
  );
  const selected: Candidate[] = [];
  const disposals: Promise<void>[] = [];
  all.forEach((c, i) => {
    if (keep.has(i)) selected.push(c);
    else disposals.push(c.handle.dispose().catch(() => undefined));
  });
  await Promise.all(disposals);

  const elements = selected.map(toEnumeratedElement);
  const textDigest = digestParts.join(' ').replace(/\s+/g, ' ').trim().slice(0, opts.maxDigestChars);
  const omitted = omittedInPage + interactive.length + informative.length + text.length - selected.length;

  return { elements, textDigest, frames: framesOut, omitted };
}
