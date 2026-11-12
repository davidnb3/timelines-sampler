import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rollRows, WORD } from './wordmark.ts';

describe('rollRows', () => {
  it('starts every column at zero', () => {
    assert.equal(rollRows().map((r) => r[0]).join(''), '000000000');
  });

  it('ends on the letters of the name', () => {
    assert.equal(rollRows().map((r) => r[r.length - 1]).join(''), WORD);
  });

  it('counts up in order, through more digits the further right the column is', () => {
    const rows = rollRows();
    assert.deepEqual(rows[0], ['0', '1', 'T']);
    assert.deepEqual(rows[4], ['0', '1', '2', '3', '4', '5', 'l']);
    assert.deepEqual(rows[8], ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 's']);
    for (let i = 1; i < rows.length; i++) assert.equal(rows[i]!.length, rows[i - 1]!.length + 1);
  });
});
