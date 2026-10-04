# @cu/adapter-credentials

`@cu/adapter-credentials` implements the `CredentialProvider` port for sources other than the environment. The port and the default `env` provider live in `@cu/core/credentials` (`packages/core/src/credentials/`). The design is in [`docs/design/credentials.md`](../../docs/design/credentials.md).

The package depends on `@cu/core` only and runs from source through `tsx` with no build step: `exports["."]` points at `src/index.ts`.

## Spec forms

The CLI picks a provider with `--credentials <spec>` or `CU_CREDENTIALS`; `parseCredentialSpec` turns the spec into a provider.

| Spec | Provider |
|---|---|
| `env` (default) | Environment variables (`@cu/core/credentials`). |
| `file:<path>` | A JSON object (`{"APP_USER": "...", "APP_PASSWORD": "..."}`) or dotenv-style `KEY=VALUE` lines. |
| `exec:<command>` | A credential-helper process. See the protocol below. |

Everything after the first `:` is the path or command, so `file:C:\secrets\app.json` works.

### `file:`

- A leading UTF-8 byte-order mark is ignored (Windows PowerShell 5.1 `Set-Content -Encoding utf8` writes one).
- Trimmed content starting with `{` is parsed as a JSON object of string values. Anything else is parsed as dotenv, in exactly this dialect:
  - one `KEY=VALUE` per line, `KEY` matching `[A-Za-z_][A-Za-z0-9_]*`, whitespace around `=` and at the line ends trimmed;
  - an optional leading `export `;
  - `#` starts a comment only as the first non-blank character of a line. There are no inline comments: `A=b # c` is the value `b # c`;
  - one pair of matching surrounding quotes (`"..."` or `'...'`) is stripped;
  - no escape processing (`\n` stays a backslash and an `n`), no multi-line values, no variable expansion;
  - lines that match none of this are ignored, and a later duplicate key wins.
- A relative path resolves against the process's current working directory when the credentials are loaded.
- A path whose directory does not exist is `unavailable`.
- A file inside a git work tree is refused unless `git check-ignore` confirms it is ignored, so a commit can't pick it up. If git fails to run or isn't installed, the file is refused. Keep the file outside the repository, or git-ignore it.
- Only the requested names are kept. Error messages never quote the file.

### `exec:` protocol

1. The command is split into arguments (quoting rules below) and run without a shell.
2. stdin receives one line, `{"names":["APP_USER","APP_PASSWORD"]}`, and is then closed.
3. The helper writes one JSON object to stdout: `{"APP_USER":"...","APP_PASSWORD":"..."}`. Requested names must map to strings. Extra keys are ignored, and a name it leaves out is reported as missing.
4. Exit code 0 means success. A non-zero exit is a `failed` result. A helper that does not finish within 10 seconds is killed (`timeout`), and stdout larger than 1 MiB is rejected (`malformed`). Killing takes down the helper's whole process tree (`taskkill /T /F` on Windows; on POSIX the helper leads its own process group, which gets SIGTERM, then SIGKILL), so a child the helper started cannot keep running or keep `cu` alive.
5. stderr goes straight to the terminal, so a helper can say "not signed in". It is never captured, so it never reaches evidence or an error message. No error message ever contains stdout.

The provider id, shown in errors, is `exec:<program>`, without the arguments, since those can carry tokens.

Quoting rules:

- Unquoted whitespace separates arguments.
- `"double quotes"` group; inside them `\"` is a quote and `\\` a backslash.
- `'single quotes'` group literally.
- Outside quotes a backslash is literal, so `C:\tools\helper.exe` works unquoted.
- No variables, globs, pipes or redirection. Put those in a wrapper script.

On Windows, Node can't spawn a `.cmd` or `.bat` without a shell. Point the spec at an `.exe`, or run a script through its interpreter: `exec:node helper.mjs`, `exec:powershell -NoProfile -File helper.ps1`.

### Helper sketches

These sketches show the shape of a wrapper. They are examples only and are not tested in this repository.

1Password CLI (`op`), mapping each name to a secret reference:

```js
// op-helper.mjs -- exec:node op-helper.mjs
import { execFileSync } from 'node:child_process';
const refs = { APP_USER: 'op://Ops/legacy-app/username', APP_PASSWORD: 'op://Ops/legacy-app/password' };
let input = '';
for await (const chunk of process.stdin) input += chunk;
const out = {};
for (const name of JSON.parse(input).names) {
  if (refs[name]) out[name] = execFileSync('op', ['read', refs[name]], { encoding: 'utf8' }).trimEnd();
}
process.stdout.write(JSON.stringify(out));
```

HashiCorp Vault, reading one KV secret whose keys are the credential names:

```js
// vault-helper.mjs -- exec:node vault-helper.mjs kv/legacy-app
import { execFileSync } from 'node:child_process';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const data = JSON.parse(execFileSync('vault', ['kv', 'get', '-format=json', process.argv[2]], { encoding: 'utf8' })).data.data;
const out = {};
for (const name of JSON.parse(input).names) if (typeof data[name] === 'string') out[name] = data[name];
process.stdout.write(JSON.stringify(out));
```

An SSO token helper, exposing a short-lived token as a named credential:

```js
// token-helper.mjs -- exec:node token-helper.mjs
import { execFileSync } from 'node:child_process';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const out = {};
if (JSON.parse(input).names.includes('APP_TOKEN')) {
  // Any CLI that prints a current access token, e.g. a cloud CLI's "get-access-token" command.
  out.APP_TOKEN = execFileSync('my-sso-cli', ['token', '--audience', 'legacy-app'], { encoding: 'utf8' }).trim();
}
process.stdout.write(JSON.stringify(out));
```

## Tests

To run the tests, use either command from the repo root:

```bash
npx vitest run --project adapter-credentials
# or
npm test -w @cu/adapter-credentials
```

`credentials.redteam.test.ts` plants a secret in every failure path of both providers and checks that no error carries it. It also runs the git refusal against a real `git init` repository, skipped when git is not installed.
