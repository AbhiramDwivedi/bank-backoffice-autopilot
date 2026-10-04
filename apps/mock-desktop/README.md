# Teller Workstation (mock desktop app)

Teller Workstation is a deliberately dated Windows Forms back-office app: the desktop counterpart of the [web mock app](../mock-app/README.md), with the same demo credentials and member data. Discovery and replay run against it through the desktop surface ([`docs/design/desktop.md`](../../docs/design/desktop.md)). All data is fictional. Windows only.

## Run

```bash
npm run mock-desktop
```

`teller.ps1` compiles `src/TellerWorkstation.cs` into `TellerWorkstation.exe` under `%LOCALAPPDATA%\cu-mock-desktop\<source hash>` the first time that source version runs (the C# compiler that ships with .NET Framework, through `Add-Type`; not available under PowerShell Constrained Language Mode), then starts it and waits for it to exit. A cached exe runs only if it is owned by the current user and matches the hash recorded when it was built; otherwise it is rebuilt. It runs as its own process, `TellerWorkstation.exe`, so its desktop location is `desktop://tellerworkstation/<window title>`. The window is small, opens at the bottom-right edge of the primary screen, and never takes focus when it appears.

To drive it from the CLI, use the desktop policy and let the run start the app:

```bash
npm run --silent cli -- --policy policies/desktop.yaml --base-url desktop://tellerworkstation \
  --app-command "powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps/mock-desktop/teller.ps1" \
  replay <capability.json> --input memberId=12345
```

## Screens

| Window title | What it does |
|---|---|
| `Teller Workstation - Sign On` | User ID and password (`operator1` / `demo-pass-123`, or `MOCK_USER` / `MOCK_PASSWORD`; the desktop surface passes an app it launches only a minimal Windows environment plus the names the launch allows, and the CLI allows none, so a run started by the CLI always uses the defaults). A wrong password shows "Invalid user ID or password." |
| `Teller Workstation - Member Lookup` | Member ID and Find. "No member found with ID 99999.", or "Access denied: member record 90001 is restricted." |
| `Teller Workstation - Member <id>` | Contact Information (name, address, phone, tax ID) and Balances (savings in a read-only box, checking in a label). "Open Sub-Account..." opens the confirmation. |
| `Confirm Open Sub-Account` | A modal dialog. "Open Sub-Account" opens a sub-account (reference `SA-1000001`, then up); Cancel does nothing. |
| `Teller Workstation - Session Expired` | Sign-on again, after the session-expiry fault. |
| `Teller Workstation - Application Error` | Lookup after the lookup fault: "Application Error: ORA-01017 member service unavailable." |

The member data (`data/members.json`) is a copy of the web mock's seed: member `12345` is Jane Q. Sample with savings $1,234.56 and checking $310.00, `90001` is restricted, `99999` does not exist, `10001` to `10020` are the general seed. Each member also has a fictional tax ID, so masking has something to hide.

The controls are deliberately inconsistent, the way a legacy app's are: some have a developer-assigned name (UIA AutomationId: `txtUserId`, `btnSignOn`, `txtSavings`, `btnOpenSubAccount`...), some have neither a name nor a label just before them, and the member-ID box is created before its label, so Windows announces it with an unrelated caption.

## Faults

| Switch | Effect |
|---|---|
| `failLookup` | Find shows the application error. |
| `expireSession` | The next Find, New Lookup or Open Sub-Account lands on sign-on with "Your session has expired. Please sign on again." One-shot. |
| `slowMs` | Find shows "Searching..." and completes after N ms. |

Set them with the `MOCK_DESKTOP_FAULTS` environment variable (JSON, read at start), or with a control file named by `MOCK_DESKTOP_FAULT_FILE` (the same JSON, re-read before every action, so a running app can be switched; `expireSession` fires once per write of the file).

Other environment variables: `MOCK_DESKTOP_WATCH_PID` (exit when that process exits; tests set it to themselves), `MOCK_DESKTOP_QUIET=1` (no taskbar button).

## For tests

`@cu/mock-desktop/launch` exports `buildTeller({ cacheRoot? })` (compile and return the exe path; the build cache defaults to `%LOCALAPPDATA%\cu-mock-desktop` and moves only through this option, which becomes `teller.ps1 -CacheRoot`, never through an environment variable), `tellerLaunch()` (the command, arguments, quiet self-terminating environment, and the `allowEnv` list of the `MOCK_*` names above that the launched app is allowed to receive), `createFaultFile()`, and the demo constants.
