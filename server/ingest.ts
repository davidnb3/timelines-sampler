import { parseArgs } from 'node:util';
import { hasEpisode, libraryStats, listTopics, openDb, saveEpisode } from './db.ts';
import { dateFromName, titleFromName } from './naming.ts';
import { downloadUrl, detailsUrl, itemFiles, pickMp3s, searchItems } from './sources/internetArchive.ts';
import { episodesByFeed, feedById, searchFeeds, type PiFeed } from './sources/podcastIndex.ts';
import { normalizeTopics } from './topics.ts';
import { modelAvailable, transcribe } from './whisper.ts';

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
