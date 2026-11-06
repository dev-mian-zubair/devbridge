# DevBridge intro video

A self-contained [Remotion](https://remotion.dev) project that renders the
~66s intro video embedded at the top of the main [README](../../README.md).
Independent of DevBridge's own `package.json`/`node_modules` — this is its
own npm project, nested here only for repo-locality.

GitHub doesn't play a repo-committed MP4 inline in a README (only a click-
through link to it, or a video uploaded through its web editor), so the
README embeds a short animated GIF (`docs/intro.gif`, ~15s) cut from the
video's more visually dynamic moments, with a link to the full 66s
narrated `docs/intro.mp4` (has audio; the GIF doesn't, and the full video
is too slow-paced as a silent loop — it was timed for narration) alongside
it.

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

# cut a few dynamic segments, speed them up ~1.4x, and re-encode (not -c copy —
# stream-copy trims snap to keyframes and glitch at the splice points)
ffmpeg -y -i intro.mp4 -filter_complex "\
[0:v]trim=start=24:end=29.5,setpts=PTS-STARTPTS[v1]; \
[0:v]trim=start=40:end=46.5,setpts=PTS-STARTPTS[v2]; \
[0:v]trim=start=49.5:end=58,setpts=PTS-STARTPTS[v3]; \
[v1][v2][v3]concat=n=3:v=1:a=0[vcat]; \
[vcat]setpts=PTS/1.4[vout]" \
-map "[vout]" -an highlight.mp4

ffmpeg -y -i highlight.mp4 -vf "fps=14,scale=960:-1:flags=lanczos,palettegen=stats_mode=diff" /tmp/palette.png
ffmpeg -y -i highlight.mp4 -i /tmp/palette.png \
  -lavfi "fps=14,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" \
  intro.gif
rm highlight.mp4
```

(Segment timestamps above match the current cut of the video — re-pick
them if the scene timings change.)

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
