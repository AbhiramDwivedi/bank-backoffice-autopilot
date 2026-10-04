# @cu/make-evidence

This package builds the `evidence/` folder from real runs. For each scenario, it replays a capability through the `cu` CLI and copies the run directory into `evidence/`. It also copies any discovery and extend runs you name, copies the artifact, and writes `evidence/README.md`. Run directories already hold only redacted content, so this script does not redact again.

It depends on `@cu/cli` and imports `TENANTS` from `@cu/cli/runtime`. It runs from source through `tsx`, with no build step.

## Run it

Before you run it, start the mock app on port 4173. If you pass `--tenant-b`, also start it on port 4174.

From the repo root, run:

```bash
npm run evidence -- --artifact <artifact.json> [--discovery-run <runId>] [--extend-run <runId>] [--tenant-b]
```

You can repeat `--extend-run` once for each extend run.

## Tests

This package has no automated tests of its own. `npm run typecheck` covers it.
