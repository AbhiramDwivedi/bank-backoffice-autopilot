# @cu/video

This package builds the recorded demo walkthrough. It drives the mock app and the CLI through a scripted scenario, captures frames and terminal output, adds narration, and assembles the result into a video file.

It depends on `@cu/core`, `@cu/adapter-playwright`, `@cu/cli`, and `@cu/mock-app`. It runs from source through `tsx`, with no build step.

## Run it

From the repo root, run:

```bash
npm run video:build
```

This command runs `tsx tools/video/build.ts`. Build intermediates land in `tools/video/.build`. The build resolves that path, and the repo root, from the script's own location, not from the working directory.

CI does not rebuild the committed `evidence/explainer.mp4`. Run this script by hand when you want to regenerate it. For prerequisites and editing notes, see [how the explainer video is built](../../docs/video/README.md).

## Tests

This package has no automated tests. `npm run typecheck` still typechecks it.
