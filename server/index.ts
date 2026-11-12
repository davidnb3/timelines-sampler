import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bounce, parseBounce } from './bounce.ts';
import { ClipError, cutClip, warmSource, type ClipFormat } from './clip.ts';
import { PORT, WEB_DIST } from './config.ts';
import { MAX_FADE_MS } from './fade.ts';
import { getSegmentsBetween, libraryStats, listTopics, openDb } from './db.ts';
import { expandWindow, searchLibrary } from './sources/library.ts';
import { searchTv } from './sources/gdelt.ts';
import {
  addClip, createTimeline, deleteTimeline, duplicateTimeline, getTimeline, listTimelines, removeClip, renameTimeline,
  TimelineError, setStory, updateClip,
} from './timelines.ts';
import { checkRequest } from './guard.ts';
import { buildProcessors, planJob } from './importers/index.ts';
import { expandPaths } from './importers/files.ts';
import { filmsInfo } from './importers/films.ts';
import { JobRunner } from './jobs.ts';
import { modelAvailable } from './models.ts';
import { podcastIndexKeys, readSettings, updateSettings } from './settings.ts';
import { onSetupChange, setupStatus, startInstall, type ToolId } from './setup.ts';
import { countItems } from './sources/internetArchive.ts';
import { searchFeeds } from './sources/podcastIndex.ts';

const conn = openDb();
const runner = new JobRunner(conn, buildProcessors(conn));
runner.start();
/** Set by the desktop app: see guard.ts. */
const GUARD = { token: process.env.TIMELINES_TOKEN || null, port: PORT };

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** Serves a file with Range support so the browser can seek inside clips. */
function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, extra: Record<string, string> = {}): void {
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file)] ?? 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return void res.end();
    }
    res.writeHead(206, {
      'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`, ...extra,
    });
    return void fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', ...extra });
  fs.createReadStream(file).pipe(res);
}

const MAX_BODY_BYTES = 1_000_000;

/**
 * Reads a JSON request body. Only `application/json` is accepted: a web page on another site
 * cannot send that to this server without a CORS preflight, which the server never answers, so
 * other sites cannot change your timelines.
 */
async function readJson(req: http.IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new TimelineError(415, 'Send application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new TimelineError(413, 'Request body is too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    throw new TimelineError(400, 'Body is not valid JSON');
  }
}

/** /api/timelines, /api/timelines/:id, /api/timelines/:id/duplicate and /api/timelines/:id/clips. */
async function handleTimelines(req: http.IncomingMessage, res: http.ServerResponse, url: URL, idText: string | undefined, sub: string | undefined): Promise<void> {
  const method = req.method ?? 'GET';
  const id = idText === undefined ? null : Number(idText);
  const body = async () => (await readJson(req)) as Record<string, unknown> | null;
  const notAllowed = () => new TimelineError(405, `${method} is not supported here`);

  if (id === null) {
    if (method === 'GET') return sendJson(res, 200, listTimelines(conn));
    if (method === 'POST') {
      const b = await body();
      return sendJson(res, 201, createTimeline(conn, b?.name, Array.isArray(b?.clips) ? b.clips : []));
    }
    throw notAllowed();
  }
  if (sub === undefined) {
    if (method === 'GET') return sendJson(res, 200, getTimeline(conn, id));
    if (method === 'PATCH') {
      // A request can rename, change the story settings, or both.
      const b = await body();
      if (b && 'story' in b) setStory(conn, id, b.story);
      if (!b || 'name' in b || !('story' in b)) return sendJson(res, 200, renameTimeline(conn, id, b?.name));
      return sendJson(res, 200, listTimelines(conn).find((t) => t.id === id));
    }
    if (method === 'DELETE') {
      deleteTimeline(conn, id);
      return sendJson(res, 200, { ok: true });
    }
    throw notAllowed();
  }
  if (sub === 'duplicate' && method === 'POST') return sendJson(res, 201, duplicateTimeline(conn, id));
  if (sub === 'clips') {
    if (method === 'POST') return sendJson(res, 201, addClip(conn, id, await body()));
    if (method === 'DELETE') return sendJson(res, 200, removeClip(conn, id, url.searchParams.get('key') ?? ''));
    if (method === 'PATCH') return sendJson(res, 200, updateClip(conn, id, url.searchParams.get('key') ?? '', (await body())?.hit));
  }
  throw notAllowed();
}

const badRequest = (err: unknown) => new TimelineError(400, err instanceof Error ? err.message : String(err));

/** The jobs and the setup state, pushed to every open window as server-sent events. */
const eventClients = new Set<http.ServerResponse>();
let eventTimer: NodeJS.Timeout | undefined;
function pushEvents(): void {
  if (eventTimer || !eventClients.size) return;
  eventTimer = setTimeout(() => {
    eventTimer = undefined;
    const payload = `data: ${JSON.stringify({ jobs: runner.list(), setup: setupStatus() })}\n\n`;
    for (const c of eventClients) c.write(payload);
  }, 120);
}
runner.onChange(pushEvents);
onSetupChange(pushEvents);

function openEventStream(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify({ jobs: runner.list(), setup: setupStatus() })}\n\n`);
  eventClients.add(res);
  const beat = setInterval(() => res.write(': still here\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(beat);
    eventClients.delete(res);
  });
}

/** Routes for adding sources: /api/jobs, /api/setup, /api/settings and /api/sources/*. */
async function handleSources(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const method = req.method ?? 'GET';
  const p = url.pathname;
  const body = async () => ((await readJson(req)) ?? {}) as Record<string, unknown>;
  const reply = (status: number, payload: unknown): true => {
    sendJson(res, status, payload);
    return true;
  };

  if (p === '/api/events' && method === 'GET') {
    openEventStream(req, res);
    return true;
  }
  if (p === '/api/setup' && method === 'GET') return reply(200, setupStatus());
  if (p === '/api/setup/install' && method === 'POST') {
    const b = await body();
    if (!['ffmpeg', 'whisper', 'model'].includes(String(b.id))) throw new TimelineError(400, 'Unknown tool');
    try {
      startInstall(b.id as ToolId, { model: b.model ? String(b.model) : undefined });
    } catch (err) {
      throw badRequest(err);
    }
    return reply(202, setupStatus());
  }

  if (p === '/api/settings') {
    if (method === 'POST') {
      const b = await body();
      updateSettings({
        ...('podcastIndexKey' in b ? { podcastIndexKey: String(b.podcastIndexKey).trim() } : {}),
        ...('podcastIndexSecret' in b ? { podcastIndexSecret: String(b.podcastIndexSecret).trim() } : {}),
      });
      pushEvents();
    }
    // Secrets are never sent back: the page only learns whether they are set.
    const s = readSettings();
    return reply(200, { podcastIndexConfigured: podcastIndexKeys() !== null, whisperModel: s.whisperModel ?? null, transcribeSpeed: s.transcribeSpeed ?? null });
  }

  if (p === '/api/sources/films' && method === 'GET') return reply(200, filmsInfo());
  if (p === '/api/sources/ia/preview' && method === 'POST') {
    const b = await body();
    const query = String(b.query ?? '').trim();
    if (!query) throw new TimelineError(400, 'Enter a search first');
    try {
      return reply(200, { count: await countItems(query) });
    } catch (err) {
      throw badRequest(err);
    }
  }
  if (p === '/api/sources/podcasts/search' && method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').trim();
    if (!q) throw new TimelineError(400, 'Enter a podcast name');
    try {
      const feeds = await searchFeeds(q, 12);
      return reply(200, feeds.map((f) => ({ id: f.id, title: f.title, author: f.author ?? null, description: (f.description ?? '').slice(0, 240), image: f.image ?? null, episodeCount: f.episodeCount ?? null, language: f.language })));
    } catch (err) {
      throw badRequest(err);
    }
  }
  if (p === '/api/sources/files/preview' && method === 'POST') {
    const b = await body();
    const paths = Array.isArray(b.paths) ? b.paths.map(String) : [];
    const { files, truncated } = expandPaths(paths);
    return reply(200, { count: files.length, truncated, sample: files.slice(0, 5) });
  }

  if (p === '/api/jobs' && method === 'GET') return reply(200, runner.list());
  if (p === '/api/jobs' && method === 'POST') {
    const b = await body();
    let planned;
    try {
      planned = await planJob(String(b.kind ?? ''), b);
    } catch (err) {
      throw badRequest(err);
    }
    const job = runner.create(String(b.kind), planned.title, planned.params, planned.items);
    return reply(201, { ...job, note: planned.note ?? null });
  }
  const one = /^\/api\/jobs\/(\d+)(?:\/(pause|resume|cancel))?$/.exec(p);
  if (one) {
    const id = Number(one[1]);
    try {
      if (!one[2] && method === 'GET') {
        const job = runner.get(id);
        if (!job) throw new TimelineError(404, 'No such job');
        return reply(200, job);
      }
      if (one[2] && method === 'POST') {
        await body();
        runner[one[2] as 'pause' | 'resume' | 'cancel'](id);
        return reply(200, runner.get(id));
      }
      if (!one[2] && method === 'DELETE') {
        runner.remove(id);
        return reply(200, { ok: true });
      }
    } catch (err) {
      if (err instanceof TimelineError) throw err;
      throw badRequest(err);
    }
    throw new TimelineError(405, `${method} is not supported here`);
  }
  return false;
}

const intParam = (v: string | null, d: number, min: number, max: number) => {
  const n = v === null ? d : Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const p = url.searchParams;

  if (await handleSources(req, res, url)) return;

  const timelines = /^\/api\/timelines(?:\/(\d+))?(?:\/(duplicate|clips))?$/.exec(url.pathname);
  if (timelines) return handleTimelines(req, res, url, timelines[1], timelines[2]);

  if (url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, library: libraryStats(conn), whisperModel: modelAvailable() });
  }

  if (url.pathname === '/api/topics') return sendJson(res, 200, listTopics(conn));

  if (url.pathname === '/api/search') {
    const q = (p.get('q') ?? '').trim();
    const source = p.get('source') ?? 'library';
    const limit = intParam(p.get('limit'), 20, 1, 50);
    if (!q) return sendJson(res, 400, { error: 'Missing q' });
    if (source === 'library') {
      const topics = (p.get('topics') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
      const found = searchLibrary(conn, q, topics, limit, intParam(p.get('context'), 1, 0, 6));
      // Resolve the audio address of the best hits now (one small request each), so playing one is quick.
      for (const ref of [...new Set(found.hits.map((h) => h.ref))].slice(0, 3)) warmSource(conn, ref);
      return sendJson(res, 200, found);
    }
    if (source === 'tv') return sendJson(res, 200, await searchTv(q, limit));
    return sendJson(res, 400, { error: `Unknown source "${source}"` });
  }

  if (url.pathname === '/api/context') {
    const win = expandWindow(
      conn,
      intParam(p.get('episode'), 0, 0, 1e9),
      intParam(p.get('first'), 0, 0, 1e9),
      intParam(p.get('last'), 0, 0, 1e9),
      intParam(p.get('before'), 0, 0, 20),
      intParam(p.get('after'), 0, 0, 20),
    );
    return win ? sendJson(res, 200, win) : sendJson(res, 404, { error: 'Segment not found' });
  }

  if (url.pathname === '/api/segments') {
    const episode = intParam(p.get('episode'), 0, 0, 1e9);
    const from = intParam(p.get('from'), 0, 0, 1e10);
    const to = intParam(p.get('to'), from, from, 1e10);
    return sendJson(res, 200, getSegmentsBetween(conn, episode, from, to));
  }

  if (url.pathname === '/api/bounce') {
    const spec = parseBounce(p.get('clips'), p.get('gap'), p.get('fmt'));
    const file = await bounce(conn, spec);
    const name = (p.get('name') ?? 'story').replace(/[^\w .-]+/g, '').slice(0, 80) || 'story';
    const extra: Record<string, string> = p.get('download')
      ? { 'Content-Disposition': `attachment; filename="${name}.${spec.format}"` }
      : {};
    return sendFile(req, res, file, extra);
  }

  if (url.pathname === '/api/clip') {
    const format: ClipFormat = p.get('fmt') === 'wav' ? 'wav' : 'mp3';
    const file = await cutClip(
      conn,
      p.get('ref') ?? '',
      Number(p.get('start')),
      Number(p.get('end')),
      format,
      { inMs: intParam(p.get('fi'), 0, 0, MAX_FADE_MS), outMs: intParam(p.get('fo'), 0, 0, MAX_FADE_MS) },
      p.get('raw') === '1',
    );
    const name = (p.get('name') ?? 'clip').replace(/[^\w .-]+/g, '').slice(0, 80) || 'clip';
    const extra: Record<string, string> = p.get('download')
      ? { 'Content-Disposition': `attachment; filename="${name}.${format}"` }
      : {};
    return sendFile(req, res, file, extra);
  }

  sendJson(res, 404, { error: 'Not found' });
}

function serveWeb(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  if (!fs.existsSync(WEB_DIST)) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return void res.end('Timelines API is running. Start the UI with `npm run dev`, or build it with `npm run build`.');
  }
  const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(WEB_DIST, rel);
  if (!file.startsWith(WEB_DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(WEB_DIST, 'index.html');
  }
  sendFile(req, res, file);
}

const server = http.createServer(async (req, res) => {
  const guard = checkRequest(GUARD, { host: req.headers.host, cookie: req.headers.cookie, url: req.url ?? '/' });
  if (!guard.allow) {
    res.writeHead(guard.status ?? 403, { 'Content-Type': 'text/plain; charset=utf-8', ...(guard.redirect ? { Location: guard.redirect } : {}), ...(guard.setCookie ? { 'Set-Cookie': guard.setCookie } : {}) });
    return void res.end(guard.message ?? '');
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveWeb(req, res, url);
  } catch (err) {
    const status = err instanceof ClipError || err instanceof TimelineError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (status === 500) console.error(`${req.method} ${req.url}:`, message);
    if (!res.headersSent) sendJson(res, status, { error: message });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const s = libraryStats(conn);
  console.log(`Timelines API on http://127.0.0.1:${PORT}  (${s.episodes} recordings, ${s.segments} segments indexed)`);
});
