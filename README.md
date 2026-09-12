# Nova Cut — AI Video Editor

A browser-based video editor (no install, no backend) with CapCut-style
editing — cut/trim/split, text overlays, Ken Burns zoom/pan, silence and
scene auto-detection — plus a natural-language command bar that can drive
every one of those tools, either offline via a built-in parser or live via
your own Claude API key.

## Features

- **Import almost anything**: MP4, MOV, WebM, MKV, AVI, HEVC/H.265, TS,
  FLV, WMV, 3GP. Files the browser can decode natively (MP4/WebM) are used
  as-is; everything else (HEVC, MKV, AVI, ...) is transparently transcoded
  to H.264/AAC MP4 in-browser via ffmpeg.wasm before it hits the timeline,
  so playback and export always work regardless of source codec/container.
- **Timeline editing**: drag to reorder clips, drag clip edges to trim,
  split at the playhead, duplicate/delete, per-clip speed.
- **Text overlays**: timed text with position, size, color, font weight,
  alignment, and fade/slide-in animation, live in the canvas preview and
  baked into the final export.
- **Zoom & pan (Ken Burns)**: per-clip zoom keyframes with a "from" and "to"
  scale/focal point, rendered live and reproduced in export with ffmpeg's
  `zoompan` filter.
- **Auto-cut**: silence detection (Web Audio RMS analysis) and scene-change
  detection (canvas frame-diff sampling) suggest — and can auto-apply — cut
  points on the selected clip.
- **AI command bar**: type instructions like
  - `split at 0:15`
  - `add text 'Hello World' from 0 to 3 top center`
  - `zoom in on clip 2 from 2 to 5`
  - `remove silence from clip 1`
  - `speed up clip 1 by 2x`

  These are matched by a built-in offline parser (no network, no API key).
  Optionally, paste an Anthropic API key in the AI settings panel (⚙) to
  have Claude translate arbitrary free-form phrasing into the same action
  schema — the key is stored only in `localStorage` and sent only to
  `api.anthropic.com`.
- **Content recognition (Claude Vision)**: the offline parser and even
  Claude's text-only mode can't resolve vague references like *"speed up
  until the last 3 cards"* or *"cut right when the pack is opened"* — they
  have no idea what's in the footage. "🔍 Recognize Video Content" (in the
  Auto-Cut tab, requires the Claude API key) samples frames from the
  selected clip and sends them to Claude's vision endpoint, which returns a
  timeline of what's actually happening (`0.0–4.2s — hand holds sealed pack
  of cards`, etc.). That timeline is cached and automatically included as
  context for every future AI command on that clip, so content-based
  instructions can be resolved to real timestamps instead of you having to
  scrub the timeline and type numbers yourself.
- **Export**: renders the full timeline (trims, speed, zoom keyframes, text
  overlays) to a downloadable H.264/AAC MP4, entirely client-side via
  ffmpeg.wasm.

## Running it

This is a static site with no build step. Any static file server works —
it just can't be opened via `file://` because it uses ES modules and Web
Workers, both of which require `http(s)://`.

```
python3 -m http.server 8080
# then open http://localhost:8080/
```

or `npx serve .`, or any equivalent.

No CDN is contacted at runtime: ffmpeg.wasm (core + JS glue) and the fonts
used for exported text are vendored under `vendor/` and `assets/fonts/`, so
the app works fully offline once served.

## Architecture

```
index.html            App shell / layout
css/styles.css         Styling
js/state.js            EditorState: clips, text overlays, zoom keyframes
js/media.js             Import: probes files, transcodes unsupported ones
js/ffmpegClient.js      ffmpeg.wasm loader (vendored, no CDN)
js/preview.js           Canvas compositor + playback loop (Ken Burns + text)
js/timeline.js          Timeline UI: drag/trim/split/reorder
js/textOverlay.js        Text overlay property panel
js/zoomEffect.js         Zoom keyframe property panel
js/autoCut.js           Silence + scene-change detection
js/aiCommands.js        NL command parser (offline) + optional Claude bridge + executor
js/visionAnalysis.js     Claude Vision: frame sampling + content-timeline recognition
js/exportPipeline.js    Builds the ffmpeg filter graph and renders the final MP4
js/app.js               Wires everything to the DOM
vendor/                Vendored ffmpeg.wasm packages (MIT) — see vendor/NOTICE.md
assets/fonts/           Roboto (Apache-2.0), used by drawtext on export
```

### How export works

1. Each clip's trimmed region is further split into segments at every zoom
   keyframe boundary.
2. Each segment is extracted and re-encoded individually — either a plain
   fit/pad pass, or ffmpeg's `zoompan` filter driven by expressions built
   from that keyframe's from/to scale and focal point (this mirrors exactly
   what the canvas preview draws).
3. All segments are concatenated (stream copy, since they share identical
   encode settings).
4. Text overlays are baked in as a chained `drawtext` pass, each windowed to
   its start/end with `enable='between(t,...)'` and an alpha ramp for the
   fade animation.

## Known limitations

- HEVC/MKV/etc. transcoding and zoompan/text rendering both run in
  single-threaded WebAssembly in the main browser tab, so long clips or 4K
  footage will be slow — this is a client-side MVP, not a hardware-
  accelerated NLE.
- Non-16:9 source video is letterboxed/pillarboxed to the 1280×720 project
  canvas rather than reframed.
- The Claude-powered command mode calls the Anthropic API directly from the
  browser for convenience during development; for a production deployment
  you'd want to proxy that call through your own backend instead of shipping
  a user's API key to client-side JS.
- No audio mixing/ducking, transitions, or multi-track video compositing
  yet — single video track with overlay text/zoom is what's implemented.
