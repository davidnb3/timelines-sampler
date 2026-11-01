import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DATA_DIR } from './config.ts';
import { hasEpisode, libraryStats, listTopics, openDb, saveEpisode } from './db.ts';
import { dateFromName, titleFromName } from './naming.ts';
import { downloadUrl, detailsUrl, itemFiles, pickMp3s, searchItems } from './sources/internetArchive.ts';
import { episodesByFeed, feedById, searchFeeds, type PiFeed } from './sources/podcastIndex.ts';
import {
  DATASET_PAGE, decodeRecording, flacDurationMs, groupRecordings, layoutClips, parseClipId, recordingDate, recordingTitle, shardUrl,
  type ClipMeta,
} from './sources/peoplesSpeech.ts';
import {
  collectionItems, FILM_COLLECTIONS, filmDate, filmShow, filmTitle, filmTopics, recordingsByItem,
  type CatalogEntry, type FilmItem, type FilmRecording, type ItemMeta,
} from './sources/peoplesSpeechFilms.ts';
import { downloadFile, readShard, readShardRows } from './sources/peoplesSpeechShard.ts';
import { normalizeTopics } from './topics.ts';
import { modelAvailable, run, transcribe } from './whisper.ts';

const USAGE = `Usage: npm run ingest -- <command> [options]

Commands
  ia        Transcribe Internet Archive audio into the search index
              --query <archive.org query>   e.g. 'collection:oldtimeradio AND subject:"science fiction"'
              --limit <n>        items to look at (default 5)
              --per-item <n>     recordings per item (default 1)
  podcast   Transcribe podcast episodes found through Podcast Index
              --term <text>      search feeds by term, or
              --feed <id>        use one feed id
              --feeds <n>        feeds to use with --term (default 1)
              --episodes <n>     latest episodes per feed (default 2)
  peoples-speech   Index clips from the People's Speech dataset (no transcription: it ships transcripts)
              --config <name>    microset (336 clips, one recording; default), clean, dirty, ...
              --shard <n>        which parquet file of the config (default 0; a full shard is about 470 MB)
  peoples-speech-films   Index only the films in People's Speech (Prelinger shorts, public-domain features, sci-fi, noir ...)
              picks them by Internet Archive collection from data/peoples-speech/catalog-clean.json, then reads the
              shards that hold them one by one (about 470 MB each, deleted afterwards); safe to stop and run again
              --select-only      only build data/peoples-speech/films.json (the list of films), do not import
              --refresh          rebuild that list instead of reusing it
              --shard <n>        import just this shard (and any shard its films spill into)
  stats     Show what is indexed
  retitle   Recompute titles and dates of Internet Archive recordings from their file names

Common options
  --topic <name>       tag everything ingested (repeatable), e.g. --topic sci-fi
  --max-minutes <n>    transcribe at most this much of each recording (default 45)
  --force              re-transcribe recordings that are already indexed
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    query: { type: 'string' },
    term: { type: 'string' },
    feed: { type: 'string' },
    feeds: { type: 'string' },
    episodes: { type: 'string' },
    limit: { type: 'string' },
    'per-item': { type: 'string' },
    topic: { type: 'string', multiple: true },
    'max-minutes': { type: 'string' },
    force: { type: 'boolean' },
    config: { type: 'string' },
    shard: { type: 'string' },
    'select-only': { type: 'boolean' },
    refresh: { type: 'boolean' },
  },
});

const num = (v: string | undefined, d: number) => (v ? Number(v) : d);
const forcedTopics = values.topic ?? [];
const maxSeconds = num(values['max-minutes'], 45) * 60;
const conn = openDb();
let failures = 0;

async function ingestRecording(r: {
  source: string;
  extId: string;
  show: string;
  title: string;
  date: string | null;
  audioUrl: string;
  pageUrl: string | null;
  durationMs: number | null;
  rawTopics: string[];
}): Promise<void> {
  if (!values.force && hasEpisode(conn, r.extId)) {
    console.log(`  skip (already indexed): ${r.title}`);
    return;
  }
  const t0 = Date.now();
  console.log(`  transcribing: ${r.title}`);
  try {
    const segments = await transcribe(r.audioUrl, maxSeconds);
    if (!segments.length) {
      console.log('  no speech found, skipped');
      return;
    }
    saveEpisode(
      conn,
      {
        source: r.source,
        extId: r.extId,
        show: r.show,
        title: r.title,
        date: r.date,
        audioUrl: r.audioUrl,
        pageUrl: r.pageUrl,
        durationMs: r.durationMs,
        topics: normalizeTopics(r.rawTopics, forcedTopics),
      },
      segments,
    );
    console.log(`  indexed ${segments.length} segments in ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (err) {
    // One bad recording should not abort a long batch.
    failures++;
    console.error(`  FAILED: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
  }
}

async function ingestIa(): Promise<void> {
  if (!values.query) throw new Error('--query is required for "ia"');
  const items = await searchItems(`${values.query} AND mediatype:audio`, num(values.limit, 5));
  console.log(`Found ${items.length} Internet Archive items`);
  for (const item of items) {
    const files = pickMp3s(await itemFiles(item.identifier)).slice(0, num(values['per-item'], 1));
    if (!files.length) console.log(`- ${item.title}: no MP3 files, skipped`);
    for (const f of files) {
      console.log(`- ${item.title} / ${f.name}`);
      await ingestRecording({
        source: 'ia',
        extId: `ia:${item.identifier}/${f.name}`,
        // The item title names the series; the uploader (`creator`) is usually a collector group.
        show: item.title.replace(/\s+-\s+Single Episodes$/i, ''),
        title: titleFromName(f.name),
        // Broadcast date from the file name beats the upload date IA records on the item.
        date: dateFromName(f.name) ?? item.date,
        audioUrl: downloadUrl(item.identifier, f.name),
        pageUrl: detailsUrl(item.identifier),
        durationMs: null,
        rawTopics: item.subjects,
      });
    }
  }
}

async function ingestPodcasts(): Promise<void> {
  let feeds: PiFeed[];
  if (values.feed) feeds = [await feedById(Number(values.feed))];
  else if (values.term) feeds = await searchFeeds(values.term, num(values.feeds, 1));
  else throw new Error('--term or --feed is required for "podcast"');
  for (const feed of feeds) {
    console.log(`- ${feed.title}`);
    for (const ep of await episodesByFeed(feed.id, num(values.episodes, 2))) {
      await ingestRecording({
        source: 'podcast',
        extId: `pi:${ep.id}`,
        show: feed.title,
        title: ep.title,
        date: ep.datePublished ? new Date(ep.datePublished * 1000).toISOString().slice(0, 10) : null,
        audioUrl: ep.enclosureUrl,
        pageUrl: ep.link ?? feed.link,
        durationMs: ep.duration ? ep.duration * 1000 : null,
        rawTopics: feed.categories,
      });
    }
  }
}

/** A file name for a recording: safe characters, and a short hash when the name had to be cut. */
function recordingSlug(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_');
  return safe.length <= 120 ? safe : `${safe.slice(0, 100)}-${createHash('sha1').update(name).digest('hex').slice(0, 8)}`;
}

/** Lays a recording's clips end to end into one FLAC file at `out`; the returned times match that file. */
async function assembleRecording(clips: ClipMeta[], out: string, list: string): Promise<{ times: { startMs: number; endMs: number }[]; durationMs: number }> {
  fs.writeFileSync(list, clips.map((c) => `file '${c.file.replaceAll("'", "'\\''")}'`).join('\n') + '\n');
  // Re-encoding (lossless) rather than copying keeps the joined file valid whatever the clips' headers say.
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'flac', out]);
  const times = layoutClips(clips.map((c) => c.durationMs));
  const durationMs = times[times.length - 1]!.endMs;
  const actualMs = Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out])).trim()) * 1000;
  if (Math.abs(actualMs - durationMs) > 50) console.warn(`  warning: assembled audio is ${Math.round(actualMs)} ms, transcript times add up to ${durationMs} ms`);
  return { times, durationMs };
}

/**
 * Indexes one shard of People's Speech. Its clips arrive with transcripts, so there is nothing to
 * transcribe: each recording's clips are laid end to end into one local FLAC file, and each clip
 * becomes a segment whose times match that file exactly (lengths come from the FLAC headers).
 */
async function ingestPeoplesSpeech(): Promise<void> {
  const config = values.config ?? 'microset';
  const shard = num(values.shard, 0);
  const padded = String(shard).padStart(4, '0');
  const root = path.join(DATA_DIR, 'peoples-speech');
  const audioDir = path.join(root, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });

  const parquet = path.join(root, `${config}-${padded}.parquet`);
  if (!fs.existsSync(parquet) || values.force) {
    console.log(`- downloading ${config} shard ${padded}`);
    await downloadFile(shardUrl(config, shard), parquet);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'back-then-ps-'));
  try {
    const clips: ClipMeta[] = [];
    const total = await readShard(parquet, (row) => {
      const text = row.text.trim();
      if (!text) return;
      const file = path.join(work, `${clips.length}.flac`);
      fs.writeFileSync(file, row.audio);
      clips.push({ id: row.id, index: parseClipId(row.id).index, durationMs: flacDurationMs(row.audio) ?? row.durationMs, text, file });
    });
    const recordings = groupRecordings(clips);
    console.log(`- read ${total} clips from ${recordings.length} recording${recordings.length === 1 ? '' : 's'}`);

    for (const rec of recordings) {
      const decoded = decodeRecording(rec.recording);
      const extId = `ps:${config}/${padded}/${rec.recording}`;
      const title = recordingTitle(decoded);
      if (!values.force && hasEpisode(conn, extId)) {
        console.log(`  skip (already indexed): ${title}`);
        continue;
      }
      const slug = recordingSlug(`${config}-${padded}-${rec.recording}`);
      const out = path.join(audioDir, `${slug}.flac`);
      const { times, durationMs } = await assembleRecording(rec.clips, out, path.join(work, `${slug}.txt`));

      saveEpisode(
        conn,
        {
          source: 'peoples-speech',
          extId,
          show: "People's Speech",
          title,
          date: recordingDate(decoded),
          audioUrl: pathToFileURL(out).href,
          pageUrl: DATASET_PAGE,
          durationMs,
          topics: normalizeTopics([], forcedTopics),
        },
        rec.clips.map((c, i) => ({ startMs: times[i]!.startMs, endMs: times[i]!.endMs, text: c.text })),
      );
      console.log(`  indexed ${rec.clips.length} clips (${(durationMs / 60000).toFixed(1)} min): ${title}`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const PS_ROOT = path.join(DATA_DIR, 'peoples-speech');

/**
 * The films of People's Speech `clean` with their Internet Archive title, date and topics, kept in
 * `films.json` (built once; `--refresh` rebuilds it). Picked by collection from the catalog of the
 * whole set, so no shard has to be read to find them.
 */
async function selectFilms(): Promise<FilmItem[]> {
  const listFile = path.join(PS_ROOT, 'films.json');
  if (!values.refresh && fs.existsSync(listFile)) return JSON.parse(fs.readFileSync(listFile, 'utf8')) as FilmItem[];
  const catalogFile = path.join(PS_ROOT, 'catalog-clean.json');
  if (!fs.existsSync(catalogFile)) throw new Error(`${catalogFile} is missing: it lists every recording of the clean config and which shard it starts in`);
  const byItem = recordingsByItem(JSON.parse(fs.readFileSync(catalogFile, 'utf8')) as CatalogEntry[]);

  console.log('- listing the Internet Archive film collections (a few minutes)');
  const meta = new Map<string, ItemMeta>();
  for (const collection of Object.keys(FILM_COLLECTIONS)) {
    const { listed, items } = await collectionItems(collection, (id) => byItem.has(id));
    for (const [id, m] of items) meta.set(id, m);
    console.log(`  ${collection}: ${listed} items, ${items.size} in the dataset`);
  }

  const films: FilmItem[] = [...meta].flatMap(([item, m]) => {
    const known = m.collections.filter((c) => c in FILM_COLLECTIONS);
    const collections = known.length ? known : ['moviesandfilms'];
    return [{
      item,
      title: filmTitle(m.title, item),
      date: filmDate(m.date, item),
      collections,
      topics: filmTopics(collections, m.subjects),
      recordings: byItem.get(item)!,
    }];
  });
  films.sort((a, b) => a.item.localeCompare(b.item));
  fs.writeFileSync(listFile, JSON.stringify(films));
  return films;
}

/** Downloads a shard; Hugging Face limits requests, so a refused one is retried after a pause. */
async function downloadShard(url: string, dest: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await downloadFile(url, dest);
    } catch (err) {
      if (attempt >= 5) throw err;
      console.warn(`  download failed (${err instanceof Error ? err.message : err}); trying again in ${30 * (attempt + 1)} s`);
      await new Promise((r) => setTimeout(r, 30_000 * (attempt + 1)));
    }
  }
}

/**
 * Indexes the films of People's Speech `clean`: only the recordings picked by `selectFilms`, shard by
 * shard (each shard is downloaded, its film clips are kept, the shard is deleted). A film that runs on
 * into the next shard queues that shard too. Progress is kept in `films-done.json`, so stopping and
 * running again continues where it left off.
 */
async function ingestPeoplesSpeechFilms(): Promise<void> {
  const films = await selectFilms();
  const hours = films.reduce((s, f) => s + f.recordings.reduce((t, r) => t + r.ms, 0), 0) / 3.6e6;
  console.log(`${films.length} films, ${hours.toFixed(1)} hours`);
  if (values['select-only']) return;

  const wanted = new Map<string, { film: FilmItem; rec: FilmRecording }>();
  for (const film of films) for (const rec of film.recordings) wanted.set(rec.recording, { film, rec });

  const audioDir = path.join(PS_ROOT, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const stateFile = path.join(PS_ROOT, 'films-done.json');
  const done: Record<string, number[]> = !values.force && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  const queue = new Set<number>(values.shard ? [num(values.shard, 0)] : films.flatMap((f) => f.recordings.map((r) => r.shard)));
  const visited = new Set<number>();
  const total = queue.size;
  const shardFile = (n: number) => path.join(PS_ROOT, `clean-${String(n).padStart(4, '0')}.parquet`);
  const downloads = new Map<number, Promise<void>>();
  const startDownload = (n: number) => {
    if (!downloads.has(n)) downloads.set(n, fs.existsSync(shardFile(n)) ? Promise.resolve() : downloadShard(shardUrl('clean', n), shardFile(n)));
    return downloads.get(n)!;
  };
  for (const f of fs.readdirSync(PS_ROOT)) if (/^clean-\d+\.parquet\.part$/.test(f)) fs.rmSync(path.join(PS_ROOT, f));

  while (queue.size) {
    const shard = Math.min(...queue);
    queue.delete(shard);
    visited.add(shard);
    const padded = String(shard).padStart(4, '0');
    const known = done[padded];
    if (known) {
      for (const n of known) if (!visited.has(n)) queue.add(n);
      continue;
    }

    const t0 = Date.now();
    const parquet = shardFile(shard);
    console.log(`- shard ${padded} (${visited.size} of about ${Math.max(total, visited.size)})`);
    // Downloads are what takes the time, so the next two shards are fetched while this one is processed.
    for (const n of [...queue].sort((a, b) => a - b).filter((n) => !done[String(n).padStart(4, '0')]).slice(0, 2)) void startDownload(n).catch(() => {});
    await startDownload(shard);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'back-then-ps-'));
    try {
      const clips: ClipMeta[] = [];
      const lastIndex = new Map<string, number>();
      await readShardRows(parquet, (id) => wanted.has(parseClipId(id).recording), (row) => {
        const { recording, index } = parseClipId(row.id);
        lastIndex.set(recording, Math.max(lastIndex.get(recording) ?? -1, index));
        const text = row.text.trim();
        if (!text) return;
        const file = path.join(work, `${clips.length}.flac`);
        fs.writeFileSync(file, row.audio);
        clips.push({ id: row.id, index, durationMs: flacDurationMs(row.audio) ?? row.durationMs, text, file });
      });

      // A film whose last clip number is short of its clip count carries on in the next shard.
      const spill: number[] = [];
      for (const [recording, last] of lastIndex) if (last + 1 < wanted.get(recording)!.rec.clips) spill.push(shard + 1);
      if (spill.length) queue.add(shard + 1);

      let indexed = 0;
      let ms = 0;
      for (const rec of groupRecordings(clips)) {
        const { film, rec: entry } = wanted.get(rec.recording)!;
        const extId = `ps:clean/${padded}/${rec.recording}`;
        if (!values.force && hasEpisode(conn, extId)) continue;
        const slug = recordingSlug(`clean-${padded}-${rec.recording}`);
        const out = path.join(audioDir, `${slug}.flac`);
        const { times, durationMs } = await assembleRecording(rec.clips, out, path.join(work, `${slug}.txt`));
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
        ms += durationMs;
      }
      console.log(`  ${indexed} recordings, ${(ms / 60000).toFixed(0)} min of audio, ${Math.round((Date.now() - t0) / 1000)} s${spill.length ? `; continues in shard ${shard + 1}` : ''}`);
      done[padded] = [...new Set(spill)];
      fs.writeFileSync(stateFile, JSON.stringify(done));
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
      fs.rmSync(parquet, { force: true });
    }
  }
}

/** Recomputes titles and dates of Internet Archive recordings from the file names in `ext_id`. */
function retitle(): void {
  const rows = conn.prepare("SELECT id, ext_id, title, date FROM episodes WHERE source = 'ia'").all() as {
    id: number;
    ext_id: string;
    title: string;
    date: string | null;
  }[];
  const update = conn.prepare('UPDATE episodes SET title = ?, date = ? WHERE id = ?');
  let changed = 0;
  for (const r of rows) {
    const file = r.ext_id.slice(r.ext_id.indexOf('/') + 1);
    const title = titleFromName(file);
    const date = dateFromName(file) ?? r.date;
    if (title !== r.title || date !== r.date) {
      update.run(title, date, r.id);
      changed++;
    }
  }
  console.log(`retitled ${changed} of ${rows.length} Internet Archive recordings`);
}

function printStats(): void {
  const s = libraryStats(conn);
  console.log(`${s.episodes} recordings, ${s.segments} searchable segments`);
  for (const t of listTopics(conn)) console.log(`  ${t.topic}: ${t.episodes}`);
}

const command = positionals[0];
try {
  if (command === 'stats') printStats();
  else if (command === 'retitle') retitle();
  else if (command === 'peoples-speech') {
    await ingestPeoplesSpeech();
    printStats();
  }
  else if (command === 'peoples-speech-films') {
    await ingestPeoplesSpeechFilms();
    printStats();
  }
  else if (command === 'ia' || command === 'podcast') {
    if (!modelAvailable()) throw new Error('Whisper model missing; see CLAUDE.md for the download command');
    if (command === 'ia') await ingestIa();
    else await ingestPodcasts();
    printStats();
    if (failures) {
      console.error(`${failures} recording(s) failed`);
      process.exitCode = 1;
    }
  } else {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
