/**
 * Public entry for the desktop surface: `createDesktopSurface` (Windows, UI Automation through
 * the bridge in ../bridge), the in-process fake bridge and fake Teller Workstation used by tests
 * on any OS, and the pieces the CLI needs to launch an app. Other modules depend on `Surface` only.
 */
export { createDesktopSurface, DesktopSurface, type BridgeConnection, type DesktopSurfaceOptions } from './surface.js';
export { BridgeCallError, BridgeClient, BridgeProcess, startUiaBridge, UIA_BRIDGE_SCRIPT, type StartBridgeOptions } from './bridge-client.js';
export { appEnvironment, parseCommandLine, processAlive, type AppLaunch } from './launch.js';
export { desktopScreenMaskFromPolicy, MASKED_TEXT, type DesktopScreenMask } from './mask.js';
export { createFakeTeller, FakeBridge, FakeBridgeError, FakeTellerApp, type FakeDesktopApp, type FakeTellerFaults, type FakeTellerOptions } from './fake-bridge.js';
export type { WireHumanEvent, WireSnapshot } from './protocol.js';
