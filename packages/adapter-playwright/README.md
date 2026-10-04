# @cu/adapter-playwright

`@cu/adapter-playwright` implements the `Surface` port for Chromium through Playwright. It enumerates elements, runs actions, handles frames, and resolves locators against a real page. The port is exported from `@cu/core/surface` and defined in `packages/core/src/surface/types.ts`.

The package depends on `@cu/core` and `@cu/browser-agent`. `@cu/browser-agent` is the in-page library for accessible naming, element enumeration, and human-action capture. The driver installs it into every page with an init script, or reuses the copy an app ships as its own `<script>` tag. For details, see [`docs/design/browser-agent.md`](../../docs/design/browser-agent.md).

The surface masks what it shows before anything leaves it: `createPlaywrightSurface({ screenMask })` takes a policy's `redaction.screen` block and the run's sensitive values (`screenMaskOptionsFromPolicy` from `@cu/core/surface`), and every screenshot, DOM snapshot and observation gets the same masks. Without `screenMask`, the schema defaults apply. If the masks can't be computed for a rendered frame, the surface takes no screenshot. For details, see [`docs/design/screen-masking.md`](../../docs/design/screen-masking.md).

The package runs from source through `tsx` with no build step: `exports["."]` points at `src/index.ts`.

## Tests

To run the tests, use either command from the repo root:

```bash
npx vitest run --project adapter-playwright
# or
npm test -w @cu/adapter-playwright
```

The tests drive a real Chromium instance against `@cu/mock-app`, a devDependency, instead of a fake surface.
