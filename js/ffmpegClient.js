// Thin wrapper around ffmpeg.wasm (single-threaded core, no COOP/COEP needed).
// Everything is vendored locally under /vendor so the editor works fully
// offline once the repo is cloned/served — no CDN dependency at runtime.

const CORE_BASE = new URL('../vendor/ffmpeg-core/', import.meta.url).href;
const FFMPEG_ESM = new URL('../vendor/ffmpeg/index.js', import.meta.url).href;
const UTIL_ESM = new URL('../vendor/ffmpeg-util/index.js', import.meta.url).href;

let ffmpegPromise = null;
let toBlobURLFn = null;

export function onLog(cb) {
  logListeners.add(cb);
  return () => logListeners.delete(cb);
}
const logListeners = new Set();

export async function getFFmpeg() {
  if (ffmpegPromise) return ffmpegPromise;
  ffmpegPromise = (async () => {
    const [{ FFmpeg }, { toBlobURL, fetchFile }] = await Promise.all([
      import(/* webpackIgnore: true */ FFMPEG_ESM),
      import(/* webpackIgnore: true */ UTIL_ESM),
    ]);
    toBlobURLFn = toBlobURL;
    const ffmpeg = new FFmpeg();
    ffmpeg.on('log', ({ message }) => {
      for (const cb of logListeners) cb(message);
    });
    await ffmpeg.load({
      coreURL: await toBlobURL(`${CORE_BASE}ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${CORE_BASE}ffmpeg-core.wasm`, 'application/wasm'),
    });
    ffmpeg.fetchFile = fetchFile;
    return ffmpeg;
  })();
  return ffmpegPromise;
}

export async function fetchFileHelper(url) {
  await getFFmpeg();
  const { fetchFile } = await import(/* webpackIgnore: true */ UTIL_ESM);
  return fetchFile(url);
}

// Returns true if the browser reports it can decode this container/codec well
// enough to just use it directly without a normalization pass.
export function canPlayNatively(file) {
  const v = document.createElement('video');
  const type = file.type || guessMimeFromName(file.name);
  if (!type) return false;
  return v.canPlayType(type) !== '';
}

export function guessMimeFromName(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    hevc: 'video/mp4',
    h265: 'video/mp4',
    ts: 'video/mp2t',
    flv: 'video/x-flv',
    wmv: 'video/x-ms-wmv',
    '3gp': 'video/3gpp',
  };
  return map[ext] || '';
}

// Normalizes any supported upload into a browser-safe H.264/AAC mp4 so the
// rest of the app (preview + export) never has to worry about HEVC, VFR,
// odd containers, etc. Returns a blob: URL.
export async function normalizeToMp4(file, onProgress) {
  const ffmpeg = await getFFmpeg();
  const inName = `in_${Date.now()}${extOf(file.name)}`;
  const outName = `out_${Date.now()}.mp4`;
  ffmpeg.on('progress', ({ progress }) => onProgress && onProgress(progress));
  await ffmpeg.writeFile(inName, await ffmpeg.fetchFile(file));
  await ffmpeg.exec([
    '-i', inName,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-vf', 'scale=\'min(1920,iw)\':-2',
    '-r', '30',
    '-c:a', 'aac',
    '-ar', '48000',
    '-ac', '2',
    '-movflags', '+faststart',
    outName,
  ]);
  const data = await ffmpeg.readFile(outName);
  await ffmpeg.deleteFile(inName);
  await ffmpeg.deleteFile(outName);
  const blob = new Blob([data.buffer], { type: 'video/mp4' });
  return URL.createObjectURL(blob);
}

function extOf(name) {
  const m = /\.[^.]+$/.exec(name);
  return m ? m[0] : '.dat';
}
