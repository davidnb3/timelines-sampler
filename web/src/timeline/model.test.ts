import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  idleLineRatio,
  LEVELS, YEAR_MS, spreadPositions, alignedTimes, fitView, formatFocus, levelFor, parseDate, pinKey, pinTime, planView, tickLabel, utc,
} from './model.ts';

const year = (t: number) => new Date(t).getUTCFullYear();

describe('parseDate', () => {
  it('reads years, months, days and timestamps', () => {
    assert.equal(parseDate('1955-04-24'), Date.parse('1955-04-24T12:00:00Z'));
    assert.equal(parseDate('2020-06-14T19:29:49Z'), Date.parse('2020-06-14T19:29:49Z'));
    assert.equal(year(parseDate('1955')!), 1955);
    assert.equal(new Date(parseDate('1955-04')!).getUTCMonth(), 3);
  });

  it('puts a bare year in the middle of the year', () => {
    const t = parseDate('1955')!;
    assert.ok(t > utc(1955, 3, 1) && t < utc(1955, 9, 1));
  });

  it('returns null for nothing and for garbage', () => {
    assert.equal(parseDate(null), null);
    assert.equal(parseDate(''), null);
    assert.equal(parseDate('sometime'), null);
  });
});

describe('pinKey and pinTime', () => {
  it('identifies a clip by recording and range', () => {
    assert.equal(pinKey({ ref: 'ep:3', startMs: 100, endMs: 900 }), 'ep:3|100|900');
    assert.notEqual(pinKey({ ref: 'ep:3', startMs: 100, endMs: 900 }), pinKey({ ref: 'ep:3', startMs: 100, endMs: 1900 }));
    // The same range with a fade is a different clip; without fades the key is what it always was.
    assert.notEqual(pinKey({ ref: 'ep:3', startMs: 100, endMs: 900 }), pinKey({ ref: 'ep:3', startMs: 100, endMs: 900, fadeInMs: 50 }));
    assert.equal(pinKey({ ref: 'ep:3', startMs: 100, endMs: 900, fadeInMs: 0, fadeOutMs: 0 }), 'ep:3|100|900');
  });

  it('falls back to the save time for undated clips', () => {
    assert.equal(pinTime({ date: null }, 42), 42);
    assert.equal(pinTime({ date: '1955-04-24' }, 42), parseDate('1955-04-24'));
  });
});

describe('levelFor', () => {
  it('moves from decades to days as the zoom increases', () => {
    assert.equal(levelFor(3).step, 50);
    assert.deepEqual(levelFor(100), { unit: 'year', step: 1, years: 1 });
    assert.equal(levelFor(2000).unit, 'month');
    assert.equal(levelFor(60_000).unit, 'day');
  });

  it('keeps labelled ticks at least minPx apart', () => {
    for (const ppy of [3, 10, 40, 150, 700, 5000, 30_000]) {
      const level = levelFor(ppy);
      assert.ok(level.years * ppy >= 84 || level === LEVELS[LEVELS.length - 1], `ppy ${ppy}`);
    }
  });
});

describe('alignedTimes', () => {
  it('aligns year ticks to the step', () => {
    const ticks = alignedTimes({ unit: 'year', step: 10, years: 10 }, utc(1943), utc(1968));
    assert.deepEqual(ticks.map(year), [1950, 1960]);
  });

  it('steps through months across a year boundary', () => {
    const ticks = alignedTimes({ unit: 'month', step: 1, years: 1 / 12 }, utc(1954, 10, 20), utc(1955, 2, 10));
    assert.deepEqual(ticks, [utc(1954, 11, 1), utc(1955, 0, 1), utc(1955, 1, 1), utc(1955, 2, 1)]);
  });

  it('includes the boundaries themselves and returns day ticks at UTC midnight', () => {
    const days = alignedTimes({ unit: 'day', step: 1, years: 1 / 365.2425 }, utc(1955, 3, 24), utc(1955, 3, 26));
    assert.deepEqual(days, [utc(1955, 3, 24), utc(1955, 3, 25), utc(1955, 3, 26)]);
  });

  it('every tick of a coarser level is a tick of the finer one', () => {
    for (let i = 1; i < LEVELS.length - 3; i++) {
      // Day ticks are capped per call, so the finest levels are compared over a short range.
      const from = utc(1940);
      const to = i <= 3 ? utc(1943) : utc(2030);
      const fine = new Set(alignedTimes(LEVELS[i - 1]!, from, to));
      assert.ok(alignedTimes(LEVELS[i]!, from, to).every((t) => fine.has(t)), `level ${i}`);
    }
  });
});

describe('tickLabel', () => {
  it('names months, years and days and marks boundaries as strong', () => {
    assert.deepEqual(tickLabel({ unit: 'month', step: 1, years: 1 / 12 }, utc(1955, 0, 1)), { text: '1955', strong: true });
    assert.deepEqual(tickLabel({ unit: 'month', step: 1, years: 1 / 12 }, utc(1955, 2, 1)), { text: 'Mar', strong: false });
    assert.deepEqual(tickLabel({ unit: 'year', step: 1, years: 1 }, utc(1950)), { text: '1950', strong: true });
    assert.deepEqual(tickLabel({ unit: 'day', step: 1, years: 1 / 365 }, utc(1955, 3, 9)), { text: '9', strong: false });
    assert.deepEqual(tickLabel({ unit: 'day', step: 1, years: 1 / 365 }, utc(1955, 3, 1)), { text: 'Apr 1955', strong: true });
  });
});

describe('formatFocus', () => {
  it('is as precise as the zoom', () => {
    const t = utc(1955, 3, 24);
    assert.equal(formatFocus(t, 100), '1955');
    assert.equal(formatFocus(t, 3000), 'Apr 1955');
    assert.equal(formatFocus(t, 50_000), '24 Apr 1955');
  });
});

describe('fitView and planView', () => {
  it('shows every time and centres between the extremes', () => {
    const a = utc(1941);
    const b = utc(1955);
    const v = fitView([a, b], 1400);
    assert.equal(v.center, (a + b) / 2);
    const px = ((b - a) / YEAR_MS) * v.ppy;
    assert.ok(px <= 1400 - 2 * 150 + 1);
  });

  it('uses a month-scale view for a single day', () => {
    assert.equal(fitView([utc(1955, 3, 24)], 1400).ppy, 400);
  });

  it('keeps the camera still when the new clip is already in view', () => {
    const current = fitView([utc(1941), utc(1955)], 1400);
    assert.equal(planView(utc(1948), [utc(1941), utc(1955)], current, 1400), current);
  });

  it('pulls back to include a clip that is out of view', () => {
    const current = fitView([utc(1941), utc(1955)], 1400);
    const v = planView(utc(2024), [utc(1941), utc(1955)], current, 1400);
    assert.ok(v.ppy < current.ppy);
    assert.ok(v.center > current.center);
  });

  it('centres on the first clip', () => {
    const t = utc(1955, 3, 24);
    assert.equal(planView(t, [], { center: Date.now(), ppy: 60 }, 1400).center, t);
  });
});

describe('spreadPositions', () => {
  it('leaves well separated dots alone', () => {
    assert.deepEqual(spreadPositions([0, 100, 300], 20), { xs: [0, 100, 300], crowded: [false, false, false] });
  });

  it('fans out dots on the same spot, centred on where they were', () => {
    const { xs, crowded } = spreadPositions([200, 200, 200], 20);
    assert.deepEqual(xs, [180, 200, 220]);
    assert.deepEqual(crowded, [true, true, true]);
  });

  it('spreads a close pair evenly', () => {
    assert.deepEqual(spreadPositions([100, 108], 20).xs, [94, 114]);
  });

  it('keeps neighbouring groups from overlapping', () => {
    const { xs } = spreadPositions([100, 100, 100, 130], 20);
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i]! - xs[i - 1]! >= 20 - 1e-9, `gap ${i}`);
  });

  it('handles none and one', () => {
    assert.deepEqual(spreadPositions([], 20), { xs: [], crowded: [] });
    assert.deepEqual(spreadPositions([50], 20), { xs: [50], crowded: [false] });
  });
});

describe('idleLineRatio', () => {
  it('keeps the usual 64% when the window is short', () => {
    assert.ok(Math.abs(idleLineRatio(500) - 0.64) < 1e-9);
    assert.ok(Math.abs(idleLineRatio(620) - 0.64) < 1e-9);
  });

  it('keeps the line the same distance from the top of the panel when the window is taller', () => {
    for (const vh of [800, 1000, 1400]) {
      const top = Math.max(0.46 * vh, 340);
      const panel = vh - top;
      assert.ok(Math.abs(idleLineRatio(vh) * panel - 0.64 * 340) < 0.001, `window ${vh}`);
    }
  });

  it('never goes above 64%', () => {
    for (let vh = 300; vh <= 2000; vh += 50) assert.ok(idleLineRatio(vh) <= 0.64);
  });
});
