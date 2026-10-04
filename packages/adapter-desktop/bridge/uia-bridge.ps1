<#
.SYNOPSIS
  The UI Automation bridge for @cu/adapter-desktop: JSON lines on stdin/stdout.

.DESCRIPTION
  Started by packages/adapter-desktop/src/bridge-client.ts as
    powershell.exe -NoProfile -NonInteractive -MTA -ExecutionPolicy Bypass -File uia-bridge.ps1
  and never by hand. The protocol and the safety rules are documented in UiaBridge.cs.

  First run on a machine generates an interop assembly for the native UI Automation COM API from
  the type library inside %WINDIR%\System32\UIAutomationCore.dll (what tlbimp.exe does, using the
  .NET Framework's own TypeLibConverter, so no SDK is needed). It is cached per user under
  %LOCALAPPDATA%\cu-uia-bridge\<UIAutomationCore version> (the -CacheRoot parameter overrides the
  root, for tests; never an environment variable, which a .env file could set) and loaded only when the cache directory and both files are owned by the current user
  and the DLL's SHA-256 matches the hash recorded when it was generated; anything else is
  regenerated. Every run then compiles UiaBridge.cs against it in memory (Add-Type) and hands
  stdin/stdout to it. Exits when stdin closes.

  Needs Add-Type, so it cannot run under PowerShell Constrained Language Mode (AppLocker/WDAC).
#>
param([string]$CacheRoot)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$core = Join-Path $env:WINDIR 'System32\UIAutomationCore.dll'
$version = (Get-Item $core).VersionInfo.FileVersion -replace '[^0-9A-Za-z.]', '_'
$root = if ($CacheRoot) { $CacheRoot } else { Join-Path $env:LOCALAPPDATA 'cu-uia-bridge' }
$cacheDir = Join-Path $root $version
$dllName = 'Interop.UIAutomationClient.dll'

$me = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object System.Security.Principal.WindowsPrincipal($me)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
$adminsSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')

# True when the current user owns the path (an elevated administrator's files are owned by Administrators).
function Test-OwnedByMe([string]$path) {
  try {
    $owner = (Get-Acl -LiteralPath $path).Owner
    $sid = (New-Object System.Security.Principal.NTAccount($owner)).Translate([System.Security.Principal.SecurityIdentifier])
    return ($sid -eq $me.User) -or ($isAdmin -and $sid -eq $adminsSid)
  } catch { return $false }
}

# The DLL in $dir, if it is ours and unchanged since it was generated.
function Get-VerifiedDll([string]$dir) {
  $dll = Join-Path $dir $dllName
  $hashFile = "$dll.sha256"
  if (-not (Test-Path -LiteralPath $dll) -or -not (Test-Path -LiteralPath $hashFile)) { return $null }
  foreach ($p in @($dir, $dll, $hashFile)) { if (-not (Test-OwnedByMe $p)) { return $null } }
  $expected = (Get-Content -Raw -LiteralPath $hashFile).Trim()
  if ((Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash -ne $expected) { return $null }
  return $dll
}

$interop = Get-VerifiedDll $cacheDir
if (-not $interop) {
  Add-Type -TypeDefinition @'
using System;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
namespace CuUiaInterop {
  public class Sink : ITypeLibImporterNotifySink {
    public void ReportEvent(ImporterEventKind kind, int code, string message) { }
    public Assembly ResolveRef(object typeLib) { return null; }
  }
  public static class Generator {
    [DllImport("oleaut32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void LoadTypeLibEx(string file, int regKind, out ITypeLib typeLib);
    public static void Generate(string dll, string dir) {
      ITypeLib tl;
      LoadTypeLibEx(dll, 2 /* REGKIND_NONE */, out tl);
      var file = System.IO.Path.Combine(dir, "Interop.UIAutomationClient.dll");
      var ab = (System.Reflection.Emit.AssemblyBuilder)new TypeLibConverter().ConvertTypeLibToAssembly(
        tl, file, TypeLibImporterFlags.None, new Sink(), null, null, "Interop.UIAutomationClient", null);
      ab.Save("Interop.UIAutomationClient.dll");
    }
  }
}
'@
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  if (-not (Test-OwnedByMe $root)) { throw "the bridge cache root $root is not owned by the current user; refusing to use it" }
  # Generate into a private staging directory, record the hash, then move it into place.
  $staging = Join-Path $root ('staging-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  Push-Location $staging
  try { [CuUiaInterop.Generator]::Generate($core, $staging) } finally { Pop-Location }
  $generated = Join-Path $staging $dllName
  $hash = (Get-FileHash -LiteralPath $generated -Algorithm SHA256).Hash
  Set-Content -LiteralPath "$generated.sha256" -Value $hash -Encoding ascii
  # A stale or tampered cache directory (or one left without its DLL) is replaced, not nested into.
  if (Test-Path -LiteralPath $cacheDir) { Remove-Item -LiteralPath $cacheDir -Recurse -Force -ErrorAction SilentlyContinue }
  try { Move-Item -LiteralPath $staging -Destination $cacheDir -ErrorAction Stop } catch { }
  $nested = Join-Path $cacheDir (Split-Path -Leaf $staging)
  # Whatever happened to the move (another bridge raced us, a DLL in use could not be deleted),
  # load the copy we just generated, wherever it ended up.
  $candidates = @($cacheDir, $staging, $nested)
  $interop = $null
  foreach ($dir in $candidates) {
    $dll = Join-Path $dir $dllName
    if ((Test-Path -LiteralPath $dll) -and (Test-OwnedByMe $dll) -and (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash -eq $hash) { $interop = $dll; break }
  }
  if (-not $interop) { throw 'could not place the generated UI Automation interop assembly' }
}

Add-Type -Path $interop
Add-Type -TypeDefinition (Get-Content -Raw -Path (Join-Path $here 'UiaBridge.cs')) `
  -ReferencedAssemblies $interop, System.Drawing, System.Web.Extensions
[CuUiaBridge.Bridge]::Main()
