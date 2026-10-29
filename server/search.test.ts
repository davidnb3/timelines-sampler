import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveRef } from './clip.ts';
import { openDb, saveEpisode } from './db.ts';
import { buildMatches, expandWindow, searchLibrary, tokenize } from './sources/library.ts';
import { buildGdeltQuery, clipFromGdelt } from './sources/gdelt.ts';
import { normalizeTopics } from './topics.ts';
import { cleanSegments } from './whisper.ts';
import { pickMp3s } from './sources/internetArchive.ts';

const seg = (startMs: number, text: string) => ({ startMs, endMs: startMs + 2000, text });

function seed() {
  const conn = openDb(':memory:');
  saveEpisode(
    conn,
    {
      source: 'ia', extId: 'ia:x/1.mp3', show: 'Dimension X', title: 'The Man In The Moon', date: '1950-07-14',
      audioUrl: 'https://example.test/1.mp3', pageUrl: null, durationMs: null, topics: ['old-time-radio', 'sci-fi'],
    },
    [
      seg(0, 'Good evening, this is Dimension X.'),
      seg(2000, 'The planets are dying, one by one.'),
      seg(4000, 'Contact has been lost with the moon base.'),
      seg(6000, 'We are going to need more oxygen.'),
      seg(8000, 'Sign off.'),
    ],
  );
  saveEpisode(
    conn,
    {
      source: 'podcast', extId: 'pi:2', show: 'Cooking Hour', title: 'Soup', date: '2024-01-01',
      audioUrl: 'https://example.test/2.mp3', pageUrl: null, durationMs: null, topics: ['food'],
    },
    [seg(0, 'Contact your butcher about the planets of onions.')],
  );
  return conn;
}

describe('query building', () => {
  it('tokenizes punctuation away', () => {
    assert.deepEqual(tokenize("Don't panic, Arthur!"), ['dont', 'panic', 'arthur']);
  });

  it('goes from exact phrase to looser matches', () => {
    assert.deepEqual(buildMatches('the planets are dying'), [
      '"the planets are dying"',
      '"planets" AND "dying"',
      '"planets" OR "dying"',
    ]);
  });

  it('uses a single quoted word for one-word queries', () => {
    assert.deepEqual(buildMatches('Moon'), ['"moon"']);
  });

  it('returns nothing for empty queries', () => {
    assert.deepEqual(buildMatches('  !! '), []);
  });
});

describe('library search', () => {
  it('finds the phrase and widens it with neighbouring segments', () => {
    const conn = seed();
    const r = searchLibrary(conn, 'planets are dying', [], 10, 1);
    const hit = r.hits[0]!;
    assert.equal(hit.show, 'Dimension X');
    assert.match(hit.text, /Good evening/);
    assert.match(hit.text, /Contact has been lost/);
    assert.equal(hit.startMs, 0);
    assert.equal(hit.endMs, 6000);
    assert.equal(hit.ref.startsWith('ep:'), true);
  });

  it('stems words, so "planet" finds "planets"', () => {
    const conn = seed();
    const hits = searchLibrary(conn, 'planet', ['sci-fi'], 10).hits;
    assert.equal(hits.length, 1);
    assert.match(hits[0]!.text, /planets are dying/);
  });

  it('filters by topic', () => {
    const conn = seed();
    const all = searchLibrary(conn, 'planets', [], 10);
    const scifi = searchLibrary(conn, 'planets', ['sci-fi'], 10);
    assert.equal(all.hits.length, 2);
    assert.equal(scifi.hits.length, 1);
    assert.equal(scifi.hits[0]!.show, 'Dimension X');
  });

  it('falls back to looser matches when the phrase is absent', () => {
    const conn = seed();
    const r = searchLibrary(conn, 'moon base lost contact', [], 10);
    assert.equal(r.hits.length > 0, true);
  });

  it('expands a hit by whole segments', () => {
    const conn = seed();
    const hit = searchLibrary(conn, 'contact has been lost', ['sci-fi'], 5, 0).hits[0]!;
    const wider = expandWindow(conn, hit.episodeId!, hit.firstIdx!, hit.lastIdx!, 1, 1)!;
    assert.equal(wider.startMs, 2000);
    assert.equal(wider.endMs, 8000);
  });

  it('replaces an episode when it is saved again', () => {
    const conn = seed();
    saveEpisode(
      conn,
      { source: 'ia', extId: 'ia:x/1.mp3', show: 'Dimension X', title: 'Redo', date: null, audioUrl: 'u', pageUrl: null, durationMs: null, topics: ['sci-fi'] },
      [seg(0, 'Entirely new words.')],
    );
    assert.equal(searchLibrary(conn, 'oxygen', [], 5).hits.length, 0);
    assert.equal(searchLibrary(conn, 'entirely new', [], 5).hits.length, 1);
  });
});

describe('topics', () => {
  it('maps source spellings onto canonical topics and drops housekeeping subjects', () => {
    assert.deepEqual(normalizeTopics(['Science Fiction', 'Sci-Fi', 'OTR', 'OTRR', '1950', 'Dimension X']), [
      'old-time-radio',
      'sci-fi',
    ]);
  });

  it('adds forced topics', () => {
    assert.deepEqual(normalizeTopics([], ['Science Fiction', 'zines']), ['sci-fi', 'zines']);
  });
});

describe('transcript cleaning', () => {
  it('drops sound tags and runaway repeats', () => {
    const out = cleanSegments([
      seg(0, '[MUSIC]'),
      seg(1000, 'Hello there.'),
      seg(2000, 'Thank you.'),
      seg(3000, 'Thank you.'),
      seg(4000, 'Thank you.'),
      seg(5000, 'Thank you.'),
      seg(6000, '(applause)'),
      seg(7000, 'Goodbye.'),
    ]);
    assert.deepEqual(out.map((s) => s.text), ['Hello there.', 'Thank you.', 'Thank you.', 'Goodbye.']);
  });
});

describe('TV source', () => {
  it('quotes multi-word queries and adds a market', () => {
    assert.equal(buildGdeltQuery('flying saucer'), '"flying saucer" market:"National"');
    assert.equal(buildGdeltQuery('saucer'), 'saucer market:"National"');
    assert.equal(buildGdeltQuery('"flying saucer" crash'), '"flying saucer" crash market:"National"');
  });

  it('maps a GDELT clip onto a hit with padded bounds', () => {
    const hit = clipFromGdelt({
      preview_url: 'https://api.gdeltproject.org/api/v2/tvv/tvv?id=CSPAN3_20170723_040000_UFO&offset=3314',
      ia_show_id: 'CSPAN3_20170723_040000_UFO',
      date: '2017-07-23T04:55:29Z',
      station: 'CSPAN3',
      show: '20th_Century_UFO_Conspiracies',
      show_date: '2017-07-23T04:00:00Z',
      snippet: 'allegedly, flying saucer crashes',
    });
    assert.equal(hit.startMs, 3306_000);
    assert.equal(hit.endMs, 3338_000);
    assert.equal(hit.ref, 'ia:CSPAN3_20170723_040000_UFO');
    assert.equal(hit.title, '20th Century UFO Conspiracies');
    assert.equal(hit.embedUrl, 'https://archive.org/embed/CSPAN3_20170723_040000_UFO?start=3306&end=3338');
  });
});

describe('clip refs', () => {
  it('resolves library episodes but never TV refs or junk', () => {
    const conn = seed();
    const episodeId = searchLibrary(conn, 'planets', ['sci-fi'], 1).hits[0]!.episodeId;
    assert.equal(resolveRef(conn, `ep:${episodeId}`), 'https://example.test/1.mp3');
    assert.equal(resolveRef(conn, 'ia:CSPAN3_20170723_040000_UFO'), null);
    assert.equal(resolveRef(conn, 'ep:99999'), null);
    assert.equal(resolveRef(conn, 'nonsense'), null);
  });
});

describe('Internet Archive files', () => {
  it('keeps one MP3 per recording, preferring VBR', () => {
    const picked = pickMp3s([
      { name: 'a.mp3', format: 'VBR MP3', size: 10 },
      { name: 'a_64kb.mp3', format: '64Kbps MP3', size: 5 },
      { name: 'b.mp3', format: '64Kbps MP3', size: 5 },
      { name: 'a.ogg', format: 'Ogg Vorbis', size: 7 },
    ]);
    assert.deepEqual(picked.map((f) => f.name), ['a.mp3', 'b.mp3']);
  });
});
