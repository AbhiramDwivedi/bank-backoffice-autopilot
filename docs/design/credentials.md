# Credentials and authentication

Two separate things authenticate in this system:

- **The runtime to the target app.** A capability signs in by typing credentials into the app's
  own login form. This document is mostly about that: where the values come from, what the
  artifact stores, and how a run signs in again when its session expires.
- **An operator to Relay.** A person taking control of a live session through the console. That is
  covered at the end, in [Operator authentication to Relay](#operator-authentication-to-relay).

## What was true before

Authentication was not a separate module. Signing in was a run of ordinary recorded steps that
typed `{kind:'secret', env: NAME}` bindings, and every value behind those bindings came from
`process.env`, read by name in five places:

| Where | What it did |
|---|---|
| `packages/core/src/schema/template.ts` | `BindContext.secret` was an injectable resolver, but it defaulted to `process.env`. Core's `replayCapability({secret})` and `discover({secrets})` accepted a resolver; the CLI never passed one, so every secret binding in a real run fell through to the environment. Only tests injected one. |
| `apps/cu/src/commands/discover.ts` | `SECRET_ENV_NAMES = ['MOCK_USER', 'MOCK_PASSWORD']`, hard-coded. The preflight checked those two env vars, and `forbiddenValues` (the artifact leak scan) read `MOCK_PASSWORD` and `MOCK_USER` by name. |
| `apps/cu/src/runtime/compose.ts` | `secretEnvNames` plus `envValues()` read `process.env` on every use to feed the run's redactor, the broker's `secretValues` and Relay's payload redaction. `run-replay.ts`'s `secretEnvNamesOf(capability)` supplied the names. |
| `apps/cu/src/runtime/operators.ts` | The `relogin` scripted operator hard-coded the mock app's login form: `input[name=userId]`, `input[name=password]`, `input[name=login]`, `/login`, `/workstation`, and the member-search field in the `main` frame, with values from `MOCK_USER`/`MOCK_PASSWORD`. It could re-authenticate to the mock app and to nothing else. |
| `apps/cu/src/env.ts` | Defaulted `MOCK_USER`/`MOCK_PASSWORD` to the mock's demo login. |

The scrubbing side was already value-based and name-agnostic: the run redactor's `values` list
(`evidence/redact.ts`), the session broker's `secretValues` (escalation text, human-action identity
fields), replay's scrubber (`replay/bind.ts` registers every value it binds from a secret), and the
discovery agent's scrubber (`agent/scrub.ts`, `<secret:NAME>` placeholders). Those needed a source
of values, not a redesign. The mock app (`apps/mock-app/app.ts`) and `tools/video` also read
`MOCK_PASSWORD`; they are the target app's own configuration and a demo recorder that scripts the
mock directly, not the runtime, and are unchanged.

So "authentication can be plugged in separately" was not true. It is now, within the limits at the
end of this document.

## The port

`packages/core/src/credentials/` is a core module with no dependencies:

```ts
interface CredentialProvider {
  readonly id: string;                                        // 'env', 'file:<path>', 'exec:<program>'
  load(names: readonly string[]): Promise<CredentialLoadResult>;
}
interface CredentialSet {
  get(name: string): string | undefined;                      // backs BindContext.secret
  values(): string[];                                         // what the redactor scrubs
  names(): string[];
}
type CredentialLoadResult = { ok: true; set: CredentialSet } | { ok: false; error: CredentialFailure };
```

Two phases, on purpose. `load` is async and runs once per run, before a Relay console, a browser or
a model client exists; that is where a vault call or a helper process fits, and where a missing
credential fails fast. The `CredentialSet` it returns is synchronous, because binding happens
inside replay's step loop.

`loadCredentials(provider, names)` is the one place the completeness rule lives: names are
validated and de-duplicated, a provider that throws becomes `provider_error` (its message is
dropped, since a third-party provider might quote what it read), the set is trimmed to exactly the
requested names, and any name without a non-empty value is a `missing` failure listing exactly those
names. Every failure message names credentials and the provider, never a value.

A deviation from the original sketch: `load` returns a typed result rather than a bare
`Promise<CredentialSet>`. Expected failures in this codebase are typed results, and "the helper
exited non-zero" is an expected failure.

`envCredentialProvider(env = process.env)` lives in core because it wraps nothing external. It is
now the only place in `packages/core/src` and `apps/cu/src` that reads a credential from
`process.env`. Core no longer falls back to the environment anywhere: with no resolver, a secret
binding is simply unavailable and fails to bind.

## Providers

`--credentials <spec>` (global, or `CU_CREDENTIALS`) picks the provider for the run; the flag wins
over the variable. It is a plain string to commander, with no argument parser: commander quotes a
rejected argument verbatim ("argument '<value>' is invalid"), and an `exec:` command's arguments can
carry tokens. Only the commands that bind credentials (`discover`, `replay`, `optimize`, `catalog invoke`)
resolve it (`credentialProviderOf`, `apps/cu/src/globals.ts`), so a malformed `CU_CREDENTIALS` does
not break `validate` or `catalog list`. A bad spec fails with `cu: --credentials / CU_CREDENTIALS:
<what is wrong>; expected one of: env | file:<path> | exec:<command>` and exit 1, quoting no part of
the spec, not even its leading word (a pasted token has no `:`).

| Spec | Provider | Notes |
|---|---|---|
| `env` (default) | `envCredentialProvider` (core) | Reads the requested names from the environment, after `.env` loading. |
| `file:<path>` | `fileCredentialProvider` (`@cu/adapter-credentials`) | A JSON object of strings, or dotenv-style lines. A file inside a git work tree is refused unless `git check-ignore` confirms it is ignored, so a credentials file cannot be committed by accident; if git fails or is missing, it is refused too. A file whose directory does not exist is `unavailable`. Parse errors are reported without the parser's message, because V8 quotes the input. A relative path resolves against the process's current working directory at load time. |
| `exec:<command>` | `execCredentialProvider` (`@cu/adapter-credentials`) | The credential-helper pattern, as in `git credential` or `docker-credential-*`. |

The dotenv dialect is deliberately small: `KEY=VALUE` per line, optional `export `, `#` only as a
whole-line comment (no inline comments: `A=b # c` is the value `b # c`), one pair of matching
surrounding quotes stripped, no escape processing (`\n` stays two characters), no multi-line
values, no variable expansion; a later duplicate wins. A leading UTF-8 byte-order mark is stripped
for both forms (Windows PowerShell 5.1's `Set-Content -Encoding utf8` writes one).

### The exec protocol

1. The command is split into argv and spawned **without a shell**.
2. stdin receives one line, `{"names":["APP_USER","APP_PASSWORD"]}`, then closes.
3. stdout must be one JSON object, `{"APP_USER":"...","APP_PASSWORD":"..."}`. Requested names
   must be strings; extra keys are dropped unread.
4. Exit 0 is success. Non-zero is `failed`; no answer in 10 s kills the helper (`timeout`); more
   than 1 MiB of stdout kills it (`malformed`). A kill takes the whole process tree (`taskkill /T
   /F` on Windows; the helper runs in its own process group on POSIX, sent SIGTERM then SIGKILL),
   and on every outcome the helper's pipes are destroyed and it is unref'd, so a grandchild still
   holding stdout cannot keep `cu` alive.
5. stderr is inherited, so "not signed in to the vault" reaches the terminal. It is never captured,
   so it cannot end up in a failure message, evidence or a log.

No failure message includes stdout or any argument (arguments can carry tokens), so the provider id
is `exec:<program>` only.

Quoting rules, deliberately small: unquoted whitespace separates arguments; `"double quotes"` group,
with `\"` and `\\` as the only escapes; `'single quotes'` group literally; outside quotes a backslash
is literal, so `C:\tools\helper.exe` works unquoted. No expansion, globbing, pipes or redirection:
write a wrapper script. On Windows, Node will not spawn a `.cmd` or `.bat` without a shell, so point
the spec at an `.exe` or run a script through its interpreter (`exec:node helper.mjs`).

This one seam covers the 1Password CLI, HashiCorp Vault, cloud secret-manager CLIs and SSO token
helpers through a few lines of wrapper script, with no vendor SDK in this repository.
`packages/adapter-credentials/README.md` sketches wrappers for those; they are examples, not tested
integrations.

## What the artifact stores

Names only. A binding stays `{kind:'secret', env: NAME}`: `env` is now simply the credential's
name, resolved by whichever provider the run uses. The field keeps its name so every existing
artifact, the JSON Schema and the agent's tool vocabulary stay valid. Nothing in an artifact says
which provider resolved a name: that is a property of the run, so the same capability replays from
the environment on a laptop and from a vault helper in a scheduled job.

## Where credentials flow

`runReplay` loads the names of every secret binding the run will execute (the capability with the
run's tenant override applied, and no other tenant's, so a name only another tenant needs is never
demanded); `discover` loads its `--secret` names. Then the loaded set goes everywhere a credential is touched:

| Consumer | Uses |
|---|---|
| Replay binding | `replayCapability({secret: set.get})` |
| Discovery binding | `discover({secretEnvNames, secrets: set.get})`; the model sees only names |
| Run redactor, broker `secretValues`, Relay payloads | `compose({credentials: set})`, through `set.values()` |
| Discover's artifact leak scan | `forbiddenValues(inputs, set)`: every credential value of 3+ characters, whatever its name. A refusal names the credential (`it contains the value of credential APP_USER`), never the value. A short or common value (a username like `admin`) can occur in the app's own text and cause a false refusal. |
| `relogin` | `attachAutoOperator(..., {credentials: set})` |

`discover --secret NAME` (repeatable) names the credentials the agent may bind; giving it replaces
the default `MOCK_USER`, `MOCK_PASSWORD`. That is what lets discovery target an app other than the
mock without stuffing its login into `MOCK_*`. `env.ts` still applies the mock's demo login to
`MOCK_USER`/`MOCK_PASSWORD` when they are unset, so the zero-configuration demo keeps working; an
explicitly empty value stays empty and fails the preflight.

A missing credential stops the run before anything starts: `discover` prints
`discover: credentials (env): not set: APP_PASSWORD; refusing to start (no browser launched)` and
exits 1; `runReplay` throws `CredentialsUnavailableError` (typed, carrying the failure), which the
CLI reports the same way. The `replay` command loads the credentials itself, before `--fault`
changes the target app and before `--times` launches its shared browser, then hands `runReplay` a
provider backed by the loaded set (`preloadedCredentialProvider`), so "no browser launched" is true
on every path. This is a configuration error of the invocation, like an unreadable policy
file, so it is not folded into a `ReplayResult`.

## The auth block and generic re-login

A capability may now say which of its steps sign in:

```json
"auth": {
  "steps": ["s01", "s02", "s03", "s04"],
  "signedIn": { "kind": "url_matches", "pattern": "/workstation$" }
}
```

`deriveAuth` (`packages/core/src/schema/auth.ts`) is the one rule that produces it, used both by the
recorder at build time and by `relogin` at run time for an artifact without a block:

The principle: **signing in does not depend on the run's inputs.** No sign-in step binds an
`{kind:'input'}` value, carries an `{input.x}` placeholder or is an `extract`, so a relogin can never
re-run part of the business flow unattended. The rule:

1. The first step must be a `navigate`, so a re-run starts from a known page.
2. The sign-in lies before the first step that depends on the run's inputs (or extracts). Within
   that prefix, find the last secret-bound step. None: no sign-in.
3. The sign-in ends at the **submit** after it: the first Enter (or the secret typed with
   `pressEnter`), or the first click on a control that is not a checkbox, radio button, switch or
   text field (judged from the target's snapshot role/tag and its role/css locators).
4. No step in the run may be `irreversible`.
5. The signed-in condition is the submit's own postcondition when it has one; otherwise **the
   form is gone**: `not element_visible(<the field the last secret was typed into>)`, bounding-box
   locators dropped (a coordinate always hits something on the next page). That holds on a
   single-page login that never changes URL, and is false after a wrong password because the form
   re-renders. Its failure mode: an error page that drops the form also satisfies it. `relogin`
   additionally requires the condition to still hold half a second after it first does, because the
   form briefly disappears while the submit navigates even when the login is about to be refused.

How the rule got here. The first draft ("through the first step after the last secret that has a met
checkpoint") would have stretched the shipped artifact's sign-in over the member search, because its
sign-on click has no checkpoint. A review of the second version (last secret, first click, "left the
sign-in page" by URL) found three real flows it got wrong: a PIN typed later in the business flow
pulled the member search into the sign-in; a "remember me" checkbox was taken for the submit; and an
entry on a home page followed by a click to `/login` made "not on the entry URL" true on the login
page itself, so a wrong password "succeeded". The input boundary, the submit classification and the
form-based condition fix those three; `packages/core/src/schema/auth.test.ts` pins each. The review
proposed ending the sign-in after the *first contiguous* group of secrets instead; the input boundary
is used because it also keeps a two-page login (user, Next, password, Sign on) and a second factor
typed before the business flow inside the sign-in, which the first-group rule would cut short.

The recorder applies the same static rule rather than its record-time knowledge (which page the
secrets were typed on, whether the submit navigated), so a recorded block and a run-time derivation
for the same steps always agree; the tests check both on the shipped artifact and the example.

`validateCapability` holds an explicit block to the same principles (`invalid_auth`): every id is a
step; the ids are the capability's first steps in order with no gaps; at least one is secret-bound;
none is irreversible, depends on inputs or extracts; the last one is a submit; and the signed-in
condition depends on no input and actually proves something. A condition made only of negations
(`not`, `text_absent`, `element_absent`) holds on almost any page, so it is refused, except "a
secret's own field is gone" (`not element_visible` or `element_absent` over one of the block's
secret steps' targets, without bounding boxes). The recorder fills the block in; if it ever failed
validation it would be dropped, falling back to run-time derivation.
The shipped `artifacts/lookup-member-savings-balance.json` has no block and is not edited; the
example artifact carries one, so the e2e suite covers both paths.

`relogin` no longer knows any app. On a session-expiry escalation it takes the capability as the
run executes it (tenant override applied, so an override's extra step inside the sign-in is
re-run too), resolves the auth steps, and for each one binds it (inputs, base URL, secrets from the
credential set), waits for its precondition, acts through the operator-guarded `ctx.act` (policy
still applies; the actions are recorded as the scripted operator's), and waits for its
postcondition. Then the signed-in condition must hold, and `decideReloginHandBack` hands back
`current_step` with `resumeAtStepId` naming the first step after the sign-in, so replay rebuilds
whatever page state the lost session took (`docs/design/replay.md`, "Resuming at another step").
If replay refuses that resume point (it would repeat or skip an irreversible step), it asks again
with reason `policy_block`, and `relogin` aborts rather than guess. It aborts with a note naming what failed (a step id, a
credential name, a failure code, never a value) when there is no capability, no sign-in to derive,
a binding or step fails, or the app does not accept the login.

A sign-in control whose text matches the policy's irreversible patterns (a button labelled
"Submit": the default `irreversibleTextPatterns` start with `submit`) cannot be re-run by `relogin`:
the policy-enforcing surface refuses it with `policy_violation`, and the relogin aborts at that
step. (If discovery recorded the step as `irreversible`, rule 4 already keeps it out of a derived
sign-in, and the validator out of an explicit one.) The operator's options: handle the expiry by hand through Relay
(`--auto-operator none`), or narrow the policy's pattern for that deployment so the login button is
not classified irreversible (a policy decision, reviewed like any other).

## OAuth2 and SSO, later

Nothing here is built; this is where each would plug in.

**A token obtained by OAuth2.** A new provider, e.g. `oauth2:<config file>` in
`@cu/adapter-credentials` or its own adapter package. Its `load(names)` runs a client-credentials
grant (unattended) or a device-code flow (prints the verification URL and code on stderr and polls),
and returns the access token under a credential name such as `APP_TOKEN`. Everything downstream is
unchanged: the token is bound by name, scrubbed by value, and never written to an artifact. Two
gaps to close first: the set is loaded once, so a run that outlives the token needs a refresh (the
natural hook is `relogin` calling `provider.load` again before re-running the sign-in); and a token
that belongs in an HTTP header rather than a form field needs a `Surface` capability to set request
headers (`BrowserContext.setExtraHTTPHeaders` in the Playwright adapter), which the port does not
have today.

**A UI login that is an SSO redirect.** That is not a credential-provider concern. The sign-in is
still recorded steps, they just cross to the identity provider's origin (which the policy must
allow) and back. Username and password are secret bindings like any other. MFA is a human step:
the run escalates and an operator completes the challenge in the same live session through Relay,
then hands back. For `relogin`, an auth block would need to mark such a sign-in as interactive, so
the scripted operator hands the session to a human instead of aborting.

## Operator authentication to Relay

A separate surface with its own seam. `createRelayApp` declared an `authenticate` middleware, but
before this change it was mounted only on `GET /` and the `/api` router, so `/assets` and the 404
fallback escaped it, and neither `startRelayServer` nor the CLI's `startRelayConsole` could pass it.
The security review's "no operator authentication unless a deployment supplies the hook" was true
only for code that called `createRelayApp` directly.

Now the hook is mounted once, app-wide, after the Host and Origin guards, so it runs before every
route: the console page, `/assets`, every API route including the `/api/events` SSE stream, and
the 404 fallback. `startRelayServer({authenticate})` and `startRelayConsole({authenticate})` pass it
through; there is deliberately no CLI flag and no login UI. When the middleware sets
`res.locals.operator`, that identity replaces the self-asserted `by` on take, hand back and abort.
`apps/relay/test/server/operator-auth.redteam.test.ts` pins every route. A hook that throws, returns
a rejected promise or calls `next(err)` answers a fixed `401 authentication failed` with nothing from
the error (an LDAP error can quote a password), logged server-side by class name only
(`operator-auth-failure.redteam.test.ts`). No authenticator ships;
because assets are gated, a browser-facing one has to be cookie-based or sit behind a proxy.

## Limits

- **Credentials live in process memory for the whole run.** The set holds plain strings, and
  JavaScript cannot zero a string. A heap dump of a running `cu` process contains them.
- **The page sees what is typed into it.** Anything the app does with a credential (echo it,
  store it, send it to a third party) is outside this runtime's control.
- **Scrubbing is by value.** A credential the app re-formats (upper-cased, partly masked,
  base64-encoded, split across elements) is not recognised and can reach evidence. Values shorter
  than 3 characters are not scrubbed by the broker or scanned for in artifacts, because they would
  match ordinary text.
- **`file:` checks git, not permissions.** It does not check the file's mode, and a file outside
  any work tree is accepted as is.
- **An `exec:` helper is trusted code.** It runs with the user's environment and privileges; its
  stderr goes to the terminal, so a helper that prints a secret to stderr leaks it there.
- **The derived "form is gone" condition can be fooled.** An app that answers a refused login with
  an error page without the form satisfies it. Replay's next step then fails and escalates again,
  bounded by `maxEscalations`, so the cost is a retry, not a silent success. A submit with its own
  checkpoint (or an explicit `auth` block) avoids it.
- **The derivation is a heuristic over recorded steps.** A sign-in whose submit is a control the
  classifier takes for a field or toggle, or whose secret is typed after a step that uses the run's
  inputs, is not derived; `relogin` then aborts with a note and the expiry goes to a human. An
  explicit `auth` block, held to the same rules by the validator, covers such flows.
