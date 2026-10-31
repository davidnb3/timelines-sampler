import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { singleflight } from './singleflight.ts';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe('singleflight', () => {
  it('runs the work once for callers that overlap, and shares the result', async () => {
    let runs = 0;
    const work = async () => {
      runs++;
      await tick();
      return 'done';
    };
    const results = await Promise.all([singleflight('a', work), singleflight('a', work), singleflight('a', work)]);
    assert.deepEqual(results, ['done', 'done', 'done']);
    assert.equal(runs, 1);
  });

  it('runs again once the first has finished', async () => {
    let runs = 0;
    const work = async () => ++runs;
    assert.equal(await singleflight('b', work), 1);
    assert.equal(await singleflight('b', work), 2);
  });

  it('does not mix up different keys', async () => {
    const [x, y] = await Promise.all([singleflight('x', async () => 'x'), singleflight('y', async () => 'y')]);
    assert.deepEqual([x, y], ['x', 'y']);
  });

  it('shares a failure with everyone waiting, then allows a retry', async () => {
    const fail = async () => {
      await tick();
      throw new Error('boom');
    };
    const settled = await Promise.allSettled([singleflight('c', fail), singleflight('c', fail)]);
    assert.deepEqual(settled.map((s) => s.status), ['rejected', 'rejected']);
    assert.equal(await singleflight('c', async () => 'ok'), 'ok');
  });
});
