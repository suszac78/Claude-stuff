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
- **AI command bar**: three selectable modes (AI settings panel, ⚙), same
  action schema underneath:
  - **Pattern Matching (default)**: free, instant, fully offline. Only
    understands exact phrasings like `split at 0:15`,
    `add text 'Hello World' from 0 to 3 top center`,
    `zoom in on clip 2 from 2 to 5`, `remove silence from clip 1`,
    `speed up clip 1 by 2x`.
  - **Free Local AI**: free, no account, *real* natural-language
    understanding — phrase things however you like. Runs a small
    instruction-tuned language model entirely in your browser via WebGPU
    ([WebLLM](https://github.com/mlc-ai/web-llm)), no server, no API key.
    Needs a WebGPU-capable browser (Chrome/Edge; not Safari/Firefox by
    default). Two quality tiers, picked in the same panel (model weights
    are cached by the browser after the first download — see
    `vendor/webllm/NOTICE.md`):
    - *Fast* — [Llama-3.2-1B-Instruct](https://huggingface.co/mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC), ~880MB.
    - *Smarter* (default) — [Phi-3.5-mini-instruct](https://huggingface.co/mlc-ai/Phi-3.5-mini-instruct-q4f16_1-MLC), ~3.8B params, ~3.7GB, meaningfully better instruction-following, slower per response.

    No model that fits in a browser tab matches a frontier model like
    Claude — this narrows that gap, not closes it.
  - **Claude API**: best quality, phrase requests however you like, at the
    cost of API usage on your own key — paste it in the same panel; it's
    stored only in `localStorage` and sent only to `api.anthropic.com`.
  - **Gemini API**: the same bring-your-own-key idea, for anyone who already
    has a [Google Gemini](https://aistudio.google.com/apikey) key instead of
    a Claude one — sent only to `generativelanguage.googleapis.com`. Same
    action schema, same executor, same vision-recognition support as
    Claude — just a different provider underneath.
- **Content recognition**: the offline parser and even Claude's text-only
  mode can't resolve vague references like *"speed up until the last 3
  cards"* or *"cut right when the pack is opened"* — they have no idea
  what's in the footage. "🔍 Recognize Video Content" (Auto-Cut tab) samples
  frames from the selected clip and analyzes them, producing a timeline of
  what's actually happening. That timeline is cached and automatically fed
  into every future AI command on that clip, so content-based instructions
  can be resolved to real timestamps instead of you scrubbing the timeline
  and typing numbers by hand. Follows whichever AI command bar mode is
  selected, same output shape from all three:
  - **Free, local, no account (default — Pattern Matching/Free Local AI
    modes)**: runs [TensorFlow.js](https://www.tensorflow.org/js) + the
    COCO-SSD object detector entirely in your browser — no API key, no
    server, no cost to anyone. It recognizes 80 common object classes
    (person, cup, phone, chair, ...) and produces coarser labels like
    `visible: person, cup`. The ~20MB model weights are fetched once per
    session from Google's public model bucket the first time you use it.
  - **Claude Vision / Gemini Vision (Claude API / Gemini API modes)**: uses
    that provider's vision model instead, producing much richer, specific
    descriptions (`hand tears open a sealed pack of cards`) since it isn't
    limited to a fixed class list — at the cost of API usage on your key.
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

Editing and export need no CDN at runtime: ffmpeg.wasm (core + JS glue), the
fonts used for exported text, and the TensorFlow.js/COCO-SSD JS libraries are
all vendored under `vendor/` and `assets/fonts/`. The one exception is the
free local content-recognition feature, which fetches the ~20MB COCO-SSD
model weights from Google's public `storage.googleapis.com` model bucket the
first time you use it per session (see `vendor/tfjs/NOTICE.md`) — everything
else works fully offline once served.

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
js/aiCommands.js        NL command parser (offline) + Claude bridge + shared action schema/parser + executor
js/geminiClient.js       Gemini API bridge (text command parsing + vision), mirrors aiCommands.js/visionAnalysis.js
js/localLLM.js           WebLLM: free local NL command parsing via a small in-browser LLM, no key needed
js/visionAnalysis.js     Claude Vision: frame sampling + content-timeline recognition (paid, needs a key)
js/localVision.js        TensorFlow.js/COCO-SSD: free local object recognition, no key needed
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
- The free local recognition path (COCO-SSD) only knows 80 generic object
  classes — it can spot "person" or "cell phone" but has no concept of, say,
  a specific card trick, so it can't produce the same specific descriptions
  Claude Vision can. It's a real, useful, zero-cost floor, not a full
  replacement for Claude Vision on content-specific instructions.
- Likewise, "Free Local AI" command parsing (WebLLM) is a real language
  model, not pattern matching, but even the larger "Smarter" tier (3.8B) is
  tiny next to Claude — it will misparse, drop, or refuse to resolve parts
  of long, multi-clause, ambiguous instructions in a way Claude usually
  won't, especially ones that depend on content it has no way to see
  concrete numbers for (durations, "the last N seconds", etc.). It also
  requires WebGPU (Chrome/Edge) and a one-time download (880MB–3.7GB
  depending on tier).
