# Batch text-to-speech with System.Speech. Reads a plan JSON (one PowerShell process for the
# whole batch, not one per clip) and writes one WAV per item.
#
# Plan JSON shape: { "outDir": "<dir>", "items": [ { "id": "c01", "text": "..." }, ... ] }
# Output: <outDir>/<id>.wav, 44.1kHz 16-bit mono PCM.
param(
  [Parameter(Mandatory = $true)][string]$PlanFile,
  [string]$Voice = "Microsoft David Desktop",
  [int]$Rate = 1
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Speech

$plan = Get-Content -Raw -Path $PlanFile | ConvertFrom-Json
$outDir = $plan.outDir
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $synth.SelectVoice($Voice)
} catch {
  $available = ($synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }) -join ', '
  Write-Error "voice '$Voice' not found. Installed voices: $available"
  throw
}
$synth.Rate = $Rate

$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  44100,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono
)

$count = 0
foreach ($item in $plan.items) {
  $outPath = Join-Path $outDir ("$($item.id).wav")
  $synth.SetOutputToWaveFile($outPath, $fmt)
  $synth.Speak([string]$item.text)
  $synth.SetOutputToNull()
  Write-Host "synthesized $($item.id) -> $outPath"
  $count++
}
Write-Host "done: $count clip(s) synthesized with voice '$Voice' rate $Rate"
