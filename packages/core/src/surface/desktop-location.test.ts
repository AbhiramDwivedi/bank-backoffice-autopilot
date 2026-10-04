import { describe, expect, it } from 'vitest';
import {
  decodedDesktopLocation,
  desktopOrigin,
  desktopUrlProblem,
  formatDesktopUrl,
  isDesktopUrl,
  normalizeProcessName,
  parseDesktopUrl,
  processNameFromImage,
  resolveDesktopRelative,
} from './desktop-location.js';

describe('desktop locations', () => {
  it('formats the process (lower-cased, as the OS names it) as the host and the window title as one encoded segment', () => {
    expect(formatDesktopUrl('TellerWorkstation', 'Teller Workstation - Sign On')).toBe('desktop://tellerworkstation/Teller%20Workstation%20-%20Sign%20On');
    expect(formatDesktopUrl('TellerWorkstation')).toBe('desktop://tellerworkstation');
    expect(formatDesktopUrl('app', 'a/b?c#d')).toBe('desktop://app/a%2Fb%3Fc%23d');
  });

  it('round-trips through parseDesktopUrl, including titles with separators and dot-only titles', () => {
    for (const title of ['Teller Workstation - Member 12345', 'a/b?c#d', '100% done', 'Ünïcödé', '.', '..', '...']) {
      expect(parseDesktopUrl(formatDesktopUrl('My App', title))).toEqual({ processName: 'my app', title });
    }
    // An untitled window and "no window" are the same location.
    expect(parseDesktopUrl(formatDesktopUrl('My App', ''))).toEqual({ processName: 'my app' });
    expect(parseDesktopUrl('desktop://tellerworkstation')).toEqual({ processName: 'tellerworkstation' });
    expect(parseDesktopUrl('desktop://tellerworkstation/')).toEqual({ processName: 'tellerworkstation' });
  });

  it('normalizes case, and refuses a host ending in .exe with the fix spelled out (the OS names processes without it)', () => {
    expect(parseDesktopUrl('desktop://TellerWorkstation/X')).toEqual({ processName: 'tellerworkstation', title: 'X' });
    expect(desktopOrigin('TELLERWORKSTATION')).toBe(desktopOrigin('tellerworkstation'));
    expect(normalizeProcessName(' Teller.exe ')).toBe('teller.exe');
    expect(parseDesktopUrl('desktop://TellerWorkstation.exe')).toBeUndefined();
    expect(desktopUrlProblem('desktop://TellerWorkstation.exe/x')).toMatch(/without \.exe \(desktop:\/\/tellerworkstation\)/);
    expect(desktopUrlProblem('desktop://tellerworkstation/x')).toBeUndefined();
    // Only an image file name a person typed loses its extension, once.
    expect(processNameFromImage('TellerWorkstation.EXE')).toBe('tellerworkstation');
    expect(processNameFromImage('foo.exe.exe')).toBe('foo.exe');
  });

  it('resolves relative locations without dot segments, the same way for the guard and the surface', () => {
    const base = 'desktop://tellerworkstation/Teller%20Workstation%20-%20Sign%20On';
    expect(resolveDesktopRelative('/..', base)).toBe('desktop://tellerworkstation/..');
    expect(parseDesktopUrl(resolveDesktopRelative('/..', base)!)).toEqual({ processName: 'tellerworkstation', title: '..' });
    expect(resolveDesktopRelative('%2E', base)).toBe('desktop://tellerworkstation/%2E');
    expect(resolveDesktopRelative('desktop://other/x', base)).toBe('desktop://other/x');
    expect(resolveDesktopRelative('http://x/', base)).toBeUndefined();
    expect(resolveDesktopRelative('/x', 'http://localhost/')).toBeUndefined();
  });

  it('applies URL preprocessing (tab/newline removed, outer controls trimmed) before deciding', () => {
    expect(parseDesktopUrl('\u0001 desk\ttop://teller\nworkstation/X ')).toEqual({ processName: 'tellerworkstation', title: 'X' });
    expect(isDesktopUrl(' desk\ttop://x')).toBe(true);
  });

  it.each([
    ['another scheme', 'http://tellerworkstation/'],
    ['no host', 'desktop:///Teller'],
    ['no authority', 'desktop:tellerworkstation'],
    ['credentials', 'desktop://evil@tellerworkstation/'],
    ['a port', 'desktop://tellerworkstation:80/'],
    ['a query', 'desktop://tellerworkstation/x?y=1'],
    ['a fragment', 'desktop://tellerworkstation/x#y'],
    ['two path segments', 'desktop://tellerworkstation/a/b'],
    ['a malformed escape', 'desktop://tellerworkstation/%E0%A4%A'],
    ['a space in the host', 'desktop://teller workstation/'],
    ['garbage', 'not a url'],
  ])('rejects %s', (_label, url) => {
    expect(parseDesktopUrl(url)).toBeUndefined();
  });

  it('isDesktopUrl recognizes the scheme only', () => {
    expect(isDesktopUrl('desktop://x')).toBe(true);
    expect(isDesktopUrl('DESKTOP://x')).toBe(true);
    expect(isDesktopUrl('http://desktop/')).toBe(false);
  });

  it('decodedDesktopLocation shows the title as written', () => {
    expect(decodedDesktopLocation('desktop://TellerWorkstation/Confirm%20Open%20Sub-Account')).toBe('desktop://tellerworkstation/Confirm Open Sub-Account');
    expect(decodedDesktopLocation('http://x/')).toBeUndefined();
  });
});
