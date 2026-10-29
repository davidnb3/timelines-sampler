import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CLIP_DIR } from './config.ts';
import { getEpisode } from './db.ts';
import { inputFormatArgs, run } from './whisper.ts';

export type ClipFormat = 'mp3' | 'wav';

/** Longest clip the server will cut, so a bad request cannot pull a whole broadcast. */
const MAX_CLIP_MS = 10 * 60 * 1000;

/**
 * Turns an opaque clip ref into a media URL; only refs the server itself issued resolve.
 * TV refs (`ia:`) deliberately do not: the Internet Archive refuses downloads of TV news.
 */
export function resolveRef(conn: DatabaseSync, ref: string): string | null {
  const sep = ref.indexOf(':');
  if (ref.slice(0, sep) !== 'ep') return null;
  return getEpisode(conn, Number(ref.slice(sep + 1)))?.audio_url ?? null;
}

/** Cuts [startMs, endMs] from the source into a cached audio file and returns its path. */
export async function cutClip(
  conn: DatabaseSync,
  ref: string,
  startMs: number,
  endMs: number,
  format: ClipFormat,
): Promise<string> {
  const url = resolveRef(conn, ref);
  if (!url) throw new ClipError(404, 'Unknown clip reference');
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) {
    throw new ClipError(400, 'Invalid clip bounds');
  }
  if (endMs - startMs > MAX_CLIP_MS) throw new ClipError(400, 'Clip is longer than 10 minutes');

  fs.mkdirSync(CLIP_DIR, { recursive: true });
  const key = crypto.createHash('sha1').update(`${url}|${startMs}|${endMs}|${format}`).digest('hex').slice(0, 24);
  const out = path.join(CLIP_DIR, `${key}.${format}`);
  if (fs.existsSync(out)) return out;

  const encode = ['-vn', '-ac', '2', '-ar', '44100', ...(format === 'wav' ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'libmp3lame', '-q:a', '3'])];
  const tmp = `${out}.part.${format}`;
  try {
    await run('ffmpeg', [
      '-v', 'error', '-y',
      '-ss', (startMs / 1000).toFixed(3), ...inputFormatArgs(url), '-i', url, '-t', ((endMs - startMs) / 1000).toFixed(3),
      ...encode, tmp,
    ]);
    fs.renameSync(tmp, out);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return out;
}

export class ClipError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
