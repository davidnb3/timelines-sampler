import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { downloadTo } from '../download.ts';

/** Downloads a file to `dest` (see `downloadTo`); `signal` stops it and leaves nothing behind. */
export async function downloadFile(url: string, dest: string, signal?: AbortSignal): Promise<void> {
  await downloadTo(url, dest, { signal });
}

export interface ShardRow {
  id: string;
  durationMs: number;
  text: string;
  audio: Uint8Array;
}

/**
 * Reads a shard one row group at a time (about 100 clips, 28 MB), so memory stays small however
 * big the file is, and hands each row to `onRow`.
 */
export async function readShard(file: string, onRow: (row: ShardRow) => void | Promise<void>): Promise<number> {
  const buffer = await asyncBufferFromFile(file);
  const meta = await parquetMetadataAsync(buffer);
  let rowStart = 0;
  let count = 0;
  for (const group of meta.row_groups) {
    const rowEnd = rowStart + Number(group.num_rows);
    // `utf8: false` keeps binary columns as bytes; by default they are decoded as text, which corrupts audio.
    // Columns that are text by type (id, transcript) are still strings.
    const rows = (await parquetReadObjects({ file: buffer, compressors, rowStart, rowEnd, utf8: false })) as {
      id: string;
      duration_ms: number;
      text: string;
      audio: { bytes: Uint8Array };
    }[];
    for (const r of rows) {
      await onRow({ id: r.id, durationMs: Number(r.duration_ms), text: r.text ?? '', audio: r.audio.bytes });
      count++;
    }
    rowStart = rowEnd;
  }
  return count;
}

/**
 * Like `readShard`, but only for the clips `wanted` accepts (it gets the clip id). It reads each row
 * group's ids first and decodes the audio of a row group only when it holds a wanted clip, so a
 * shard with a few films in it costs a few row groups, not the whole file.
 */
export async function readShardRows(
  file: string,
  wanted: (clipId: string) => boolean,
  onRow: (row: ShardRow) => void | Promise<void>,
): Promise<number> {
  const buffer = await asyncBufferFromFile(file);
  const metadata = await parquetMetadataAsync(buffer);
  let rowStart = 0;
  let count = 0;
  for (const group of metadata.row_groups) {
    const rowEnd = rowStart + Number(group.num_rows);
    const ids = (await parquetReadObjects({ file: buffer, metadata, compressors, columns: ['id'], rowStart, rowEnd })) as { id: string }[];
    const hits = ids.flatMap((r, i) => (wanted(r.id) ? [i] : []));
    if (hits.length) {
      const rows = (await parquetReadObjects({
        file: buffer, metadata, compressors, rowStart: rowStart + hits[0]!, rowEnd: rowStart + hits[hits.length - 1]! + 1, utf8: false,
      })) as { id: string; duration_ms: number; text: string; audio: { bytes: Uint8Array } }[];
      for (const r of rows) {
        if (!wanted(r.id)) continue;
        await onRow({ id: r.id, durationMs: Number(r.duration_ms), text: r.text ?? '', audio: r.audio.bytes });
        count++;
      }
    }
    rowStart = rowEnd;
  }
  return count;
}
