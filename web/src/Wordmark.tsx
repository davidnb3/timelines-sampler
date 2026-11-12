import { useEffect, type CSSProperties } from 'react';
import { CORE, rollRows, WORD } from './wordmark.ts';

/** If the animation never reports its end (a hidden tab), the intro is over after this long. */
const GIVE_UP_MS = 5000;

/**
 * The name in the top bar. With `intro`, it starts as a timecode at zero and each letter rolls in from a column
 * counting up, left to right, once (see `rollRows`); afterwards, and for people who asked for less motion, it is
 * the plain word with the "l" in the accent colour.
 */
export function Wordmark({ intro, onDone }: { intro: boolean; onDone: () => void }) {
  useEffect(() => {
    if (!intro) return;
    const t = setTimeout(onDone, GIVE_UP_MS);
    return () => clearTimeout(t);
  }, [intro, onDone]);

  if (!intro) {
    return (
      <span className="brand-name">
        Time<span className="brand-l">l</span>ines
      </span>
    );
  }
  const rows = rollRows();
  return (
    <span className="brand-name" role="img" aria-label="Timelines">
      {rows.map((column, i) => (
        <span key={i} className="roll-col" aria-hidden>
          <span
            className="roll-strip"
            style={{ '--i': i, '--n': column.length } as CSSProperties}
            onAnimationEnd={i === WORD.length - 1 ? onDone : undefined}
          >
            {column.map((glyph, k) => {
              const last = k === column.length - 1;
              return (
                <span key={k} className={`roll-d${last ? ' roll-f' : ''}${last && i === CORE ? ' brand-l' : ''}`}>
                  {glyph}
                </span>
              );
            })}
          </span>
        </span>
      ))}
    </span>
  );
}
