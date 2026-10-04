import { describe, expect, it } from 'vitest';
import type { Bootstrap } from '../shared/api.js';
import { renderIndexHtml } from './bootstrap.js';

const TEMPLATE = '<!doctype html>\n<html><head></head><body><!--RELAY_BOOTSTRAP--></body></html>\n';

function sampleBoot(overrides: Partial<Bootstrap> = {}): Bootstrap {
  return {
    runs: [],
    interventions: [],
    lastEventId: 'abcd1234.0',
    serverTime: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('renderIndexHtml', () => {
  it('replaces the marker with a JSON data-island script carrying the bootstrap', () => {
    const html = renderIndexHtml(TEMPLATE, sampleBoot());
    expect(html).not.toContain('RELAY_BOOTSTRAP');
    expect(html).toContain('<script id="relay-bootstrap" type="application/json">');
    const match = /<script id="relay-bootstrap" type="application\/json">(.*?)<\/script>/s.exec(html);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1] as string) as Bootstrap;
    expect(parsed.lastEventId).toBe('abcd1234.0');
  });

  it("inserts $&, $', $` and $1 from page-controlled text literally, never as replace() patterns", () => {
    const payload = "a $& b $' c $` d $1 e $$ f";
    const html = renderIndexHtml(TEMPLATE, sampleBoot({ lastEventId: payload }));
    const match = /<script id="relay-bootstrap" type="application\/json">(.*?)<\/script>/s.exec(html);
    expect(match).not.toBeNull();
    expect((JSON.parse(match![1] as string) as Bootstrap).lastEventId).toBe(payload);
    // The rest of the template is intact: nothing before or after the marker was spliced in.
    expect(html.startsWith('<!doctype html>\n<html><head></head><body><script id="relay-bootstrap"')).toBe(true);
    expect(html.endsWith('</script></body></html>\n')).toBe(true);
  });

  it('leaves the template unchanged when the marker is absent', () => {
    const html = renderIndexHtml('<html><body>no marker here</body></html>', sampleBoot());
    expect(html).toBe('<html><body>no marker here</body></html>');
  });

  it('escapes </script><script>alert(1)</script> in a reason so it can never break out of the data island', () => {
    const payload = '</script><script>alert(1)</script>';
    const boot = sampleBoot({
      interventions: [
        {
          id: 'int-1',
          runId: 'run-1',
          runKind: 'replay',
          reason: { code: 'stuck', message: payload },
          createdAt: '2026-01-01T00:00:00.000Z',
          status: 'open',
          hasScreenshot: false,
          humanActions: [],
          captureMode: 'none',
          timeline: [],
        },
      ],
    });
    const html = renderIndexHtml(TEMPLATE, boot);

    // The raw payload must never appear verbatim: no literal `<` or `>` survives inside the
    // script body, so a browser's HTML tokenizer scanning for `</script` cannot be fooled.
    expect(html).not.toContain('</script><script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e');

    // Exactly one real <script> element exists (the data island itself); the payload did not
    // create additional script boundaries.
    const scriptTags = html.match(/<script[ >]/g) ?? [];
    expect(scriptTags).toHaveLength(1);

    // And the JSON still round-trips to the original, un-escaped text.
    const match = /<script id="relay-bootstrap" type="application\/json">(.*?)<\/script>/s.exec(html);
    const parsed = JSON.parse(match![1] as string) as Bootstrap;
    expect(parsed.interventions[0]?.reason.message).toBe(payload);
  });

  it('escapes &, U+2028 and U+2029 so the data island is never misparsed as script', () => {
    const boot = sampleBoot({ lastEventId: `a&b${'\u2028'}c${'\u2029'}d` });
    const html = renderIndexHtml(TEMPLATE, boot);
    expect(html).not.toContain('\u2028');
    expect(html).not.toContain('\u2029');
    expect(html).toContain('\\u0026');
    expect(html).toContain('\\u2028');
    expect(html).toContain('\\u2029');
    const match = /<script id="relay-bootstrap" type="application\/json">(.*?)<\/script>/s.exec(html);
    const parsed = JSON.parse(match![1] as string) as Bootstrap;
    expect(parsed.lastEventId).toBe(`a&b${'\u2028'}c${'\u2029'}d`);
  });
});
