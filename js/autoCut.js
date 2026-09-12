import { clamp } from './utils.js';

// Analyzes a clip's audio (source file, honoring inPoint/outPoint) and
// returns silence gaps as { start, end } in clip-local (trimmed) seconds.
export async function detectSilence(clip, { thresholdDb = -40, minSilenceMs = 400 } = {}) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const res = await fetch(clip.url);
    const arrayBuffer = await res.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const channelData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;

    const windowSize = Math.floor(sampleRate * 0.05); // 50ms windows
    const threshold = Math.pow(10, thresholdDb / 20);
    const silentWindows = [];
    for (let i = 0; i < channelData.length; i += windowSize) {
      let sumSquares = 0;
      const end = Math.min(i + windowSize, channelData.length);
      for (let j = i; j < end; j++) sumSquares += channelData[j] * channelData[j];
      const rms = Math.sqrt(sumSquares / (end - i));
      silentWindows.push({ t: i / sampleRate, silent: rms < threshold });
    }

    const gaps = [];
    let gapStart = null;
    for (const w of silentWindows) {
      if (w.silent && gapStart === null) gapStart = w.t;
      if (!w.silent && gapStart !== null) {
        if ((w.t - gapStart) * 1000 >= minSilenceMs) gaps.push({ start: gapStart, end: w.t });
        gapStart = null;
      }
    }
    if (gapStart !== null) {
      const lastT = silentWindows[silentWindows.length - 1]?.t ?? audioBuffer.duration;
      if ((lastT - gapStart) * 1000 >= minSilenceMs) gaps.push({ start: gapStart, end: lastT });
    }

    // Translate from source-file time into this clip's trimmed local time.
    const localDur = (clip.outPoint - clip.inPoint) / (clip.speed || 1);
    return gaps
      .map((g) => ({
        start: clamp((g.start - clip.inPoint) / (clip.speed || 1), 0, localDur),
        end: clamp((g.end - clip.inPoint) / (clip.speed || 1), 0, localDur),
      }))
      .filter((g) => g.end - g.start > 0.05);
  } finally {
    ctx.close();
  }
}

// Samples frames at `intervalSec` and flags large pixel-difference jumps as
// probable scene changes. Returns clip-local seconds (trimmed timeline).
export async function detectSceneChanges(clip, { intervalSec = 0.5, diffThreshold = 0.28 } = {}) {
  const video = document.createElement('video');
  video.src = clip.url;
  video.muted = true;
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = reject;
  });

  const sampleW = 32, sampleH = 18;
  const canvas = document.createElement('canvas');
  canvas.width = sampleW;
  canvas.height = sampleH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const localDur = (clip.outPoint - clip.inPoint) / (clip.speed || 1);
  let prevFrame = null;
  const cuts = [];

  for (let t = 0; t < localDur; t += intervalSec) {
    const sourceTime = clip.inPoint + t * clip.speed;
    await seekTo(video, sourceTime);
    ctx.drawImage(video, 0, 0, sampleW, sampleH);
    const frame = ctx.getImageData(0, 0, sampleW, sampleH).data;
    if (prevFrame) {
      let diff = 0;
      for (let i = 0; i < frame.length; i += 4) {
        diff += Math.abs(frame[i] - prevFrame[i]) + Math.abs(frame[i + 1] - prevFrame[i + 1]) + Math.abs(frame[i + 2] - prevFrame[i + 2]);
      }
      const normalized = diff / (sampleW * sampleH * 3 * 255);
      if (normalized > diffThreshold) cuts.push(t);
    }
    prevFrame = frame;
  }
  return cuts;
}

export function seekTo(video, time) {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = time;
  });
}
