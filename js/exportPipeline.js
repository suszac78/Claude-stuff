import { getFFmpeg, onLog as onFfmpegLog } from './ffmpegClient.js';
import { escapeDrawtext, clamp } from './utils.js';
import { PROJECT } from './state.js';
import { resolveEffectBuffer, audioBufferToWav } from './soundEffects.js';

// ffmpeg.wasm's exec() resolves even when the underlying command fails (it
// just logs to stderr and produces no output file), so the only reliable
// way to check whether a file has an audio stream is to run `-i` with no
// output and watch the probe info it logs.
async function probeHasAudio(ffmpeg, filename) {
  let hasAudio = false;
  const unsubscribe = onFfmpegLog((msg) => {
    if (/Stream #\d+:\d+.*Audio:/.test(msg)) hasAudio = true;
  });
  try {
    await ffmpeg.exec(['-i', filename]);
  } finally {
    unsubscribe();
  }
  return hasAudio;
}

// Splits a clip's trimmed local timeline [0, localDur) into an ordered list
// of segments, each either a plain (no-zoom) pass or covered by exactly one
// zoom keyframe. Segments always cover the full duration with no gaps.
function buildSegments(clip, localDur, zoomKeyframes) {
  const zooms = zoomKeyframes
    .filter((z) => z.clipId === clip.id && z.end > z.start)
    .map((z) => ({ ...z, start: clamp(z.start, 0, localDur), end: clamp(z.end, 0, localDur) }))
    .filter((z) => z.end - z.start > 0.02)
    .sort((a, b) => a.start - b.start);

  const segments = [];
  let cursor = 0;
  for (const z of zooms) {
    if (z.end <= cursor) continue;
    const start = Math.max(z.start, cursor);
    if (start > cursor) segments.push({ start: cursor, end: start, zoom: null });
    segments.push({ start, end: z.end, zoom: z });
    cursor = z.end;
  }
  if (cursor < localDur - 0.02) segments.push({ start: cursor, end: localDur, zoom: null });
  return segments.filter((s) => s.end - s.start > 0.02);
}

function zoompanFilter(zoom, segDurSec) {
  const frames = Math.max(1, Math.round(segDurSec * PROJECT.fps));
  const p = `(on/${frames})`;
  const z = `(${zoom.fromScale}+(${zoom.toScale}-${zoom.fromScale})*${p})`;
  const fx = `(${zoom.fromX}+(${zoom.toX}-${zoom.fromX})*${p})`;
  const fy = `(${zoom.fromY}+(${zoom.toY}-${zoom.fromY})*${p})`;
  const x = `((${fx}/100)*iw-(iw/${z})/2)`;
  const y = `((${fy}/100)*ih-(ih/${z})/2)`;
  return `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${PROJECT.width}x${PROJECT.height}:fps=${PROJECT.fps}`;
}

function fitPadFilter() {
  return `scale=${PROJECT.width}:${PROJECT.height}:force_original_aspect_ratio=decrease,pad=${PROJECT.width}:${PROJECT.height}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${PROJECT.fps}`;
}

function atempoChain(speed) {
  // atempo only accepts [0.5, 2.0] per instance; chain to cover wider ranges.
  const filters = [];
  let remaining = speed;
  while (remaining > 2.0) {
    filters.push('atempo=2.0');
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    filters.push('atempo=0.5');
    remaining /= 0.5;
  }
  filters.push(`atempo=${remaining.toFixed(4)}`);
  return filters.join(',');
}

async function fetchFontFiles(ffmpeg) {
  const [regular, bold] = await Promise.all([
    ffmpeg.fetchFile(new URL('../assets/fonts/Roboto-Regular.ttf', import.meta.url).href),
    ffmpeg.fetchFile(new URL('../assets/fonts/Roboto-Bold.ttf', import.meta.url).href),
  ]);
  await ffmpeg.writeFile('font-regular.ttf', regular);
  await ffmpeg.writeFile('font-bold.ttf', bold);
}

export async function exportProject(state, { onProgress, onLog } = {}) {
  const log = (msg) => onLog && onLog(msg);
  const progress = (p, label) => onProgress && onProgress(p, label);
  const ffmpeg = await getFFmpeg();

  progress(0.02, 'Loading source clips...');
  const clipFileNames = new Map();
  for (let i = 0; i < state.clips.length; i++) {
    const clip = state.clips[i];
    const name = `src${i}.mp4`;
    await ffmpeg.writeFile(name, await ffmpeg.fetchFile(clip.url));
    clipFileNames.set(clip.id, name);
  }

  const segmentFiles = [];
  let segCounter = 0;
  const totalClips = state.clips.length;

  for (let ci = 0; ci < totalClips; ci++) {
    const clip = state.clips[ci];
    const localDur = state.clipDuration(clip);
    const segments = buildSegments(clip, localDur, state.zoomKeyframes);
    const srcName = clipFileNames.get(clip.id);

    for (const seg of segments) {
      const sourceStart = clip.inPoint + seg.start * clip.speed;
      const sourceDur = (seg.end - seg.start) * clip.speed;
      const outName = `seg${segCounter++}.mp4`;
      const vf = [
        `setpts=(PTS-STARTPTS)/${clip.speed}`,
        seg.zoom ? zoompanFilter(seg.zoom, seg.end - seg.start) : fitPadFilter(),
      ].join(',');
      const af = clip.speed !== 1 ? `${atempoChain(clip.speed)},aresample=48000,aformat=channel_layouts=stereo` : 'aresample=48000,aformat=channel_layouts=stereo';

      await ffmpeg.exec([
        '-ss', String(sourceStart),
        '-i', srcName,
        '-t', String(sourceDur),
        '-vf', vf,
        '-af', af,
        '-r', String(PROJECT.fps),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '48000', '-ac', '2',
        outName,
      ]);
      segmentFiles.push(outName);
      progress(0.05 + 0.55 * (segmentFiles.length / Math.max(1, estimateSegmentCount(state))), `Rendering clip ${ci + 1}/${totalClips}...`);
    }
  }

  progress(0.65, 'Joining segments...');
  const concatList = segmentFiles.map((f) => `file '${f}'`).join('\n');
  await ffmpeg.writeFile('concat.txt', new TextEncoder().encode(concatList));
  await ffmpeg.exec(['-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-c', 'copy', 'concat_out.mp4']);

  let finalInput = 'concat_out.mp4';
  if (state.textOverlays.length > 0) {
    progress(0.75, 'Rendering text overlays...');
    await fetchFontFiles(ffmpeg);
    const drawtextFilters = state.textOverlays.map((o) => {
      const fontfile = o.bold ? 'font-bold.ttf' : 'font-regular.ttf';
      const xExpr = o.align === 'left' ? `(w*${o.x}/100)` : o.align === 'right' ? `(w*${o.x}/100)-text_w` : `(w*${o.x}/100)-text_w/2`;
      const yExpr = `(h*${o.y}/100)-text_h/2`;
      const fadeDur = Math.min(0.3, (o.end - o.start) / 2).toFixed(2);
      const alphaExpr = o.animation === 'fade'
        ? `:alpha='if(lt(t-${o.start},${fadeDur}),(t-${o.start})/${fadeDur},if(lt(${o.end}-t,${fadeDur}),(${o.end}-t)/${fadeDur},1))'`
        : '';
      return `drawtext=fontfile=${fontfile}:text='${escapeDrawtext(o.text)}':fontsize=${o.fontSize}:fontcolor=${o.color}:borderw=2:bordercolor=black@0.65:x=${xExpr}:y=${yExpr}:enable='between(t,${o.start},${o.end})'${alphaExpr}`;
    });
    await ffmpeg.exec([
      '-i', finalInput,
      '-vf', drawtextFilters.join(','),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      'with_text.mp4',
    ]);
    finalInput = 'with_text.mp4';
  }

  const sfxWavFiles = [];
  if (state.soundEffects.length > 0) {
    progress(0.85, 'Mixing sound effects...');
    const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
    const inputArgs = ['-i', finalInput];
    const sfxFilterParts = [];
    const sfxLabels = [];
    let inputIndex = 1;
    try {
      for (const sfx of state.soundEffects) {
        const buffer = await resolveEffectBuffer(sfx, tempCtx);
        const wavBlob = audioBufferToWav(buffer);
        const wavData = new Uint8Array(await wavBlob.arrayBuffer());
        const fname = `sfx${inputIndex}.wav`;
        await ffmpeg.writeFile(fname, wavData);
        sfxWavFiles.push(fname);
        inputArgs.push('-i', fname);
        const delayMs = Math.max(0, Math.round(sfx.start * 1000));
        const vol = sfx.volume ?? 1;
        sfxFilterParts.push(`[${inputIndex}:a]adelay=${delayMs}|${delayMs},volume=${vol}[sfx${inputIndex}]`);
        sfxLabels.push(`[sfx${inputIndex}]`);
        inputIndex++;
      }
    } finally {
      tempCtx.close();
    }
    const baseHasAudio = await probeHasAudio(ffmpeg, finalInput);
    const filterComplex = baseHasAudio
      ? `${sfxFilterParts.join(';')};[0:a]anull[a0];[a0]${sfxLabels.join('')}amix=inputs=${sfxLabels.length + 1}:duration=first:dropout_transition=0:normalize=0[aout]`
      : `${sfxFilterParts.join(';')};${sfxLabels.join('')}amix=inputs=${sfxLabels.length}:duration=longest:dropout_transition=0:normalize=0[aout]`;
    await ffmpeg.exec([
      ...inputArgs,
      '-filter_complex', filterComplex,
      '-map', '0:v',
      '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      'with_sfx.mp4',
    ]);
    finalInput = 'with_sfx.mp4';
  }

  progress(0.95, 'Finalizing...');
  const data = await ffmpeg.readFile(finalInput);
  const blob = new Blob([data.buffer], { type: 'video/mp4' });

  for (const f of [...clipFileNames.values(), ...segmentFiles, ...sfxWavFiles, 'concat.txt', 'concat_out.mp4', 'with_text.mp4', 'with_sfx.mp4']) {
    try { await ffmpeg.deleteFile(f); } catch {}
  }

  progress(1, 'Done!');
  log('Export complete.');
  return blob;
}

function estimateSegmentCount(state) {
  let count = 0;
  for (const clip of state.clips) {
    count += Math.max(1, buildSegments(clip, state.clipDuration(clip), state.zoomKeyframes).length);
  }
  return count;
}

export function downloadBlob(blob, filename = 'export.mp4') {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
