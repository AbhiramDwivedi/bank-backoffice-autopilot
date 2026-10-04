/**
 * The one reusable "dark terminal" template for every term:* clip (README's "Terminal segments"
 * section): a slim title bar, monospace body, and three content shapes:
 *
 *   - 'typed'  — a prompt + command typed quickly, then real captured output revealed, then an
 *                `exit code: N` line. (term:replay-*, term:no-llm, term:handoff-result)
 *   - 'scroll' — a long pretty-printed excerpt that auto-scrolls top to bottom over the clip's
 *                held duration. (term:artifact)
 *   - 'static' — a handful of labeled excerpts/blocks shown at once, no animation beyond the
 *                initial fade. (term:markup, term:policy, term:redaction)
 *
 * Every doc's text must already have been through `maskAndVerify` (lib/masker.ts) by the caller;
 * this module only escapes/highlights, it does not scrub secrets.
 */
import path from 'node:path';
import type { Browser } from 'playwright';
import type { Segment } from './contracts.js';
import { VIDEO_OUT_DIR, WIDTH, HEIGHT } from './contracts.js';
import { escapeHtml, sleep } from './util.js';

export type TerminalMode = 'typed' | 'scroll' | 'static';

export interface TerminalBlock {
  label: string;
  code: string;
}

export interface TerminalDoc {
  /** Slim title-bar text, e.g. 'cu replay — PowerShell'. */
  title: string;
  mode: TerminalMode;
  /** 'typed' mode: the prompt, e.g. 'PS C:\\work\\cu-capability-runtime>'. */
  prompt?: string;
  /** 'typed' mode: the command line (already truthful/wrapped-safe; may be shortened to fit the frame). */
  command?: string;
  /** 'typed' mode: real captured output, newline-separated. */
  outputText?: string;
  /** 'typed' mode: shown as `exit code: N` after the output. */
  exitCode?: number;
  /** 'static' mode: labeled excerpts shown together. */
  blocks?: TerminalBlock[];
  /** 'scroll' mode: the long excerpt that scrolls top to bottom. */
  scrollText?: string;
  /** Small caption under the content, e.g. "long descriptions truncated". */
  footerNote?: string;
}

const HIGHLIGHTS: { re: RegExp; cls: string }[] = [
  { re: /\bsucceeded\b/gi, cls: 'hl-good' },
  { re: /\bFAILED\b/g, cls: 'hl-bad' },
  { re: /\bhard failure\b/gi, cls: 'hl-bad' },
  { re: /\bbusiness outcome\b/gi, cls: 'hl-warn' },
  { re: /\bescalated\b/gi, cls: 'hl-info' },
  { re: /\bexit code:?\s*\d+/gi, cls: 'hl-exit' },
  { re: /\[REDACTED[^\]]*]/g, cls: 'hl-warn' },
  { re: /"?valueRedacted"?\s*:\s*true/g, cls: 'hl-warn' },
];

function highlight(escaped: string): string {
  let out = escaped;
  for (const { re, cls } of HIGHLIGHTS) {
    out = out.replace(re, (m) => `<span class="${cls}">${m}</span>`);
  }
  return out;
}

function renderOutputHtml(outputText: string): string {
  return outputText
    .split('\n')
    .map((line) => `<div class="line">${highlight(escapeHtml(line)) || '&nbsp;'}</div>`)
    .join('\n');
}

/** JSON-serializes for embedding inside an inline <script>, escaping `<` so `</script>` can never
 *  appear inside the literal (the classic embedding hazard). */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003C');
}

const BASE_CSS = `
  :root{color-scheme:dark;}
  html,body{margin:0;padding:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:#0b0e11;}
  *{box-sizing:border-box;}
  body{font-family:Consolas,"Cascadia Mono",monospace;color:#e8edf2;}
  .titlebar{
    height:40px;display:flex;align-items:center;gap:10px;padding:0 16px;
    background:#1b2430;border-bottom:1px solid #2a3542;
    font-family:system-ui,Segoe UI,sans-serif;font-size:15px;color:#9fb2c2;
  }
  .dots{display:flex;gap:6px;}
  .dot{width:11px;height:11px;border-radius:50%;background:#3a4553;}
  .win{position:absolute;top:40px;left:0;right:0;bottom:0;padding:22px 28px;overflow-y:auto;overflow-x:hidden;scrollbar-width:none;}
  .win::-webkit-scrollbar{width:0;height:0;}
  .prompt{color:#38bdf8;}
  .cmd-line{font-size:21px;line-height:1.5;white-space:pre-wrap;word-break:break-word;margin-bottom:14px;}
  .cursor{display:inline-block;width:10px;background:#e8edf2;margin-left:2px;animation:blink 1s step-start infinite;}
  @keyframes blink{50%{opacity:0;}}
  @keyframes hb{from{opacity:0.01;}to{opacity:0.02;}}
  #hb{position:fixed;right:0;bottom:0;width:2px;height:2px;background:#fff;animation:hb 0.2s linear infinite alternate;pointer-events:none;}
  .out{font-size:19px;line-height:1.45;white-space:pre-wrap;word-break:break-word;margin:0;}
  .out .line{min-height:1.45em;}
  .hl-good{color:#4ade80;font-weight:700;}
  .hl-bad{color:#f87171;font-weight:700;}
  .hl-warn{color:#f5a623;font-weight:700;}
  .hl-info{color:#a78bfa;font-weight:700;}
  .hl-exit{color:#eef2f6;font-weight:700;background:#1b2430;padding:0 4px;border-radius:3px;}
  .footnote{position:absolute;left:0;right:0;bottom:0;height:44px;line-height:44px;padding:0 28px;background:#161b22;border-top:1px solid #2a313a;font-family:system-ui,Segoe UI,sans-serif;font-size:14px;color:#7d8a97;font-style:italic;}
  .blocks{position:absolute;top:40px;left:0;right:0;bottom:0;display:flex;flex-direction:column;gap:12px;padding:18px 26px;}
  .block{flex:1;min-height:0;display:flex;flex-direction:column;border:1px solid #2a3542;border-radius:8px;background:#12161b;overflow:hidden;}
  .block-label{flex:0 0 auto;font-family:system-ui,Segoe UI,sans-serif;font-size:14px;font-weight:700;color:#f5a623;background:#1b2430;padding:5px 12px;letter-spacing:0.02em;}
  .block-code{flex:1;min-height:0;margin:0;padding:8px 14px;font-size:15px;line-height:1.4;white-space:pre-wrap;word-break:break-word;overflow:hidden;}
  .scrollpane{position:absolute;top:40px;left:0;right:0;bottom:44px;padding:18px 28px;overflow:hidden;}
  .scrollpane pre{margin:0;font-size:16px;line-height:1.5;white-space:pre-wrap;word-break:break-word;}
`;

function buildTypedBody(doc: TerminalDoc): { html: string; script: string } {
  const promptText = doc.prompt ?? '';
  const command = doc.command ?? '';
  const outputHtml = renderOutputHtml(doc.outputText ?? '');
  const html = `
    <div class="cmd-line"><span class="prompt">${escapeHtml(promptText)}</span> <span id="cmd"></span><span id="cursor" class="cursor">&nbsp;</span></div>
    <pre id="out" class="out" style="opacity:0"></pre>
    ${doc.exitCode !== undefined ? `<div class="cmd-line" id="exitline" style="opacity:0;margin-top:10px"></div>` : ''}
  `;
  const script = `
    (function(){
      var command = ${jsonForScript(command)};
      var outputHtml = ${jsonForScript(outputHtml)};
      var exitCode = ${jsonForScript(doc.exitCode)};
      var cmdEl = document.getElementById('cmd');
      var cursorEl = document.getElementById('cursor');
      var outEl = document.getElementById('out');
      var exitEl = document.getElementById('exitline');
      var typeMs = Math.min(1400, Math.max(300, command.length * 22));
      var perChar = command.length > 0 ? typeMs / command.length : 0;
      var i = 0;
      function typeStep(){
        i += 1;
        cmdEl.textContent = command.slice(0, i);
        if (i < command.length) setTimeout(typeStep, perChar);
        else setTimeout(afterType, 220);
      }
      function scrollToEnd(){
        // Long real output can exceed the window's height; keep the tail (and the exit code
        // line, the most important part) in view rather than letting it hide below the fold.
        var win = document.querySelector('.win');
        if (win) win.scrollTop = win.scrollHeight;
      }
      function afterType(){
        if (cursorEl) cursorEl.style.display = 'none';
        outEl.style.opacity = '1';
        outEl.innerHTML = outputHtml;
        scrollToEnd();
        if (exitEl) setTimeout(showExit, 420);
      }
      function showExit(){
        exitEl.style.opacity = '1';
        var cls = (exitCode === 0) ? 'hl-good' : 'hl-bad';
        exitEl.innerHTML = '<span class="' + cls + '">exit code: ' + exitCode + '</span>';
        scrollToEnd();
      }
      if (command.length > 0) setTimeout(typeStep, 120);
      else afterType();
      document.body.dataset.ready = '1';
    })();
  `;
  return { html, script };
}

function buildScrollBody(doc: TerminalDoc, durationMs: number): { html: string; script: string } {
  const text = escapeHtml(doc.scrollText ?? '');
  const html = `<div class="scrollpane" id="pane"><pre id="scrolltext">${text}</pre></div>`;
  const leadMs = 700;
  const tailMs = 700;
  const scrollMs = Math.max(1000, durationMs - leadMs - tailMs);
  const script = `
    (function(){
      var pane = document.getElementById('pane');
      var start = null;
      var scrollMs = ${jsonForScript(scrollMs)};
      function step(ts){
        if (start === null) start = ts;
        var elapsed = ts - start;
        var max = pane.scrollHeight - pane.clientHeight;
        var progress = Math.min(1, elapsed / scrollMs);
        pane.scrollTop = Math.max(0, max) * progress;
        if (progress < 1) requestAnimationFrame(step);
      }
      setTimeout(function(){ requestAnimationFrame(step); }, ${jsonForScript(leadMs)});
      document.body.dataset.ready = '1';
    })();
  `;
  return { html, script };
}

function buildStaticBody(doc: TerminalDoc): { html: string; script: string } {
  const blocks = doc.blocks ?? [];
  const html = `
    <div class="blocks">
      ${blocks
        .map(
          (b) => `<div class="block">
            <div class="block-label">${escapeHtml(b.label)}</div>
            <pre class="block-code">${highlight(escapeHtml(b.code))}</pre>
          </div>`,
        )
        .join('\n')}
    </div>
  `;
  const script = `document.body.dataset.ready = '1';`;
  return { html, script };
}

/** Builds the full standalone HTML document for one term:* clip. */
export function buildTerminalHtml(doc: TerminalDoc, durationMs: number): string {
  const built = doc.mode === 'typed' ? buildTypedBody(doc) : doc.mode === 'scroll' ? buildScrollBody(doc, durationMs) : buildStaticBody(doc);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(doc.title)}</title>
<style>${BASE_CSS}</style>
</head>
<body>
  <div class="titlebar">
    <div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
    <div>${escapeHtml(doc.title)}</div>
  </div>
  <div class="win">
    ${built.html}
  </div>
  ${doc.footerNote ? `<div class="footnote">${escapeHtml(doc.footerNote)}</div>` : ''}
  <script>${built.script}</script>
<!-- keeps the page repainting so Playwright's screencast emits frames for the whole segment -->
<div id="hb"></div>
</body>
</html>`;
}

/** Renders one term:* clip as a recorded segment: opens a context, sets the built HTML as page
 *  content, waits for the page to signal it rendered, holds for `durationMs` (>= minClipMs of the
 *  clip's narration), then closes and returns the resulting Segment. */
export async function renderTerminalSegment(browser: Browser, clipId: string, doc: TerminalDoc, durationMs: number): Promise<Segment> {
  const created = Date.now();
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    recordVideo: { dir: VIDEO_OUT_DIR, size: { width: WIDTH, height: HEIGHT } },
  });
  const page = await context.newPage();
  const html = buildTerminalHtml(doc, durationMs);
  await page.setContent(html, { waitUntil: 'load' });
  try {
    await page.waitForSelector('body[data-ready="1"]', { timeout: 5000 });
  } catch {
    await page.waitForTimeout(300);
  }
  const trimStartMs = Date.now() - created;
  await sleep(durationMs);
  await context.close();
  const file = await page.video()!.path();
  return { clipId, file, trimStartMs, durationMs, note: path.basename(file) };
}
