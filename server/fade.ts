/**
 * Fades on a clip's start and end, in milliseconds. Pure, and also imported by the web code so the
 * editor and the export agree on how fades are limited.
 */
export interface Fade {
  inMs: number;
  outMs: number;
}

export const NO_FADE: Fade = { inMs: 0, outMs: 0 };
export const MAX_FADE_MS = 10_000;

/** Rounds, bounds each fade, and shrinks both together if they would add up to more than the clip. */
export function clampFade(inMs: number, outMs: number, lengthMs: number): Fade {
  const bound = (v: number) => (Number.isFinite(v) ? Math.min(MAX_FADE_MS, Math.max(0, Math.round(v))) : 0);
  const fadeIn = bound(inMs);
  const fadeOut = bound(outMs);
  const total = fadeIn + fadeOut;
  const room = Math.max(0, lengthMs);
  if (total <= room || total === 0) return { inMs: fadeIn, outMs: fadeOut };
  const scale = room / total;
  return { inMs: Math.floor(fadeIn * scale), outMs: Math.floor(fadeOut * scale) };
}

export const hasFade = (fade: Fade | undefined): fade is Fade => !!fade && (fade.inMs > 0 || fade.outMs > 0);

/** ffmpeg `afade` filters for a clip that starts at time 0 and is `lengthMs` long. Linear, like the editor draws it. */
export function fadeFilters(fade: Fade, lengthMs: number): string[] {
  const seconds = (ms: number) => (ms / 1000).toFixed(3);
  const filters: string[] = [];
  if (fade.inMs > 0) filters.push(`afade=t=in:st=0:d=${seconds(fade.inMs)}`);
  if (fade.outMs > 0) filters.push(`afade=t=out:st=${seconds(lengthMs - fade.outMs)}:d=${seconds(fade.outMs)}`);
  return filters;
}
