/**
 * Pure helpers for trimming a clip on its waveform. Times are absolute milliseconds in the source
 * recording unless a name says otherwise. The waveform shows a window around the clip (so edges can
 * be dragged outward, as in Ableton's arrangement view) and the region is the part that is played,
 * saved and pinned.
 */

/** Peak resolution: one value per 2 ms. */
export const PEAKS_PER_SEC = 500;
/** Audio shown on each side of the clip, for trimming outward. */
export const WINDOW_PAD_MS = 8000;
/** The shortest region the edges can be dragged to. */
export const MIN_REGION_MS = 100;

import { clampFade, NO_FADE, type Fade } from '../../server/fade.ts';

export { clampFade, NO_FADE };
export type { Fade };

export interface Segment {
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface Region {
  a: number;
  b: number;
}

export const clampNumber = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The span of the source that is loaded for editing a clip. */
export function windowFor(startMs: number, endMs: number, pad = WINDOW_PAD_MS): { startMs: number; endMs: number } {
  return { startMs: Math.max(0, startMs - pad), endMs: endMs + pad };
}

/**
 * Loudness per 1/`perSec` second bucket, 0..1 and scaled to the loudest bucket, taken as the
 * maximum absolute sample over all channels.
 */
export function buildPeaks(channels: ArrayLike<number>[], sampleRate: number, perSec = PEAKS_PER_SEC): Float32Array {
  const length = channels[0]?.length ?? 0;
  const bucket = Math.max(1, Math.floor(sampleRate / perSec));
  const peaks = new Float32Array(Math.ceil(length / bucket));
  let top = 0.001;
  for (let i = 0; i < peaks.length; i++) {
    let max = 0;
    const end = Math.min(length, (i + 1) * bucket);
    for (const channel of channels) {
      for (let j = i * bucket; j < end; j++) {
        const v = Math.abs(channel[j]!);
        if (v > max) max = v;
      }
    }
    peaks[i] = max;
    if (max > top) top = max;
  }
  for (let i = 0; i < peaks.length; i++) peaks[i] = peaks[i]! / top;
  return peaks;
}

/** The loudest peak between two times (relative to the start of the peaks), for drawing one pixel column. */
export function peakBetween(peaks: Float32Array, fromMs: number, toMs: number, perSec = PEAKS_PER_SEC): number {
  const from = Math.max(0, Math.floor((fromMs / 1000) * perSec));
  const to = Math.min(peaks.length - 1, Math.max(from, Math.ceil((toMs / 1000) * perSec)));
  let max = 0;
  for (let i = from; i <= to; i++) if (peaks[i]! > max) max = peaks[i]!;
  return max;
}

/** Moves `t` onto the nearest target if one is within `thresholdMs`. */
export function snapTime(t: number, targets: number[], thresholdMs: number): { t: number; snapped: boolean } {
  let best = t;
  let bestDistance = thresholdMs + 1;
  for (const target of targets) {
    const d = Math.abs(target - t);
    if (d < bestDistance) {
      best = target;
      bestDistance = d;
    }
  }
  return bestDistance <= thresholdMs ? { t: best, snapped: true } : { t, snapped: false };
}

/** Where the transcript puts sentence boundaries inside the window: the places edges snap to. */
export function boundaries(segments: Segment[]): number[] {
  return [...new Set(segments.flatMap((s) => [s.startMs, s.endMs]))].sort((x, y) => x - y);
}

/** Drags one edge to `t`, keeping the region inside the window and at least `min` long. */
export function dragEdge(
  region: Region,
  edge: 'a' | 'b',
  t: number,
  win: { startMs: number; endMs: number },
  min = MIN_REGION_MS,
): Region {
  if (edge === 'a') return { a: clampNumber(t, win.startMs, region.b - min), b: region.b };
  return { a: region.a, b: clampNumber(t, region.a + min, win.endMs) };
}

/** Slides the whole region by `delta`, keeping its length and staying inside the window. */
export function moveRegion(region: Region, delta: number, win: { startMs: number; endMs: number }): Region {
  const length = region.b - region.a;
  const a = clampNumber(region.a + delta, win.startMs, win.endMs - length);
  return { a, b: a + length };
}

/**
 * The transcript text for a region: every segment that mostly lies inside it. Segments are
 * sentence-sized (whisper), so a selection in the middle of a long one still returns that sentence.
 */
export function selectText(
  segments: Segment[],
  region: Region,
): { text: string; firstIdx: number | undefined; lastIdx: number | undefined } {
  const length = region.b - region.a;
  const picked = segments.filter((s) => {
    const overlap = Math.min(s.endMs, region.b) - Math.max(s.startMs, region.a);
    if (overlap <= 0) return false;
    return overlap >= 0.4 * (s.endMs - s.startMs) || overlap >= 0.4 * length;
  });
  return {
    text: picked.map((s) => s.text.trim()).join(' '),
    firstIdx: picked[0]?.idx,
    lastIdx: picked[picked.length - 1]?.idx,
  };
}

/** A clip's fades as stored on its hit. */
export function fadeOf(hit: { fadeInMs?: number; fadeOutMs?: number }): Fade {
  return { inMs: hit.fadeInMs ?? 0, outMs: hit.fadeOutMs ?? 0 };
}

/** Loudness (0..1) of a region at absolute time `t`: it fades in from its start and out toward its end. */
export function fadeGain(t: number, region: Region, fade: Fade): number {
  if (fade.inMs > 0 && t < region.a + fade.inMs) return Math.max(0, (t - region.a) / fade.inMs);
  if (fade.outMs > 0 && t > region.b - fade.outMs) return Math.max(0, (region.b - t) / fade.outMs);
  return 1;
}

/** Drags a fade handle to time `t` (absolute ms); the two fades together never exceed the region. */
export function dragFade(which: 'in' | 'out', region: Region, fade: Fade, t: number): Fade {
  const length = region.b - region.a;
  if (which === 'in') return { inMs: Math.round(clampNumber(t - region.a, 0, length - fade.outMs)), outMs: fade.outMs };
  return { inMs: fade.inMs, outMs: Math.round(clampNumber(region.b - t, 0, length - fade.inMs)) };
}

/**
 * A clip after the user changed its region or fades: the new range and fades, the transcript text
 * inside the range, and the indexes of the segments that text came from.
 */
export function editedHit<T extends { startMs: number; endMs: number; text: string; firstIdx?: number; lastIdx?: number; fadeInMs?: number; fadeOutMs?: number }>(
  hit: T,
  region: Region,
  fades: Fade,
  segments: Segment[],
): T {
  const picked = selectText(segments, region);
  return {
    ...hit,
    startMs: Math.round(region.a),
    endMs: Math.round(region.b),
    text: picked.text,
    firstIdx: picked.firstIdx ?? hit.firstIdx,
    lastIdx: picked.lastIdx ?? hit.lastIdx,
    // Absent rather than 0, so clips without fades look exactly as they did before fades existed.
    fadeInMs: fades.inMs > 0 ? fades.inMs : undefined,
    fadeOutMs: fades.outMs > 0 ? fades.outMs : undefined,
  };
}
