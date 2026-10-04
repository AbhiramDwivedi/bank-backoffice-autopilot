/**
 * Inlines the `Bootstrap` snapshot into the UI's `index.html`, so the first paint needs no round
 * trip: `GET /` reads the built template once (see app.ts) and swaps the literal
 * `<!--RELAY_BOOTSTRAP-->` marker for a JSON data island the UI bundle reads on load.
 */
import type { Bootstrap } from '../shared/api.js';

const MARKER = '<!--RELAY_BOOTSTRAP-->';

/**
 * Escapes the characters that would otherwise let JSON break out of the `<script>` element or
 * confuse a line-oriented JS parser: `<`/`>`/`&` (e.g. a reason containing a `</script><script>`
 * payload must never close the data-island tag) and the two line separators (valid in JSON
 * strings but illegal as raw characters in a JS *script*; this tag isn't parsed as script, but the
 * escape is cheap defense-in-depth against a page that later moves this JSON into an eval'd/
 * Function-constructed context).
 */
function escapeForInlineScript(json: string): string {
  return json.replace(/[<>&\u2028\u2029]/g, (ch) => {
    switch (ch) {
      case '<':
        return '\\u003c';
      case '>':
        return '\\u003e';
      case '&':
        return '\\u0026';
      case '\u2028':
        return '\\u2028';
      case '\u2029':
        return '\\u2029';
      default:
        return ch;
    }
  });
}

/** Replaces the literal `<!--RELAY_BOOTSTRAP-->` marker in `template` with the escaped bootstrap
 *  data island. `template` is unchanged (returned as-is) if the marker is not present. The
 *  replacement is passed as a function so `$&`, `$'`, `` $` `` and `$<n>` in page-controlled text
 *  are inserted literally, never expanded as `String.prototype.replace` patterns. */
export function renderIndexHtml(template: string, boot: Bootstrap): string {
  const json = escapeForInlineScript(JSON.stringify(boot));
  const script = `<script id="relay-bootstrap" type="application/json">${json}</script>`;
  return template.replace(MARKER, () => script);
}
