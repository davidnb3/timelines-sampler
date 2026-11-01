import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { filmDate, filmShow, filmTitle, filmTopics, itemOf, recordingsByItem, type CatalogEntry } from './peoplesSpeechFilms.ts';

describe('itemOf', () => {
  it('takes the Internet Archive item from a recording id', () => {
    assert.equal(itemOf('HowTexti1948_SLASH_HowTexti1948_DOT_mp3'), 'HowTexti1948');
    assert.equal(itemOf('gov_DOT_uscourts_DOT_ca5_DOT_16-50468_SLASH_x_DOT_mp3'), 'gov.uscourts.ca5.16-50468');
  });
});

describe('recordingsByItem', () => {
  it('collects all recordings of one item', () => {
    const catalog: CatalogEntry[] = [
      ['A_SLASH_a1_DOT_mp3', 10, 1000, 3],
      ['A_SLASH_a2_DOT_mp3', 5, 500, 4],
      ['B_SLASH_b_DOT_mp3', 7, 700, 4],
    ];
    const by = recordingsByItem(catalog);
    assert.equal(by.size, 2);
    assert.deepEqual(by.get('A')?.map((r) => r.shard), [3, 4]);
  });
});

describe('filmDate', () => {
  it('reads year, month and day precisions', () => {
    assert.equal(filmDate('1958', 'x'), '1958');
    assert.equal(filmDate('ca. 1941', 'x'), '1941');
    assert.equal(filmDate('1941-03', 'x'), '1941-03');
    assert.equal(filmDate('1941-03-12T00:00:00Z', 'x'), '1941-03-12');
  });
  it('treats January 1st as a bare year', () => {
    assert.equal(filmDate('1950-01-01', 'x'), '1950');
  });
  it('falls back to a year at the end of the item name', () => {
    assert.equal(filmDate(null, 'HowTexti1948'), '1948');
    assert.equal(filmDate('unknown', 'Californ1958'), '1958');
    assert.equal(filmDate(null, 'Nightofthelivingdead'), null);
  });
  it('ignores implausible years', () => {
    assert.equal(filmDate('2024', 'x'), null);
  });
});

describe('filmTitle', () => {
  it('moves a trailing article to the front', () => {
    assert.equal(filmTitle('Snob, The', 'SnobThe1958'), 'The Snob');
    assert.equal(filmTitle('Food for America (Part I)', 'f'), 'Food for America (Part I)');
  });
  it('uses the item name when there is no title', () => {
    assert.equal(filmTitle(undefined, 'abc'), 'abc');
  });
});

describe('filmTopics and filmShow', () => {
  it('adds the topics of every film collection and the subjects we know', () => {
    assert.deepEqual(filmTopics(['SciFi_Horror'], ['Science fiction', 'Aliens']), ['film', 'horror', 'sci-fi']);
    assert.deepEqual(filmTopics(['prelinger'], ['Social guidance']), ['film', 'prelinger']);
  });
  it('names the source by collection', () => {
    assert.equal(filmShow(['prelinger', 'moviesandfilms']), 'Prelinger Archives');
    assert.equal(filmShow(['feature_films']), 'Public-domain film');
  });
});
