# tools

These scripts build the repo's evidence. They are not part of the runtime, and nothing in `apps/` or `packages/` imports them.

The following table lists each tool and the command that runs it:

| Folder | What it does | Command |
|---|---|---|
| [`evidence/`](evidence/) | Replays a capability against the running mock app and copies the run directories into [`evidence/`](../evidence/). | `npm run evidence -- --artifact <file>` |
| [`video/`](video/) | Rebuilds the narrated walkthrough, `evidence/explainer.mp4`, from real runs. It uses its own ports, so it does not collide with a running demo. | `npm run video:build` |
