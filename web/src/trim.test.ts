import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  boundaries, buildPeaks, dragEdge, dragFade, editedHit, fadeGain, fadeOf, moveRegion, peakBetween, selectText, snapTime, windowFor, type Segment,
} from './trim.ts';

const win = { startMs: 1000, endMs: 11_000 };
const seg = (idx: number, startMs: number, endMs: number, text: string): Segment => ({ idx, startMs, endMs, text });

describe('windowFor', () => {
  it('pads both sides and never goes before the start of the recording', () => {
    assert.deepEqual(windowFor(20_000, 25_000), { startMs: 12_000, endMs: 33_000 });
    assert.deepEqual(windowFor(3000, 5000), { startMs: 0, endMs: 13_000 });
  });
});

describe('buildPeaks', () => {
  it('takes the loudest sample per bucket over all channels and scales to 1', () => {
    const left = new Float32Array(1000).fill(0.1);
    const right = new Float32Array(1000).fill(0);
    right[600] = -0.8;
    const peaks = buildPeaks([left, right], 500, 50); // 10 samples per bucket
    assert.equal(peaks.length, 100);
    assert.equal(Math.max(...peaks), 1);
    assert.ok(Math.abs(peaks[0]! - 0.125) < 1e-6);
    assert.equal(peaks[60], 1);
  });

  it('is empty for no audio', () => {
    assert.equal(buildPeaks([], 44100).length, 0);
  });
});

describe('peakBetween', () => {
  it('returns the maximum inside the range', () => {
    const peaks = Float32Array.from([0.1, 0.9, 0.2, 0.3]);
    assert.equal(peakBetween(peaks, 0, 4, 1000), Math.fround(0.9));
    assert.equal(peakBetween(peaks, 2, 3, 1000), Math.fround(0.3));
  });
});

describe('snapTime', () => {
  it('snaps to the nearest target within the threshold only', () => {
    assert.deepEqual(snapTime(1030, [1000, 2000], 50), { t: 1000, snapped: true });
    assert.deepEqual(snapTime(1500, [1000, 2000], 50), { t: 1500, snapped: false });
    assert.deepEqual(snapTime(1970, [1000, 2000, 1990], 50), { t: 1990, snapped: true });
  });
});

describe('boundaries', () => {
  it('lists segment starts and ends once, in order', () => {
    assert.deepEqual(boundaries([seg(1, 0, 1000, 'a'), seg(2, 1000, 2500, 'b')]), [0, 1000, 2500]);
  });
});

describe('dragEdge', () => {
  it('moves the start edge, keeping a minimum length and the window', () => {
    assert.deepEqual(dragEdge({ a: 3000, b: 6000 }, 'a', 4000, win), { a: 4000, b: 6000 });
    assert.deepEqual(dragEdge({ a: 3000, b: 6000 }, 'a', 9000, win), { a: 5900, b: 6000 });
    assert.deepEqual(dragEdge({ a: 3000, b: 6000 }, 'a', 0, win), { a: 1000, b: 6000 });
  });

  it('moves the end edge the same way', () => {
    assert.deepEqual(dragEdge({ a: 3000, b: 6000 }, 'b', 8000, win), { a: 3000, b: 8000 });
    assert.deepEqual(dragEdge({ a: 3000, b: 6000 }, 'b', 2000, win), { a: 3000, b: 3100 });
    assert.deepEqual(dragEdge({ a: 3000, b: 6000 }, 'b', 99_000, win), { a: 3000, b: 11_000 });
  });
});

describe('moveRegion', () => {
  it('slides and keeps the length, stopping at the window edges', () => {
    assert.deepEqual(moveRegion({ a: 3000, b: 6000 }, 1000, win), { a: 4000, b: 7000 });
    assert.deepEqual(moveRegion({ a: 3000, b: 6000 }, -9000, win), { a: 1000, b: 4000 });
    assert.deepEqual(moveRegion({ a: 3000, b: 6000 }, 99_000, win), { a: 8000, b: 11_000 });
  });
});

describe('selectText', () => {
  const segments = [seg(4, 1000, 3000, 'First.'), seg(5, 3000, 6000, ' Second.'), seg(6, 6000, 20_000, 'A very long third one.')];

  it('joins the segments that mostly lie inside the region', () => {
    assert.deepEqual(selectText(segments, { a: 1000, b: 6000 }), { text: 'First. Second.', firstIdx: 4, lastIdx: 5 });
  });

  it('ignores a segment that only grazes the region', () => {
    assert.equal(selectText(segments, { a: 2900, b: 6100 }).text, 'Second.');
  });

  it('returns the sentence when the region sits inside one long segment', () => {
    assert.deepEqual(selectText(segments, { a: 8000, b: 10_000 }), { text: 'A very long third one.', firstIdx: 6, lastIdx: 6 });
  });

  it('is empty when the region has no speech', () => {
    assert.deepEqual(selectText(segments, { a: 30_000, b: 31_000 }), { text: '', firstIdx: undefined, lastIdx: undefined });
  });
});

describe('fadeOf', () => {
  it('reads the fades of a hit, none when absent', () => {
    assert.deepEqual(fadeOf({}), { inMs: 0, outMs: 0 });
    assert.deepEqual(fadeOf({ fadeInMs: 120, fadeOutMs: 40 }), { inMs: 120, outMs: 40 });
  });
});

describe('fadeGain', () => {
  const region = { a: 1000, b: 5000 };
  const fade = { inMs: 500, outMs: 1000 };

  it('ramps up at the start, stays at 1, ramps down at the end', () => {
    assert.equal(fadeGain(1000, region, fade), 0);
    assert.equal(fadeGain(1250, region, fade), 0.5);
    assert.equal(fadeGain(3000, region, fade), 1);
    assert.equal(fadeGain(4500, region, fade), 0.5);
    assert.equal(fadeGain(5000, region, fade), 0);
  });

  it('is 1 everywhere without fades', () => {
    assert.equal(fadeGain(1000, region, { inMs: 0, outMs: 0 }), 1);
  });
});

describe('dragFade', () => {
  const region = { a: 1000, b: 5000 };

  it('sets the fade from the handle position, never below zero', () => {
    assert.deepEqual(dragFade('in', region, { inMs: 0, outMs: 0 }, 1600), { inMs: 600, outMs: 0 });
    assert.deepEqual(dragFade('in', region, { inMs: 300, outMs: 0 }, 400), { inMs: 0, outMs: 0 });
    assert.deepEqual(dragFade('out', region, { inMs: 0, outMs: 0 }, 4200), { inMs: 0, outMs: 800 });
  });

  it('keeps the two fades from overlapping', () => {
    assert.deepEqual(dragFade('in', region, { inMs: 0, outMs: 1000 }, 99_000), { inMs: 3000, outMs: 1000 });
    assert.deepEqual(dragFade('out', region, { inMs: 3500, outMs: 0 }, 0), { inMs: 3500, outMs: 500 });
  });
});

describe('editedHit', () => {
  const hit = { startMs: 1000, endMs: 4000, text: 'old', firstIdx: 1, lastIdx: 1, show: 'X' };
  const segments = [{ idx: 7, startMs: 5000, endMs: 7000, text: 'New line.' }];

  it('takes the new range, the text inside it and the fades', () => {
    const next = editedHit(hit, { a: 5000.4, b: 7000 }, { inMs: 120, outMs: 0 }, segments);
    assert.deepEqual(next, { startMs: 5000, endMs: 7000, text: 'New line.', firstIdx: 7, lastIdx: 7, fadeInMs: 120, fadeOutMs: undefined, show: 'X' });
  });

  it('keeps the old segment indexes when the new range has no speech', () => {
    const next = editedHit(hit, { a: 9000, b: 9500 }, { inMs: 0, outMs: 0 }, segments);
    assert.equal(next.text, '');
    assert.equal(next.firstIdx, 1);
  });
});
