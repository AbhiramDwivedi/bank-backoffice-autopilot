/**
 * Redteam: a credential obtained from a non-env provider (`file:` / `exec:`, @cu/adapter-credentials)
 * is bound where the capability needs it and reaches nothing persisted or served: not the
 * discovered artifact, not any evidence file, not a Relay payload.
 *
 * Offline: the in-memory CU Core surface (which accepts exactly the demo login), a scripted LLM,
 * and a real `node` credential helper / a real credentials file in the OS temp dir. The credential
 * NAMES are deliberately not the mock's (`APP_USER` / `APP_PASSWORD`) and are absent from the
 * process environment, so a pass proves the values came from the provider and nowhere else.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCuCoreSurface } from '@cu/core/surface';
import { createScriptedLlm, requestText, type ScriptedTurn } from '@cu/core/agent';
import { findRef } from '@cu/core/agent/test-helpers';
import { validateCapability, type Capability } from '@cu/core/schema';
import { execCredentialProvider, fileCredentialProvider } from '@cu/adapter-credentials';
import { runDiscover } from './commands/discover.js';
import { runReplay, startRelayConsole, type RelayServerHandle } from './runtime/index.js';

const BASE_URL = 'http://localhost:4173';
// The only login the CU Core fake accepts; here they travel under non-mock names.
const USER_VALUE = 'operator1';
const PASSWORD_VALUE = 'demo-pass-123';
const VALUES = [USER_VALUE, PASSWORD_VALUE];

const tempDirs: string[] = [];
const servers: RelayServerHandle[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});
afterAll(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const n of ['APP_USER', 'APP_PASSWORD']) {
    saved[n] = process.env[n];
    delete process.env[n];
  }
});
afterAll(() => {
  for (const [n, v] of Object.entries(saved)) if (v !== undefined) process.env[n] = v;
});

/** Every file under `dir`, as text. */
function allText(dir: string): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(fs.readFileSync(p).toString('latin1'));
    }
  };
  walk(dir);
  return out.join('\n');
}

/** A credential helper (`exec:` protocol) that answers APP_USER / APP_PASSWORD for whatever it is asked. */
function execHelperCommand(): string {
  const dir = tempDir('cred-helper-');
  const script = path.join(dir, 'helper.mjs');
  fs.writeFileSync(
    script,
    [
      "let input = '';",
      "process.stdin.on('data', (d) => { input += d; });",
      "process.stdin.on('end', () => {",
      '  const { names } = JSON.parse(input);',
      `  const all = { APP_USER: ${JSON.stringify(USER_VALUE)}, APP_PASSWORD: ${JSON.stringify(PASSWORD_VALUE)} };`,
      '  const out = {};',
      '  for (const n of names) if (n in all) out[n] = all[n];',
      '  process.stdout.write(JSON.stringify(out));',
      '});',
    ].join('\n'),
  );
  return `"${process.execPath}" "${script}"`;
}

/** A credentials file outside any repository (the OS temp dir). */
function credentialsFile(): string {
  const file = path.join(tempDir('cred-file-'), 'creds.json');
  fs.writeFileSync(file, JSON.stringify({ APP_USER: USER_VALUE, APP_PASSWORD: PASSWORD_VALUE }));
  return file;
}

/** The example capability with its secret bindings renamed to APP_USER / APP_PASSWORD. */
function exampleWithAppNames(): Capability {
  const text = fs
    .readFileSync('artifacts/examples/lookup-member-savings-balance.example.json', 'utf8')
    .replaceAll('"MOCK_USER"', '"APP_USER"')
    .replaceAll('"MOCK_PASSWORD"', '"APP_PASSWORD"');
  return JSON.parse(text) as Capability;
}

const typeSecret = (nameIncludes: string, name: string): ScriptedTurn => (req) => ({
  tool: 'type',
  input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes }), source: 'secret', value: name, why: `Enter ${name}`, expect: '' },
});
const typeInput = (nameIncludes: string, inputName: string): ScriptedTurn => (req) => ({
  tool: 'type',
  input: { ref: findRef(requestText(req), { role: 'textbox', nameIncludes }), source: 'input', value: inputName, why: 'Enter the member ID', expect: '' },
});
const click = (role: string, nameIncludes: string, why: string, expect = ''): ScriptedTurn => (req) => ({
  tool: 'click',
  input: { ref: findRef(requestText(req), { role, nameIncludes }), why, expect },
});
const extract = (nameIncludes: string, output: string, parse: 'text' | 'currency'): ScriptedTurn => (req) => ({
  tool: 'extract',
  input: { ref: findRef(requestText(req), { role: 'cell', nameIncludes }), output, parse, why: `Read ${output}` },
});

describe('discover with an exec: credential helper and --secret names', () => {
  it('binds the helper\'s values by name, records names only, and leaks no value into the artifact or the evidence', async () => {
    const runsDir = tempDir('cred-discover-runs-');
    const out = path.join(tempDir('cred-discover-out-'), 'cap.json');
    const llm = createScriptedLlm([
      typeSecret('User ID', 'APP_USER'),
      typeSecret('Password', 'APP_PASSWORD'),
      click('button', 'login', 'Sign on', 'Member ID'),
      typeInput('Member ID', 'memberId'),
      click('clickable', 'Search', 'Search for the member', 'record(s) found'),
      click('clickable', '12345', 'Open the matching result', 'Savings Balance'),
      extract('Jane Q. Sample', 'memberName', 'text'),
      extract('$1,234.56', 'savingsBalance', 'currency'),
      { tool: 'done', input: { success_text: 'Savings Balance', summary: 'Read the member name and savings balance.' } },
    ]);
    const lines: string[] = [];
    const result = await runDiscover(
      {
        goal: 'Log in, look up member 12345 and read their savings balance.',
        input: ['memberId=12345'],
        sensitive: [],
        output: ['savingsBalance:number', 'memberName:string'],
        id: 'cred-redteam-lookup',
        out,
        entry: '/login',
        vendor: 'Acme Core Systems',
        product: 'CU Core Workstation',
        operatorPort: 0,
        autoOperator: 'abort',
        secret: ['APP_USER', 'APP_PASSWORD'],
        credentials: execCredentialProvider(execHelperCommand(), { stderr: 'ignore' }),
        policy: 'policies/default.yaml',
        runsDir,
        headless: true,
        baseUrl: BASE_URL,
      },
      { llm, surface: createCuCoreSurface({ interstitial: false }), print: (l) => lines.push(l) },
    );

    expect(result.exitCode, lines.join('\n')).toBe(0);
    const artifactText = fs.readFileSync(out, 'utf8');
    const cap = JSON.parse(artifactText) as Capability;
    expect(validateCapability(cap).ok).toBe(true);
    expect(artifactText).toContain('"env": "APP_USER"');
    expect(artifactText).toContain('"env": "APP_PASSWORD"');
    expect(cap.auth?.steps).toEqual(['s01', 's02', 's03', 's04']);
    const evidence = allText(result.runDir);
    for (const v of VALUES) {
      expect(artifactText, `${v} in the artifact`).not.toContain(v);
      expect(evidence, `${v} in the evidence`).not.toContain(v);
    }
  });
});

describe('replay with a file: credentials file', () => {
  it('binds APP_USER / APP_PASSWORD from the file (they are not in the environment) and succeeds', async () => {
    const runsDir = tempDir('cred-replay-runs-');
    const { result, runDir } = await runReplay({
      capability: exampleWithAppNames(),
      inputs: { memberId: '12345' },
      policyPath: 'policies/default.yaml',
      runsDir,
      baseUrl: BASE_URL,
      headless: true,
      autoOperator: 'none',
      surface: createCuCoreSurface(),
      credentials: fileCredentialProvider(credentialsFile()),
    });
    expect(result.kind).toBe('success');
    const evidence = allText(runDir);
    for (const v of VALUES) expect(evidence, `${v} in the evidence`).not.toContain(v);
  });

  it('a value echoed by the app into an error and the URL at escalation reaches neither the run dir nor any Relay payload', async () => {
    const cap = exampleWithAppNames();
    const search = cap.steps.find((s) => s.id === 's06');
    if (search === undefined) throw new Error('test: example has no s06');
    search.onFailure = 'escalate';

    const surface = createCuCoreSurface();
    // The app echoes both credentials back: in an error message and in the URL.
    surface.inject({ kind: 'act_error', match: { actionType: 'click', targetId: 'search' }, code: 'app_error', message: `Search failed for ${USER_VALUE} / ${PASSWORD_VALUE}.` });
    surface.currentUrl = () => Promise.resolve(`${BASE_URL}/members/search?u=${USER_VALUE}&p=${PASSWORD_VALUE}`);

    const staticDir = tempDir('cred-relay-static-');
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><html><body><!--RELAY_BOOTSTRAP--></body></html>');
    fs.mkdirSync(path.join(staticDir, 'assets'));
    const server = await startRelayConsole({ port: 0, staticDir });
    servers.push(server);

    const run = runReplay({
      capability: cap,
      inputs: { memberId: '12345' },
      policyPath: 'policies/default.yaml',
      runsDir: tempDir('cred-relay-runs-'),
      baseUrl: BASE_URL,
      headless: true,
      autoOperator: 'none',
      operator: { server },
      surface,
      credentials: fileCredentialProvider(credentialsFile()),
    });

    let id: string | undefined;
    for (let i = 0; i < 400 && id === undefined; i++) {
      const body = (await (await fetch(`${server.url}/api/interventions`)).json()) as { interventions: { id: string }[] };
      id = body.interventions[0]?.id;
      if (id === undefined) await new Promise((r) => setTimeout(r, 10));
    }
    if (id === undefined) throw new Error('test: escalation never reached Relay');
    const relayText = [
      await (await fetch(`${server.url}/api/interventions/${id}`)).text(),
      await (await fetch(`${server.url}/api/interventions`)).text(),
      await (await fetch(`${server.url}/api/runs`)).text(),
      await (await fetch(`${server.url}/`)).text(),
    ].join('\n');
    expect(relayText).toContain(id);

    await fetch(`${server.url}/api/interventions/${id}/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'alice' }),
    });
    const { result, runDir } = await run;
    expect(result.kind).toBe('escalated');
    const everything = `${relayText}\n${allText(runDir)}\n${JSON.stringify(result)}`;
    for (const v of VALUES) expect(everything, `${v} leaked`).not.toContain(v);
  });
});
