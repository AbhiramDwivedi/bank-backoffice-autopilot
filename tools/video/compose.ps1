# Builds a Windows.Media.Editing.MediaComposition from a plan JSON and renders it to an mp4
# (H.264 video + AAC audio). Static, parameterised: nothing here is generated per run, only the
# plan file (written by assemble.ts) changes.
#
# Plan JSON shape:
# {
#   "outputMp4": "<path>", "width": 1280, "height": 720,
#   "frameRateNum": 25, "frameRateDen": 1, "videoKbps": 550, "audioKbps": 96,
#   "clips": [
#     { "kind": "video", "file": "<webm>", "trimStartMs": 0, "durationMs": 4000 },
#     { "kind": "image", "file": "<png>", "durationMs": 2000 }
#   ],
#   "audioTracks": [ { "file": "<wav>", "delayMs": 250 }, ... ]
# }
param(
  [Parameter(Mandatory = $true)][string]$PlanFile
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$asTaskProg = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperationWithProgress`2' })[0]

function Await($op, [Type]$t) {
  $task = $asTaskGeneric.MakeGenericMethod($t).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Editing.MediaComposition, Windows.Media.Editing, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.MediaProperties.MediaEncodingProfile, Windows.Media.MediaProperties, ContentType = WindowsRuntime] | Out-Null

$sf = [Windows.Storage.StorageFile]
$plan = Get-Content -Raw -Path $PlanFile | ConvertFrom-Json

$comp = New-Object Windows.Media.Editing.MediaComposition
$clipAdd = [System.Collections.Generic.ICollection[Windows.Media.Editing.MediaClip]].GetMethod("Add")
$audioAdd = [System.Collections.Generic.ICollection[Windows.Media.Editing.BackgroundAudioTrack]].GetMethod("Add")

Write-Host "building composition: $($plan.clips.Count) clip item(s), $($plan.audioTracks.Count) audio track(s)"

# Actual start of every picture item. A webm can decode slightly shorter than its planned length,
# so narration is anchored to where its clip really starts, not to the plan, to keep sync.
$actualStartTicks = New-Object System.Collections.Generic.List[long]
$cursorTicks = [long]0
$shortfallMs = 0.0
foreach ($item in $plan.clips) {
  $file = Await ($sf::GetFileFromPathAsync($item.file)) ([Windows.Storage.StorageFile])
  if ($item.kind -eq 'video') {
    $clip = Await ([Windows.Media.Editing.MediaClip]::CreateFromFileAsync($file)) ([Windows.Media.Editing.MediaClip])
    $trimStart = [TimeSpan]::FromMilliseconds([double]$item.trimStartMs)
    $wantDuration = [TimeSpan]::FromMilliseconds([double]$item.durationMs)
    $trimEndTicks = $clip.OriginalDuration.Ticks - $trimStart.Ticks - $wantDuration.Ticks
    if ($trimEndTicks -lt 0) { $trimEndTicks = 0 }
    $clip.TrimTimeFromStart = $trimStart
    $clip.TrimTimeFromEnd = [TimeSpan]::FromTicks($trimEndTicks)
  } else {
    $wantDuration = [TimeSpan]::FromMilliseconds([double]$item.durationMs)
    $clip = Await ([Windows.Media.Editing.MediaClip]::CreateFromImageFileAsync($file, $wantDuration)) ([Windows.Media.Editing.MediaClip])
  }
  $clipAdd.Invoke($comp.Clips, @($clip)) | Out-Null
  $actualStartTicks.Add($cursorTicks)
  $cursorTicks += $clip.TrimmedDuration.Ticks
  $shortfallMs += [double]$item.durationMs - $clip.TrimmedDuration.TotalMilliseconds
  $itemShort = [double]$item.durationMs - $clip.TrimmedDuration.TotalMilliseconds
  if ($itemShort -gt 1000) { throw ("picture item {0} ({1}) is {2:N0} ms shorter than planned; the recording is truncated" -f $actualStartTicks.Count, $item.file, $itemShort) }
}
Write-Host ("picture items total {0:N1}s; shortfall vs plan {1:N0} ms (narration re-anchored)" -f ($cursorTicks / 1e7), $shortfallMs)

$actualLines = New-Object System.Collections.Generic.List[string]
foreach ($a in $plan.audioTracks) {
  $wavFile = Await ($sf::GetFileFromPathAsync($a.file)) ([Windows.Storage.StorageFile])
  $bg = Await ([Windows.Media.Editing.BackgroundAudioTrack]::CreateFromFileAsync($wavFile)) ([Windows.Media.Editing.BackgroundAudioTrack])
  if ($null -ne $a.clipIndex) {
    $bg.Delay = [TimeSpan]::FromTicks($actualStartTicks[[int]$a.clipIndex]) + [TimeSpan]::FromMilliseconds([double]$a.leadMs)
  } else {
    $bg.Delay = [TimeSpan]::FromMilliseconds([double]$a.delayMs)
  }
  $actualLines.Add(("{0}  narration starts {1:N2}s" -f (Split-Path -Leaf $a.file), $bg.Delay.TotalSeconds))
  $audioAdd.Invoke($comp.BackgroundAudioTracks, @($bg)) | Out-Null
}

Set-Content -Encoding UTF8 -Path (Join-Path (Split-Path -Parent $PlanFile) 'actual-timeline.txt') -Value $actualLines
$outDir = Split-Path -Parent $plan.outputMp4
$outName = Split-Path -Leaf $plan.outputMp4
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$folder = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($outDir)) ([Windows.Storage.StorageFolder])
$outFile = Await ($folder.CreateFileAsync($outName, [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])

$prof = [Windows.Media.MediaProperties.MediaEncodingProfile]::CreateMp4([Windows.Media.MediaProperties.VideoEncodingQuality]::HD720p)
$prof.Video.Width = [uint32]$plan.width
$prof.Video.Height = [uint32]$plan.height
$prof.Video.FrameRate.Numerator = [uint32]$plan.frameRateNum
$prof.Video.FrameRate.Denominator = [uint32]$plan.frameRateDen
$prof.Video.Bitrate = [uint32]([double]$plan.videoKbps * 1000)
$prof.Audio.Bitrate = [uint32]([double]$plan.audioKbps * 1000)

Write-Host "rendering to $($plan.outputMp4) ($($plan.width)x$($plan.height) @ $($plan.frameRateNum)/$($plan.frameRateDen)fps, video=$($plan.videoKbps)kbps audio=$($plan.audioKbps)kbps)"
$renderOp = $comp.RenderToFileAsync($outFile, [Windows.Media.Editing.MediaTrimmingPreference]::Precise, $prof)
$renderTask = $asTaskProg.MakeGenericMethod([Windows.Media.Transcoding.TranscodeFailureReason], [double]).Invoke($null, @($renderOp))
$renderTask.Wait(-1) | Out-Null
$reason = $renderTask.Result
Write-Host "render result: $reason"
if ($reason -ne [Windows.Media.Transcoding.TranscodeFailureReason]::None) {
  Write-Error "render failed: $reason"
  exit 1
}
Write-Host "wrote $($plan.outputMp4)"
