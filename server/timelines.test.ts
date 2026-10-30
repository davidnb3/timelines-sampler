import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDb } from './db.ts';
import {
  addClip, cleanName, createTimeline, deleteTimeline, duplicateTimeline, getTimeline, listTimelines, removeClip,
  renameTimeline, validateClip, TimelineError,
} from './timelines.ts';

const clip = (key: string, savedAt = 1000) => ({ key, savedAt, hit: { ref: 'ep:1', startMs: 1000, endMs: 4000, show: 'Dimension X', text: 'Hello.' } });

describe('cleanName', () => {
  it('trims, collapses spaces and limits the length', () => {
    assert.equal(cleanName('  My   first  story '), 'My first story');
    assert.equal(cleanName('x'.repeat(100)).length, 60);
  });

  it('rejects empty and non-string names', () => {
    assert.throws(() => cleanName('   '), TimelineError);
    assert.throws(() => cleanName(undefined), TimelineError);
    assert.throws(() => cleanName(5), TimelineError);
  });
});

describe('validateClip', () => {
  it('accepts a clip and defaults savedAt', () => {
    const c = validateClip({ key: 'ep:1|1000|4000', hit: { ref: 'ep:1', startMs: 1000, endMs: 4000 } });
    assert.equal(c.key, 'ep:1|1000|4000');
    assert.ok(Number.isFinite(c.savedAt));
  });

  it('rejects clips the server cannot use', () => {
    assert.throws(() => validateClip(null), /key/);
    assert.throws(() => validateClip({ key: 'k', hit: { ref: 'ep:1', startMs: 'a', endMs: 2 } }), /hit/);
    assert.throws(() => validateClip({ key: 'k', hit: { ref: 'ep:1', startMs: 1, endMs: 2, text: 'x'.repeat(30_000) } }), /too large/);
  });
});

describe('timelines', () => {
  it('creates, lists and reads back with clips', () => {
    const conn = openDb(':memory:');
    const a = createTimeline(conn, 'First', [clip('a'), clip('b', 2000)]);
    createTimeline(conn, 'Second');
    assert.deepEqual(listTimelines(conn).map((t) => [t.name, t.clipCount]), [['First', 2], ['Second', 0]]);
    const detail = getTimeline(conn, a.id);
    assert.deepEqual(detail.clips.map((c) => c.key), ['a', 'b']);
    assert.equal(detail.clips[0]!.hit.show, 'Dimension X');
  });

  it('adds clips once and removes them', () => {
    const conn = openDb(':memory:');
    const t = createTimeline(conn, 'Story');
    addClip(conn, t.id, clip('a'));
    assert.equal(addClip(conn, t.id, clip('a')).clipCount, 1);
    addClip(conn, t.id, clip('b'));
    assert.equal(removeClip(conn, t.id, 'a').clipCount, 1);
    assert.deepEqual(getTimeline(conn, t.id).clips.map((c) => c.key), ['b']);
  });

  it('renames', () => {
    const conn = openDb(':memory:');
    const t = createTimeline(conn, 'Old');
    assert.equal(renameTimeline(conn, t.id, 'New name').name, 'New name');
  });

  it('duplicates with its own copy of the clips', () => {
    const conn = openDb(':memory:');
    const t = createTimeline(conn, 'Story', [clip('a')]);
    const copy = duplicateTimeline(conn, t.id);
    assert.equal(copy.name, 'Story copy');
    assert.notEqual(copy.id, t.id);
    removeClip(conn, copy.id, 'a');
    assert.equal(getTimeline(conn, t.id).clips.length, 1);
  });

  it('deletes a timeline with its clips', () => {
    const conn = openDb(':memory:');
    const t = createTimeline(conn, 'Gone', [clip('a')]);
    deleteTimeline(conn, t.id);
    assert.equal(listTimelines(conn).length, 0);
    assert.equal((conn.prepare('SELECT COUNT(*) AS n FROM timeline_clips').get() as { n: number }).n, 0);
  });

  it('answers 404 for a timeline that does not exist', () => {
    const conn = openDb(':memory:');
    for (const fn of [() => getTimeline(conn, 9), () => renameTimeline(conn, 9, 'x'), () => deleteTimeline(conn, 9), () => addClip(conn, 9, clip('a'))]) {
      assert.throws(fn, (e: unknown) => e instanceof TimelineError && e.status === 404);
    }
  });

  it('rolls back a create with an invalid clip', () => {
    const conn = openDb(':memory:');
    assert.throws(() => createTimeline(conn, 'Bad', [{ key: '', hit: {} }]), TimelineError);
    assert.equal(listTimelines(conn).length, 0);
  });
});
