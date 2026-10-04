# Extracts frames from an mp4 at given times using Windows.Media.Editing.MediaComposition
# (Playwright's ffmpeg can't decode H.264, so this is how a reviewer inspects the rendered
# output). Usage:
#   frames.ps1 -Mp4 <path> -OutDir <dir> -EveryS 10
#   frames.ps1 -Mp4 <path> -OutDir <dir> -Times 12.5,80
param(
  [Parameter(Mandatory = $true)][string]$Mp4,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [double]$EveryS = 0,
  # Comma-separated seconds, e.g. "12.5,80" (a plain string: when this script is invoked from
  # an external process, PowerShell's -File argument binding does not auto-split a comma list
  # into a [double[]] the way the interactive console parser would).
  [string]$Times = ''
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($op, [Type]$t) {
  $task = $asTaskGeneric.MakeGenericMethod($t).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Editing.MediaComposition, Windows.Media.Editing, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.ImageStream, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

$sf = [Windows.Storage.StorageFile]
# StorageFile needs an absolute path.
$Mp4 = (Resolve-Path -LiteralPath $Mp4).ProviderPath
$file = Await ($sf::GetFileFromPathAsync($Mp4)) ([Windows.Storage.StorageFile])
$clip = Await ([Windows.Media.Editing.MediaClip]::CreateFromFileAsync($file)) ([Windows.Media.Editing.MediaClip])

$comp = New-Object Windows.Media.Editing.MediaComposition
[System.Collections.Generic.ICollection[Windows.Media.Editing.MediaClip]].GetMethod("Add").Invoke($comp.Clips, @($clip)) | Out-Null

$durationTicks = $clip.OriginalDuration.Ticks

$timesList = New-Object System.Collections.Generic.List[double]
if ($Times -and $Times.Trim().Length -gt 0) {
  foreach ($tok in ($Times -split ',')) {
    $tok = $tok.Trim()
    if ($tok.Length -gt 0) { $timesList.Add([double]$tok) }
  }
}
if ($EveryS -gt 0) {
  $durationSeconds = $durationTicks / [TimeSpan]::TicksPerSecond
  $t = 0.0
  while ($t -lt $durationSeconds) {
    $timesList.Add($t)
    $t += $EveryS
  }
}
if ($timesList.Count -eq 0) {
  throw "nothing to extract: pass -EveryS <seconds> and/or -Times <comma-separated seconds>"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path -LiteralPath $OutDir).ProviderPath

foreach ($t in $timesList) {
  $ts = [TimeSpan]::FromSeconds($t)
  if ($ts.Ticks -ge $durationTicks) { $ts = [TimeSpan]::FromTicks([Math]::Max(0, $durationTicks - 1)) }
  $imgStream = Await ($comp.GetThumbnailAsync($ts, 1280, 720, [Windows.Media.Editing.VideoFramePrecision]::NearestFrame)) ([Windows.Graphics.Imaging.ImageStream])
  $reader = New-Object Windows.Storage.Streams.DataReader($imgStream)
  $size = [uint32]$imgStream.Size
  Await ($reader.LoadAsync($size)) ([uint32]) | Out-Null
  $bytes = New-Object byte[] $size
  $reader.ReadBytes($bytes)
  $name = "frame_{0:00.00}s.jpg" -f $t
  $outPath = Join-Path $OutDir $name
  [System.IO.File]::WriteAllBytes($outPath, $bytes)
  Write-Host "wrote $outPath"
}
