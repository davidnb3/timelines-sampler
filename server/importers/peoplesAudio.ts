import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { run } from '../exec.ts';
import { layoutClips, type ClipMeta } from '../sources/peoplesSpeech.ts';

/** A file name for a recording: safe characters, and a short hash when the name had to be cut. */
export function recordingSlug(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_');
  return safe.length <= 120 ? safe : `${safe.slice(0, 100)}-${createHash('sha1').update(name).digest('hex').slice(0, 8)}`;
}

/** Lays a recording's clips end to end into one FLAC file at `out`; the returned times match that file. */
export async function assembleRecording(
  clips: ClipMeta[],
  out: string,
  list: string,
  signal?: AbortSignal,
): Promise<{ times: { startMs: number; endMs: number }[]; durationMs: number }> {
  fs.writeFileSync(list, clips.map((c) => `file '${c.file.replaceAll("'", "'\\''")}'`).join('\n') + '\n');
  // Re-encoding (lossless) rather than copying keeps the joined file valid whatever the clips' headers say.
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'flac', out], { signal });
  const times = layoutClips(clips.map((c) => c.durationMs));
  const durationMs = times[times.length - 1]!.endMs;
  const actualMs = Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { signal })).trim()) * 1000;
  if (Math.abs(actualMs - durationMs) > 50) console.warn(`  warning: assembled audio is ${Math.round(actualMs)} ms, transcript times add up to ${durationMs} ms`);
  return { times, durationMs };
}
