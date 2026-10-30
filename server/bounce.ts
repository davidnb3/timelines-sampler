import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ClipError, cutClip, resolveRef, type ClipFormat } from './clip.ts';
import { CLIP_DIR } from './config.ts';
import { clampFade, type Fade } from './fade.ts';
import { run } from './whisper.ts';

export interface BounceClip {
  ref: string;
  startMs: number;
  endMs: number;
  /** Fades set in the editor; the story keeps them. */
  fade: Fade;
}

export interface BounceSpec {
  clips: BounceClip[];
  gapMs: number;
  format: ClipFormat;
}

/** A story is a handful of clips; these limits keep one request from turning into a long job. */
const MAX_CLIPS = 60;
const MAX_GAP_MS = 5000;
const MAX_TOTAL_MS = 30 * 60 * 1000;

/** Validates a bounce request. `clips` is the JSON a browser sends: [{ref, start, end, fi?, fo?}] with times in ms. */
export function parseBounce(clipsJson: string | null, gap: string | null, fmt: string | null): BounceSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(clipsJson ?? '');
  } catch {
    throw new ClipError(400, 'clips must be a JSON array');
  }
  if (!Array.isArray(raw) || raw.length === 0) throw new ClipError(400, 'No clips to bounce');
  if (raw.length > MAX_CLIPS) throw new ClipError(400, `At most ${MAX_CLIPS} clips`);
  let total = 0;
  const clips = raw.map((c): BounceClip => {
    const { ref, start, end, fi, fo } = (c ?? {}) as Record<string, unknown>;
    if (typeof ref !== 'string' || typeof start !== 'number' || typeof end !== 'number' || !(start >= 0) || !(end > start)) {
      throw new ClipError(400, 'Each clip needs ref, start and end (ms)');
    }
    total += end - start;
    const fade = clampFade(typeof fi === 'number' ? fi : 0, typeof fo === 'number' ? fo : 0, end - start);
    return { ref, startMs: Math.round(start), endMs: Math.round(end), fade };
  });
  if (total > MAX_TOTAL_MS) throw new ClipError(400, 'Story is longer than 30 minutes');
  const gapMs = Math.min(MAX_GAP_MS, Math.max(0, Number.parseInt(gap ?? '400', 10) || 0));
  return { clips, gapMs, format: fmt === 'wav' ? 'wav' : 'mp3' };
}

/**
 * Joins clips, in the given order and with `gapMs` of silence between them, into one file and
 * returns its path. Each clip is cut the usual way (cached), so the result matches what the
 * player in the browser plays.
 */
export async function bounce(conn: DatabaseSync, spec: BounceSpec): Promise<string> {
  for (const c of spec.clips) if (!resolveRef(conn, c.ref)) throw new ClipError(404, `Unknown clip reference ${c.ref}`);

  fs.mkdirSync(CLIP_DIR, { recursive: true });
  const key = crypto.createHash('sha1').update(JSON.stringify(spec)).digest('hex').slice(0, 24);
  const out = path.join(CLIP_DIR, `story-${key}.${spec.format}`);
  if (fs.existsSync(out)) return out;

  const pieces: string[] = [];
  for (const c of spec.clips) pieces.push(await cutClip(conn, c.ref, c.startMs, c.endMs, 'wav', c.fade));

  let gapFile: string | null = null;
  if (spec.gapMs > 0 && pieces.length > 1) {
    gapFile = path.join(CLIP_DIR, `gap-${spec.gapMs}.wav`);
    if (!fs.existsSync(gapFile)) {
      await run('ffmpeg', [
        '-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
        '-t', (spec.gapMs / 1000).toFixed(3), '-c:a', 'pcm_s16le', gapFile,
      ]);
    }
  }

  const list = `${out}.txt`;
  const tmp = `${out}.part.${spec.format}`;
  try {
    const lines = pieces.flatMap((file, i) => (i > 0 && gapFile ? [gapFile, file] : [file])).map((f) => `file '${f.replaceAll("'", "'\\''")}'`);
    fs.writeFileSync(list, `${lines.join('\n')}\n`);
    const encode = spec.format === 'wav' ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'libmp3lame', '-q:a', '2'];
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, ...encode, tmp]);
    fs.renameSync(tmp, out);
  } finally {
    fs.rmSync(list, { force: true });
    fs.rmSync(tmp, { force: true });
  }
  return out;
}
