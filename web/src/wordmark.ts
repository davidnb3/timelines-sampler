export const WORD = 'Timelines';
/** The 5th letter is the centre of the nine, where the logo has its orange bar. */
export const CORE = Math.floor(WORD.length / 2);

/**
 * What each letter rolls through on its way in. Before the roll all nine columns read 0, a timecode at zero. Each
 * column then counts up from 0 like an odometer, and the further right it is, the more digits it passes (two for
 * the first, ten for the last), so the last letters spin the longest, like the seconds of a clock. The last row of
 * every column is its letter.
 */
export function rollRows(): string[][] {
  return [...WORD].map((letter, i) => [...Array.from({ length: i + 2 }, (_, d) => String(d)), letter]);
}
