import { dateFromName } from '../naming.ts';

/**
 * People's Speech (MLCommons, Hugging Face): about 15 second clips of English speech, each with its
 * transcript, numbered in order within the recording they were cut from. Transcripts are lowercase
 * without punctuation. A recording's clips are laid end to end here, so a recording becomes one
 * episode with one segment per clip and times that match the audio exactly.
 */

export const DATASET = 'MLCommons/peoples_speech';
export const DATASET_PAGE = `https://huggingface.co/datasets/${DATASET}`;

/** The parquet conversion of a config's shard, which is what the dataset viewer is built from. */
export function shardUrl(config: string, shard: number, split = 'train'): string {
  return `https://huggingface.co/datasets/${DATASET}/resolve/refs%2Fconvert%2Fparquet/${config}/${split}/${String(shard).padStart(4, '0')}.parquet`;
}

/** `07282016HFUUforum_SLASH_..._mp3_00012.flac` is clip 12 of the recording `07282016HFUUforum_SLASH_..._mp3`. */
export function parseClipId(id: string): { recording: string; index: number } {
  const m = /^(.*)_(\d+)\.[a-z0-9]{2,4}$/i.exec(id);
  return m ? { recording: m[1]!, index: Number(m[2]) } : { recording: id, index: 0 };
}

/** Recording ids spell "/" and "." as `_SLASH_` and `_DOT_`; this turns them back. */
export function decodeRecording(recording: string): string {
  return recording.replaceAll('_SLASH_', '/').replaceAll('_DOT_', '.');
}

/** The recording date when its name has one, as `mm-dd-yyyy` or `yyyy-mm-dd`; null otherwise. */
export function recordingDate(decoded: string): string | null {
  const us = /(\d{2})-(\d{2})-(\d{4})/.exec(decoded);
  if (us) {
    const [month, day, year] = [Number(us[1]), Number(us[2]), Number(us[3])];
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 1900 && year <= new Date().getFullYear()) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  return dateFromName(decoded);
}

/** A readable title from the file name: no folder, no extension, no date. */
export function recordingTitle(decoded: string): string {
  const file = decoded.split('/').pop() ?? decoded;
  return (
    file
      .replace(/\.[a-z0-9]{2,4}$/i, '')
      .replace(/\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2}/, ' ')
      .replace(/[_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || decoded
  );
}

/** Length of a FLAC file from its STREAMINFO header (sample count over sample rate); null when it cannot be read. */
export function flacDurationMs(bytes: Uint8Array): number | null {
  if (bytes.length < 26 || bytes[0] !== 0x66 || bytes[1] !== 0x4c || bytes[2] !== 0x61 || bytes[3] !== 0x43) return null;
  if ((bytes[4]! & 0x7f) !== 0) return null; // the first block must be STREAMINFO
  const rate = bytes[18]! * 4096 + bytes[19]! * 16 + (bytes[20]! >> 4);
  // 36-bit sample count, combined without signed 32-bit shifts.
  const total = (bytes[21]! & 0x0f) * 2 ** 32 + bytes[22]! * 2 ** 24 + bytes[23]! * 2 ** 16 + bytes[24]! * 2 ** 8 + bytes[25]!;
  if (rate === 0 || total === 0) return null;
  return (total / rate) * 1000;
}

export interface ClipMeta {
  id: string;
  index: number;
  durationMs: number;
  text: string;
  /** Where the clip's audio was saved while the recording is assembled. */
  file: string;
}

export interface Recording {
  recording: string;
  clips: ClipMeta[];
}

/** Groups clips by recording and orders each recording's clips by their number. */
export function groupRecordings(clips: ClipMeta[]): Recording[] {
  const byRecording = new Map<string, ClipMeta[]>();
  for (const c of clips) {
    const { recording } = parseClipId(c.id);
    byRecording.set(recording, [...(byRecording.get(recording) ?? []), c]);
  }
  return [...byRecording.entries()].map(([recording, list]) => ({ recording, clips: list.sort((a, b) => a.index - b.index) }));
}

/** Lays clips end to end: each one's start and end in the assembled recording. */
export function layoutClips(durationsMs: number[]): { startMs: number; endMs: number }[] {
  let at = 0;
  return durationsMs.map((d) => {
    const startMs = Math.round(at);
    at += d;
    return { startMs, endMs: Math.round(at) };
  });
}
