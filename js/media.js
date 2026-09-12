import { canPlayNatively, normalizeToMp4 } from './ffmpegClient.js';

// Formats we always trust the browser to play, so we skip the (slow) wasm
// transcode pass. Everything else — HEVC/H.265, MKV, AVI, WMV, etc. — gets
// normalized to H.264/AAC mp4 first.
const TRUSTED_EXTENSIONS = new Set(['mp4', 'm4v', 'webm']);

function extOf(file) {
  return file.name.split('.').pop().toLowerCase();
}

function probeDuration(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = url;
    v.onloadedmetadata = () => resolve(v.duration);
    v.onerror = () => reject(new Error('Could not read video metadata'));
  });
}

// Imports a File into the editor: probes it, transcodes if needed, and
// returns { url, duration, wasTranscoded }.
export async function importVideoFile(file, { onStatus } = {}) {
  const ext = extOf(file);
  const trusted = TRUSTED_EXTENSIONS.has(ext) && canPlayNatively(file);

  if (trusted) {
    onStatus && onStatus(`Reading ${file.name}...`);
    const url = URL.createObjectURL(file);
    try {
      const duration = await probeDuration(url);
      return { url, duration, wasTranscoded: false };
    } catch {
      // Fall through to transcode — browser claimed support but failed
      // (common for HEVC-in-mp4 mislabelled files, VFR mkv-in-mp4, etc.)
    }
  }

  onStatus && onStatus(`Converting ${file.name} (${ext.toUpperCase()}) for editing...`);
  const url = await normalizeToMp4(file, (p) => {
    onStatus && onStatus(`Converting ${file.name}... ${Math.round(p * 100)}%`);
  });
  const duration = await probeDuration(url);
  return { url, duration, wasTranscoded: true };
}

export const SUPPORTED_EXTENSIONS = [
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'hevc', 'h265', 'ts', 'flv', 'wmv', '3gp',
];
