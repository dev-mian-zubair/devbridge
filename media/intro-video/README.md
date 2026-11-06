# DevBridge intro video

A self-contained [Remotion](https://remotion.dev) project that renders the
~66s intro video embedded at the top of the main [README](../../README.md).
Independent of DevBridge's own `package.json`/`node_modules` — this is its
own npm project, nested here only for repo-locality.

GitHub doesn't play a repo-committed MP4 inline in a README (only a click-
through link to it, or a video uploaded through its web editor), so the
README embeds an animated GIF (`docs/intro.gif`) rendered from the video,
with a link to the full-quality `docs/intro.mp4` (has audio; the GIF
doesn't) alongside it.

## Rebuilding

```bash
npm install
npm run start   # Remotion Studio — preview/edit the composition
npm run render  # renders out/intro.mp4
```

After rendering, copy the result into the main repo's `docs/` and
regenerate the GIF:

```bash
cp out/intro.mp4 ../../docs/intro.mp4
cd ../../docs
ffmpeg -y -i intro.mp4 -vf "fps=10,scale=960:-1:flags=lanczos,palettegen=stats_mode=diff" /tmp/palette.png
ffmpeg -y -i intro.mp4 -i /tmp/palette.png \
  -lavfi "fps=10,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" \
  intro.gif
```

## Structure

- `src/Intro.tsx` — the root composition, sequencing all 7 scenes and
  sizing each one from its narration clip's real duration.
- `src/scenes/Scene{1..7}*.tsx` — one file per scene (Title, Why, Quick
  start, Sign in, API call, Frameworks, Closing).
- `src/components/` — shared pieces (window-chrome mockup, typewriter text
  effect, a base scene wrapper).
- `public/audio/scene{1..7}.wav` — pre-synthesized narration (see below).
  Checked in so rebuilding the video doesn't require the TTS setup below.
- `public/images/dashboard-screenshot.png` — a real capture of DevBridge's
  dashboard, used as-is in the Sign in scene (not a recreated mockup).

## Narration

Synthesized with [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M)
(Apache-2.0, commercial-use-safe), voice `am_michael`, via the local
offline TTS tooling in the sibling `personal/cos` repo — not a dependency
of this project; only used once to produce the checked-in WAV files. To
regenerate a line (if the script changes):

```bash
echo "<narration text>" | /path/to/cos/.venv/bin/python \
  /path/to/cos/studio/scripts/kokoro_synth.py \
  --voice am_michael --speed 1.0 \
  --model /path/to/cos/assets/voices/kokoro/kokoro-v1.0.onnx \
  --voices /path/to/cos/assets/voices/kokoro/voices-v1.0.bin \
  --out public/audio/sceneN.wav
```
