import { uid } from './utils.js';

export const PROJECT = {
  width: 1280,
  height: 720,
  fps: 30,
};

// A Clip wraps a normalized (browser-playable) source and the trim/speed
// applied to it. `inPoint`/`outPoint` are seconds within the *source* file.
function makeClip({ name, url, sourceDuration }) {
  return {
    id: uid('clip'),
    name,
    url,
    sourceDuration,
    inPoint: 0,
    outPoint: sourceDuration,
    speed: 1,
  };
}

function makeTextOverlay(partial) {
  return {
    id: uid('text'),
    text: 'Your text',
    start: 0,
    end: 3,
    x: 50, // percent, center
    y: 85,
    fontSize: 48,
    color: '#ffffff',
    fontFamily: 'Inter, Arial, sans-serif',
    bold: true,
    align: 'center',
    animation: 'fade', // none | fade | slide
    ...partial,
  };
}

function makeZoomKeyframe(partial) {
  return {
    id: uid('zoom'),
    clipId: null,
    start: 0, // seconds, relative to clip's *trimmed* local timeline
    end: 2,
    fromScale: 1,
    toScale: 1.3,
    fromX: 50, // percent focal point within frame
    fromY: 50,
    toX: 50,
    toY: 50,
    ...partial,
  };
}

function makeSoundEffect(partial) {
  return {
    id: uid('sfx'),
    kind: 'builtin', // 'builtin' | 'custom' | 'freesound'
    effect: null, // builtin effect id (see soundEffects.js BUILTIN_EFFECTS)
    url: null, // custom/freesound: blob URL of the upload, or a Freesound preview URL
    name: '',
    start: 0, // global timeline seconds
    duration: 0.3,
    volume: 1,
    license: null, // freesound: license string, e.g. "Creative Commons 0"
    attribution: null, // freesound: uploader username, for license compliance
    ...partial,
  };
}

export class EditorState {
  constructor() {
    this.clips = [];
    this.textOverlays = [];
    this.zoomKeyframes = [];
    this.soundEffects = [];
    this.playhead = 0;
    this.playing = false;
    this.selection = { type: null, id: null };
    this.contentAnalysis = new Map(); // clipId -> [{start,end,description}]
    this.listeners = new Set();
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(reason) {
    for (const fn of this.listeners) fn(reason, this);
  }

  addClip({ name, url, sourceDuration }) {
    const clip = makeClip({ name, url, sourceDuration });
    this.clips.push(clip);
    this.emit('clips');
    return clip;
  }

  removeClip(clipId) {
    this.clips = this.clips.filter((c) => c.id !== clipId);
    this.zoomKeyframes = this.zoomKeyframes.filter((z) => z.clipId !== clipId);
    this.contentAnalysis.delete(clipId);
    this.emit('clips');
  }

  duplicateClip(clipId) {
    const idx = this.clips.findIndex((c) => c.id === clipId);
    if (idx === -1) return null;
    const src = this.clips[idx];
    const copy = { ...src, id: uid('clip') };
    this.clips.splice(idx + 1, 0, copy);
    this.emit('clips');
    return copy;
  }

  reorderClip(clipId, newIndex) {
    const idx = this.clips.findIndex((c) => c.id === clipId);
    if (idx === -1) return;
    const [clip] = this.clips.splice(idx, 1);
    this.clips.splice(clamp(newIndex, 0, this.clips.length), 0, clip);
    this.emit('clips');
  }

  clipDuration(clip) {
    return Math.max(0, (clip.outPoint - clip.inPoint) / (clip.speed || 1));
  }

  totalDuration() {
    return this.clips.reduce((sum, c) => sum + this.clipDuration(c), 0);
  }

  // Returns { clip, index, localTime, clipStart } for a global timeline time.
  locateTime(t) {
    let acc = 0;
    for (let i = 0; i < this.clips.length; i++) {
      const clip = this.clips[i];
      const dur = this.clipDuration(clip);
      if (t < acc + dur || i === this.clips.length - 1) {
        const localTime = clamp(t - acc, 0, dur);
        return { clip, index: i, localTime, clipStart: acc, clipDuration: dur };
      }
      acc += dur;
    }
    return null;
  }

  clipGlobalStart(clipId) {
    let acc = 0;
    for (const c of this.clips) {
      if (c.id === clipId) return acc;
      acc += this.clipDuration(c);
    }
    return 0;
  }

  splitClipAt(globalTime) {
    const loc = this.locateTime(globalTime);
    if (!loc) return;
    const { clip, localTime } = loc;
    if (localTime <= 0.05 || localTime >= this.clipDuration(clip) - 0.05) return; // too close to edge
    const splitSourceOffset = clip.inPoint + localTime * clip.speed;
    const idx = this.clips.indexOf(clip);
    const second = { ...clip, id: uid('clip'), inPoint: splitSourceOffset };
    clip.outPoint = splitSourceOffset;
    this.clips.splice(idx + 1, 0, second);
    // A split invalidates any cached content analysis spanning the old range.
    this.contentAnalysis.delete(clip.id);
    // Re-home zoom keyframes that fell in the second half.
    const movedZooms = this.zoomKeyframes.filter((z) => z.clipId === clip.id && z.start >= localTime);
    for (const z of movedZooms) {
      z.clipId = second.id;
      z.start -= localTime;
      z.end -= localTime;
    }
    this.emit('clips');
    return second;
  }

  trimClip(clipId, { inPoint, outPoint }) {
    const clip = this.clips.find((c) => c.id === clipId);
    if (!clip) return;
    if (inPoint != null) clip.inPoint = clamp(inPoint, 0, clip.outPoint - 0.05);
    if (outPoint != null) clip.outPoint = clamp(outPoint, clip.inPoint + 0.05, clip.sourceDuration);
    this.emit('clips');
  }

  setClipSpeed(clipId, speed) {
    const clip = this.clips.find((c) => c.id === clipId);
    if (!clip) return;
    clip.speed = clamp(speed, 0.25, 4);
    this.emit('clips');
  }

  addTextOverlay(partial) {
    const overlay = makeTextOverlay(partial);
    this.textOverlays.push(overlay);
    this.emit('overlays');
    return overlay;
  }

  updateTextOverlay(id, patch) {
    const o = this.textOverlays.find((x) => x.id === id);
    if (!o) return;
    Object.assign(o, patch);
    this.emit('overlays');
  }

  removeTextOverlay(id) {
    this.textOverlays = this.textOverlays.filter((o) => o.id !== id);
    this.emit('overlays');
  }

  addZoomKeyframe(partial) {
    const zoom = makeZoomKeyframe(partial);
    this.zoomKeyframes.push(zoom);
    this.emit('zooms');
    return zoom;
  }

  updateZoomKeyframe(id, patch) {
    const z = this.zoomKeyframes.find((x) => x.id === id);
    if (!z) return;
    Object.assign(z, patch);
    this.emit('zooms');
  }

  removeZoomKeyframe(id) {
    this.zoomKeyframes = this.zoomKeyframes.filter((z) => z.id !== id);
    this.emit('zooms');
  }

  activeZoomFor(clipId, localTime) {
    return this.zoomKeyframes.find(
      (z) => z.clipId === clipId && localTime >= z.start && localTime < z.end
    );
  }

  activeTextOverlays(globalTime) {
    return this.textOverlays.filter((o) => globalTime >= o.start && globalTime < o.end);
  }

  addSoundEffect(partial) {
    const sfx = makeSoundEffect(partial);
    this.soundEffects.push(sfx);
    this.emit('sfx');
    return sfx;
  }

  updateSoundEffect(id, patch) {
    const sfx = this.soundEffects.find((s) => s.id === id);
    if (!sfx) return;
    Object.assign(sfx, patch);
    this.emit('sfx');
  }

  removeSoundEffect(id) {
    this.soundEffects = this.soundEffects.filter((s) => s.id !== id);
    this.emit('sfx');
  }

  setContentAnalysis(clipId, segments) {
    this.contentAnalysis.set(clipId, segments);
    this.emit('content');
  }

  getContentAnalysis(clipId) {
    return this.contentAnalysis.get(clipId) || null;
  }

  serialize() {
    return JSON.stringify(
      {
        clips: this.clips.map(({ url, ...rest }) => rest), // urls are blob: local-only
        textOverlays: this.textOverlays,
        zoomKeyframes: this.zoomKeyframes,
        soundEffects: this.soundEffects.map(({ url, ...rest }) => rest),
      },
      null,
      2
    );
  }
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}
