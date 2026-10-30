import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyOrder, dropIndex, moveInOrder, stepGap, toggleKey } from './settings.ts';

const clips = ['a', 'b', 'c', 'd'].map((key) => ({ key }));
const keys = (list: { key: string }[]) => list.map((c) => c.key).join('');

describe('applyOrder', () => {
  it('keeps date order when nothing is saved', () => {
    assert.equal(keys(applyOrder(clips, [])), 'abcd');
  });

  it('follows the saved order, then appends clips it does not know', () => {
    assert.equal(keys(applyOrder(clips, ['c', 'a'])), 'cabd');
  });

  it('ignores saved keys that no longer exist', () => {
    assert.equal(keys(applyOrder(clips, ['x', 'd', 'b'])), 'dbac');
  });
});

describe('moveInOrder', () => {
  it('moves a key to an index', () => {
    assert.deepEqual(moveInOrder(['a', 'b', 'c', 'd'], 'd', 1), ['a', 'd', 'b', 'c']);
    assert.deepEqual(moveInOrder(['a', 'b', 'c', 'd'], 'a', 3), ['b', 'c', 'd', 'a']);
  });

  it('clamps the index', () => {
    assert.deepEqual(moveInOrder(['a', 'b', 'c'], 'b', 99), ['a', 'c', 'b']);
    assert.deepEqual(moveInOrder(['a', 'b', 'c'], 'b', -4), ['b', 'a', 'c']);
  });
});

describe('toggleKey', () => {
  it('adds and removes', () => {
    assert.deepEqual(toggleKey(['a'], 'b'), ['a', 'b']);
    assert.deepEqual(toggleKey(['a', 'b'], 'a'), ['b']);
  });
});

describe('stepGap', () => {
  it('moves by 100 ms within 0 to 3 s', () => {
    assert.equal(stepGap(400, 1), 500);
    assert.equal(stepGap(400, -1), 300);
    assert.equal(stepGap(0, -1), 0);
    assert.equal(stepGap(3000, 1), 3000);
  });
});

describe('dropIndex', () => {
  it('counts the chips whose middle the pointer has passed', () => {
    assert.equal(dropIndex([50, 150, 250], 10), 0);
    assert.equal(dropIndex([50, 150, 250], 160), 2);
    assert.equal(dropIndex([50, 150, 250], 999), 3);
    assert.equal(dropIndex([], 5), 0);
  });
});
