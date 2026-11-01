import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decodeRecording, flacDurationMs, groupRecordings, layoutClips, parseClipId, recordingDate, recordingTitle, shardUrl,
  type ClipMeta,
} from './peoplesSpeech.ts';

/** A minimal FLAC header: "fLaC", a STREAMINFO block header, then 34 bytes with the rate and sample count. */
function flacHeader(sampleRate: number, totalSamples: number): Uint8Array {
  const b = new Uint8Array(42);
  b.set([0x66, 0x4c, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22]);
  b[18] = (sampleRate >> 12) & 0xff;
  b[19] = (sampleRate >> 4) & 0xff;
  b[20] = ((sampleRate & 0x0f) << 4) | (0 << 1) | 0; // mono, high bit of bits-per-sample
  b[21] = (0xf << 4) | Number((BigInt(totalSamples) >> 32n) & 0x0fn);
  b[22] = Number((BigInt(totalSamples) >> 24n) & 0xffn);
  b[23] = Number((BigInt(totalSamples) >> 16n) & 0xffn);
  b[24] = Number((BigInt(totalSamples) >> 8n) & 0xffn);
  b[25] = Number(BigInt(totalSamples) & 0xffn);
  return b;
}

describe('parseClipId', () => {
  it('splits a clip id into its recording and number', () => {
    assert.deepEqual(parseClipId('07282016HFUUforum_SLASH_07-28-2016_HFUUforum_DOT_mp3_00012.flac'), {
      recording: '07282016HFUUforum_SLASH_07-28-2016_HFUUforum_DOT_mp3',
      index: 12,
    });
  });

  it('treats an id without a number as a recording of its own', () => {
    assert.deepEqual(parseClipId('lonely'), { recording: 'lonely', index: 0 });
  });
});

describe('recording names', () => {
  const decoded = decodeRecording('07282016HFUUforum_SLASH_07-28-2016_HFUUforum_DOT_mp3');

  it('decodes the slash and dot spellings', () => {
    assert.equal(decoded, '07282016HFUUforum/07-28-2016_HFUUforum.mp3');
  });

  it('reads a month-day-year date from the name', () => {
    assert.equal(recordingDate(decoded), '2016-07-28');
    assert.equal(recordingDate('talks/2019-03-02_show.mp3'), '2019-03-02');
    assert.equal(recordingDate('talks/13-45-2016_show.mp3'), null);
    assert.equal(recordingDate('talks/plain.mp3'), null);
  });

  it('makes a readable title without folder, extension or date', () => {
    assert.equal(recordingTitle(decoded), 'HFUUforum');
    assert.equal(recordingTitle('a/b/some_great_talk.mp3'), 'some great talk');
  });
});

describe('flacDurationMs', () => {
  it('reads the length from the header', () => {
    assert.equal(flacDurationMs(flacHeader(16000, 16000 * 15)), 15000);
    assert.equal(Math.round(flacDurationMs(flacHeader(16000, 238_720)) ?? 0), 14920);
  });

  it('handles sample counts above 32 bits', () => {
    assert.equal(flacDurationMs(flacHeader(16000, 2 ** 33)), (2 ** 33 / 16000) * 1000);
  });

  it('is null for anything that is not a readable FLAC header', () => {
    assert.equal(flacDurationMs(new Uint8Array(40)), null);
    assert.equal(flacDurationMs(flacHeader(16000, 0)), null);
    assert.equal(flacDurationMs(new Uint8Array(4)), null);
  });
});

describe('groupRecordings and layoutClips', () => {
  const clip = (id: string, durationMs: number): ClipMeta => ({ id, index: parseClipId(id).index, durationMs, text: id, file: id });

  it('groups by recording and orders clips by number', () => {
    const groups = groupRecordings([clip('b_00002.flac', 10), clip('a_00001.flac', 10), clip('b_00001.flac', 10)]);
    assert.deepEqual(groups.map((g) => [g.recording, g.clips.map((c) => c.index)]), [['b', [1, 2]], ['a', [1]]]);
  });

  it('lays clips end to end', () => {
    assert.deepEqual(layoutClips([14920, 14530, 15000]), [
      { startMs: 0, endMs: 14920 },
      { startMs: 14920, endMs: 29450 },
      { startMs: 29450, endMs: 44450 },
    ]);
  });
});

describe('shardUrl', () => {
  it('points at the parquet conversion of a shard', () => {
    assert.match(shardUrl('microset', 0), /refs%2Fconvert%2Fparquet\/microset\/train\/0000\.parquet$/);
    assert.match(shardUrl('clean', 12), /clean\/train\/0012\.parquet$/);
  });
});
