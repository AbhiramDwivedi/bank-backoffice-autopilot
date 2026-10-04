<#
.SYNOPSIS
  Launches Teller Workstation, the mock legacy desktop app (apps/mock-desktop/README.md).

.DESCRIPTION
  Compiles src/TellerWorkstation.cs into TellerWorkstation.exe under
  %LOCALAPPDATA%\cu-mock-desktop\<source hash> (-CacheRoot overrides the root, for tests)
  the first time this source version runs (Add-Type, the C# compiler that ships with .NET
  Framework; no repo build step), then starts it and waits for it to exit. A cached exe is run only
  when its directory and files are owned by the current user and its SHA-256 matches the hash
  recorded when it was built; anything else is rebuilt. The window is small, opens at the
  bottom-right edge of the primary screen and never takes activation.

  -BuildOnly compiles (if needed) and prints the exe path without starting it.

  Environment: MOCK_USER (default operator1), MOCK_PASSWORD (default demo-pass-123),
  MOCK_DESKTOP_FAULTS (JSON: failLookup, expireSession, slowMs), MOCK_DESKTOP_FAULT_FILE (a JSON
  control file with the same keys, re-read before every action), MOCK_DESKTOP_WATCH_PID (exit when
  that process exits), MOCK_DESKTOP_QUIET=1 (no taskbar button).

  Needs Add-Type, so it cannot run under PowerShell Constrained Language Mode.
#>
param(
  [string]$DataPath,
  [switch]$BuildOnly,
  # Build cache root, for tests. A parameter, never an environment variable: a .env file in the
  # working directory must not be able to point the launcher at a planted exe.
  [string]$CacheRoot
)
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $here 'src\TellerWorkstation.cs'
if (-not $DataPath) { $DataPath = Join-Path $here 'data\members.json' }
$DataPath = (Resolve-Path $DataPath).Path

$root = if ($CacheRoot) { $CacheRoot } else { Join-Path $env:LOCALAPPDATA 'cu-mock-desktop' }
$sourceHash = (Get-FileHash -Path $src -Algorithm SHA256).Hash.Substring(0, 16)
$dir = Join-Path $root $sourceHash
$exeName = 'TellerWorkstation.exe'

$me = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object System.Security.Principal.WindowsPrincipal($me)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
$adminsSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')

function Test-OwnedByMe([string]$path) {
  try {
    $owner = (Get-Acl -LiteralPath $path).Owner
    $sid = (New-Object System.Security.Principal.NTAccount($owner)).Translate([System.Security.Principal.SecurityIdentifier])
    return ($sid -eq $me.User) -or ($isAdmin -and $sid -eq $adminsSid)
  } catch { return $false }
}

function Get-VerifiedExe([string]$d) {
  $exe = Join-Path $d $exeName
  $hashFile = "$exe.sha256"
  if (-not (Test-Path -LiteralPath $exe) -or -not (Test-Path -LiteralPath $hashFile)) { return $null }
  foreach ($p in @($d, $exe, $hashFile)) { if (-not (Test-OwnedByMe $p)) { return $null } }
  if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne (Get-Content -Raw -LiteralPath $hashFile).Trim()) { return $null }
  return $exe
}

$exe = Get-VerifiedExe $dir
if (-not $exe) {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  if (-not (Test-OwnedByMe $root)) { throw "the build cache root $root is not owned by the current user; refusing to use it" }
  $staging = Join-Path $root ('staging-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  $built = Join-Path $staging $exeName
  Add-Type -TypeDefinition (Get-Content -Raw -Path $src) `
    -ReferencedAssemblies System.Windows.Forms, System.Drawing, System.Web.Extensions `
    -OutputAssembly $built -OutputType WindowsApplication
  $hash = (Get-FileHash -LiteralPath $built -Algorithm SHA256).Hash
  Set-Content -LiteralPath "$built.sha256" -Value $hash -Encoding ascii
  # A stale or tampered build directory (or one left without its exe) is replaced, not nested into.
  if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
  try { Move-Item -LiteralPath $staging -Destination $dir -ErrorAction Stop } catch { }
  $exe = $null
  foreach ($d in @($dir, $staging, (Join-Path $dir (Split-Path -Leaf $staging)))) {
    $candidate = Join-Path $d $exeName
    if ((Test-Path -LiteralPath $candidate) -and (Test-OwnedByMe $candidate) -and (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash -eq $hash) { $exe = $candidate; break }
  }
  if (-not $exe) { throw 'could not place the built TellerWorkstation.exe' }
}

if ($BuildOnly) { Write-Output $exe; exit 0 }

$p = Start-Process -FilePath $exe -ArgumentList ('"' + $DataPath + '"') -PassThru
$p.WaitForExit()
exit $p.ExitCode
