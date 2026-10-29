import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatDate, formatTime, highlightParts } from './format.ts';

const matched = (text: string, terms: string[]) =>
  highlightParts(text, terms)
    .filter((p) => p.match)
    .map((p) => p.text.trim());

describe('highlightParts', () => {
  it('marks searched words and their simple inflections', () => {
    assert.deepEqual(matched('The planets are dying, planet by planet.', ['planet']), ['planets', 'planet', 'planet.']);
  });

  it('does not mark longer words that merely start with the term', () => {
    assert.deepEqual(matched('radio devices and radioactive clouds', ['radio']), ['radio']);
  });

  it('returns the text untouched when there are no terms', () => {
    assert.deepEqual(highlightParts('hello there', []), [{ text: 'hello there', match: false }]);
  });

  it('keeps all the original text', () => {
    const text = "Good. We'll try, in any event.";
    assert.equal(highlightParts(text, ['try']).map((p) => p.text).join(''), text);
  });
});

describe('formatTime', () => {
  it('formats minutes and hours', () => {
    assert.equal(formatTime(83_000), '01:23');
    assert.equal(formatTime(4_466_000), '1:14:26');
    assert.equal(formatTime(-5), '00:00');
  });
});

describe('formatDate', () => {
  it('handles year-only, day and timestamp dates, and nothing', () => {
    assert.equal(formatDate('1955'), '1955');
    assert.equal(formatDate('1955-04-24'), 'Apr 24, 1955');
    assert.equal(formatDate('2020-06-14T19:29:49Z'), 'Jun 14, 2020');
    assert.equal(formatDate(null), null);
  });
});
