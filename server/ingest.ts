import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DATA_DIR } from './config.ts';
import { hasEpisode, libraryStats, listTopics, openDb, saveEpisode } from './db.ts';
import { buildProcessors } from './importers/index.ts';
import { cleanTopics } from './importers/common.ts';
import { iaProcessor, planIa, type IaParams } from './importers/ia.ts';
import { assembleRecording, recordingSlug } from './importers/peoplesAudio.ts';
import { filmsInfo, planFilms } from './importers/films.ts';
import { planPodcast, podcastProcessor, type PodcastParams } from './importers/podcast.ts';
import { JobRunner, type ItemSpec, type Processor, type ProcessorContext } from './jobs.ts';
import { dateFromName, titleFromName } from './naming.ts';
import { feedById, searchFeeds, type PiFeed } from './sources/podcastIndex.ts';
import {
  collectionItems, FILM_COLLECTIONS, filmDate, filmTitle, filmTopics, recordingsByItem,
  type CatalogEntry, type FilmItem, type ItemMeta,
} from './sources/peoplesSpeechFilms.ts';
import {
  DATASET_PAGE, decodeRecording, flacDurationMs, groupRecordings, parseClipId, recordingDate, recordingTitle, shardUrl,
  type ClipMeta,
} from './sources/peoplesSpeech.ts';
import { downloadFile, readShard } from './sources/peoplesSpeechShard.ts';
import { normalizeTopics } from './topics.ts';
import { modelAvailable } from './whisper.ts';

const USAGE = `Usage: npm run ingest -- <command> [options]

Commands
  ia        Transcribe Internet Archive audio or video into the search index
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
              the same import the app offers: one background job that reads the shards holding the films, one by one
              (about 470 MB each, deleted afterwards). Ctrl-C pauses it; run the command again to continue.
              --select-only      only build data/peoples-speech/films.json (the list of films) from the Internet Archive
                                 and data/peoples-speech/catalog-clean.json, do not import
              --refresh          rebuild that list instead of reusing it
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
const forcedTopics = cleanTopics(values.topic ?? []);
const maxMinutes = num(values['max-minutes'], 45);
const conn = openDb();
let failures = 0;

/** Runs the items of an import one after another in this process, printing what happens. */
async function runItems(processor: Processor, params: Record<string, unknown>, items: ItemSpec[]): Promise<void> {
  const controller = new AbortController();
  for (const [i, item] of items.entries()) {
    console.log(`- [${i + 1}/${items.length}] ${item.label}`);
    const ctx: ProcessorContext = {
      signal: controller.signal,
      progress: (stage) => console.log(`  ${stage}`),
      addItems: (more) => void items.push(...more),
      peekWaiting: (n) => items.slice(i + 1, i + 1 + n),
      hasItem: (label) => items.some((it) => it.label === label),
    };
    try {
      const result = await processor.run(item, ctx, params);
      console.log(result === 'skipped' ? '  skipped (already indexed or no speech)' : '  indexed');
    } catch (err) {
      failures++;
      console.error(`  FAILED: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
    }
  }
}

async function ingestIa(): Promise<void> {
  if (!values.query) throw new Error('--query is required for "ia"');
  const params: IaParams = {
    query: `${values.query} AND mediatype:audio`,
    limit: num(values.limit, 5),
    perItem: num(values['per-item'], 1),
    maxMinutes,
    topics: forcedTopics,
    show: null,
  };
  const items = await planIa(params);
  console.log(`Found ${items.length} Internet Archive items`);
  await runItems(iaProcessor(conn), { ...params }, items);
}

async function ingestPodcasts(): Promise<void> {
  let feeds: PiFeed[];
  if (values.feed) feeds = [await feedById(Number(values.feed))];
  else if (values.term) feeds = await searchFeeds(values.term, num(values.feeds, 1));
  else throw new Error('--term or --feed is required for "podcast"');
  for (const feed of feeds) {
    console.log(`- ${feed.title}`);
    const { items } = await planPodcast({ feedId: feed.id, episodes: num(values.episodes, 2) });
    const params: PodcastParams = { feedId: feed.id, episodes: items.length, maxMinutes, topics: forcedTopics, feedTitle: feed.title, link: feed.link, categories: feed.categories };
    await runItems(podcastProcessor(conn), { ...params }, items);
  }
}

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

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'timelines-ps-'));
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

/** Imports the films as one background job, the way the app does: Ctrl-C pauses it, running the command again continues it. */
async function ingestPeoplesSpeechFilms(): Promise<void> {
  const films = await selectFilms();
  const info = filmsInfo(films);
  console.log(`${info.films} films, ${info.hours} hours, ${info.shards} shards (about ${info.downloadGb} GB to download, ${info.diskGb} GB kept)`);
  if (values['select-only']) return;

  const runner = new JobRunner(conn, buildProcessors(conn));
  const open = conn.prepare("SELECT id FROM jobs WHERE kind = 'films' AND state IN ('paused', 'queued') ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
  runner.start();
  let id: number;
  if (open) {
    id = open.id;
    console.log(`Continuing job ${id}`);
    runner.resume(id);
  } else {
    id = runner.create('films', `Old films (${info.films} films)`, {}, planFilms(films)).id;
  }
  let last = '';
  runner.onChange(() => {
    const j = runner.get(id)!;
    const line = `[${j.done + j.skipped}/${j.total}] ${j.current ?? j.state}`;
    if (line !== last) console.log(line);
    last = line;
  });
  const stop = () => {
    runner.pause(id);
    setTimeout(() => process.exit(0), 3000);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await runner.idle();
  const j = runner.get(id)!;
  console.log(`Job ${j.state}: ${j.done} done, ${j.skipped} skipped, ${j.failed} failed`);
  for (const f of j.failures) console.error(`  FAILED ${f.label}: ${f.error}`);
  if (j.failed) failures++;
}

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
  } else if (command === 'peoples-speech-films') {
    await ingestPeoplesSpeechFilms();
    printStats();
  } else if (command === 'ia' || command === 'podcast') {
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
