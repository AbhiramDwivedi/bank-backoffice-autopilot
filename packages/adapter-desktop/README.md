# @cu/adapter-desktop

`@cu/adapter-desktop` implements the `Surface` port for native Windows applications through UI Automation. The port is exported from `@cu/core/surface` and defined in `packages/core/src/surface/types.ts`. The design, the mapping onto the capability vocabulary and the limits are in [`docs/design/desktop.md`](../../docs/design/desktop.md).

The package has two halves:

- `bridge/`: `uia-bridge.ps1` and `UiaBridge.cs`. A Windows PowerShell 5.1 process hosting C# that talks to the native UI Automation COM API and speaks JSON lines over stdio. It only lists, acts on and captures windows of the process tree it is attached to, and never synthesizes global input.
- `src/`: the TypeScript surface. It builds a view of the app from each bridge snapshot, resolves locators, synthesizes descriptors, applies masking, handles dialogs and translates human-action events.

The package depends only on `@cu/core`. It runs from source through `tsx` with no build step: `exports["."]` points at `src/index.ts`. The bridge compiles itself at start (an interop assembly is generated on first run and cached under `%LOCALAPPDATA%\cu-uia-bridge`, loaded only when owned by the current user and matching its recorded hash; the cache root moves only through the `cacheRoot` start option, never an environment variable). A launched app receives only a minimal Windows environment plus the names in `launch.allowEnv` (see "A launched app gets an allowlisted environment" in the design doc). It needs `Add-Type`, so it does not run under PowerShell Constrained Language Mode.

## Use

```ts
import { createDesktopSurface } from '@cu/adapter-desktop';

const surface = await createDesktopSurface({
  processName: 'tellerworkstation', // the host of its desktop:// locations
  launch: { command: 'C:\\Apps\\Teller\\TellerWorkstation.exe', args: [] }, // or attachPid: 1234
});
```

From the CLI, a `desktop://<process>` base URL selects this surface. See [`apps/cu/README.md`](../../apps/cu/README.md).

## Tests

To run the tests, use either command from the repo root:

```bash
npx vitest run --project adapter-desktop
# or
npm test -w @cu/adapter-desktop
```

`*.test.ts` files other than the integration test run on any OS against `src/fake-bridge.ts`, an in-process fake bridge with a model of Teller Workstation. `mock-desktop.integration.test.ts` runs the real bridge against the real app (`@cu/mock-desktop`, a devDependency) and is skipped on anything but Windows. Its windows open small, without taking focus, at the bottom-right edge of the screen, and are closed when the file ends.
