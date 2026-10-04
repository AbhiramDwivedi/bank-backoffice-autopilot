/**
 * Red team: a seeded leak fuzzer for screen masking, on the real surface.
 *
 * Each page is generated from the layouts the rules support: label/value table cells (with a value
 * carried only by `<img alt>`), one-cell "Label: value" and `<br>` lines, prose with a label in the
 * middle of a line, values split across nodes (a text pattern), `dt`/`dd`, bold captions, header
 * rows with `rowspan`, a heading that repeats a masked value (propagation), a run value echoed in a
 * note, form fields (one typed into by the surface, one filled later by a script), a scroll
 * container, text overflowing a narrow cell, a `display: contents` value, an absolutely positioned
 * value, and a child frame. Every piece of PII is painted in one colour.
 *
 * Then a random schedule of benign mutations runs WHILE captures are taken: setting a field's
 * `.value`, scrolling inner containers, toggling classes, `insertRule`/`deleteRule`, CSS animations
 * and transitions, an animation driven by `requestAnimationFrame`, a progressive Web Animation,
 * in-place `characterData` edits to new values, re-renders with the same and with new values, a
 * frame reload, script focus, `adoptedStyleSheets` swaps, and bursts of sub-10 ms toggles.
 *
 * Every returned capture must hold zero PII-coloured pixels (counted over the whole PNG) and none of
 * the PII strings (observation text, DOM snapshot). A withheld capture is fine; the counts are
 * reported. Each page is also captured at rest, before the mutations start, and that capture must
 * be a real screenshot (a PNG of the viewport's size, not the omitted placeholder and not the
 * empty PNG a failed capture returns): a masker that withholds or errors everywhere fails. At rest
 * it must also keep at least MIN_MARKER_SHARE of the non-PII marker text an unmasked screenshot
 * shows (painted in a second colour): a masker that greys the whole page fails too.
 *
 * Reproducible: CU_MASK_FUZZ_SEED picks one seed (default: four fixed seeds),
 * CU_MASK_FUZZ_ITERATIONS the pages per seed, CU_MASK_FUZZ_CAPTURES the captures of each kind.
 */
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveScreenMask } from '@cu/core/schema';
import { isOmittedScreenshot, type Observation } from '@cu/core/surface';
import { createPlaywrightSurface, type PlaywrightSurface } from './surface.js';
import { countColor } from './test-helpers.js';

/** Non-PII marker text, painted in its own colour: a masker that greys the whole page fails the bound below. */
const MARKER_RGB: readonly [number, number, number] = [0, 180, 255];
/**
 * At rest, at least this share of the marker pixels an unmasked screenshot shows must survive in
 * the masked one. Measured over 60 pages (seeds 7, 99, 4242; 20 pages each): the lowest share was
 * 0.962. The markers never share an element with a masked value; what is lost is anti-aliasing
 * that renders slightly differently under the capture's stylesheet, and Playwright's element masks
 * painting rows a scroll container clips over the marker below it. A masker that greys the page
 * keeps none.
 */
const MIN_MARKER_SHARE = 0.9;

const SEEDS = process.env['CU_MASK_FUZZ_SEED'] !== undefined ? [Number(process.env['CU_MASK_FUZZ_SEED'])] : [20261001, 7, 4242, 99];
const ITERATIONS = Number(process.env['CU_MASK_FUZZ_ITERATIONS'] ?? 2);
const CAPTURES = Number(process.env['CU_MASK_FUZZ_CAPTURES'] ?? 2);
const ORIGIN = 'http://fuzz.test';
const VIEWPORT = { width: 1000, height: 1100 };

let browser: Browser;
let decoder: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  decoder = await (await browser.newContext()).newPage();
});
afterAll(async () => {
  await browser.close();
});

/** mulberry32: small, fast, seedable. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Gen {
  int: (n: number) => number;
  pick: <T>(xs: readonly T[]) => T;
}

function gen(seed: number): Gen {
  const next = rng(seed);
  const int = (n: number): number => Math.floor(next() * n);
  return { int, pick: (xs) => xs[int(xs.length)]! };
}

const STREETS = ['Quill', 'Harbor', 'Juniper', 'Wexford', 'Calder', 'Thistle', 'Marlow', 'Bramble'];
const SUFFIXES = ['Rd', 'St', 'Ave', 'Ln', 'Ct', 'Way'];

/** A layout instance: its HTML and every PII string it shows. */
interface Built {
  html: string;
  pii: string[];
}

/** What a layout may use beyond the generator: the run value, and values shown elsewhere on the page. */
interface Ctx {
  runValue: string;
}

const PII = (v: string): string => `<span class="pii">${v}</span>`;
/** A value under a label rule: the in-place edits only change these (to another value under the same rule). */
const LV = (v: string): string => `<span class="pii lv">${v}</span>`;
const address = (g: Gen): string => `${10 + g.int(89)} ${g.pick(STREETS)} ${g.pick(SUFFIXES)}`;
const phone = (g: Gen): string => `413-555-${String(1000 + g.int(8999))}`;
const GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

/** The layouts the rules support. Each returns HTML and the PII it shows. */
const LAYOUTS: Record<string, (g: Gen, id: string, ctx: Ctx) => Built> = {
  table(g, id) {
    const a = address(g);
    const p = phone(g);
    const alt = address(g);
    return {
      html: `<table id="${id}"><tr><td>Address</td><td class="pii lv">${a}</td></tr><tr><td>Phone</td><td class="pii lv">${p}</td></tr><tr><td>Address</td><td><img alt="${alt}" width="8" height="8" src="${GIF}"></td></tr><tr><td>Branch</td><td>North</td></tr></table>`,
      pii: [a, p, alt],
    };
  },
  inline(g, id) {
    const a = address(g);
    const p = phone(g);
    return { html: `<table id="${id}"><tr><td>Address: ${LV(a)}</td><td>Branch: North</td></tr></table><p>Phone: ${LV(p)}<br>Desk: Main</p>`, pii: [a, p] };
  },
  prose(g, id) {
    const a = address(g);
    const p = phone(g);
    return {
      html: `<p id="${id}" style="max-width:520px">Called member about the overdue payment plan and agreed a new date for the next instalment. Address: ${LV(a)} Branch: North. Callback Phone: ${LV(p)}</p>`,
      pii: [a, p],
    };
  },
  split(g, id) {
    const x = String(100 + g.int(799));
    const y = String(10 + g.int(89));
    const z = String(1000 + g.int(8999));
    return { html: `<p id="${id}">Ref SSN ${PII(x)}<span class="pii">-${y}</span><b class="pii">-${z}</b> on file</p>`, pii: [`${x}-${y}-${z}`] };
  },
  dl(g, id) {
    const a = address(g);
    return { html: `<dl id="${id}"><dt>Address</dt><dd class="pii lv">${a}</dd><dt>Branch</dt><dd>North</dd></dl>`, pii: [a] };
  },
  caption(g, id) {
    const p = phone(g);
    return { html: `<p id="${id}"><b>Phone</b> ${PII(p)}<br><b>Branch</b> Main</p>`, pii: [p] };
  },
  header(g, id) {
    const a1 = address(g);
    const a2 = address(g);
    return {
      html: `<table id="${id}" border="1"><tr><th>Group</th><th>Address</th><th>Branch</th></tr><tr><td rowspan="2">A</td><td class="pii lv">${a1}</td><td>North</td></tr><tr><td class="pii lv">${a2}</td><td>South</td></tr></table>`,
      pii: [a1, a2],
    };
  },
  propagation(g, id) {
    const a = address(g);
    return { html: `<div id="${id}"><h3>Shipping to ${PII(a)}</h3><table><tr><td>Address</td><td class="pii">${a}</td></tr></table></div>`, pii: [a] };
  },
  runValue(_g, id, ctx) {
    return { html: `<p id="${id}">Reference on file: ${PII(ctx.runValue)} (do not share)</p>`, pii: [ctx.runValue] };
  },
  fields(g, id) {
    const a = address(g);
    const b = address(g);
    const c = address(g);
    return {
      html: `<div id="${id}"><label>Notes <input class="pii fld" value="${a}"></label> <textarea class="pii fld" rows="1">${b}</textarea> <select class="pii fld"><option>${c}</option></select> <label>Later <input class="pii fld empty" value=""></label> <label>Search <input class="pii fld typed" value=""></label></div>`,
      pii: [a, b, c],
    };
  },
  scroll(g, id) {
    const rows: string[] = [];
    const pii: string[] = [];
    for (let i = 0; i < 8; i++) {
      const a = address(g);
      pii.push(a);
      rows.push(`<tr><td>Address</td><td class="pii lv">${a}</td></tr>`);
    }
    return { html: `<div id="${id}" class="scroller" style="height:90px;overflow:auto;border:1px solid #ccc"><table>${rows.join('')}</table></div>`, pii };
  },
  overflow(g, id) {
    const a = `${address(g)} Building ${g.int(90) + 10} Apartment ${g.int(900) + 100}`;
    return { html: `<table id="${id}"><tr><td>Address</td><td class="pii lv" style="width:40px;max-width:40px;white-space:nowrap;overflow:visible">${a}</td></tr></table>`, pii: [a] };
  },
  contents(g, id) {
    const a = address(g);
    return { html: `<table id="${id}"><tr><td>Address</td><td><span class="pii lv" style="display:contents">${a}</span></td></tr></table>`, pii: [a] };
  },
  absolute(g, id) {
    const a = address(g);
    return {
      html: `<div id="${id}" style="position:relative;height:30px"><p style="position:absolute;left:${200 + g.int(300)}px;top:0;margin:0">Note. Address: ${LV(a)}</p></div>`,
      pii: [a],
    };
  },
};

/** A late value set into an empty field by the mutation schedule (masked: every field is, under `all`). */
const LATE_VALUE = '61 Latecomer Rd';
/** Values the in-place edits switch to. */
const EDIT_VALUES = ['72 Editwise Rd', '73 Editwise Ln'];

interface BuiltPage {
  top: string;
  frame: string;
  pii: string[];
  /** Replacement HTML with new values, for the "re-render with new values" mutation. */
  alternates: string[];
  runValue: string;
  typedValue: string;
}

function buildPage(seed: number): BuiltPage {
  const g = gen(seed);
  const ctx: Ctx = { runValue: `RV-${10000 + g.int(89999)}-Q` };
  const typedValue = `TK-${1000 + g.int(8999)}-lookup`;
  const names = Object.keys(LAYOUTS);
  const parts: string[] = [];
  const pii: string[] = [LATE_VALUE, ...EDIT_VALUES, ctx.runValue, typedValue];
  // Every layout once, in a seeded order, plus a few repeats.
  const order = [...names].sort(() => g.int(3) - 1);
  for (let i = 0; i < 3; i++) order.push(g.pick(names));
  order.forEach((name, i) => {
    const b = LAYOUTS[name]!(g, `blk${i}`, ctx);
    parts.push(`<section class="blk">${b.html}<p class="marker">Marker paragraph ${i} for the over-masking bound</p></section>`);
    pii.push(...b.pii);
  });
  const alternates: string[] = [];
  for (let i = 0; i < 3; i++) {
    const b = LAYOUTS[g.pick(['table', 'inline', 'prose', 'dl', 'header'])]!(g, `alt${i}`, ctx);
    alternates.push(b.html);
    pii.push(...b.pii);
  }
  const fb = LAYOUTS['table']!(g, 'fblk', ctx);
  const fb2 = LAYOUTS['prose']!(g, 'fblk2', ctx);
  pii.push(...fb.pii, ...fb2.pii);
  const style = `<style>
    body { margin: 0; font: bold 16px Arial, sans-serif; color: #000; background: #fff; }
    .pii { color: #ff00aa; }
    .marker { color: #00b4ff; margin: 2px 8px; font: 900 26px Arial, sans-serif; }
    td { padding: 2px 8px; }
    .alt { padding-left: 24px; }
    .spin { animation: slide 0.4s infinite alternate; }
    .slow { transition: transform 0.6s, margin-left 0.6s; transform: translateX(28px); }
    @keyframes slide { from { transform: translateX(0); } to { transform: translateX(36px); } }
    input:focus, textarea:focus { outline: 3px solid #00aa00; }
    input, textarea, select { font: bold 16px Arial, sans-serif; width: 200px; }
  </style>`;
  const top = `<!doctype html><html><head><meta charset="utf-8"><title>Fuzz ${seed}</title>${style}</head><body>
    ${parts.join('\n')}
    <iframe id="frm" src="${ORIGIN}/frame-${seed}.html" width="700" height="190"></iframe>
  </body></html>`;
  const frame = `<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${fb.html}${fb2.html}<p class="marker">Marker paragraph in the frame</p></body></html>`;
  return { top, frame, pii, alternates, runValue: ctx.runValue, typedValue };
}

/** Starts a random schedule of benign mutations in the page; returns a stopper. */
async function startMutations(page: Page, seed: number, alternates: string[]): Promise<() => Promise<void>> {
  await page.evaluate(
    ([s, late, edits, alts]) => {
      let a = s >>> 0;
      const r = (): number => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const pick = <T,>(xs: ArrayLike<T>): T | undefined => (xs.length ? xs[Math.floor(r() * xs.length)] : undefined);
      const w = window as unknown as { __fuzzTimer?: number; __fuzzStop?: boolean };
      w.__fuzzStop = false;
      const sheet = document.styleSheets[0] as CSSStyleSheet | undefined;
      const adopted = new CSSStyleSheet();
      adopted.replaceSync('td { letter-spacing: 1px; } .blk { margin-top: 6px; }');
      const sections = (): NodeListOf<HTMLElement> => document.querySelectorAll<HTMLElement>('section');
      const ops: (() => void)[] = [
        () => {
          const f = pick(document.querySelectorAll<HTMLInputElement>('input.empty'));
          if (f) f.value = f.value ? '' : late;
        },
        () => {
          const sc = pick(document.querySelectorAll<HTMLElement>('.scroller'));
          if (sc) sc.scrollTop = Math.floor(r() * 200);
        },
        () => pick(document.querySelectorAll('section, td, p'))?.classList.toggle('alt'),
        () => {
          if (!sheet) return;
          if (r() < 0.5) sheet.insertRule('td { padding-left: ' + Math.floor(r() * 20) + 'px; }', sheet.cssRules.length);
          else if (sheet.cssRules.length > 8) sheet.deleteRule(sheet.cssRules.length - 1);
        },
        () => pick(sections())?.classList.toggle('spin'),
        () => pick(document.querySelectorAll('section, table'))?.classList.toggle('slow'),
        () => {
          // Re-render with the same content: new nodes, no marks.
          const sec = pick(sections());
          if (!sec) return;
          const markup = sec.innerHTML;
          sec.innerHTML = markup;
        },
        () => {
          // Re-render with new values.
          const sec = pick(sections());
          const html = pick(alts);
          if (sec && html) sec.innerHTML = html;
        },
        () => {
          // In-place characterData edit of a value under a label rule, to another value.
          const el = pick(document.querySelectorAll('.lv'));
          const t = el ? Array.from(el.childNodes).find((n) => n.nodeType === 3) : undefined;
          const v = pick(edits);
          if (t && v) (t as Text).data = v;
        },
        () => {
          const fr = document.getElementById('frm') as HTMLIFrameElement | null;
          if (!fr || r() >= 0.3) return;
          const src = fr.src;
          fr.src = src;
        },
        () => pick(document.querySelectorAll<HTMLElement>('input, textarea'))?.focus(),
        () => {
          document.adoptedStyleSheets = document.adoptedStyleSheets.length ? [] : [adopted];
        },
        () => {
          // An animation driven by requestAnimationFrame, for a while.
          const sec = pick(sections());
          if (!sec) return;
          const until = performance.now() + 400;
          const step = (now: number): void => {
            sec.style.transform = `translateX(${Math.round(20 * Math.sin(now / 30))}px)`;
            if (now < until && !w.__fuzzStop) requestAnimationFrame(step);
            else sec.style.transform = '';
          };
          requestAnimationFrame(step);
        },
        () => {
          // A progressive (finite) Web Animation.
          pick(sections())?.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(24px)' }], { duration: 1500 + Math.floor(r() * 1500) });
        },
        () => {
          // A burst of sub-10 ms toggles.
          const sec = pick(sections());
          if (!sec) return;
          const iv = window.setInterval(() => sec.classList.toggle('alt'), 1 + Math.floor(r() * 8));
          window.setTimeout(() => window.clearInterval(iv), 150);
        },
      ];
      const tick = (): void => {
        if (w.__fuzzStop) return;
        try {
          pick(ops)?.();
        } catch {
          /* a benign op that does not apply now */
        }
        w.__fuzzTimer = window.setTimeout(tick, 5 + Math.floor(r() * 35));
      };
      tick();
    },
    [seed, LATE_VALUE, EDIT_VALUES, alternates] as const,
  );
  return async () => {
    await page
      .evaluate(() => {
        const w = window as unknown as { __fuzzTimer?: number; __fuzzStop?: boolean };
        w.__fuzzStop = true;
        clearTimeout(w.__fuzzTimer);
      })
      .catch(() => undefined);
  };
}

/** The observation's text channel: everything but the screenshot. */
function observationText(o: Observation): string {
  const { screenshotPng, ...rest } = o;
  void screenshotPng;
  return JSON.stringify(rest);
}

function leaks(text: string, pii: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return pii.filter((v) => lower.includes(v.toLowerCase()));
}

/** True for a real capture: a PNG of the viewport's size (not the omitted placeholder, not the 1x1 empty PNG). */
function isRealCapture(png: Buffer): boolean {
  if (isOmittedScreenshot(png) || png.length < 24 || png.readUInt32BE(12) !== 0x49484452) return false; // 'IHDR'
  return png.readUInt32BE(16) === VIEWPORT.width && png.readUInt32BE(20) === VIEWPORT.height;
}

type Tally = Record<'calm' | 'observe' | 'screenshot' | 'dom', { returned: number; withheld: number }>;

/** Per page at rest: masked marker pixels / unmasked marker pixels (reported). */
const markerShares: number[] = [];

async function fuzzPage(seed: number, tally: Tally, failures: string[]): Promise<void> {
  const page = buildPage(seed);
  const surface: PlaywrightSurface = await createPlaywrightSurface({
    browser,
    viewport: VIEWPORT,
    screenMask: {
      config: { ...resolveScreenMask(undefined), maskInputs: 'all', maskLabels: ['^address$', '^phone$'], maskTextPatterns: true },
      textPatterns: [],
      sensitiveValues: () => [page.runValue],
    },
  });
  try {
    await surface.page.context().route(`${ORIGIN}/**`, (route) => {
      const body = route.request().url().includes('/frame-') ? page.frame : page.top;
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
    });
    expect((await surface.act({ type: 'navigate', url: `${ORIGIN}/page-${seed}.html` }, 15_000)).ok).toBe(true);
    await surface.page.waitForLoadState('load');
    // Type into the search field through the surface (a typed value is masked in its field).
    const search = (await surface.observe()).elements.find((e) => e.tag === 'input' && e.name.includes('Search'));
    if (search) await surface.act({ type: 'type', target: { ref: search.ref }, value: page.typedValue }, 5000);

    // At rest first: a real screenshot must go out, and cleanly.
    const calm = await surface.screenshot();
    if (!isRealCapture(calm)) {
      tally.calm.withheld++;
      failures.push(`seed ${seed} at rest: no real screenshot (${isOmittedScreenshot(calm) ? 'withheld' : `${calm.length} bytes`})`);
    } else {
      tally.calm.returned++;
      const n = await countColor(decoder, calm);
      if (n > 0) failures.push(`seed ${seed} at rest: ${n} PII pixels`);
      // Over-masking bound: the masked capture keeps the non-PII marker text an unmasked one shows.
      const raw = await surface.page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
      const shown = await countColor(decoder, raw, MARKER_RGB);
      const kept = await countColor(decoder, calm, MARKER_RGB);
      markerShares.push(shown > 0 ? kept / shown : 0);
      if (shown === 0 || kept / shown < MIN_MARKER_SHARE) failures.push(`seed ${seed} at rest: over-masked, ${kept} of ${shown} marker pixels left`);
    }

    const stop = await startMutations(surface.page, seed * 7 + 1, page.alternates);
    try {
      for (let c = 0; c < CAPTURES; c++) {
        const o = await surface.observe();
        const textLeaks = leaks(observationText(o), page.pii);
        if (textLeaks.length) failures.push(`seed ${seed} observe #${c}: text carries ${textLeaks.join(', ')}`);
        if (o.screenshotPng) {
          tally.observe.returned++;
          if (!isRealCapture(o.screenshotPng)) failures.push(`seed ${seed} observe #${c}: not a real capture`);
          const n = await countColor(decoder, o.screenshotPng);
          if (n > 0) failures.push(`seed ${seed} observe #${c}: ${n} PII pixels`);
        } else tally.observe.withheld++;

        const shot = await surface.screenshot();
        if (isOmittedScreenshot(shot)) tally.screenshot.withheld++;
        else {
          tally.screenshot.returned++;
          if (!isRealCapture(shot)) failures.push(`seed ${seed} screenshot #${c}: not a real capture (${shot.length} bytes)`);
          const n = await countColor(decoder, shot);
          if (n > 0) failures.push(`seed ${seed} screenshot #${c}: ${n} PII pixels`);
        }

        const dom = await surface.domSnapshot();
        if (dom.startsWith('<!-- DOM withheld')) tally.dom.withheld++;
        else {
          tally.dom.returned++;
          const domLeaks = leaks(dom, page.pii);
          if (domLeaks.length) failures.push(`seed ${seed} dom #${c}: carries ${domLeaks.join(', ')}`);
        }
      }
    } finally {
      await stop();
    }
  } finally {
    await surface.close();
  }
}

describe(`screen-mask leak fuzzer (seeds ${SEEDS.join(', ')}; ${ITERATIONS} pages each; ${CAPTURES} captures of each kind)`, () => {
  for (const base of SEEDS) {
    it(`seed ${base}: zero PII pixels and strings in every returned capture; a real capture at rest on every page`, async () => {
      const tally: Tally = { calm: { returned: 0, withheld: 0 }, observe: { returned: 0, withheld: 0 }, screenshot: { returned: 0, withheld: 0 }, dom: { returned: 0, withheld: 0 } };
      const failures: string[] = [];
      for (let i = 0; i < ITERATIONS; i++) await fuzzPage(base + i, tally, failures);
      console.log(
        `[screen-mask fuzz] seed=${base} pages=${ITERATIONS} captures=${CAPTURES} ${JSON.stringify(tally)} marker share at rest min=${Math.min(...markerShares).toFixed(3)}`,
      );
      expect(failures, failures.join('\n')).toEqual([]);
    }, 600_000);
  }
});
