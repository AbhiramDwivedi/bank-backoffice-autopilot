/**
 * Real markup excerpts for term:markup, read straight from the mock app's own EJS views (not
 * fetched over HTTP, so this segment has no dependency on mock-app session/fault state).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './script.js';

const VIEWS_DIR = path.join(REPO_ROOT, 'apps', 'mock-app', 'views');

function read(view: string): string {
  return readFileSync(path.join(VIEWS_DIR, view), 'utf8');
}

/** Lines from `start` (first line matching `startRe`) through the first later line matching
 *  `endRe` (inclusive), trimmed. Falls back to just the start line if `endRe` never matches. */
function extractRange(text: string, startRe: RegExp, endRe: RegExp): string {
  const lines = text.split('\n');
  const s = lines.findIndex((l) => startRe.test(l));
  if (s === -1) return '(not found in view source)';
  let e = -1;
  for (let i = s; i < lines.length; i += 1) {
    if (endRe.test(lines[i]!)) {
      e = i;
      break;
    }
  }
  if (e === -1) e = s;
  return lines
    .slice(s, e + 1)
    .map((l) => l.trim())
    .join('\n');
}

function readPartial(view: string): string {
  return readFileSync(path.join(VIEWS_DIR, 'partials', view), 'utf8');
}

export interface MarkupExcerpt {
  label: string;
  code: string;
}

/** The four excerpts the script calls out: login label in the adjacent <td> (no <label>), the
 *  search div-button, the onclick result row, and the bare span tabs. */
export function markupExcerpts(): MarkupExcerpt[] {
  const login = read('login.ejs');
  const search = read('search.ejs');
  const detail = read('detail.ejs');

  const loginLabel = extractRange(login, /User ID:/, /name="userId"/);
  const searchButton = extractRange(search, /<div class="btn" onclick="doSearch/, /<div class="btn" onclick="doSearch/);
  const resultRow = extractRange(search, /onclick="\$\$go\('\/members\//, /onclick="\$\$go\('\/members\//);
  const tabs = extractRange(detail, /id="tabProfile"/, /id="tabNotes"/);

  return [
    { label: 'apps/mock-app/views/login.ejs — label in the adjacent <td>, no <label>', code: loginLabel },
    { label: 'apps/mock-app/views/search.ejs — search control is a <div>, not a <button>', code: searchButton },
    { label: 'apps/mock-app/views/search.ejs — result row: <tr onclick>, no <a>', code: resultRow },
    { label: 'apps/mock-app/views/detail.ejs — tabs are bare <span onclick>', code: tabs },
  ];
}

/**
 * The mock app's own monitoring tag (term:agent-tag, first block): the browser-agent's <script>
 * line from the shared partial, plus the <head> lines of login.ejs that pull it in — showing it
 * is wired into every page's <head>, the same way a real core system's RUM/analytics tag would be.
 */
export function agentTagExcerpt(): MarkupExcerpt[] {
  const partial = readPartial('cu-agent.ejs');
  const scriptLine = partial
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('<script'));

  const login = read('login.ejs');
  const headExcerpt = extractRange(login, /^<head>/, /<title>/);

  return [
    {
      label: 'apps/mock-app/views/partials/cu-agent.ejs — the monitoring tag',
      code: scriptLine ?? '(not found in partial source)',
    },
    {
      label: 'apps/mock-app/views/login.ejs — pulled into every page’s <head>',
      code: headExcerpt,
    },
  ];
}
