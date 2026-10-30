import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cbrLayout, id3Length } from './mp3.ts';

/** MPEG1 Layer III, 44.1 kHz, no CRC, stereo; bitrate index 9 = 128 kbps (417-byte frames), 5 = 64 kbps. */
const header = (bitrateIndex: number, padding = 0) => [0xff, 0xfb, (bitrateIndex << 4) | (padding << 1), 0x00];

/** Frames of the given bitrate indexes, padded the way a normal encoder does so the average is exact. */
function frames(bitrateIndexes: number[], pad = true): Uint8Array {
  const parts: number[][] = [];
  let owed = 0;
  for (const index of bitrateIndexes) {
    const kbps = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128][index]!;
    const ideal = (144000 * kbps) / 44100;
    owed += ideal - Math.floor(ideal);
    const padding = pad && owed >= 1 ? 1 : 0;
    if (padding) owed -= 1;
    const frame = new Array<number>(Math.floor(ideal) + padding).fill(0);
    frame.splice(0, 4, ...header(index, padding));
    parts.push(frame);
  }
  return Uint8Array.from(parts.flat());
}

/** MPEG2 Layer III, 22.05 kHz, 64 kbps, never padded: every frame is 208 bytes (a real Internet Archive file). */
function unpaddedMpeg2(count: number): Uint8Array {
  const parts: number[][] = [];
  for (let i = 0; i < count; i++) {
    const frame = new Array<number>(208).fill(0);
    frame.splice(0, 4, 0xff, 0xf3, 0x80, 0x00);
    parts.push(frame);
  }
  return Uint8Array.from(parts.flat());
}

const id3 = (bodySize: number) => Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, (bodySize >> 7) & 0x7f, bodySize & 0x7f, ...new Array(bodySize).fill(0)]);
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));

describe('id3Length', () => {
  it('reads the syncsafe size and adds the 10-byte header', () => {
    assert.equal(id3Length(id3(300)), 310);
  });

  it('counts the footer when the flag is set', () => {
    const tag = id3(20);
    tag[5] = 0x10;
    assert.equal(id3Length(tag), 40);
  });

  it('is 0 without a tag', () => {
    assert.equal(id3Length(frames([9, 9, 9])), 0);
  });
});

describe('cbrLayout', () => {
  const many = (index: number, n = 60) => new Array<number>(n).fill(index);

  it('recognises constant-bitrate audio and its byte rate', () => {
    const a = cbrLayout(frames(many(9)))!;
    assert.equal(a.offset, 0);
    assert.ok(Math.abs(a.bytesPerSec - 16_000) < 1);
    assert.ok(Math.abs(cbrLayout(frames(many(5)))!.bytesPerSec - 8_000) < 1);
  });

  it('measures the real rate of a stream that never pads, instead of trusting the nominal bitrate', () => {
    // 208 bytes per 576 samples at 22.05 kHz is 7962.5 bytes/s, not the nominal 64 kbps = 8000.
    assert.ok(Math.abs(cbrLayout(unpaddedMpeg2(60))!.bytesPerSec - 7962.5) < 0.01);
    assert.ok(Math.abs(cbrLayout(frames(many(9), false))!.bytesPerSec - (417 * 44100) / 1152) < 0.01);
  });

  it('refuses to guess when too few frames are available to judge padding', () => {
    assert.equal(cbrLayout(frames(many(9, 6))), null);
  });

  it('finds the first frame after padding', () => {
    assert.equal(cbrLayout(concat(new Uint8Array(100), frames(many(9))))?.offset, 100);
  });

  it('accepts a buffer that ends mid-way once a few frames agree', () => {
    assert.ok(cbrLayout(frames(many(9)).subarray(0, 417 * 40 + 200)));
  });

  it('rejects frames whose bitrate changes', () => {
    assert.equal(cbrLayout(frames([...many(9, 20), 7, ...many(9, 20)])), null);
  });

  it('rejects a Xing (variable bitrate) header but accepts Info', () => {
    const withTag = (tag: string) => {
      const buf = frames(many(9));
      buf.set([...tag].map((c) => c.charCodeAt(0)), 36);
      return buf;
    };
    assert.equal(cbrLayout(withTag('Xing')), null);
    assert.equal(cbrLayout(withTag('VBRI')), null);
    assert.ok(cbrLayout(withTag('Info')));
  });

  it('returns null for data that is not MP3, or too short', () => {
    assert.equal(cbrLayout(new Uint8Array(2000).fill(7)), null);
    assert.equal(cbrLayout(frames([9]).subarray(0, 300)), null);
  });
});
