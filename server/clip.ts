import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { CLIP_DIR, USER_AGENT } from './config.ts';
import { getEpisode } from './db.ts';
import { clampFade, fadeFilters, hasFade, NO_FADE, withDeclick, type Fade } from './fade.ts';
import { cbrLayout, id3Length } from './mp3.ts';
import { singleflight } from './singleflight.ts';
import { inputFormatArgs, run } from './whisper.ts';

export type ClipFormat = 'mp3' | 'wav';

/** Longest clip the server will cut, so a bad request cannot pull a whole broadcast. */
const MAX_CLIP_MS = 10 * 60 * 1000;

/** Audio fetched before the clip start, so the decoder can find a frame boundary and settle. */
const LEAD_S = 1;
/** Audio fetched after the clip end. */
const TAIL_S = 0.5;
/** How much of a file's start is read to learn its layout. */
const HEAD_BYTES = 16 * 1024;
/** How long a resolved URL and layout are trusted (CDN links can be signed and expire). */
const SOURCE_TTL_MS = 15 * 60 * 1000;

/**
 * Turns an opaque clip ref into a media URL; only refs the server itself issued resolve.
 * TV refs (`ia:`) deliberately do not: the Internet Archive refuses downloads of TV news.
 */
export function resolveRef(conn: DatabaseSync, ref: string): string | null {
  const sep = ref.indexOf(':');
  if (ref.slice(0, sep) !== 'ep') return null;
  return getEpisode(conn, Number(ref.slice(sep + 1)))?.audio_url ?? null;
}

/**
 * What is known about an episode's audio file. `url` is the address after all redirects: podcast
 * links bounce through trackers (5 hops, ~1.5 s each time), and ffmpeg followed them on every cut.
 * `cbr` is set for constant-bitrate MP3, where a clip's bytes can be computed and fetched alone.
 */
interface Source {
  url: string;
  cbr: { offset: number; bytesPerSec: number } | null;
}

const sources = new Map<string, { loading: Promise<Source>; expires: number }>();

class RangeError extends Error {}

/** Fetches bytes [from, to] (inclusive). Fails unless the server honours the range (206). */
async function fetchRange(url: string, from: number, to: number): Promise<{ finalUrl: string; bytes: Uint8Array }> {
  const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}`, 'User-Agent': USER_AGENT }, redirect: 'follow' });
  if (res.status !== 206) {
    // A 200 would stream the whole file; drop it unread.
    await res.body?.cancel().catch(() => undefined);
    throw new RangeError(`Range request answered HTTP ${res.status}`);
  }
  return { finalUrl: res.url, bytes: new Uint8Array(await res.arrayBuffer()) };
}

async function loadSource(original: string): Promise<Source> {
  try {
    const head = await fetchRange(original, 0, HEAD_BYTES - 1);
    const audioStart = id3Length(head.bytes);
    // A large ID3 tag (cover art) can push the first frame beyond the bytes read so far.
    const audio =
      audioStart + 2048 <= head.bytes.length
        ? head.bytes.subarray(audioStart)
        : (await fetchRange(head.finalUrl, audioStart, audioStart + 8191)).bytes;
    const layout = cbrLayout(audio);
    return { url: head.finalUrl, cbr: layout && { offset: audioStart + layout.offset, bytesPerSec: layout.bytesPerSec } };
  } catch {
    // No ranges, not MP3, host trouble: ffmpeg can still cut from the original address.
    return { url: original, cbr: null };
  }
}

function getSource(original: string): Promise<Source> {
  const known = sources.get(original);
  if (known && known.expires > Date.now()) return known.loading;
  const loading = loadSource(original);
  sources.set(original, { loading, expires: Date.now() + SOURCE_TTL_MS });
  return loading;
}

/** Resolves an episode's address and layout in the background so its first clip is quick. */
export function warmSource(conn: DatabaseSync, ref: string): void {
  const url = resolveRef(conn, ref);
  if (url && !url.startsWith('file:')) void getSource(url);
}

/** Cuts [startMs, endMs] from the source into a cached audio file and returns its path. */
export async function cutClip(
  conn: DatabaseSync,
  ref: string,
  startMs: number,
  endMs: number,
  format: ClipFormat,
  fadeRequest?: Fade,
  /** Skip the automatic declick fade: the editor loads the audio around a clip as it is. */
  raw = false,
): Promise<string> {
  const original = resolveRef(conn, ref);
  if (!original) throw new ClipError(404, 'Unknown clip reference');
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) {
    throw new ClipError(400, 'Invalid clip bounds');
  }
  if (endMs - startMs > MAX_CLIP_MS) throw new ClipError(400, 'Clip is longer than 10 minutes');

  fs.mkdirSync(CLIP_DIR, { recursive: true });
  const length = endMs - startMs;
  const fade = raw
    ? hasFade(fadeRequest) ? clampFade(fadeRequest.inMs, fadeRequest.outMs, length) : undefined
    : withDeclick(fadeRequest ?? NO_FADE, length);
  // Raw clips without fades keep the cache keys they always had; declicked ones get their own.
  const fadeKey = hasFade(fade) ? `|${raw ? 'fade' : 'dc'}${fade.inMs}-${fade.outMs}` : '';
  const key = crypto.createHash('sha1').update(`${original}|${startMs}|${endMs}|${format}${fadeKey}`).digest('hex').slice(0, 24);
  const out = path.join(CLIP_DIR, `${key}.${format}`);
  if (fs.existsSync(out)) return out;
  // Identical requests that overlap share one cut: they would otherwise all write the same cache file.
  return singleflight(out, async () => {
    if (fs.existsSync(out)) return out;

    const startS = startMs / 1000;
    const lengthS = (endMs - startMs) / 1000;
    const encode = ['-vn', '-ac', '2', '-ar', '44100', ...(format === 'wav' ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'libmp3lame', '-q:a', '3'])];
    // Unique temporary names, so two processes (a second server, a test run) never write the same file.
    const unique = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const tmp = `${out}.${unique}.part.${format}`;
    const piece = `${out}.${unique}.piece.mp3`;
    try {
      // A recording stored on this machine (People's Speech): ffmpeg cuts straight from the file. FLAC
      // seeks exactly, so none of the byte-range machinery below is needed.
      if (original.startsWith('file:')) {
        const file = fileURLToPath(original);
        if (!fs.existsSync(file)) throw new ClipError(404, 'The audio file for this recording is missing');
        await run('ffmpeg', [
          '-v', 'error', '-y', '-ss', startS.toFixed(3), '-i', file, '-t', lengthS.toFixed(3),
          ...(hasFade(fade) ? ['-af', fadeFilters(fade, endMs - startMs).join(',')] : []),
          ...encode, tmp,
        ]);
        fs.renameSync(tmp, out);
        return out;
      }

      const source = await getSource(original);

      if (source.cbr) {
        // Constant bitrate: fetch just the bytes around the clip and let ffmpeg trim to the exact start.
        const { offset, bytesPerSec } = source.cbr;
        const from = Math.max(offset, Math.floor(offset + (startS - LEAD_S) * bytesPerSec));
        const to = Math.ceil(offset + (startS + lengthS + TAIL_S) * bytesPerSec);
        try {
          const { bytes } = await fetchRange(source.url, from, to);
          fs.writeFileSync(piece, bytes);
          // Seconds from the start of the fetched piece to the requested clip start.
          const skip = Math.max(0, startS - (from - offset) / bytesPerSec);
          // With a fade the trim has to happen inside the filter chain: ffmpeg applies output-side
          // `-ss` after the filters, which would put the fade before the cut.
          const trim = hasFade(fade)
            ? ['-af', [`atrim=start=${skip.toFixed(3)}:duration=${lengthS.toFixed(3)}`, 'asetpts=PTS-STARTPTS', ...fadeFilters(fade, endMs - startMs)].join(',')]
            : ['-ss', skip.toFixed(3), '-t', lengthS.toFixed(3)];
          await run('ffmpeg', ['-v', 'error', '-y', '-f', 'mp3', '-i', piece, ...trim, ...encode, tmp]);
          fs.renameSync(tmp, out);
          return out;
        } catch {
          // A stale or refused link, a partial answer: forget what we knew and cut the slow way.
          sources.delete(original);
        }
      }

      await run('ffmpeg', [
        '-v', 'error', '-y',
        '-ss', startS.toFixed(3), ...inputFormatArgs(source.url), '-i', source.url, '-t', lengthS.toFixed(3),
        ...(hasFade(fade) ? ['-af', fadeFilters(fade, endMs - startMs).join(',')] : []),
        ...encode, tmp,
      ]);
      fs.renameSync(tmp, out);
    } finally {
      fs.rmSync(tmp, { force: true });
      fs.rmSync(piece, { force: true });
    }
    return out;
  });
}

export class ClipError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
