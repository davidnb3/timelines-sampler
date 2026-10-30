/** Where each clip of a story starts, and how long the story is, for clips played back to back with a gap. */
export function storyLayout(durationsMs: number[], gapMs: number): { starts: number[]; total: number } {
  const starts: number[] = [];
  let at = 0;
  durationsMs.forEach((d, i) => {
    starts.push(at);
    at += d + (i < durationsMs.length - 1 ? gapMs : 0);
  });
  return { starts, total: at };
}

/** The clip playing at `ms` of the story. The silence after a clip still belongs to it; -1 before the start or after the end. */
export function clipAt(starts: number[], durationsMs: number[], gapMs: number, ms: number): number {
  if (ms < 0 || starts.length === 0) return -1;
  for (let i = starts.length - 1; i >= 0; i--) {
    if (ms >= starts[i]!) return ms <= starts[i]! + durationsMs[i]! + gapMs ? i : -1;
  }
  return -1;
}

/**
 * Eases `value` toward `target` over time without overshooting: the same smoothing the timeline
 * camera uses. `rate` is per second.
 */
export function approach(value: number, target: number, dtSeconds: number, rate = 5): number {
  return value + (target - value) * (1 - Math.exp(-dtSeconds * rate));
}
