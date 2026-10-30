import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseBounce } from './bounce.ts';

const clips = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ ref: `ep:${i + 1}`, start: 1000, end: 4000 })));

describe('parseBounce', () => {
  it('accepts clips and applies defaults', () => {
    const spec = parseBounce(clips(2), null, null);
    assert.equal(spec.clips.length, 2);
    assert.equal(spec.gapMs, 400);
    assert.equal(spec.format, 'mp3');
    assert.deepEqual(spec.clips[0], { ref: 'ep:1', startMs: 1000, endMs: 4000, fade: { inMs: 0, outMs: 0 } });
  });

  it('reads gap and format, and clamps the gap', () => {
    assert.equal(parseBounce(clips(1), '0', 'wav').gapMs, 0);
    assert.equal(parseBounce(clips(1), '250', 'wav').format, 'wav');
    assert.equal(parseBounce(clips(1), '999999', 'mp3').gapMs, 5000);
    assert.equal(parseBounce(clips(1), 'abc', 'mp3').gapMs, 0);
  });

  it('keeps the fades of each clip, limited to its length', () => {
    const spec = parseBounce('[{"ref":"ep:1","start":0,"end":1000,"fi":120,"fo":250},{"ref":"ep:2","start":0,"end":600,"fi":900,"fo":300}]', null, null);
    assert.deepEqual(spec.clips[0]!.fade, { inMs: 120, outMs: 250 });
    assert.deepEqual(spec.clips[1]!.fade, { inMs: 450, outMs: 150 });
  });

  it('rejects bad input', () => {
    assert.throws(() => parseBounce(null, null, null), /JSON/);
    assert.throws(() => parseBounce('[]', null, null), /No clips/);
    assert.throws(() => parseBounce('{"a":1}', null, null), /No clips/);
    assert.throws(() => parseBounce(clips(61), null, null), /At most/);
    assert.throws(() => parseBounce('[{"ref":"ep:1","start":5,"end":2}]', null, null), /start and end/);
    assert.throws(() => parseBounce('[{"ref":3,"start":1,"end":2}]', null, null), /start and end/);
    assert.throws(() => parseBounce('[{"ref":"ep:1","start":0,"end":2000000}, {"ref":"ep:1","start":0,"end":2000000}]', null, null), /30 minutes/);
  });
});
