import { describe, expect, it } from 'vitest';
import { systemPrompt } from './prompt.js';

describe('systemPrompt: the surface kind is told truthfully', () => {
  it('a web run is told it is looking at a browser-based app (and the default is web)', () => {
    const web = systemPrompt({ secretEnvNames: ['MOCK_USER'] });
    expect(web).toBe(systemPrompt({ secretEnvNames: ['MOCK_USER'], surface: 'web' }));
    expect(web).toContain('browser-based back-office application');
    expect(web).toContain('native browser dialog');
    expect(web).not.toMatch(/desktop|UI Automation/i);
  });

  it('a desktop run is told it sees a Windows app through its accessibility tree and a window screenshot, with no web pages', () => {
    const desktop = systemPrompt({ secretEnvNames: ['MOCK_USER'], surface: 'desktop' });
    expect(desktop).toContain('Windows desktop back-office application');
    expect(desktop).toContain('accessibility tree (Windows UI Automation)');
    expect(desktop).toContain("screenshot of the application's own window");
    expect(desktop).toContain('desktop://<program>/<window title>');
    expect(desktop).toContain('modal dialog window');
    expect(desktop).not.toMatch(/browser-based|raw HTML|framesets|native browser dialog/);
    // The rules that do not depend on the surface are the same.
    for (const section of ['TRUST BOUNDARY', 'CREDENTIALS AND INPUT DATA', 'IRREVERSIBLE ACTIONS']) expect(desktop).toContain(section);
  });
});
