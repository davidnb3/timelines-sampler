import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clampFade, fadeFilters, hasFade } from './fade.ts';

describe('clampFade', () => {
  it('rounds and bounds each fade', () => {
    assert.deepEqual(clampFade(120.4, -5, 5000), { inMs: 120, outMs: 0 });
    assert.deepEqual(clampFade(99_999, 0, 60_000), { inMs: 10_000, outMs: 0 });
    assert.deepEqual(clampFade(Number.NaN, 50, 1000), { inMs: 0, outMs: 50 });
  });

  it('shrinks both fades together when they would exceed the clip', () => {
    assert.deepEqual(clampFade(800, 800, 1000), { inMs: 500, outMs: 500 });
    assert.deepEqual(clampFade(900, 300, 600), { inMs: 450, outMs: 150 });
  });

  it('leaves fades that fit alone', () => {
    assert.deepEqual(clampFade(400, 600, 1000), { inMs: 400, outMs: 600 });
  });
});

describe('fadeFilters', () => {
  it('builds in and out filters relative to the clip start', () => {
    assert.deepEqual(fadeFilters({ inMs: 120, outMs: 250 }, 3000), ['afade=t=in:st=0:d=0.120', 'afade=t=out:st=2.750:d=0.250']);
  });

  it('skips a fade that is zero', () => {
    assert.deepEqual(fadeFilters({ inMs: 0, outMs: 250 }, 3000), ['afade=t=out:st=2.750:d=0.250']);
    assert.deepEqual(fadeFilters({ inMs: 0, outMs: 0 }, 3000), []);
  });
});

describe('hasFade', () => {
  it('is true only when something fades', () => {
    assert.equal(hasFade(undefined), false);
    assert.equal(hasFade({ inMs: 0, outMs: 0 }), false);
    assert.equal(hasFade({ inMs: 0, outMs: 1 }), true);
  });
});
