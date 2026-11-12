import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ASSUMED_SPEED, estimateTranscription, formatCount, formatDuration, IA_PRESETS } from './presets.ts';

describe('estimateTranscription', () => {
  it('caps each recording at the chosen minutes', () => {
    const e = estimateTranscription(10, 85, 20, 4);
    assert.equal(e.audioHours, (10 * 20) / 60);
    assert.equal(e.workHours, e.audioHours / 4);
    assert.equal(e.assumedSpeed, false);
  });

  it('uses the average length when the recording is shorter than the cap or there is no cap', () => {
    assert.equal(estimateTranscription(60, 1.5, 10, 2).audioHours, 1.5);
    assert.equal(estimateTranscription(2, 30, null, 2).audioHours, 1);
  });

  it('guesses the speed before anything was transcribed', () => {
    const e = estimateTranscription(10, 30, null, null);
    assert.equal(e.assumedSpeed, true);
    assert.equal(e.workHours, e.audioHours / ASSUMED_SPEED);
  });
});

describe('formatDuration', () => {
  it('speaks in minutes, hours and days', () => {
    assert.equal(formatDuration(0.001), 'under a minute');
    assert.equal(formatDuration(0.25), '15 minutes');
    assert.equal(formatDuration(1), '1 hour');
    assert.equal(formatDuration(3.54), '3.5 hours');
    assert.equal(formatDuration(96), '4 days');
  });
  it('groups thousands', () => assert.equal(formatCount(8458), '8,458'));
});

describe('IA_PRESETS', () => {
  it('has unique ids and a search for every preset but the custom one', () => {
    assert.equal(new Set(IA_PRESETS.map((p) => p.id)).size, IA_PRESETS.length);
    for (const p of IA_PRESETS) assert.equal(p.query === '', p.id === 'custom');
  });
});
