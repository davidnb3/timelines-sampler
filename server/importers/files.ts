import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { run } from '../exec.ts';
import type { ItemSpec, Processor } from '../jobs.ts';
import { clampInt, cleanTopics, maxSecondsFor, saveRecording, transcribeAndSave } from './common.ts';
import { parseSubtitles } from './subtitles.ts';

export interface FilesParams {
  topics: string[];
  maxMinutes: number | null;
}

export const MEDIA_EXT = /\.(mp3|m4a|m4b|aac|wav|flac|ogg|oga|opus|wma|aiff?|mp4|m4v|mov|mkv|webm|avi|mpe?g|ogv)$/i;
export const MAX_FILES = 5000;

/** The audio and video files among `paths`: files are taken as they are, folders are searched through. Hidden files are skipped. */
export function expandPaths(paths: string[], limit = MAX_FILES): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const visit = (p: string): void => {
    if (files.length >= limit) {
      truncated = true;
      return;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(p);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      const names = fs.readdirSync(p).filter((n) => !n.startsWith('.')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      for (const n of names) visit(path.join(p, n));
    } else if (stat.isFile() && MEDIA_EXT.test(p) && !path.basename(p).startsWith('.')) {
      files.push(p);
    }
  };
  for (const p of paths) visit(p);
  return { files: [...new Set(files)], truncated };
}

/** A subtitle file next to a recording (`talk.srt`, `talk.en.vtt` ...), or null. */
export function findSubtitles(file: string): string | null {
  const base = file.slice(0, file.length - path.extname(file).length);
  for (const suffix of ['.srt', '.vtt', '.en.srt', '.en.vtt']) {
    if (fs.existsSync(base + suffix)) return base + suffix;
  }
  return null;
}

/** A readable title from a file name: no folder, no extension, underscores as spaces. */
export function fileTitle(file: string): string {
  const name = path.basename(file, path.extname(file)).replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return name || path.basename(file);
}

export function parseFilesParams(body: Record<string, unknown>): FilesParams & { paths: string[] } {
  const paths = Array.isArray(body.paths) ? body.paths.map(String).filter(Boolean) : [];
  if (!paths.length) throw new Error('Choose some files or a folder first');
  return {
    paths,
    topics: cleanTopics(body.topics),
    maxMinutes: body.maxMinutes === null || body.maxMinutes === undefined || body.maxMinutes === '' ? null : clampInt(body.maxMinutes, 10, 1, 600),
  };
}

export function planFiles(paths: string[]): { items: ItemSpec[]; truncated: boolean } {
  const { files, truncated } = expandPaths(paths);
  if (!files.length) throw new Error('No audio or video files found there');
  return { items: files.map((file) => ({ label: path.basename(file), params: { file } })), truncated };
}

async function durationMs(file: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { signal });
    const s = Number(out.trim());
    return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : null;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    return null;
  }
}

export function filesProcessor(conn: DatabaseSync): Processor {
  return {
    async run(item, ctx, jobParams) {
      const p = jobParams as unknown as FilesParams;
      const file = String(item.params.file);
      if (!fs.existsSync(file)) throw new Error('The file is not there any more');
      const recording = {
        source: 'file',
        extId: `file:${file}`,
        show: 'My files',
        title: fileTitle(file),
        date: null,
        audioUrl: pathToFileURL(file).href,
        pageUrl: null,
        durationMs: await durationMs(file, ctx.signal),
        rawTopics: [] as string[],
        topics: p.topics,
      };
      const subtitles = findSubtitles(file);
      if (subtitles) {
        // Subtitles already say what is spoken and when: no transcription needed.
        const segments = parseSubtitles(fs.readFileSync(subtitles, 'utf8'));
        if (segments.length) {
          saveRecording(conn, recording, segments);
          return 'done';
        }
      }
      return transcribeAndSave(conn, recording, { maxSeconds: maxSecondsFor(p.maxMinutes), signal: ctx.signal, onStage: ctx.progress });
    },
  };
}
