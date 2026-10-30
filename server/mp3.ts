/**
 * Just enough MP3 parsing to cut clips without reading a whole file: for constant-bitrate audio the
 * byte position of any time is `time * bytesPerSec`, so a single HTTP Range request can fetch it.
 */

const MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Fewest frames that must agree on bitrate before a file counts as constant bitrate. */
const MIN_FRAMES = 3;
/** Frames needed to tell whether the encoder pads frames, when that changes the byte rate noticeably. */
const FRAMES_TO_JUDGE_PADDING = 12;
/** How far past the start to look for the first frame (ID3 padding can precede it). */
const SYNC_SEARCH = 4096;

export interface Cbr {
  /** Offset of the first audio frame, relative to the buffer given to `cbrLayout`. */
  offset: number;
  /**
   * Measured, not nominal: a 64 kbps stream whose encoder never pads frames really runs at 7962
   * bytes a second, and trusting 8000 put clips 1.9 s off after seven minutes.
   */
  bytesPerSec: number;
}

/** Length in bytes of a leading ID3v2 tag (header, body and footer), or 0 when there is none. */
export function id3Length(buf: Uint8Array): number {
  if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0;
  const size = ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f);
  const footer = buf[5]! & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

interface Frame {
  version: number;
  kbps: number;
  rate: number;
  /** Samples per frame: 1152 for MPEG1, 576 for MPEG2 and 2.5. */
  samples: number;
  padded: boolean;
  length: number;
  /** Average length if the encoder pads to hit the nominal bitrate exactly (usually fractional). */
  ideal: number;
}

/** Parses a Layer III frame header at `pos`; null if there is no valid one there. */
function frameAt(buf: Uint8Array, pos: number): Frame | null {
  if (pos + 4 > buf.length) return null;
  const b1 = buf[pos + 1]!;
  const b2 = buf[pos + 2]!;
  if (buf[pos] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5, 1 = reserved
  const layer = (b1 >> 1) & 3; // 1 = Layer III
  if (version === 1 || layer !== 1) return null;
  const bitrateIndex = b2 >> 4;
  const rateIndex = (b2 >> 2) & 3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const kbps = (version === 3 ? MPEG1_L3 : MPEG2_L3)[bitrateIndex]!;
  const rate = SAMPLE_RATES[version]![rateIndex]!;
  const padding = (b2 >> 1) & 1;
  const ideal = ((version === 3 ? 144000 : 72000) * kbps) / rate;
  return { version, kbps, rate, samples: version === 3 ? 1152 : 576, padded: padding === 1, length: Math.floor(ideal) + padding, ideal };
}

/**
 * Checks that the audio at the start of `buf` (after any ID3 tag) is constant-bitrate MP3 and
 * returns where it starts and how many bytes a second takes. Null for anything else: variable
 * bitrate (a Xing or VBRI header, or frames that disagree), other codecs, or too little data.
 */
export function cbrLayout(buf: Uint8Array): Cbr | null {
  let start = -1;
  const limit = Math.min(buf.length - 4, SYNC_SEARCH);
  for (let i = 0; i <= limit; i++) {
    if (frameAt(buf, i)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  const first = frameAt(buf, start)!;
  // A Xing or VBRI tag lives inside the first frame; "Info" is the same tag on constant-bitrate files.
  const head = String.fromCharCode(...buf.subarray(start, Math.min(buf.length, start + first.length)));
  if (head.includes('Xing') || head.includes('VBRI')) return null;

  let pos = start;
  let frameCount = 0;
  let paddedCount = 0;
  while (pos + 4 <= buf.length) {
    const frame = frameAt(buf, pos);
    if (!frame) return null; // junk or a different stream in the middle: not safe to compute positions
    if (frame.kbps !== first.kbps || frame.version !== first.version || frame.rate !== first.rate) return null;
    frameCount++;
    if (frame.padded) paddedCount++;
    pos += frame.length;
  }
  if (frameCount < MIN_FRAMES) return null;

  // Average bytes per frame. Encoders either pad frames so the average matches the nominal bitrate
  // exactly, or never pad (every frame is the rounded-down size); the padding bits say which.
  const whole = Math.floor(first.ideal);
  const fraction = first.ideal - whole;
  let bytesPerFrame = first.ideal;
  if (fraction > 0.05) {
    if (frameCount < FRAMES_TO_JUDGE_PADDING) return null;
    const share = paddedCount / frameCount;
    if (Math.abs(share - fraction) <= 0.2) bytesPerFrame = first.ideal;
    else if (share <= 0.1) bytesPerFrame = whole;
    else if (share >= 0.9) bytesPerFrame = whole + 1;
    else return null;
  }
  return { offset: start, bytesPerSec: (bytesPerFrame * first.rate) / first.samples };
}
