import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dateFromName, titleFromName } from './naming.ts';

describe('dateFromName', () => {
  it('reads two-digit years from old-time-radio file names', () => {
    assert.equal(dateFromName('XMinusOne55-04-24001NoContact.mp3'), '1955-04-24');
  });

  it('reads four-digit years', () => {
    assert.equal(dateFromName('Dimension_X_1950-04-08__01_OuterLimit.mp3'), '1950-04-08');
  });

  it('maps low two-digit years to the 2000s', () => {
    assert.equal(dateFromName('show 12-03-09.mp3'), '2012-03-09');
  });

  it('rejects impossible dates and names without one', () => {
    assert.equal(dateFromName('episode 55-13-40.mp3'), null);
    assert.equal(dateFromName('The Man In The Moon.mp3'), null);
  });
});

describe('titleFromName', () => {
  it('drops the extension and the date, and splits joined words', () => {
    assert.equal(titleFromName('Dimension_X_1950-04-08__01_OuterLimit.mp3'), 'Dimension X 01 Outer Limit');
    assert.equal(titleFromName('XMinusOne55-04-24001NoContact.mp3'), 'X Minus One 001 No Contact');
  });

  it('leaves already readable names alone', () => {
    assert.equal(titleFromName('The Man In The Moon.mp3'), 'The Man In The Moon');
  });
});
