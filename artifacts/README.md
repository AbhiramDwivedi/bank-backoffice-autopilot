# artifacts

This folder holds capabilities: discovery writes them and replay reads them. Each file is a typed, versioned JSON document that validates against the schema in `packages/core/schema/`.

The repo tracks the following files:

| File | Contents |
|---|---|
| `lookup-member-savings-balance.json` | The shipped capability, version 1.2.2, status `approved`. The model recorded it, two probing runs extended it with the not-found and access-denied outcomes, and one hand-written override covers tenant B. `npm run evidence` replays this file to build the [`evidence/`](../evidence/) folder. It predates the optimizer and is left unchanged: `cu validate` warns that its password step is recorded twice (`redundant_repeated_step`) and that its `member_not_found` detector is not bound to the input (`unbound_outcome_detector`). Fixing either means a new draft and a new approval. |
| `examples/lookup-member-savings-balance.example.json` | A hand-written version of the same capability, for comparison with what the model produced. |

A capability stores credential names, never values: a secret binding's `env` field names a credential that the run's `--credentials` source resolves. Its optional `auth` block lists the steps that sign in and the condition that proves the session is signed in; the scripted `relogin` operator re-runs them after a session expires. Discovery writes the block; for a capability without one, such as the shipped file, the same steps are derived at run time. See [`docs/design/credentials.md`](../docs/design/credentials.md).

The catalog (`npm run cli -- catalog list`) loads this folder and offers an agent the highest non-deprecated version of each capability id. To find one without knowing its id, use `npm run cli -- catalog search "savings balance"`: it ranks capabilities on their id, name, description, inputs, outputs, business outcomes and app metadata, so write those descriptions for a reader who is searching. `catalog tools --brief` lists name plus a one-line description (the first sentence of `description`, so make that sentence stand alone), and `catalog tools --id <id>` prints one full tool definition; pass `--approved-only` to either to leave out drafts. See [`docs/design/capability-selection.md`](../docs/design/capability-selection.md).

New discovery runs write here by default, with status `draft`. Git ignores those files, so experiments stay out of commits. Discovery never overwrites an existing `artifacts/<id>.json`; to write somewhere else, pass `--out`.

To promote a draft:

1. Check it with `npm run cli -- validate <file>`.
2. Replay it with `npm run replay -- <file>` and confirm the run ends in `success` or `business_outcome`. Replay records each run under `runs/`.
3. Approve it with `npm run cli -- approve <file> --by <name>`.

`approve` refuses a capability that has no such replay of that version under `runs/`, unless you pass `--force`. When the replay's result carries a content digest, it must match the file, so a replay of different content under the same version does not count. On success, it sets the status to `approved` and bumps the patch version.

A capability may also carry `readOnly: true`, the operator's assertion that replaying it changes nothing in the app. `discover --read-only` writes it. The optimizer replays variants of a capability only when it is there. See [`docs/design/optimize.md`](../docs/design/optimize.md).
