# Vendored: TensorFlow.js + COCO-SSD (free, local object recognition)

- `tf.min.js` — [@tensorflow/tfjs](https://www.npmjs.com/package/@tensorflow/tfjs) 4.22.0 (Apache-2.0), browser UMD bundle.
- `coco-ssd.min.js` — [@tensorflow-models/coco-ssd](https://www.npmjs.com/package/@tensorflow-models/coco-ssd) 2.2.3 (Apache-2.0), browser UMD bundle.

Both are loaded as plain `<script>` tags (they set `window.tf` / `window.cocoSsd`),
lazily, only when the user clicks "Recognize Video Content" and does not have
a Claude API key configured.

The actual COCO-SSD model weights (~20MB) are **not** vendored here — they're
fetched at runtime directly from Google's public
`storage.googleapis.com/tfjs-models/` bucket, the standard hosting location
used by every consumer of this model. This keeps the repo small; it does mean
the free recognition path needs network access to `storage.googleapis.com`
the first time it runs per browser session (the model is then cached in
memory for the rest of the session).

This is genuinely free: everything runs as WebAssembly/WebGL inference in the
visitor's own browser, no server, no API key, no per-use cost to anyone. The
trade-off is quality — COCO-SSD only recognizes 80 everyday object classes
(person, cup, chair, cell phone, etc.), so it can't produce rich, specific
descriptions the way Claude's vision model can (see `../NOTICE.md` and
`js/visionAnalysis.js` for that optional, paid alternative).
