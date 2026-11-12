import type { Hit } from '../api.ts';

export const DAY_MS = 86_400_000;
export const YEAR_MS = 365.2425 * DAY_MS;

/** Pixels per year: the zoom range runs from a century across a screen to a few hundred px per day. */
export const MIN_PPY = 3;
export const MAX_PPY = 120_000;

export interface View {
  /** Time at the middle of the timeline, in ms since the epoch. */
  center: number;
  /** Zoom, in pixels per year. */
  ppy: number;
}

/** UTC midnight of a calendar date; works for years below 100 too. */
export function utc(year: number, month = 0, day = 1): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month, day);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

export const MIN_TIME = utc(1900, 0, 1);
export const maxTime = (now = Date.now()) => now + 5 * YEAR_MS;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const clampTime = (t: number) => clamp(t, MIN_TIME, maxTime());

/**
 * Accepts "1955", "1955-04", "1955-04-24" or a full ISO timestamp. A bare year is placed in the
 * middle of that year, because the real day is unknown.
 */
export function parseDate(date: string | null | undefined): number | null {
  if (!date) return null;
  let t: number;
  if (/^\d{4}$/.test(date)) t = utc(Number(date), 6, 2);
  else if (/^\d{4}-\d{2}$/.test(date)) t = utc(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, 15);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(date)) t = Date.parse(`${date}T12:00:00Z`);
  else t = Date.parse(date);
  return Number.isFinite(t) ? t : null;
}

/** Identity of a saved clip: the same recording range saved twice is the same clip. */
export function pinKey(hit: Pick<Hit, 'ref' | 'startMs' | 'endMs' | 'fadeInMs' | 'fadeOutMs'>): string {
  const fades = hit.fadeInMs || hit.fadeOutMs ? `|${hit.fadeInMs ?? 0}|${hit.fadeOutMs ?? 0}` : '';
  return `${hit.ref}|${hit.startMs}|${hit.endMs}${fades}`;
}

/** Where a clip sits on the timeline: its recording date, or the day it was saved when undated. */
export function pinTime(hit: Pick<Hit, 'date'>, savedAt: number): number {
  return parseDate(hit.date) ?? savedAt;
}

export type Unit = 'day' | 'month' | 'year';

export interface Level {
  unit: Unit;
  step: number;
  /** Approximate length of one step in years. */
  years: number;
}

/** Tick granularities from finest to coarsest. Each tick of a level is also a tick of the finer one. */
export const LEVELS: readonly Level[] = [
  { unit: 'day', step: 1, years: 1 / 365.2425 },
  { unit: 'month', step: 1, years: 1 / 12 },
  { unit: 'month', step: 3, years: 3 / 12 },
  { unit: 'year', step: 1, years: 1 },
  { unit: 'year', step: 5, years: 5 },
  { unit: 'year', step: 10, years: 10 },
  { unit: 'year', step: 25, years: 25 },
  { unit: 'year', step: 50, years: 50 },
  { unit: 'year', step: 100, years: 100 },
];

/** The finest level whose labelled ticks are at least `minPx` apart at this zoom. */
export function levelFor(ppy: number, minPx = 84): Level {
  return LEVELS.find((l) => l.years * ppy >= minPx) ?? LEVELS[LEVELS.length - 1]!;
}

/** Tick times of a level inside [from, to], aligned to calendar boundaries. */
export function alignedTimes(level: Level, from: number, to: number): number[] {
  const out: number[] = [];
  const cap = 2000;
  if (level.unit === 'year') {
    const first = Math.floor(new Date(from).getUTCFullYear() / level.step) * level.step;
    for (let y = first; out.length < cap; y += level.step) {
      const t = utc(y, 0, 1);
      if (t > to) break;
      if (t >= from) out.push(t);
    }
  } else if (level.unit === 'month') {
    const start = new Date(from);
    let y = start.getUTCFullYear();
    let m = Math.floor(start.getUTCMonth() / level.step) * level.step;
    while (out.length < cap) {
      const t = utc(y, m, 1);
      if (t > to) break;
      if (t >= from) out.push(t);
      m += level.step;
      y += Math.floor(m / 12);
      m %= 12;
    }
  } else {
    for (let t = Math.floor(from / DAY_MS) * DAY_MS; t <= to && out.length < cap; t += DAY_MS * level.step) {
      if (t >= from) out.push(t);
    }
  }
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Label of a tick; `strong` marks the boundary of the next coarser unit (a decade, a new year, a new month). */
export function tickLabel(level: Level, t: number): { text: string; strong: boolean } {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  if (level.unit === 'year') return { text: String(y), strong: y % 10 === 0 };
  if (level.unit === 'month') return m === 0 ? { text: String(y), strong: true } : { text: MONTHS[m]!, strong: false };
  return day === 1 ? { text: `${MONTHS[m]} ${y}`, strong: true } : { text: String(day), strong: false };
}

/** The readout under the playhead: as precise as the zoom level is. */
export function formatFocus(t: number, ppy: number): string {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  if (ppy > 20_000) return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${y}`;
  if (ppy > 600) return `${MONTHS[d.getUTCMonth()]} ${y}`;
  return String(y);
}

/** A view that shows all the given times with some breathing room on both sides. */
export function fitView(times: number[], width: number, padPx = 150): View {
  if (times.length === 0) return { center: Date.now(), ppy: 60 };
  const lo = Math.min(...times);
  const hi = Math.max(...times);
  const center = (lo + hi) / 2;
  if (hi - lo < 7 * DAY_MS) return { center, ppy: 400 };
  const usable = Math.max(200, width - padPx * 2);
  return { center, ppy: clamp(usable / ((hi - lo) / YEAR_MS), MIN_PPY, 6000) };
}

/**
 * Where the camera should go when a clip at time `t` is added: stay put if the clip is already in
 * view, otherwise pull back far enough to show everything.
 */
export function planView(t: number, existing: number[], current: View, width: number): View {
  if (existing.length === 0) return { center: t, ppy: 400 };
  const x = width / 2 + ((t - current.center) / YEAR_MS) * current.ppy;
  if (x > width * 0.12 && x < width * 0.88) return current;
  return fitView([...existing, t], width);
}

/**
 * Keeps dots from sitting on top of each other. `xs` are the natural positions of the clips, in
 * order. Clips closer than `min` pixels form a group, fanned out evenly around where the group
 * naturally sits; a final pass makes sure neighbouring groups do not overlap either. `crowded[i]`
 * says the dot was moved because of company (its label then waits until it is hovered or focused).
 */
export function spreadPositions(xs: number[], min: number): { xs: number[]; crowded: boolean[] } {
  const out = [...xs];
  const crowded = xs.map(() => false);
  let start = 0;
  while (start < xs.length) {
    let end = start + 1;
    while (end < xs.length && xs[end]! - xs[end - 1]! < min) end++;
    const size = end - start;
    if (size > 1) {
      const centre = xs.slice(start, end).reduce((sum, x) => sum + x, 0) / size;
      for (let i = 0; i < size; i++) {
        out[start + i] = centre + (i - (size - 1) / 2) * min;
        crowded[start + i] = true;
      }
    }
    start = end;
  }
  for (let i = 1; i < out.length; i++) {
    if (out[i]! - out[i - 1]! < min) {
      out[i] = out[i - 1]! + min;
      crowded[i] = true;
      crowded[i - 1] = true;
    }
  }
  return { xs: out, crowded };
}

/**
 * Idle layout: the timeline panel starts at 46% of the window height (at least 340 px down) and reaches the
 * bottom edge, so there is no empty strip under it. The line stays where it always was, 218 px into the
 * panel (64% of the 340 px panel that used to hang there), however tall the window is.
 */
export const IDLE_PANEL_MIN = 340;
export const IDLE_PANEL_TOP_RATIO = 0.46;
export const IDLE_LINE_RATIO = 0.64;

/** The line's height as a fraction of the idle panel, for a window `viewportHeight` pixels tall. */
export function idleLineRatio(viewportHeight: number): number {
  const top = Math.max(IDLE_PANEL_TOP_RATIO * viewportHeight, IDLE_PANEL_MIN);
  const panel = Math.max(IDLE_PANEL_MIN, viewportHeight - top);
  return Math.min(IDLE_LINE_RATIO, (IDLE_LINE_RATIO * IDLE_PANEL_MIN) / panel);
}
