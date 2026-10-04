# Explainer video

`tools/video/` builds `evidence/explainer.mp4` (1280x720, H.264/AAC) from this repo.

## Rebuild the video

You need Windows 10 or 11. The build uses the built-in speech voices and Windows Media Foundation.

1. Install dependencies:

   ```bash
   npm install
   npx playwright install chromium
   ```

2. Free ports 4183 and 4310. The build runs its own mock app on 4183, and Relay's console uses 4310 for the handoff.
3. Run the build. It takes a few minutes.

   ```bash
   npm run video:build
   ```

Runs land in `runs-video/`, and intermediate files land in `tools/video/.build/`. The build compiles Relay's UI into `apps/relay/dist` when that bundle is missing or stale, so the first build is slower than later ones.

To change the video, edit these files:

- Narration: `tools/video/script.md`
- Slides: `tools/video/slides.html`
- Recorded segments: `tools/video/record.ts`

## Extract frames for review

To pull stills out of the rendered mp4, run `tools/video/frames.ps1`:

```powershell
# every 10 seconds
powershell -File tools/video/frames.ps1 -Mp4 evidence/explainer.mp4 -OutDir <dir> -EveryS 10

# specific timestamps, for example to check that a cut lines up with its narration
powershell -File tools/video/frames.ps1 -Mp4 evidence/explainer.mp4 -OutDir <dir> -Times 12.5,40.2
```

You can combine the two flags. Frames land in `<dir>` as `frame_<seconds>s.jpg`.

## What the video shows

The narration is synthesized speech (Windows System.Speech, voice "Microsoft David Desktop"), not a recorded voice. Every terminal segment shows output that the build captured from a real command, or a real file in this repo.

The artifact on screen is `artifacts/lookup-member-savings-balance.json`. A model discovery run recorded it, two more runs extended it with its business outcomes, and one tenant override was written by hand.

The handoff is a real replay. It hits an expired session and escalates to Relay. A human takes control, finishes the step, and hands back, and the replay resumes in the same browser.

## Why the build does not use ffmpeg to encode

The ffmpeg binary that Playwright ships handles only VP8/WebM. The build renders the final H.264/AAC mp4 with Windows' `Windows.Media.Editing.MediaComposition` instead, in `tools/video/compose.ps1`. It still uses Playwright's ffmpeg to pull still frames out of the recorded WebM segments during assembly.
