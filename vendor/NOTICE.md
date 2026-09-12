# Vendored third-party code

This directory vendors the browser video-processing engine used for import
normalization and export, so the editor works fully offline (no CDN calls at
runtime) once this repo is cloned.

- `ffmpeg/` — [@ffmpeg/ffmpeg](https://www.npmjs.com/package/@ffmpeg/ffmpeg) 0.12.10 (MIT), ESM build.
- `ffmpeg-util/` — [@ffmpeg/util](https://www.npmjs.com/package/@ffmpeg/util) 0.12.1 (MIT), ESM build.
- `ffmpeg-core/` — [@ffmpeg/core](https://www.npmjs.com/package/@ffmpeg/core) 0.12.6 (MIT wrapper), the single-threaded
  WebAssembly build of FFmpeg itself. FFmpeg is licensed LGPL/GPL depending on
  build configuration — see https://github.com/ffmpegwasm/ffmpeg.wasm for the
  exact build flags used upstream.

None of these files are modified from their published npm packages. To
update a version, re-run:

```
npm pack @ffmpeg/ffmpeg@<version>
npm pack @ffmpeg/util@<version>
npm pack @ffmpeg/core@<version>
```

and replace the corresponding `dist/esm` (or `dist/umd` for `core`) contents.

`assets/fonts/Roboto-{Regular,Bold}.ttf` are from Google's
[Roboto](https://github.com/googlefonts/roboto) project (Apache License 2.0)
and are baked into exported video via ffmpeg's `drawtext` filter.
