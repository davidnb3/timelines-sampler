import { STORY_GAP_MS } from '../api.ts';

/**
 * How a timeline's story is put together, saved with the timeline: the order of its clips (keys;
 * clips not listed follow in date order), the clips left out, and the silence between clips.
 */
export interface StorySettings {
  order: string[];
  muted: string[];
  gapMs: number;
}

export const DEFAULT_STORY: StorySettings = { order: [], muted: [], gapMs: STORY_GAP_MS };

export const MAX_GAP_MS = 3000;
export const GAP_STEP_MS = 100;

/** `dated` is the clips in date order. The saved order wins; clips it does not know yet follow in date order. */
export function applyOrder<T extends { key: string }>(dated: T[], order: string[]): T[] {
  const byKey = new Map(dated.map((c) => [c.key, c]));
  const listed = order.flatMap((key) => (byKey.has(key) ? [byKey.get(key)!] : []));
  const seen = new Set(listed.map((c) => c.key));
  return [...listed, ...dated.filter((c) => !seen.has(c.key))];
}

/** Moves `key` so that it ends up at `toIndex` of the list (counted after removing it). */
export function moveInOrder(keys: string[], key: string, toIndex: number): string[] {
  const without = keys.filter((k) => k !== key);
  const at = Math.min(without.length, Math.max(0, toIndex));
  return [...without.slice(0, at), key, ...without.slice(at)];
}

/** Adds the key to the list, or removes it when it is there. */
export function toggleKey(list: string[], key: string): string[] {
  return list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
}

/** One step more or less silence, kept between 0 and 3 s. */
export function stepGap(gapMs: number, direction: 1 | -1): number {
  return Math.min(MAX_GAP_MS, Math.max(0, gapMs + direction * GAP_STEP_MS));
}

/**
 * Where a dragged chip lands: the index among the other chips, from the pointer's x and the
 * horizontal midpoints of the chips (in order, excluding the dragged one).
 */
export function dropIndex(midpoints: number[], x: number): number {
  let index = 0;
  for (const mid of midpoints) if (x > mid) index++;
  return index;
}
