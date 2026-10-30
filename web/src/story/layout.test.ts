import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { approach, clipAt, storyLayout } from './layout.ts';

describe('storyLayout', () => {
  it('places clips back to back with a gap between them, none after the last', () => {
    assert.deepEqual(storyLayout([4000, 3500, 5000], 400), { starts: [0, 4400, 8300], total: 13_300 });
  });

  it('handles one clip and none', () => {
    assert.deepEqual(storyLayout([2000], 400), { starts: [0], total: 2000 });
    assert.deepEqual(storyLayout([], 400), { starts: [], total: 0 });
  });
});

describe('clipAt', () => {
  const durations = [4000, 3500, 5000];
  const { starts } = storyLayout(durations, 400);

  it('finds the clip for a time, counting the gap after a clip as part of it', () => {
    assert.equal(clipAt(starts, durations, 400, 0), 0);
    assert.equal(clipAt(starts, durations, 400, 4200), 0);
    assert.equal(clipAt(starts, durations, 400, 4400), 1);
    assert.equal(clipAt(starts, durations, 400, 13_000), 2);
  });

  it('is -1 outside the story', () => {
    assert.equal(clipAt(starts, durations, 400, -5), -1);
    assert.equal(clipAt(starts, durations, 400, 20_000), -1);
    assert.equal(clipAt([], [], 400, 10), -1);
  });
});

describe('approach', () => {
  it('moves toward the target and never past it', () => {
    const v = approach(0, 1, 0.1);
    assert.ok(v > 0 && v < 1);
    assert.ok(approach(v, 1, 0.1) > v);
    assert.equal(approach(1, 1, 1), 1);
  });
});
