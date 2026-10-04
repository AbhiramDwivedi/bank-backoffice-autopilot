import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { appEnvironment, killLaunched, launchApp, parseCommandLine } from './launch.js';

describe('parseCommandLine', () => {
  it.each([
    ['app.exe', { command: 'app.exe', args: [] }],
    ['  app.exe   a  b ', { command: 'app.exe', args: ['a', 'b'] }],
    ['"C:\\Program Files\\App\\app.exe" --flag "a b"', { command: 'C:\\Program Files\\App\\app.exe', args: ['--flag', 'a b'] }],
    ['powershell.exe -File "apps\\mock desktop\\teller.ps1"', { command: 'powershell.exe', args: ['-File', 'apps\\mock desktop\\teller.ps1'] }],
    ['app "say ""hi""" x', { command: 'app', args: ['say "hi"', 'x'] }],
    ['app ""', { command: 'app', args: [''] }],
    ['app a"b c"d', { command: 'app', args: ['ab cd'] }],
    ['C:\\dir\\app.exe C:\\path\\ends\\', { command: 'C:\\dir\\app.exe', args: ['C:\\path\\ends\\'] }],
  ])('%j', (line, expected) => {
    expect(parseCommandLine(line)).toEqual(expected);
  });

  it('rejects an empty line and an unterminated quote; never expands anything', () => {
    expect(() => parseCommandLine('   ')).toThrow(/empty/);
    expect(() => parseCommandLine('app "open')).toThrow(/unterminated/);
    expect(parseCommandLine('app %PATH% $HOME `x` ; rm -rf /').args).toEqual(['%PATH%', '$HOME', '`x`', ';', 'rm', '-rf', '/']);
  });
});

describe('appEnvironment: a launched app never inherits the runtime secrets', () => {
  const base = {
    PATH: 'C:\\Windows',
    ANTHROPIC_API_KEY: 'not-a-real-key-xyz',
    anthropic_base_url: 'x',
    TYPESAFE_TOKEN: 't',
    CU_RUN_ID: 'r',
    MOCK_PASSWORD: 'p',
    DB_PASSWORD_FILE: 'f',
    GITHUB_TOKEN: 'g',
    AWS_SECRET: 's',
    SOME_API_KEY: 'k',
    MOCK_DESKTOP_FAULT_FILE: 'faults.json',
    MOCK_DESKTOP_WATCH_PID: '1',
    MOCK_USER: 'operator1',
    RUN_CREDENTIAL: 'c',
  };

  /** Secrets under names no denylist anticipates: an allowlist withholds them all. */
  const sneaky = {
    APIKEY: '1',
    GITHUB_PAT: '2',
    DATABASE_URL: 'postgres://u:pw@db/x',
    SESSION_TOKEN_V2: '3',
    DB_PASSWD: '4',
    CLIENT_SECRET_B64: '5',
    CREDENTIALS: '6',
    AUTH: '7',
  };

  it('passes only the minimal Windows base plus allowEnv; everything else, by any name, is withheld', () => {
    const env = appEnvironment({ ...base, ...sneaky, SystemRoot: 'C:\\Windows', 'ProgramFiles(x86)': 'x', PROCESSOR_ARCHITECTURE: 'AMD64', Path: 'p2' }, {
      allow: ['MOCK_USER', 'MOCK_DESKTOP_WATCH_PID'],
    });
    expect(Object.keys(env).sort()).toEqual(['MOCK_DESKTOP_WATCH_PID', 'MOCK_USER', 'PATH', 'PROCESSOR_ARCHITECTURE', 'Path', 'ProgramFiles(x86)', 'SystemRoot'].sort());
  });

  it('dropEnv and the runtime prefixes win over allowEnv', () => {
    const env = appEnvironment(base, { allow: ['MOCK_PASSWORD', 'ANTHROPIC_API_KEY', 'RUN_CREDENTIAL', 'CU_RUN_ID'], drop: ['run_credential'] });
    expect(env.MOCK_PASSWORD).toBe('p');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.RUN_CREDENTIAL).toBeUndefined();
    expect(env.CU_RUN_ID).toBeUndefined();
  });

  it('a real child started by launchApp receives only the allowlisted names', async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cu-launch-env-')), 'names.txt');
    const app = await launchApp({
      command: process.execPath,
      args: ['-e', "require('fs').writeFileSync(process.argv[1], Object.keys(process.env).join('\\n'))", out],
      env: { ...process.env, ...sneaky, ANTHROPIC_API_KEY: 'not-a-real-key-test', CU_SECRET_THING: '1', MY_TOKEN: '2', RUN_CREDENTIAL: '3', MOCK_DESKTOP_QUIET: '1' },
      allowEnv: ['MOCK_DESKTOP_QUIET', 'RUN_CREDENTIAL'],
      dropEnv: ['RUN_CREDENTIAL'],
    });
    await app.exited;
    const names = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((n) => n.toUpperCase());
    for (const gone of [...Object.keys(sneaky), 'ANTHROPIC_API_KEY', 'CU_SECRET_THING', 'MY_TOKEN', 'RUN_CREDENTIAL']) expect(names).not.toContain(gone);
    expect(names).toContain('MOCK_DESKTOP_QUIET');
    // Every name the child saw is in the base or the allow list.
    const base = /^(SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|PATH|PATHEXT|TEMP|TMP|USERPROFILE|USERNAME|USERDOMAIN|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PUBLIC|ALLUSERSPROFILE|COMPUTERNAME|OS|NUMBER_OF_PROCESSORS|PSMODULEPATH|LOGONSERVER|PROGRAMFILES.*|PROGRAMW6432|COMMONPROGRAMFILES.*|COMMONPROGRAMW6432|PROCESSOR_.*|MOCK_DESKTOP_QUIET)$/;
    expect(names.filter((n) => !base.test(n))).toEqual([]);
  });
});

describe('killLaunched: never by a bare pid', () => {
  const fakeChild = (exitCode: number | null, signalCode: NodeJS.Signals | null = null): ChildProcess => ({ exitCode, signalCode }) as unknown as ChildProcess;

  it('kills a launched app whose own handle says it is running', () => {
    const killed: number[] = [];
    expect(killLaunched({ pid: 4242, child: fakeChild(null) }, (pid) => killed.push(pid))).toBe(true);
    expect(killed).toEqual([4242]);
  });

  it('does nothing once the launched process has exited: its pid may already be someone else', () => {
    const killed: number[] = [];
    expect(killLaunched({ pid: 4242, child: fakeChild(0) }, (pid) => killed.push(pid))).toBe(false);
    expect(killLaunched({ pid: 4242, child: fakeChild(null, 'SIGTERM') }, (pid) => killed.push(pid))).toBe(false);
    expect(killed).toEqual([]);
  });
});
