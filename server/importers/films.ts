import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, SEED_DIR } from '../config.ts';
import { hasEpisode, saveEpisode } from '../db.ts';
import { abortError } from '../exec.ts';
import type { ItemSpec, Processor } from '../jobs.ts';
import { filmShow, type FilmItem, type FilmRecording } from '../sources/peoplesSpeechFilms.ts';
import { flacDurationMs, groupRecordings, parseClipId, shardUrl, type ClipMeta } from '../sources/peoplesSpeech.ts';
import { downloadFile, readShardRows } from '../sources/peoplesSpeechShard.ts';
import { assembleRecording, recordingSlug } from './peoplesAudio.ts';

/** The old films of People's Speech: where the list lives, how big the import is, and the job that runs it. */

const root = () => path.join(DATA_DIR, 'peoples-speech');
const SEED_FILE = 'peoples-speech-films.json';

/** The film list a developer built with `ingest peoples-speech-films --select-only`, else the one that ships with the app. */
export function loadFilms(): FilmItem[] {
  for (const file of [path.join(root(), 'films.json'), path.join(SEED_DIR, SEED_FILE)]) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as FilmItem[];
  }
  throw new Error('The list of films is missing (seed/peoples-speech-films.json)');
}

const padShard = (n: number) => String(n).padStart(4, '0');
export const shardLabel = (n: number) => `Old films, shard ${padShard(n)}`;

export interface FilmsInfo {
  films: number;
  hours: number;
  shards: number;
  /** Rough size of everything downloaded: each shard is about 470 MB. */
  downloadGb: number;
  /** Rough size kept on disk: about 66 MB of FLAC per hour. */
  diskGb: number;
}

export function filmsInfo(films: FilmItem[] = loadFilms()): FilmsInfo {
  const ms = films.reduce((s, f) => s + f.recordings.reduce((t, r) => t + r.ms, 0), 0);
  const shards = new Set(films.flatMap((f) => f.recordings.map((r) => r.shard))).size;
  const hours = ms / 3.6e6;
  return { films: films.length, hours: Math.round(hours * 10) / 10, shards, downloadGb: Math.round((shards * 0.47) * 10) / 10, diskGb: Math.round(((hours * 66) / 1000) * 10) / 10 };
}

export function planFilms(films: FilmItem[] = loadFilms()): ItemSpec[] {
  const shards = [...new Set(films.flatMap((f) => f.recordings.map((r) => r.shard)))].sort((a, b) => a - b);
  return shards.map((shard) => ({ label: shardLabel(shard), params: { shard } }));
}

/** Waits for a promise but gives up when the signal aborts (the promise itself carries on). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(abortError());
    }, { once: true });
  });

/** Shards being fetched, so the next ones download while the current one is processed; also lets a paused job pick its shard up again. */
const downloads = new Map<number, Promise<void>>();
const shardFile = (n: number) => path.join(root(), `clean-${padShard(n)}.parquet`);

function startDownload(shard: number): Promise<void> {
  let p = downloads.get(shard);
  if (!p) {
    fs.mkdirSync(root(), { recursive: true });
    p = (async () => {
      if (fs.existsSync(shardFile(shard))) return;
      // Hugging Face limits how fast it answers, so a refused download is tried again after a pause.
      for (let attempt = 0; ; attempt++) {
        try {
          return await downloadFile(shardUrl('clean', shard), shardFile(shard));
        } catch (err) {
          if (attempt >= 5) throw err;
          await pause(30_000 * (attempt + 1));
        }
      }
    })();
    p.catch(() => downloads.delete(shard));
    downloads.set(shard, p);
  }
  return p;
}

export function filmsProcessor(conn: DatabaseSync): Processor {
  return {
    async run(item, ctx) {
      const shard = Number(item.params.shard);
      const padded = padShard(shard);
      const films = loadFilms();
      const wanted = new Map<string, { film: FilmItem; rec: FilmRecording }>();
      for (const film of films) for (const rec of film.recordings) wanted.set(rec.recording, { film, rec });

      // Everything that starts in this shard is already in the library: nothing to download.
      const starting = [...wanted.values()].filter((w) => w.rec.shard === shard);
      if (starting.length && starting.every((w) => hasEpisode(conn, `ps:clean/${padded}/${w.rec.recording}`))) return 'skipped';

      for (const next of ctx.peekWaiting(2)) void startDownload(Number(next.params.shard)).catch(() => undefined);
      ctx.progress('Downloading (about 470 MB)');
      await abortable(startDownload(shard), ctx.signal);

      const audioDir = path.join(root(), 'audio');
      fs.mkdirSync(audioDir, { recursive: true });
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'timelines-ps-'));
      try {
        ctx.progress('Picking out the films');
        const clips: ClipMeta[] = [];
        const lastIndex = new Map<string, number>();
        await readShardRows(shardFile(shard), (id) => wanted.has(parseClipId(id).recording), (row) => {
          if (ctx.signal.aborted) throw abortError();
          const { recording, index } = parseClipId(row.id);
          lastIndex.set(recording, Math.max(lastIndex.get(recording) ?? -1, index));
          const text = row.text.trim();
          if (!text) return;
          const file = path.join(work, `${clips.length}.flac`);
          fs.writeFileSync(file, row.audio);
          clips.push({ id: row.id, index, durationMs: flacDurationMs(row.audio) ?? row.durationMs, text, file });
        });

        // A film whose last clip number is short of its clip count carries on in the next shard.
        const continues = [...lastIndex].some(([recording, last]) => last + 1 < wanted.get(recording)!.rec.clips);
        if (continues && !ctx.hasItem(shardLabel(shard + 1))) ctx.addItems([{ label: shardLabel(shard + 1), params: { shard: shard + 1 } }]);

        let indexed = 0;
        for (const rec of groupRecordings(clips)) {
          const { film, rec: entry } = wanted.get(rec.recording)!;
          const extId = `ps:clean/${padded}/${rec.recording}`;
          if (hasEpisode(conn, extId)) continue;
          ctx.progress(`Assembling ${film.title}`);
          const slug = recordingSlug(`clean-${padded}-${rec.recording}`);
          const out = path.join(audioDir, `${slug}.flac`);
          const { times, durationMs } = await assembleRecording(rec.clips, out, path.join(work, `${slug}.txt`), ctx.signal);
          saveEpisode(
            conn,
            {
              source: 'peoples-speech',
              extId,
              show: filmShow(film.collections),
              title: entry.shard === shard ? film.title : `${film.title} (cont.)`,
              date: film.date,
              audioUrl: pathToFileURL(out).href,
              pageUrl: `https://archive.org/details/${film.item}`,
              durationMs,
              topics: film.topics,
            },
            rec.clips.map((c, i) => ({ startMs: times[i]!.startMs, endMs: times[i]!.endMs, text: c.text })),
          );
          indexed++;
        }
        // The shard has done its job; a paused or cancelled item keeps it for the next try.
        downloads.delete(shard);
        fs.rmSync(shardFile(shard), { force: true });
        return indexed ? 'done' : 'skipped';
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    },
  };
}
