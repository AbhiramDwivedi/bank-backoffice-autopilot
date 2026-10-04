# Surface: DesktopSurface (Windows UI Automation)

`DesktopSurface` (`packages/adapter-desktop/`) implements the `Surface` port for native Windows
applications through UI Automation. The same capability vocabulary, discovery agent, replay engine,
policy guard, session broker and Relay console that drive the web app drive a desktop app: the
recorded flow does not change, only the surface under it. It replaces the core stub that used to
throw `NotImplementedError`; that stub's mapping table is below, now describing what is built.

macOS (the Accessibility API) is not built. The seam for it is the same: a bridge that answers the
protocol in `packages/adapter-desktop/src/protocol.ts` from an `AXUIElement` tree.

## Mapping onto the artifact vocabulary

| Concept in the artifact | Web (Playwright) | Desktop (UI Automation), as built |
|---|---|---|
| Location (`Observation.url`) | page URL | `desktop://<process>/<window title>`: process name as the OS reports it (no `.exe`), lower-cased; title percent-encoded as one segment (`.`/`..` as `%2E`) |
| `navigate` | load the URL | wait for a window of the app with that title (bare origin: any main window). Never starts a program, never activates a window |
| `FramePath` | frameset / iframe names | main window `[]`; another window of the app (a dialog) is a hop named by its title; a named UIA Group (a WinForms GroupBox) adds a hop named by its caption |
| `role` + `name` locator | ARIA role + accessible name | role from ControlType (Edit = `textbox`, Button = `button`, Text = `text`...) + UIA Name; only when the name is the control's own (see "Names and labels") |
| `label` locator | `<label>` or adjacent table cell | UIA `LabeledBy`, else the nearest static text to the left (same row) or directly above, in the same container |
| `text` locator | visible text node -> clickable ancestor | what a person sees on the control: its Name, or a value control's value; `tag` filters by control type |
| `relative` locator | bbox geometry within the frame | identical: geometry in the main window's client coordinates, anchored on a static text. One static equal to the anchor text wins, else one containing it; several are an ambiguity and a miss, as on the web |
| `bbox` locator | normalized to the frame viewport | normalized to the main window's client area |
| `css` locator | structural selector | no equivalent: always a miss, so a web chain falls through |
| `automation_id` locator (new) | no equivalent: always a miss | UIA AutomationId, exact |
| `Condition.text_visible` | frame innerText | text of the windows' accessibility trees (titles, names, values), whitespace-collapsed |
| `Condition.url_matches` | frame URL | the `desktop://` location |
| `dialog_open` | native alert/confirm/prompt | a blocking owned window of the app (modal, or its owner disabled) |
| `dismiss_dialog` | accept/dismiss the native dialog | invoke the dialog's default button (accept) or its Cancel button; no Cancel: close it through the UIA Window pattern |
| `act.click` | Playwright click | UIA Invoke, else Toggle, SelectionItem, ExpandCollapse; a Win32 push button gets a posted BN_CLICKED (see below) |
| `act.type` | fill / keystrokes | a Win32 edit gets `WM_SETTEXT` on its own handle (see below); other controls UIA Value `SetValue`. Replace by default, append with `clear: false` |
| `act.select` | `<select>` / custom list | the matching ListItem's SelectionItem (expanding a combo box if needed), else Value |
| `act.press` | keyboard press | WM_KEYDOWN/WM_KEYUP posted to the app's focused window (or the target's own window) |
| `domSnapshot` | DOM with values blanked | the accessibility tree, names and structure, no values at all |
| `humanCapture` | in-page DOM listeners | UIA event handlers scoped to the app's windows |

The `Capability.app.surface` field already had `'desktop'`; `discover` now records it for a
`desktop://` base URL. No action type, condition kind or result kind was added.

## How it is built

```
packages/adapter-desktop/
  bridge/uia-bridge.ps1   generates a UIA COM interop assembly on first run, compiles UiaBridge.cs, runs it
  bridge/UiaBridge.cs     the Windows half: JSON lines on stdio; PID scope; UIA tree, patterns, events; PrintWindow
  src/bridge-client.ts    typed RPC client (ids, timeouts, events), and starting/stopping the bridge process
  src/protocol.ts         the wire types
  src/tree.ts             snapshot -> view: main window, dialogs, frames, roles, names, labels, geometry, digest
  src/resolve.ts          locator strategies over a view
  src/descriptor.ts       fallback chain synthesis, checked for self-consistency
  src/mask.ts             what screenshots paint over and observations blank
  src/capture.ts          UIA event facts -> HumanAction
  src/surface.ts          DesktopSurface: the Surface methods, dialogs, navigation, lifecycle
  src/launch.ts           launching the app, killing its process tree
  src/fake-bridge.ts      in-process fake bridge + a model of Teller Workstation, for tests on any OS
```

`apps/cu` selects the surface from the base URL's scheme (`apps/cu/src/runtime/desktop.ts`):
`desktop://<process>` composes the desktop surface, anything else Playwright.

## Decisions

- **A PowerShell-hosted C# bridge, not a native Node module.** The repo has no build step and no
  native dependencies; Windows ships PowerShell 5.1 and .NET Framework, whose C# compiler
  `Add-Type` uses. The bridge is a long-lived `powershell.exe` process speaking JSON lines, so the
  Node side is ordinary async code and is tested against an in-process fake on any OS. The logic is
  C# rather than PowerShell script because UIA event callbacks arrive on threads that have no
  PowerShell runspace, and because a pattern call must be time-boxed on its own thread.
- **The native COM UI Automation API, through an interop generated at first run.** The managed
  `System.Windows.Automation` client does not apply the Win32 and MSAA proxies to Windows Forms
  controls: it reports every WinForms control as an unnamed Pane with its window handle as its
  AutomationId, and no password flag. The COM API (`CUIAutomation8`) reports proper control types,
  names, AutomationIds and `IsPassword`. There is no interop assembly on a stock machine and no
  `tlbimp.exe` without the SDK, so `uia-bridge.ps1` generates one with the .NET Framework's own
  `TypeLibConverter` from the type library inside `UIAutomationCore.dll`, and compiles the bridge
  against it. First run takes about 6 seconds; later starts about 2.
- **The interop cache is verified, not trusted.** It lives per user under
  `%LOCALAPPDATA%\cu-uia-bridge\<UIAutomationCore version>` (not `%TEMP%`, which can be shared). A
  cached DLL is loaded only when its directory, the DLL and its recorded SHA-256 are owned by the
  current user (or by Administrators, for an elevated administrator) and the hash matches; anything
  else is regenerated into a private staging directory and moved into place, replacing a stale or
  emptied cache directory instead of nesting into it. The mock app's exe is cached the same way under
  `%LOCALAPPDATA%\cu-mock-desktop`. The integration tests plant a fake DLL and empty the cache
  directory, and the bridge still starts with a verified one.
- **`-MTA`, not `-STA`.** The bridge's work runs on a thread it creates in the multithreaded
  apartment, which is what UIA event delivery wants; the PowerShell host's own apartment does not
  matter, and `-MTA` says so.
- **The bridge is dumb.** It lists windows and elements, runs one pattern call, posts one key, or
  captures one window. Locators, descriptors, labels, conditions, dialog semantics, masking policy
  and capture translation are TypeScript, where they are tested without Windows.
- **Scope is a process tree, enforced in the bridge.** `attach` binds a bridge to one root process
  id, once. Every window it lists, every element it acts on and every capture it takes must belong to
  that process or a descendant (tracked by parent pid and process start time, so a recycled pid is
  never adopted); anything else is `out_of_scope`. Windows are enumerated with `EnumWindows` and
  filtered by pid before any UIA element is created, and every tree walk uses a UIA tree filter that
  admits only elements of the owned processes, so another program's window hosted inside the app (a
  child window re-parented into it) is never fetched; its rectangle (read from Win32, no content) is
  painted over in screenshots. The integration tests pin both against a second instance of the same
  program, once side by side and once re-parented into the first.
- **Owning a process tree needs proof.** `attach` with `killOnClose` (the job object below) is
  accepted only for the process the runtime just launched: the bridge checks the process's parent is
  the runtime and that it started after the launch, and refuses (`not_launched`) otherwise, so a
  recycled pid can never put a stranger's tree in the kill-on-close job. Every `taskkill /T` is gated
  on the launched process's own `ChildProcess` handle still being alive, never on "a process with that
  pid exists". Attaching to a process the user cannot open is reported as `access_denied`.
- **A launched app gets an allowlisted environment.** A denylist of secret-looking names misses
  `APIKEY`, `GITHUB_PAT` or a `DATABASE_URL` with a password in it, so the app gets only a minimal
  Windows base (`SystemRoot`, `windir`, `SystemDrive`, `ComSpec`, `PATH`, `PATHEXT`, `TEMP`, `TMP`,
  the user's profile and app-data folders, `ProgramData`, `PUBLIC`, `ALLUSERSPROFILE`,
  `ProgramFiles*`, `CommonProgramFiles*`, `PROCESSOR_*`, `NUMBER_OF_PROCESSORS`, `OS`,
  `COMPUTERNAME`, `USERNAME`, `USERDOMAIN`, `PSModulePath`, and `LOGONSERVER`, which libuv adds to
  every child on Windows anyway) plus the names the launch lists in `allowEnv`. `dropEnv` (the run's
  credential names, passed by the composition root) and the runtime's own prefixes (`ANTHROPIC_*`,
  `TYPESAFE_*`, `CU_*`) win over `allowEnv`. Verified by running the CLI's `--app-command
  "powershell.exe ... -File apps/mock-desktop/teller.ps1"` path with an empty build cache: PowerShell
  compiles the mock with `Add-Type` and WinForms starts with exactly this base. A unit test asserts
  every name a real child receives is in the base or the allow list. The CLI passes no `allowEnv`, so
  the mock app, which reads `MOCK_USER`/`MOCK_PASSWORD`, uses its built-in demo credentials when
  started by the CLI; the test launcher (`apps/mock-desktop/launch.ts`) allows its own `MOCK_*`
  variables explicitly.
- **Cache locations come from options, never the environment.** The bridge's interop cache root and
  the mock app's build cache root can be moved only by an explicit option (`StartBridgeOptions.
  cacheRoot`, passed to `uia-bridge.ps1 -CacheRoot`; `buildTeller({ cacheRoot })`, passed to
  `teller.ps1 -CacheRoot`). Neither script reads an environment variable for it, so an inherited
  variable cannot point the bridge at a DLL someone else planted; the integration tests plant one
  with a matching hash behind an ambient variable and check it is ignored.
- **Proof of launch: the parent pid is the guarantee, the start time a sanity bound.** The bridge
  accepts `killOnClose` only for a process whose parent is the runtime and that started no more than
  60 s before the runtime's recorded launch time. Both readings are wall-clock (`Date.now()` and the
  process creation time), so a clock step between them could reject a real launch with a tight
  bound; 60 s absorbs that while still refusing a long-lived process that merely shares a recycled
  parent pid.
- **No global input, ever.** Nothing calls `SendInput`, `keybd_event`, `mouse_event`,
  `SetCursorPos`, `SetForegroundWindow` or UIA `SetFocus`. Keys are posted to the app's own window
  handle; the app's message loop translates them as it would a real key. Where a UIA proxy would
  itself activate or block the app, the bridge sends the app's own window message instead (the next
  two decisions).
- **A Win32 push button is clicked with a posted BN_CLICKED.** UIA `Invoke` on a Windows Forms
  button runs the click handler inside the cross-process call. A handler that opens a modal dialog
  (`ShowDialog`) then leaves the app's UI thread inside that call, and every later UIA request to
  the app times out until the dialog closes: the surface would be blind exactly when it has a dialog
  to handle. Posting the `WM_COMMAND`/`BN_CLICKED` notification the button's parent receives on a
  click is asynchronous, is the app's own message to its own window, and involves no mouse or
  activation. Other controls use their UIA pattern, time-boxed at 1.5 s (a call still running after
  that reports `done: false` and the surface observes the result).
- **A Win32 edit is typed into with WM_SETTEXT.** The UIA Win32 edit proxy's `SetValue` brings the
  app's window to the foreground: measured on this Windows 11 machine, the foreground window moved
  from the terminal to Teller Workstation on the first `type`. Sending `WM_SETTEXT` to the edit's
  own handle is what that proxy does underneath, without the activation; the edit raises `EN_CHANGE`
  as usual. A read-only (`ES_READONLY`) or disabled edit is refused. After every real-bridge
  integration test, in every block, a check asserts that no window of any app the file started has
  the foreground (a read-only `foreground` bridge query that reports nothing about other windows).
  A static scan (`no-global-input.redteam.test.ts`) fails if `SendInput`, `SendKeys`, `keybd_event`,
  `mouse_event`, `SetForegroundWindow`, `SetFocus`, `BringWindowToTop`, `AttachThreadInput` or
  `ShowWindow` appears in code under `packages/adapter-desktop` or `apps/mock-desktop`.
- **The launched app dies with the bridge.** The bridge puts the launched process tree in a
  kill-on-close job object. When the bridge exits for any reason (closed, killed, or its stdin closed
  because the runtime died) Windows ends the app. `close()` also asks the bridge to shut down, kills
  it after a grace period, and `taskkill /T` the app tree. An attached (not launched) app is never
  ended. The mock app additionally exits when the test runner that started it does.
- **Names and labels.** Win32 names an edit after whichever static precedes it in z-order, which in
  real apps is often some other control's caption (Teller Workstation's member-id box is announced
  as "Invalid user ID or password."). The surface computes a label from `LabeledBy` or geometry;
  when the UIA name disagrees with it, the model is shown the label and the name is not used as a
  role locator. A field's name is shown without its trailing colon.
- **AutomationId got its own locator kind** (`automation_id`) instead of a restricted `css` form
  such as `#txtUserId`. A css locator in an artifact claims a DOM; on the web, `#txtUserId` is a real
  selector that could match an unrelated element. A separate kind says exactly what it is, is a
  clean miss on the web, and maps to macOS's `AXIdentifier` later. An AutomationId that is only the
  control's window handle (what a WinForms control without a `Name` reports) changes every run and is
  never recorded.
- **Descriptors are self-consistent by construction.** Each candidate locator is resolved against
  the view it was synthesized from and kept only if it finds exactly that element, so a fresh
  artifact replays at fallback depth 0 on the screen it was recorded on.
- **Geometry is in screenshot pixels.** UIA reports physical pixels; a DPI-unaware app (most
  legacy ones) renders at 96 DPI and Windows stretches it, so `PrintWindow` returns the app's own
  smaller image. The bridge reports each window's scale; boxes in observations, `bbox` locators and
  masks are all in the screenshot's pixels.
- **Screenshots are the app's own windows.** The main window's client area with the app's other
  windows (dialogs) composited on top, each captured with `PrintWindow(PW_RENDERFULLCONTENT)` from
  its own surface: another app's window lying over it on screen never appears.
- **Masking.** Always, on this branch: password fields are never read (the bridge never asks for
  their value; a real-bridge test checks no line the bridge writes carries one) and are always
  painted over, and every field the surface typed into, or that holds a value it typed, is painted
  over for the rest of the surface's life. Which fields hold a typed value is decided in the runtime;
  typed values are never sent to the bridge, and a typed-into field shows `[MASKED]` as its value.
  The label and text rules come from the policy's `redaction.screen` block, the same one the web
  surface honours (`docs/design/screen-masking.md`): the composition root maps it with
  `desktopScreenMaskFromPolicy` into a `DesktopScreenMask` (`maskInputs`; `maskLabels`, each matched
  against a field's whole label, a trailing colon dropped; `maskTextPatterns`, the built-in and the
  policy's redaction patterns; the run's secret and sensitive values; `omitScreenshotUrlPatterns`).
  `maskSelectors` are CSS and mean nothing here. Under `maskInputs: all` every edit field's value is
  masked (an empty one stays empty), and `policies/desktop.yaml` sets it, so the model sees Teller
  Workstation's labels and extracts the record's values without seeing them. A masked element is painted over
  and marked `masked: true`; its value appears nowhere in the observation: `[MASKED]` replaces it in
  the element's `name` (for a static or button, whose name is its value), `text` and `value`, in
  every other string that would carry it (a borrowed name, the title, the text digest, a dialog
  message), in the observation's `url`, every element's `url` and every `frames[].url` (the window
  title inside the desktop:// location is scrubbed and re-encoded), and in `domSnapshot`. A frame hop
  (window or group) whose name carries a masked string is emitted as an index-only hop `{ index }`
  in `elements[].frame`, `frames[].path` and descriptors: it still matches (any frame at that depth
  with that index), and every locator of a target under it is checked unique across all the frames
  such a hop matches. No locator that would record a masked string is built, so the element is found
  by its AutomationId, label, relative position or bbox. A window title or group name that a
  `maskTextPatterns` pattern matches is itself masked, whole. Recorded human actions are masked the
  same way (target name, frame hops, location), including the title of a window that has only just
  opened. A masked string of three or more characters is replaced wherever it occurs as a substring;
  a shorter one only where it is the whole string, so masking a value of `1` does not rewrite every
  digit (a one- or two-character value embedded in a longer string is therefore not scrubbed).
  `currentUrl()` and `frameUrls()`, which only the policy reads, keep the real location. The
  surface follows the screen-masking contract of the `Surface` port: `check`/`waitFor` evaluate
  against the real text unless asked for `{ view: 'masked' }` (how discovery evaluates text the
  model wrote); `readText` returns the real text with `masked: true` when the element is masked, so
  the caller withholds it and records the output sensitive; `describeRef` returns the masked view
  as `name`/`text` (what a policy decision event may quote) and the real strings only as
  `classifyName`/`classifyText`, which the policy wrapper classifies on and never logs; and an
  observation where no screenshot may be taken carries none, while `screenshot()` returns the
  omitted-screenshot placeholder (`packages/adapter-desktop/src/screen-mask.redteam.test.ts`).
- **Human-action capture is UIA events, translated.** The bridge subscribes to Invoke, selection,
  toggle, value-change and name-change events on the app's own windows, and to new windows of the
  process tree. A value change is reported as a fact; the event's new value is never read or
  forwarded, and only a change on the editable control that has the app's keyboard focus counts (the
  app updating its own fields is not a person typing). Windows Forms raises no UIA Invoke event for
  a mouse click; its `Button.OnClick` raises a name-change notification instead. That notification
  also fires for every button of a panel that has just been shown, so a click is inferred only for a
  control that was already on screen in the view taken before the event. A navigation is recorded
  under the origin of the process whose window fired it.
- **Launching is run configuration, not policy.** `--app-command "<command line>"` starts the app;
  `--attach-pid <pid>` drives a running one. The policy file stays a guardrail: a policy that could
  carry a command line would be a way to run programs. The policy still decides which process may be
  acted on: `allowedOrigins` holds `desktop://<process>` entries, the run is narrowed to the base
  URL's one, and the surface reports locations of the process it launched (or attached to) and its
  descendants only, so starting some other program gets nothing done.

## Policy and desktop locations

`URL.origin` is the string `"null"` for every non-special scheme, so comparing desktop URLs by
origin would make every desktop app equal to every other, and to every `file:` or `blob:` URL. The
guard therefore uses one origin notion, `allowlistOrigin` (`packages/core/src/policy/guard.ts`):
`URL.origin` for http(s), `desktop://<process>` (lower-cased, decoded) for a well-formed desktop
location, nothing for anything else. A `desktop://<process>` entry allows exactly that process name,
case-insensitively, with no wildcards. A process name ending in `.exe` is rejected with "write the
process name without .exe": the OS reports names without it, so such an entry (or `--base-url`)
could never match and would only look like it allowed something. An `allowedOrigins` entry that is
neither an http(s) origin nor a desktop location makes `createPolicyGuard` throw, with the reason a
desktop entry is malformed. Path patterns match `/` plus
the decoded window title. `irreversibleUrlPatterns` are matched against the encoded URL and also
against its decoded form (`desktop://<process>/<title as shown>`), so a pattern with a title's
spaces works. A desktop location with credentials, a port, a query, a fragment, a second path
segment or a bad escape is denied; it is parsed after the same preprocessing a URL parser applies
(tabs and newlines removed, outer control characters trimmed). A window titled `.` or `..` keeps its
title (`%2E`). A relative navigate from a desktop location (`/..`, `Other Window`) resolves to
`desktop://<process>/<the path as written>`, with no dot-segment resolution, in both the guard and
the surface, so the guard checks the location the surface would go to (and the surface then reports
that no window has that title).

Any URL containing a backslash, or beginning with `//` (after the same preprocessing: `/\t/host`
counts), is refused before it is resolved, by the guard (`checkUrl`, `resolveRelativeUrl`) and by
both surfaces. Resolved against a page, `\\host\share\x` and `//host/x` are a UNC path or a
protocol-relative URL: from the `about:blank` start page Chromium turns the first into a `file:`
URL, and from an http page both reach another host. The Playwright surface hands `goto` the URL it
checked and resolved, never the raw string, accepts only http(s) or exactly `about:blank` (so
`ABOUT:BLANK` is refused, deliberately), and resolves a relative path only against an http(s) page
or the run's base URL.

Committing keys are one table in core (`committingKey`, `packages/core/src/surface/url-shape.ts`):
`\r`, `\n`, `\r\n`, `Enter`, `Return`, `NumpadEnter`, `Space`, `Spacebar` and `" "` all commit
(names case-insensitive, nothing trimmed). The guard classifies a press of any of them like Enter,
and both surfaces press the normalized key (`normalizeKeyName`), so the key the guard judged is the
key that is pressed. The composition root's per-run narrowing and the CLI's fail-fast check use the
same origin function. `packages/core/src/policy/desktop-allowlist.redteam.test.ts` and
`allowlist.redteam.test.ts` pin all of it, and
`packages/adapter-playwright/src/desktop-scheme.redteam.test.ts` pins on real Chromium that a web
surface never navigates to a UNC path, a protocol-relative URL or a non-http(s) location, and that a
committing key on a focused irreversible button is refused under policy whatever its spelling.

## Limits

- **Windows only.** The bridge needs Windows PowerShell 5.1, .NET Framework 4.x and
  `UIAutomationCore.dll`. On any other OS `createDesktopSurface` refuses to start. CI (Linux) runs the
  fake-bridge tests; the integration and end-to-end tests run on Windows only.
- **Not under Constrained Language Mode.** The bridge and the mock app compile C# with `Add-Type`,
  which PowerShell refuses under Constrained Language Mode (an AppLocker or WDAC policy). On such a
  machine the bridge does not start; shipping a signed, prebuilt bridge would be the fix.
- **Strings are capped.** Every name, value, title, AutomationId and help text the bridge reports is
  cut at 1000 characters, so a large text box is read (and `readText` returns) only its first 1000.
- **A person's typing is recognised by the app's keyboard focus.** A value change on the field that
  has the app's keyboard focus is recorded as `input`. That focus only exists when the app is in the
  foreground, so a test that may not activate the app cannot produce a focused change on the real
  app; that path is tested against the fake bridge, and the real bridge is tested for the fact it
  emits (field, no value).
- **UIA coverage depends on the toolkit.** Windows Forms, WPF and standard Win32 controls expose
  good trees. Custom-drawn controls, many Java (Swing without the Java Access Bridge) and
  Electron/Chromium apps with accessibility off, terminal emulators and games expose little or
  nothing. Legacy apps sit in between. VB6 and older ActiveX controls are often reached only
  through the MSAA (IAccessible) proxy, so roles and names can be thin or missing. Owner-drawn and
  third-party control suites (Delphi VCL custom controls, PowerBuilder DataWindows, commercial grid
  components) frequently expose a grid or form as one opaque pane. There is no OCR fallback: what
  UIA does not expose, the surface cannot see. Before targeting a real app, inspect it with
  Microsoft's Inspect.exe (Windows SDK) or Accessibility Insights for Windows. If the controls the
  workflow needs show up with a role and a name or AutomationId, the surface can drive it; if they
  show up as one unnamed pane, it cannot.
- **No global input, so some controls cannot be driven.** A control with no UIA pattern that
  activates it (a custom-drawn button, a canvas) fails with `app_error` saying so, instead of
  falling back to a synthesized click. Modifier chords (`Control+S`) are refused: posted messages
  cannot carry keyboard state reliably. A posted key is translated with the thread's current keyboard
  state, so a person holding Shift at that instant would change it.
- **The app can still activate itself.** The surface never activates a window, but an app's own
  `ShowDialog` or `MessageBox` activates the dialog it opens, and Windows lets a process started
  from the foreground take the foreground. Teller Workstation's confirmation is modal by disabling
  its owner (`Show(owner)`) for that reason; a real app's dialogs will take the screen when they open.
  Toggle, SelectionItem and ExpandCollapse go through UIA proxies whose activation behaviour was not
  measured (the mock app has no checkbox, list or combo box).
- **Windowless toolkits and keys.** WPF and other windowless toolkits have one window handle for the
  whole window; a posted key goes to that window and its own focus decides which control gets it.
- **A UIA call that blocks the app blinds the surface.** The BN_CLICKED path avoids this for push
  buttons. A menu item or other control whose Invoke opens a modal window still makes every UIA call
  time out (bounded at 1.5-3 s each) until that window closes.
- **One process tree.** A workflow that hands off to a separate program the app did not start (a
  report viewer launched through the shell, say) is out of scope by design; its location would be
  another origin and quarantine the run.
- **Screenshots.** A minimized main window gives a blank screenshot (the surface does not restore
  it: restoring activates). Windows in the app's own tree that are hidden behind its other windows
  are composited in z-order, but a window that never painted (an app that only draws on demand)
  can come back blank. A dialog whose DPI awareness differs from its owner's is scaled, and may be
  blurry.
- **Elevation.** A non-elevated runtime cannot automate an elevated (administrator) process: Windows
  blocks UIA access across that boundary (UIPI). Run both at the same level.
- **Names drift with the app's own text.** A role locator on a button whose caption changes per
  record falls through to the next locator, as on the web.
- **Speed.** A snapshot of a small app takes 100-250 ms; every action waits 200 ms for the app to
  settle. In the evidence, a replay of the seven-step balance lookup took 2.9 seconds
  (`evidence/followups/discovery-desktop/`).
